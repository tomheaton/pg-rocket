// Connection — the v3-protocol state machine over a Transport.
//
// State transitions are driven by `ReadyForQuery` boundaries, not by counting
// individual messages, so we always agree with the server about transaction
// state. Both `query()` and `extQuery()` end only when ReadyForQuery arrives,
// even if an ErrorResponse came earlier in the same exchange.
//
// What's implemented in this slice:
//   * SSL negotiation + TLS upgrade
//   * StartupMessage + ParameterStatus + BackendKeyData accumulation
//   * Auth: AuthenticationOk, CleartextPassword, MD5Password, SCRAM-SHA-256
//   * Simple-query path (Q → RowDescription/DataRow*/CommandComplete → ReadyForQuery)
//   * Extended-query path with named statements + LRU prepared cache —
//     cache hits skip Parse and go straight to Bind/Execute/Sync.
//   * Auto-reprepare on SQLSTATE 0A000 / 26000 (cached plan invalidated, or
//     server-side cache out of sync).
//   * Cursor (portal-based async generator).
//   * AbortSignal cancellation via side-connection CancelRequest (cancel()).
//   * Observability hooks: onQuery, onError, onNotice, onNotification, onConnect.
//   * Graceful end() (Terminate + FIN)
//
// Deliberately not yet implemented (next layers):
//   * Pipeliner (multiple commands, one coalesced write)
//   * Binary-format codecs (everything is text-format here)

import {
  type Codec,
  type CodecRegistry,
  getDefaultRegistry,
  Oid,
} from "../codecs/index.js";
import {
  AuthenticationError,
  ConnectionError,
  decodeErrorResponse,
  PgError,
  ProtocolError,
} from "../errors.js";
import type {
  OnError,
  OnNotice,
  OnNotification,
  OnQuery,
} from "../observability.js";
import { md5PasswordToken } from "../protocol/auth/md5.js";
import * as scram from "../protocol/auth/scram.js";
import {
  parseCommandTag,
  readCString,
  readErrorFields,
  readUtf8,
} from "../protocol/body.js";
import type { CryptoProvider } from "../protocol/crypto.js";
import {
  AuthRequest,
  BackendKind,
  FieldCode,
  Format,
  StatementOrPortal,
  TxStatus,
} from "../protocol/messages.js";
import { type BackendMessage, MessageReader } from "../protocol/reader.js";
import { MessageWriter } from "../protocol/writer.js";
import { nodeCryptoProvider } from "./node-crypto.js";
import { PreparedCache, type PreparedEntry } from "./prepared-cache.js";
import { connectTcp } from "./tcp.js";
import type { TlsUpgradeOptions, Transport } from "./transport.js";

// ────────────────────────────────────────────────────────────────────────
// Public types

export type TlsMode = "disable" | "prefer" | "require";

export interface TlsOptions extends TlsUpgradeOptions {
  readonly mode: TlsMode;
}

export type PasswordSpec = string | (() => string | Promise<string>);

/**
 * Per-connection setup hook. Runs after the handshake completes but before
 * the connection is handed back to the caller — the user can issue setup
 * statements (`set search_path …`, `set timezone …`) here that every query
 * on this connection inherits.
 */
export type OnConnect = (conn: Connection) => Promise<void> | void;

export interface ConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly password?: PasswordSpec;
  readonly applicationName?: string;
  /** "prefer" by default. Pass an object for cert/CA configuration. */
  readonly tls?: TlsMode | TlsOptions;
  /** Inject an alternate CryptoProvider; defaults to a node:crypto-backed one. */
  readonly crypto?: CryptoProvider;
  /** Inject an alternate codec registry; defaults to the day-one scalars. */
  readonly codecs?: CodecRegistry;
  /**
   * Per-connection prepared-statement cache size. The cache stores the SQL
   * texts the server has already Parse'd; subsequent calls skip Parse and go
   * straight to Bind/Execute/Sync. Default 100. Set to 0 to disable.
   */
  readonly preparedCacheSize?: number;
  /** Fires once a query settles successfully (sees CommandComplete + ReadyForQuery). */
  readonly onQuery?: OnQuery;
  /** Fires when a query fails — server ErrorResponse, transport error, or cancel. */
  readonly onError?: OnError;
  /** Fires for every backend NoticeResponse (server-side warnings, RAISE NOTICE, etc.). */
  readonly onNotice?: OnNotice;
  /** Fires for every NotificationResponse (LISTEN/NOTIFY events from the server). */
  readonly onNotification?: OnNotification;
  /** Fires once the handshake completes; the connection isn't returned until the hook resolves. */
  readonly onConnect?: OnConnect;
}

export type Row = Record<string, unknown>;

export interface QueryResult<R = Row> {
  readonly rows: R[];
  readonly rowCount: number;
  readonly command: string;
}

export interface QueryOptions {
  /**
   * Cancel the in-flight query when this signal fires. Triggers a side-channel
   * `CancelRequest`; the query then errors with `QueryCanceled` (SQLSTATE 57014).
   * Pre-aborted signals throw `signal.reason` immediately.
   */
  readonly signal?: AbortSignal;
}

export interface FieldDescription {
  readonly name: string;
  readonly tableOid: number;
  readonly columnAttr: number;
  readonly dataTypeOid: number;
  readonly typeSize: number;
  readonly typeMod: number;
  readonly format: number;
}

type ConnectionState =
  | "connecting"
  | "negotiating-tls"
  | "authenticating"
  | "ready"
  | "busy"
  | "pipelining"
  | "closing"
  | "closed"
  | "errored";

/**
 * One unit of work in the pipelined command queue. The drain loop walks
 * messages and feeds them to `step()` of the queue head; when `step()` returns
 * true the command has settled (resolved/rejected) and the queue advances.
 *
 * Commands are responsible for their own resolve/reject — the queue dispatcher
 * doesn't know about Promises.
 */
interface PipelinedCommand {
  step(msg: BackendMessage, conn: Connection): boolean;
  /**
   * Connection-level abort path (transport error, fatal protocol error,
   * connection closed). Each command rejects whatever Promise it's backing.
   */
  abort(err: Error): void;
}

// ────────────────────────────────────────────────────────────────────────
// Internals

type NegotiationWaiter = {
  resolve: (b: number) => void;
  reject: (e: Error) => void;
};
type MessageWaiter = {
  resolve: (m: BackendMessage) => void;
  reject: (e: Error) => void;
};

const utf8Encoder = new TextEncoder();

let nextConnectionId = 0;

export class Connection {
  /** Stable per-process id, included in every observability event. */
  readonly id: number = ++nextConnectionId;
  // Public, observable connection-level state populated during handshake.
  readonly serverParameters = new Map<string, string>();
  processId = 0;
  secretKey = 0;
  txStatus: number = TxStatus.Idle;

  private state: ConnectionState = "connecting";
  /**
   * True while the connection is still usable for new commands. False after
   * `end()`, transport errors, or any protocol-level fatal — pool release paths
   * read this to decide between returning the connection to idle and dropping it.
   */
  get isUsable(): boolean {
    return this.state === "ready" || this.state === "busy";
  }
  private readonly writer = new MessageWriter();
  /** @internal — accessed by ExtQueryCommand's step() in the same module. */
  readonly reader = new MessageReader();
  /** Per-connection LRU of SQL → "this connection has Parse'd this server-side". */
  private readonly prepared: PreparedCache;
  /** Set when `preparedCacheSize: 0` was passed; treated as forceFresh on every call. */
  private preparedDisabled = false;
  private negotiationWaiter: NegotiationWaiter | null = null;
  /**
   * Single-message waiter for the cursor / handshake / simple-query paths.
   * Pipelined `extQuery` calls go through {@link commandQueue} instead.
   */
  private messageWaiter: MessageWaiter | null = null;
  /**
   * In-flight pipelined commands, FIFO. The drain loop dispatches each
   * incoming framed message to the head's `step()`; when it returns true the
   * head is shifted off and the next command takes over. Multiple `extQuery`
   * calls in the same microtask coalesce their writes into one socket.write
   * via {@link scheduleFlush}; their responses are consumed in send order.
   */
  private readonly commandQueue: PipelinedCommand[] = [];
  /** When non-null, a microtask is already scheduled to flush the writer. */
  private pendingFlush: Promise<void> | null = null;
  private closeError: Error | null = null;

  // Hook references captured at construction. The hot-path firing site is
  // `if (this.onX !== undefined) { … allocate event …; this.onX(event); }`,
  // so connections without hooks pay only a single property compare per query.
  private readonly onQuery: OnQuery | undefined;
  private readonly onError: OnError | undefined;
  private readonly onNotice: OnNotice | undefined;
  private readonly onNotification: OnNotification | undefined;

  private constructor(
    private readonly transport: Transport,
    private readonly crypto: CryptoProvider,
    /** @internal — accessed by ExtQueryCommand's row decoder in the same module. */
    readonly codecs: CodecRegistry,
    private readonly options: ConnectOptions,
  ) {
    this.onQuery = options.onQuery;
    this.onError = options.onError;
    this.onNotice = options.onNotice;
    this.onNotification = options.onNotification;
    // `0` is a valid disable signal — pass through, PreparedCache itself
    // would reject it, so coerce that case to a unit cache-size fallback that
    // never persists anything.
    const cacheSize = options.preparedCacheSize ?? 100;
    this.prepared = new PreparedCache(cacheSize > 0 ? cacheSize : 1);
    if (cacheSize === 0) {
      // 1-entry cache where we never hit, in effect: callers force-fresh on
      // every query. Cheaper than special-casing the disable path everywhere.
      this.preparedDisabled = true;
    }
    transport.onData((chunk) => this.onTransportData(chunk));
    transport.onError((err) => this.onTransportError(err));
    transport.onClose(() => this.onTransportClose());
  }

  // ────────────────────────────────────────────────────────────────────────
  // Lifecycle

  static async connect(options: ConnectOptions): Promise<Connection> {
    const transport = await connectTcp(options.host, options.port);
    const conn = new Connection(
      transport,
      options.crypto ?? nodeCryptoProvider,
      options.codecs ?? getDefaultRegistry(),
      options,
    );
    try {
      await conn.handshake();
      if (options.onConnect !== undefined) {
        // The hook may issue queries; we don't return the connection until it
        // resolves. If it throws, tear down — the user expects a connection
        // that's already been initialised, or no connection at all.
        await options.onConnect(conn);
      }
    } catch (err) {
      transport.destroy();
      throw err;
    }
    return conn;
  }

  /**
   * Send Terminate and half-close. Resolves once the transport reports closure.
   * Idempotent.
   */
  async end(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return;
    this.state = "closing";
    try {
      this.writer.writeTerminate();
      await this.flush();
    } catch {
      // Best-effort: the server may have already gone away.
    }
    this.transport.end();
    this.state = "closed";
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public query API

  /**
   * Simple-query (`Q`) path. The whole SQL string is sent unparameterised; the
   * server replies in text format. Useful for DDL and quick one-off queries.
   * For parameterised queries prefer {@link extQuery}.
   */
  query<R = Row>(sql: string, options?: QueryOptions): Promise<QueryResult<R>> {
    return this.runQuery<R>(sql, [], options, () => {
      this.writer.writeQuery(sql);
    });
  }

  /**
   * Extended-query path. One pipelined batch: Parse + Bind + Describe(portal)
   * + Execute + Sync — single round-trip. Parameter types are inferred from
   * the JS values; result rows are decoded via the codec registry.
   *
   * Result format is text for every column in this slice — binary lands when
   * the prepared cache motivates Describe-statement up front.
   */
  async extQuery<R = Row>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
    options?: QueryOptions,
  ): Promise<QueryResult<R>> {
    // Up to two attempts: the second only fires on auto-reprepare-eligible
    // errors (cached plan invalidated by DDL, or the server forgot the name).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.runExtQueryOnce<R>(sql, params, options, attempt > 0);
      } catch (err) {
        if (attempt === 0 && shouldRepreparedRetry(err)) {
          // Cached plan is stale or the server-side name doesn't exist (often
          // after a `DEALLOCATE` or a schema migration mid-session). Drop the
          // cache entry; the next attempt will re-Parse from scratch.
          this.prepared.forget(sql);
          continue;
        }
        throw err;
      }
    }
    // Unreachable: the loop returns or throws on every iteration.
    throw new ProtocolError("extQuery: exhausted retry loop");
  }

  /**
   * Single-attempt extQuery: synchronously encode Parse/Bind/Describe/Execute/
   * Sync into the shared writer, push a {@link ExtQueryCommand} onto the
   * pipelined queue, schedule a microtask flush (multiple concurrent calls
   * coalesce into one socket.write), then await the command's promise.
   *
   * The connection's state machine accepts new pipelined commands while the
   * connection is `ready` (queue was empty) or `pipelining` (queue had work).
   * The cursor / handshake / simple-query paths take exclusive ownership of
   * the connection — they reject if the queue is non-empty, and the queue
   * model rejects if `state === "busy"` (cursor currently holds the slot).
   */
  private runExtQueryOnce<R>(
    sql: string,
    params: ReadonlyArray<unknown>,
    options: QueryOptions | undefined,
    forceFresh: boolean,
  ): Promise<QueryResult<R>> {
    if (this.state !== "ready" && this.state !== "pipelining") {
      return Promise.reject(
        new ConnectionError(`connection not ready (state=${this.state})`),
      );
    }
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }

    // Synchronously encode the messages so concurrent calls in the same tick
    // share one writer buffer, one microtask, one socket.write.
    const { entry } = this.encodeExtQuery(sql, params, forceFresh);

    // Sample the clock only when somebody's listening — Date.now() is cheap
    // but not free, and we promise zero hook-related overhead when off.
    const startMs =
      this.onQuery !== undefined || this.onError !== undefined ? Date.now() : 0;

    const cmd = new ExtQueryCommand<R>(sql, params, startMs, entry);
    let abortHandler: (() => void) | null = null;
    if (options?.signal !== undefined) {
      abortHandler = (): void => {
        // Don't await — the in-flight Execute will surface 57014 naturally.
        void this.cancel();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    this.commandQueue.push(cmd);
    this.state = "pipelining";

    // Kick off the coalesced flush. Concurrent extQuery calls in the same
    // microtask all see `pendingFlush !== null` and join the same flush.
    void this.scheduleFlush().catch((err) => {
      // If the actual write to the transport failed, fail every queued
      // command — the connection is poisoned at this point.
      this.fatal(err instanceof Error ? err : new ConnectionError(String(err)));
    });

    return cmd.promise.finally(() => {
      if (abortHandler !== null && options?.signal !== undefined) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    });
  }

  /**
   * Build the Parse/Bind/Describe/Execute/Sync (or just Bind/.../Sync on a
   * cache hit) frames for one execution. Pure I/O staging — runs synchronously
   * inside `runQuery`'s encode callback so timing/observability wraps it.
   *
   * `forceFresh` is set on the auto-reprepare retry path: even if the cache
   * happened to refill between attempts, treat as miss and re-Parse.
   */
  private encodeExtQuery(
    sql: string,
    params: ReadonlyArray<unknown>,
    forceFresh: boolean,
  ): { entry: PreparedEntry } {
    const paramOids: number[] = new Array(params.length);
    const paramBytes: Array<Uint8Array | null> = new Array(params.length);
    for (let i = 0; i < params.length; i++) {
      const encoded = encodeParam(params[i], this.codecs);
      paramOids[i] = encoded.oid;
      paramBytes[i] = encoded.bytes;
    }
    // length-1 format array: applies to every parameter (text in this slice).
    const paramFormats = params.length === 0 ? [] : [Format.Text];

    const { name: stmtName, entry } = this.ensurePrepared(
      sql,
      paramOids,
      forceFresh || this.preparedDisabled,
    );

    // Result formats are per-column when the cache already knows the OIDs
    // (i.e. a previous run filled `entry.resultOids`); otherwise we send the
    // length-1 text default and the row decoder paths the response as text.
    // This is the binary-format fast path: int/float/bool/uuid/timestamp/
    // bytea avoid the text codec entirely on the second call onward.
    const resultFormats = computeResultFormats(entry.resultOids, this.codecs);

    this.writer.writeBind({
      portal: "",
      statement: stmtName,
      paramFormats,
      params: paramBytes,
      resultFormats,
    });
    this.writer.writeDescribe(StatementOrPortal.Portal, "");
    this.writer.writeExecute("", 0);
    this.writer.writeSync();
    return { entry };
  }

  /**
   * Look up `sql` in the prepared cache. On hit: bumps it to MRU and returns
   * the existing entry. On miss: writes Parse for the new statement (and a
   * Close-statement for whatever LRU entry got evicted, so the server doesn't
   * accumulate stale plans), then returns the freshly-allocated entry.
   */
  private ensurePrepared(
    sql: string,
    paramOids: readonly number[],
    forceFresh: boolean,
  ): { name: string; entry: PreparedEntry } {
    const name = PreparedCache.nameFor(sql);
    if (!forceFresh) {
      const hit = this.prepared.bump(sql);
      if (hit !== null) return { name, entry: hit };
    } else {
      // Re-add will treat it as a miss whether or not the entry exists.
      this.prepared.forget(sql);
    }
    const { entry, evicted } = this.prepared.add(sql);
    if (evicted !== null) {
      // Fire-and-forget close — included in the same Sync round-trip as the
      // Parse below, so no extra latency. CloseComplete arrives before the
      // ParseComplete for the new statement.
      this.writer.writeClose(
        StatementOrPortal.Statement,
        PreparedCache.nameFor(evicted),
      );
    }
    this.writer.writeParse(name, sql, paramOids);
    return { name, entry };
  }

  /**
   * Best-effort query cancellation. Opens a side TCP connection, sends a
   * `CancelRequest` carrying the BackendKeyData captured during handshake,
   * then closes. The in-flight query naturally errors with SQLSTATE 57014
   * (QueryCanceled) on the main connection — the cancel itself never blocks
   * and never throws back to the caller (best-effort by protocol).
   *
   * Threaded automatically when callers pass `{ signal }` to query/extQuery.
   */
  async cancel(): Promise<void> {
    if (this.processId === 0 || this.secretKey === 0) {
      // Not far enough through handshake; cancel is meaningless.
      return;
    }
    let sideTransport: Transport | null = null;
    try {
      sideTransport = await connectTcp(this.options.host, this.options.port);
      const sideWriter = new MessageWriter();
      sideWriter.writeCancelRequest(this.processId, this.secretKey);
      // Copy out before sending — sideWriter is single-use here, but the same
      // safety pattern as the main flush() since we may end() before the write
      // promise resolves on slow networks.
      await sideTransport.write(sideWriter.bytes().slice());
    } catch {
      // best-effort
    } finally {
      sideTransport?.end();
    }
  }

  /**
   * Portal-based cursor. Yields up to `batchSize` rows per iteration; drives
   * the protocol with a Parse/Bind/Describe/Execute(N)/Sync prologue, then
   * Execute(N)/Sync per subsequent batch until the server reports
   * `CommandComplete`. The connection stays in a busy state for the entire
   * cursor's lifetime — concurrent queries on the same connection are
   * rejected.
   *
   * Cleanup is in a `finally` so abandoning the iterator (`break`, `throw`,
   * `return()`) closes the portal cleanly and returns the connection to the
   * `ready` state. AbortSignal is supported the same way as query/extQuery.
   */
  async *cursor<R = Row>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
    batchSize = 100,
    options?: QueryOptions,
  ): AsyncGenerator<R[], void, undefined> {
    if (batchSize < 1) {
      throw new RangeError(`cursor: batchSize must be >= 1, got ${batchSize}`);
    }
    if (this.state !== "ready") {
      throw new ConnectionError(`connection not ready (state=${this.state})`);
    }
    options?.signal?.throwIfAborted();
    this.state = "busy";

    // Same encode dance as extQuery; kept inline so we don't pre-allocate
    // anything when callers don't actually use cursors.
    const paramOids: number[] = new Array(params.length);
    const paramBytes: Array<Uint8Array | null> = new Array(params.length);
    for (let i = 0; i < params.length; i++) {
      const encoded = encodeParam(params[i], this.codecs);
      paramOids[i] = encoded.oid;
      paramBytes[i] = encoded.bytes;
    }
    const paramFormats = params.length === 0 ? [] : [Format.Text];
    const resultFormats = [Format.Text];

    let abortHandler: (() => void) | null = null;
    if (options?.signal !== undefined) {
      abortHandler = (): void => {
        void this.cancel();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    // The portal is "open" as soon as the server has accepted Bind. Until then
    // there's nothing to clean up. After CommandComplete or any ErrorResponse
    // the server has already closed it implicitly — clearing the flag avoids
    // a redundant Close in cleanup.
    //
    // Cursor fetches intentionally use Flush between batches, not Sync. Sync
    // ends the implicit transaction, which closes the portal before the next
    // Execute can fetch another batch.
    const portal = `pg_rocket_cursor_${this.id}`;
    let portalOpen = false;
    let rowDecoder: RowDecoder | null = null;

    try {
      this.writer.writeParse("", sql, paramOids);
      this.writer.writeBind({
        portal,
        statement: "",
        paramFormats,
        params: paramBytes,
        resultFormats,
      });
      this.writer.writeDescribe(StatementOrPortal.Portal, portal);
      this.writer.writeExecute(portal, batchSize);
      this.writer.writeFlush();
      await this.flush();
      portalOpen = true;

      while (true) {
        const batch: R[] = [];
        let suspended = false;
        let completed = false;
        let pendingError: PgError | null = null;

        // Drain one fetch response. With Flush, the server stops at either
        // PortalSuspended, CommandComplete, or ErrorResponse; ReadyForQuery
        // only arrives after we explicitly send Sync.
        while (!suspended && !completed && pendingError === null) {
          const msg = await this.awaitMessage();
          switch (msg.kind) {
            case BackendKind.ParseComplete:
            case BackendKind.BindComplete:
            case BackendKind.CloseComplete:
            case BackendKind.NoData:
            case BackendKind.ParameterDescription:
            case BackendKind.EmptyQueryResponse:
              break;
            case BackendKind.RowDescription:
              rowDecoder = parseRowDescription(
                this.reader.bytes,
                this.reader.view,
                msg.offset,
                this.codecs,
              );
              break;
            case BackendKind.DataRow: {
              if (rowDecoder === null) {
                const err = new ProtocolError("DataRow before RowDescription");
                this.fatal(err);
                throw err;
              }
              batch.push(
                decodeRow(
                  this.reader.bytes,
                  this.reader.view,
                  msg.offset,
                  rowDecoder,
                ) as R,
              );
              break;
            }
            case BackendKind.PortalSuspended:
              suspended = true;
              break;
            case BackendKind.CommandComplete:
              completed = true;
              break;
            case BackendKind.ErrorResponse:
              pendingError = decodeErrorResponse(
                this.reader.bytes,
                msg.offset,
                msg.length,
              );
              // The server's implicit transaction is now in a failed state.
              // Send Sync below to recover to ReadyForQuery before throwing.
              portalOpen = false;
              break;
            default: {
              const err = new ProtocolError(
                `cursor: unexpected message 0x${msg.kind.toString(16).padStart(2, "0")}`,
              );
              this.fatal(err);
              throw err;
            }
          }
        }

        if (pendingError !== null) {
          await this.syncCursorToReady();
          throw pendingError;
        }

        if (completed) {
          portalOpen = false;
          await this.syncCursorToReady();
        }

        if (batch.length > 0) {
          // The yield is the suspension point — if the consumer breaks/throws
          // here, control jumps to the finally block and we run portal cleanup.
          yield batch;
        }

        if (completed) {
          break;
        }
        if (!suspended) {
          // Defensive: every Execute(batchSize) reply must end in either
          // PortalSuspended or CommandComplete (or ErrorResponse). Anything else
          // means our state machine and the server's are out of sync.
          const err = new ProtocolError(
            "cursor: stream ended without PortalSuspended or CommandComplete",
          );
          this.fatal(err);
          throw err;
        }

        // Request the next batch.
        this.writer.writeExecute(portal, batchSize);
        this.writer.writeFlush();
        await this.flush();
      }
    } finally {
      // Cleanup runs on normal completion (no-op since portalOpen is false),
      // on iterator return()/throw() (need to send Close + Sync), and on errors.
      if (portalOpen) {
        try {
          this.writer.writeClose(StatementOrPortal.Portal, portal);
          this.writer.writeSync();
          await this.flush();
          // Drain CloseComplete + ReadyForQuery; ignore any leftover acks.
          while (true) {
            const msg = await this.awaitMessage();
            if (msg.kind === BackendKind.ReadyForQuery) {
              this.txStatus = this.reader.bytes[msg.offset] as number;
              break;
            }
          }
          this.state = "ready";
        } catch (err) {
          // Cleanup itself failed — connection is suspect. Mark it errored so
          // the pool drops it on next release.
          this.fatal(
            err instanceof Error
              ? new ConnectionError(err.message, { cause: err })
              : new ConnectionError("cursor cleanup failed"),
          );
        }
      }
      if (abortHandler !== null && options?.signal !== undefined) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  private async syncCursorToReady(): Promise<void> {
    this.writer.writeSync();
    await this.flush();
    while (true) {
      const msg = await this.awaitMessage();
      if (msg.kind === BackendKind.ReadyForQuery) {
        this.txStatus = this.reader.bytes[msg.offset] as number;
        this.state = "ready";
        return;
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // COPY
  //
  // Both directions piggy-back on the simple-query path: we send Q with the
  // COPY SQL and the server replies with CopyInResponse / CopyOutResponse,
  // entering the COPY substate. From there the server only accepts CopyData /
  // CopyDone / CopyFail from us; we only see CopyData / CopyDone (out) or
  // CommandComplete (in) from it. Either side can interrupt with an
  // ErrorResponse; in all cases the round-trip ends with ReadyForQuery.

  /**
   * Begin a `COPY ... FROM STDIN`. Sends the SQL, waits for the server to
   * confirm with `CopyInResponse`, then returns a controller the caller drives
   * with `write(chunk) / end() / fail()`. The connection stays in `busy` for
   * the lifetime of the controller — concurrent queries on this connection
   * are rejected.
   *
   * If the SQL is not a `COPY ... FROM STDIN` (or the server rejects it), the
   * promise rejects with the server's `PgError` after draining to
   * `ReadyForQuery`. The connection returns to `ready`.
   */
  async copyIn(sql: string, options?: QueryOptions): Promise<CopyInController> {
    if (this.state !== "ready") {
      throw new ConnectionError(`connection not ready (state=${this.state})`);
    }
    options?.signal?.throwIfAborted();
    this.state = "busy";

    const startMs =
      this.onQuery !== undefined || this.onError !== undefined ? Date.now() : 0;
    let abortHandler: (() => void) | null = null;
    if (options?.signal !== undefined) {
      abortHandler = (): void => {
        void this.cancel();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      this.writer.writeQuery(sql);
      await this.flush();

      let pendingError: PgError | null = null;
      // Drain until either CopyInResponse (the happy path) or
      // ReadyForQuery (the SQL wasn't a COPY FROM STDIN, or it errored).
      while (true) {
        const msg = await this.awaitMessage();
        switch (msg.kind) {
          case BackendKind.CopyInResponse:
            return new CopyInController(
              this,
              sql,
              startMs,
              options?.signal,
              abortHandler,
            );
          case BackendKind.ErrorResponse:
            pendingError = decodeErrorResponse(
              this.reader.bytes,
              msg.offset,
              msg.length,
            );
            break;
          case BackendKind.ReadyForQuery: {
            this.txStatus = this.reader.bytes[msg.offset] as number;
            this.state = "ready";
            if (pendingError !== null) {
              this.fireQueryError(sql, [], startMs, pendingError);
              throw pendingError;
            }
            // No error, no CopyInResponse — the SQL produced normal results.
            throw new ConnectionError(
              "copyIn: server did not enter COPY IN mode (SQL was not COPY FROM STDIN)",
            );
          }
          default:
            // RowDescription, DataRow, CommandComplete, CopyOutResponse, etc.
            // The server is clearly answering a different shape of query;
            // keep draining to ReadyForQuery so we can recover cleanly.
            break;
        }
      }
    } catch (err) {
      if (abortHandler !== null && options?.signal !== undefined) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      // If we tore down before reaching the controller, restore ready state
      // (drainToReady sets it; only ConnectionError-on-not-ready leaves busy).
      if (this.state === "busy") {
        this.state = "ready";
      }
      throw err;
    }
  }

  /**
   * Run a `COPY ... TO STDOUT`. Yields the raw `CopyData` payloads exactly as
   * the server framed them — text or binary format, depending on the SQL.
   * Returns the final `QueryResult` (rowCount + command) once the round-trip
   * settles on `ReadyForQuery`.
   *
   * Iterating to completion drains naturally. Abandoning the iterator (`break`,
   * `throw`, `return()`, `await using`) sends `CopyFail` if we're still in the
   * COPY substate, then drains to `ReadyForQuery` so the connection can be
   * reused.
   */
  async *copyOut(
    sql: string,
    options?: QueryOptions,
  ): AsyncGenerator<Uint8Array, QueryResult, undefined> {
    if (this.state !== "ready") {
      throw new ConnectionError(`connection not ready (state=${this.state})`);
    }
    options?.signal?.throwIfAborted();
    this.state = "busy";

    const startMs =
      this.onQuery !== undefined || this.onError !== undefined ? Date.now() : 0;
    let abortHandler: (() => void) | null = null;
    if (options?.signal !== undefined) {
      abortHandler = (): void => {
        void this.cancel();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    let copyMode = false; // true while server is in CopyOut substate
    let needRecovery = true; // false once we've drained to ReadyForQuery cleanly
    let commandTag = "";
    let pendingError: PgError | null = null;

    try {
      this.writer.writeQuery(sql);
      await this.flush();

      while (true) {
        const msg = await this.awaitMessage();
        switch (msg.kind) {
          case BackendKind.CopyOutResponse:
            copyMode = true;
            break;
          case BackendKind.CopyData: {
            // Slice copies out of the reader's buffer — the buffer can be
            // compacted/reused once the next message is requested.
            const slice = this.reader.bytes.slice(
              msg.offset,
              msg.offset + msg.length,
            );
            // The yield is a suspension point; if the consumer breaks/throws,
            // the outer finally runs the cleanup path.
            yield slice;
            break;
          }
          case BackendKind.CopyDone:
            copyMode = false;
            break;
          case BackendKind.CommandComplete:
            commandTag = readCString(
              this.reader.bytes,
              msg.offset,
              msg.offset + msg.length,
            ).value;
            break;
          case BackendKind.ErrorResponse:
            pendingError = decodeErrorResponse(
              this.reader.bytes,
              msg.offset,
              msg.length,
            );
            copyMode = false;
            break;
          case BackendKind.ReadyForQuery: {
            this.txStatus = this.reader.bytes[msg.offset] as number;
            this.state = "ready";
            needRecovery = false;
            if (pendingError !== null) {
              this.fireQueryError(sql, [], startMs, pendingError);
              throw pendingError;
            }
            const { command, rowCount } = parseCommandTag(commandTag);
            this.fireQuerySuccess(sql, [], startMs, rowCount, command);
            return { rows: [] as never[], rowCount, command };
          }
          default:
            // RowDescription / DataRow shouldn't normally appear in a COPY OUT
            // exchange; tolerate and keep draining.
            break;
        }
      }
    } finally {
      if (needRecovery) {
        // Generator was abandoned — break out of the COPY substate (if still
        // active) and drain to ReadyForQuery so the connection is reusable.
        try {
          if (copyMode) {
            this.writer.writeCopyFail("copyOut aborted by client");
            await this.flush();
          }
          while (true) {
            const msg = await this.awaitMessage();
            if (msg.kind === BackendKind.ReadyForQuery) {
              this.txStatus = this.reader.bytes[msg.offset] as number;
              this.state = "ready";
              break;
            }
          }
        } catch (err) {
          this.fatal(
            err instanceof Error
              ? new ConnectionError(err.message, { cause: err })
              : new ConnectionError("copyOut cleanup failed"),
          );
        }
      }
      if (abortHandler !== null && options?.signal !== undefined) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  /** @internal — CopyInController push path. */
  async _copyPushData(data: Uint8Array): Promise<void> {
    this.writer.writeCopyData(data);
    await this.flush();
  }

  /**
   * @internal — CopyInController.end() path. Writes CopyDone, then drains
   * CommandComplete + ReadyForQuery. Returns the parsed result; throws if
   * the server replied with ErrorResponse instead of CommandComplete.
   */
  async _copyEnd(sql: string, startMs: number): Promise<QueryResult> {
    this.writer.writeCopyDone();
    await this.flush();
    return this._copyDrainTrailer(sql, startMs);
  }

  /**
   * @internal — CopyInController.fail() path. Writes CopyFail, drains the
   * resulting ErrorResponse + ReadyForQuery. The PgError is *not* thrown —
   * the caller chose to abort; we still surface it as the return value so
   * tests/observability can see what we actually told the server.
   */
  async _copyFail(
    sql: string,
    startMs: number,
    message: string,
  ): Promise<PgError | null> {
    this.writer.writeCopyFail(message);
    await this.flush();
    let err: PgError | null = null;
    while (true) {
      const msg = await this.awaitMessage();
      switch (msg.kind) {
        case BackendKind.ErrorResponse:
          err = decodeErrorResponse(this.reader.bytes, msg.offset, msg.length);
          break;
        case BackendKind.ReadyForQuery:
          this.txStatus = this.reader.bytes[msg.offset] as number;
          this.state = "ready";
          if (err !== null) {
            this.fireQueryError(sql, [], startMs, err);
          }
          return err;
        default:
          break;
      }
    }
  }

  private async _copyDrainTrailer(
    sql: string,
    startMs: number,
  ): Promise<QueryResult> {
    let commandTag = "";
    let pendingError: PgError | null = null;
    while (true) {
      const msg = await this.awaitMessage();
      switch (msg.kind) {
        case BackendKind.CommandComplete:
          commandTag = readCString(
            this.reader.bytes,
            msg.offset,
            msg.offset + msg.length,
          ).value;
          break;
        case BackendKind.ErrorResponse:
          pendingError = decodeErrorResponse(
            this.reader.bytes,
            msg.offset,
            msg.length,
          );
          break;
        case BackendKind.ReadyForQuery: {
          this.txStatus = this.reader.bytes[msg.offset] as number;
          this.state = "ready";
          if (pendingError !== null) {
            this.fireQueryError(sql, [], startMs, pendingError);
            throw pendingError;
          }
          const { command, rowCount } = parseCommandTag(commandTag);
          this.fireQuerySuccess(sql, [], startMs, rowCount, command);
          return { rows: [] as never[], rowCount, command };
        }
        default:
          break;
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shared dispatch

  private async runQuery<R>(
    sql: string,
    params: ReadonlyArray<unknown>,
    options: QueryOptions | undefined,
    encode: () => void,
  ): Promise<QueryResult<R>> {
    if (this.state !== "ready") {
      throw new ConnectionError(`connection not ready (state=${this.state})`);
    }
    options?.signal?.throwIfAborted();
    this.state = "busy";

    // Only sample the clock when somebody's listening — Date.now() is cheap
    // but not free, and we promise zero hook-related overhead when off.
    const startMs =
      this.onQuery !== undefined || this.onError !== undefined ? Date.now() : 0;

    encode();

    let abortHandler: (() => void) | null = null;
    if (options?.signal !== undefined) {
      abortHandler = (): void => {
        // Don't await — the in-flight query will surface 57014 naturally.
        void this.cancel();
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      await this.flush();
      const result = await this.consumeUntilReady<R>();
      if (this.onQuery !== undefined) {
        this.onQuery({
          sql,
          params,
          durationMs: Date.now() - startMs,
          rowCount: result.rowCount,
          command: result.command,
          connectionId: this.id,
        });
      }
      return result;
    } catch (err) {
      if (this.onError !== undefined) {
        this.onError({
          error: err as Error,
          sql,
          params,
          durationMs: Date.now() - startMs,
          connectionId: this.id,
        });
      }
      throw err;
    } finally {
      if (abortHandler !== null && options?.signal !== undefined) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shared response handling

  private async consumeUntilReady<R>(): Promise<QueryResult<R>> {
    let rowDecoder: RowDecoder | null = null;
    const rows: R[] = [];
    let commandTag = "";
    let pendingError: PgError | null = null;

    while (true) {
      const msg = await this.awaitMessage();
      switch (msg.kind) {
        // Acks with no body we care about.
        case BackendKind.ParseComplete:
        case BackendKind.BindComplete:
        case BackendKind.CloseComplete:
        case BackendKind.NoData:
        case BackendKind.ParameterDescription:
        case BackendKind.PortalSuspended:
        case BackendKind.EmptyQueryResponse:
          break;
        case BackendKind.RowDescription:
          rowDecoder = parseRowDescription(
            this.reader.bytes,
            this.reader.view,
            msg.offset,
            this.codecs,
          );
          break;
        case BackendKind.DataRow: {
          if (rowDecoder === null) {
            const err = new ProtocolError("DataRow before RowDescription");
            this.fatal(err);
            throw err;
          }
          rows.push(
            decodeRow(
              this.reader.bytes,
              this.reader.view,
              msg.offset,
              rowDecoder,
            ) as R,
          );
          break;
        }
        case BackendKind.CommandComplete:
          commandTag = readCString(
            this.reader.bytes,
            msg.offset,
            msg.offset + msg.length,
          ).value;
          break;
        case BackendKind.ErrorResponse:
          pendingError = decodeErrorResponse(
            this.reader.bytes,
            msg.offset,
            msg.length,
          );
          break;
        case BackendKind.ReadyForQuery: {
          this.txStatus = this.reader.bytes[msg.offset] as number;
          this.state = "ready";
          if (pendingError !== null) throw pendingError;
          const { command, rowCount } = parseCommandTag(commandTag);
          return { rows, rowCount, command };
        }
        default: {
          // CopyInResponse / CopyOutResponse / etc. fall here. The connection's
          // state is now indeterminate — bail and force the caller to reconnect.
          const err = new ProtocolError(
            `unexpected message: 0x${msg.kind.toString(16).padStart(2, "0")}`,
          );
          this.fatal(err);
          throw err;
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Handshake

  private async handshake(): Promise<void> {
    await this.maybeUpgradeTls();
    await this.startup();
  }

  private async maybeUpgradeTls(): Promise<void> {
    const tlsConfig = this.normaliseTlsConfig();
    if (tlsConfig.mode === "disable") return;

    this.state = "negotiating-tls";
    this.writer.writeSslRequest();
    await this.flush();

    const reply = await this.awaitNegotiationByte();
    if (reply === 0x53 /* 'S' */) {
      if (this.transport.upgradeTls === undefined) {
        throw new ConnectionError(
          "server agreed to TLS but transport does not support upgrade",
        );
      }
      await this.transport.upgradeTls({
        servername: tlsConfig.servername ?? this.options.host,
        ca: tlsConfig.ca,
        cert: tlsConfig.cert,
        key: tlsConfig.key,
        rejectUnauthorized: tlsConfig.rejectUnauthorized,
      });
    } else if (reply === 0x4e /* 'N' */) {
      if (tlsConfig.mode === "require") {
        throw new ConnectionError(
          "server does not support TLS but mode='require'",
        );
      }
      // Continue without TLS.
    } else {
      throw new ProtocolError(
        `unexpected SSL negotiation reply: 0x${reply.toString(16).padStart(2, "0")}`,
      );
    }
  }

  private normaliseTlsConfig(): TlsOptions & { mode: TlsMode } {
    const tls = this.options.tls;
    if (tls === undefined) return { mode: "prefer" };
    if (typeof tls === "string") return { mode: tls };
    return tls;
  }

  private async startup(): Promise<void> {
    this.state = "authenticating";
    const params: Record<string, string> = {
      user: this.options.user,
      database: this.options.database,
      application_name: this.options.applicationName ?? "pg-rocket",
      client_encoding: "UTF8",
    };
    this.writer.writeStartup(params);
    await this.flush();

    while (true) {
      const msg = await this.awaitMessage();
      switch (msg.kind) {
        case BackendKind.AuthenticationRequest:
          await this.handleAuthRequest(msg);
          break;
        case BackendKind.BackendKeyData:
          this.processId = this.reader.view.getInt32(msg.offset, false);
          this.secretKey = this.reader.view.getInt32(msg.offset + 4, false);
          break;
        case BackendKind.ReadyForQuery:
          this.txStatus = this.reader.bytes[msg.offset] as number;
          this.state = "ready";
          return;
        case BackendKind.ErrorResponse: {
          const err = decodeErrorResponse(
            this.reader.bytes,
            msg.offset,
            msg.length,
          );
          throw err;
        }
        case BackendKind.NegotiateProtocolVersion:
          // Server is older / negotiating; we requested v3.0, which all supported
          // servers accept. Tolerate the message.
          break;
        default:
          throw new ProtocolError(
            `unexpected startup message: 0x${msg.kind.toString(16).padStart(2, "0")}`,
          );
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Auth

  private async handleAuthRequest(msg: BackendMessage): Promise<void> {
    const subcode = this.reader.view.getInt32(msg.offset, false);
    switch (subcode) {
      case AuthRequest.Ok:
        return;
      case AuthRequest.CleartextPassword: {
        const password = await resolvePassword(this.options.password);
        this.writer.writePasswordMessage(password);
        await this.flush();
        return;
      }
      case AuthRequest.Md5Password: {
        const salt = this.reader.bytes.slice(
          msg.offset + 4,
          msg.offset + 4 + 4,
        );
        const password = await resolvePassword(this.options.password);
        const token = await md5PasswordToken(
          this.crypto,
          this.options.user,
          password,
          salt,
        );
        this.writer.writePasswordMessage(token);
        await this.flush();
        return;
      }
      case AuthRequest.Sasl:
        await this.handleSasl(msg);
        return;
      case AuthRequest.SaslContinue:
      case AuthRequest.SaslFinal:
        // These arrive only inside handleSasl()'s nested awaits.
        throw new ProtocolError(
          `unexpected SASL subcode out of order: ${subcode}`,
        );
      default:
        throw new AuthenticationError(`unsupported auth subcode: ${subcode}`);
    }
  }

  private async handleSasl(msg: BackendMessage): Promise<void> {
    const mechanisms = readSaslMechanisms(
      this.reader.bytes,
      msg.offset + 4,
      msg.offset + msg.length,
    );
    if (!mechanisms.includes("SCRAM-SHA-256")) {
      throw new AuthenticationError(
        `server offered SASL mechanisms [${mechanisms.join(", ")}], expected SCRAM-SHA-256`,
      );
    }

    const password = await resolvePassword(this.options.password);

    const { session, result } = scram.clientFirst(this.crypto);
    this.writer.writeSaslInitialResponse(
      result.mechanism,
      result.initialResponse,
    );
    await this.flush();

    // Expect AuthenticationSASLContinue.
    const continueMsg = await this.awaitMessage();
    if (continueMsg.kind !== BackendKind.AuthenticationRequest) {
      throw new ProtocolError(
        `expected AuthenticationRequest after SASL initial, got 0x${continueMsg.kind.toString(16)}`,
      );
    }
    const continueSub = this.reader.view.getInt32(continueMsg.offset, false);
    if (continueSub !== AuthRequest.SaslContinue) {
      throw new ProtocolError(`expected SaslContinue (11), got ${continueSub}`);
    }
    const serverFirst = this.reader.bytes.subarray(
      continueMsg.offset + 4,
      continueMsg.offset + continueMsg.length,
    );

    const clientFinal = await scram.clientFinal(
      this.crypto,
      session,
      password,
      serverFirst,
    );
    this.writer.writeSaslResponse(clientFinal);
    await this.flush();

    // Expect AuthenticationSASLFinal.
    const finalMsg = await this.awaitMessage();
    if (finalMsg.kind !== BackendKind.AuthenticationRequest) {
      throw new ProtocolError(
        `expected AuthenticationRequest after SASL final, got 0x${finalMsg.kind.toString(16)}`,
      );
    }
    const finalSub = this.reader.view.getInt32(finalMsg.offset, false);
    if (finalSub !== AuthRequest.SaslFinal) {
      throw new ProtocolError(`expected SaslFinal (12), got ${finalSub}`);
    }
    const serverFinal = this.reader.bytes.subarray(
      finalMsg.offset + 4,
      finalMsg.offset + finalMsg.length,
    );
    try {
      scram.verifyServerFinal(session, serverFinal);
    } catch (err) {
      throw new AuthenticationError((err as Error).message, { cause: err });
    }
    // The next message should be AuthenticationOk; outer loop handles it.
  }

  // ────────────────────────────────────────────────────────────────────────
  // I/O plumbing

  private async flush(): Promise<void> {
    const bytes = this.writer.bytes();
    if (bytes.length === 0) return;
    // subarray view points into the writer's buffer; copy because the writer
    // may grow/reset before the transport has finished its async write.
    const copy = bytes.slice();
    this.writer.reset();
    await this.transport.write(copy);
  }

  /**
   * Microtask-deferred flush. Multiple pipelined commands that encode their
   * frames in the same tick all `await scheduleFlush()` and join the same
   * pending Promise; the microtask then issues one `socket.write` for all of
   * them. The kernel sees one segment (one TLS record over TLS), which is the
   * coalescing the design depends on.
   *
   * The pending promise is captured in a local before being cleared, then the
   * actual flush runs. New flushes that come in *after* the writer has been
   * snapshotted but before the transport.write resolves schedule a fresh
   * round, so concurrent batches are pipelined back-to-back.
   */
  private scheduleFlush(): Promise<void> {
    if (this.pendingFlush !== null) return this.pendingFlush;
    const p = Promise.resolve().then(() => {
      // Drop the reference before flushing so a new caller in the same batch
      // (post-snapshot, pre-write-resolve) can schedule another round.
      this.pendingFlush = null;
      return this.flush();
    });
    this.pendingFlush = p;
    return p;
  }

  private onTransportData(chunk: Uint8Array): void {
    this.reader.push(chunk);
    this.drain();
  }

  private onTransportError(err: Error): void {
    this.fatal(
      err instanceof ConnectionError
        ? err
        : new ConnectionError(err.message, { cause: err }),
    );
  }

  private onTransportClose(): void {
    if (this.state === "closed") return;
    if (this.closeError === null) {
      this.closeError = new ConnectionError("connection closed by peer");
    }
    this.state = "closed";
    this.failPending(this.closeError);
  }

  private fatal(err: Error): void {
    if (this.closeError !== null) return;
    this.closeError = err;
    this.state = "errored";
    this.failPending(err);
    this.transport.destroy(err);
  }

  private failPending(err: Error): void {
    if (this.negotiationWaiter !== null) {
      const w = this.negotiationWaiter;
      this.negotiationWaiter = null;
      w.reject(err);
    }
    if (this.messageWaiter !== null) {
      const w = this.messageWaiter;
      this.messageWaiter = null;
      w.reject(err);
    }
    // Reject every queued command in send-order. Each command's reject path
    // is no-op-after-settled, so this is safe to run after a per-command error.
    if (this.commandQueue.length > 0) {
      const queue = this.commandQueue.splice(0);
      for (const cmd of queue) cmd.abort(err);
    }
  }

  /**
   * @internal — pipelined dispatcher escape hatch. Equivalent to `fatal()`
   * but exposed to {@link ExtQueryCommand} so a wire-protocol violation
   * in the middle of a queue can tear the connection down without the
   * command class importing `fatal()` directly through a private getter.
   */
  fatalForPipeline(err: Error): void {
    this.fatal(err);
  }

  /** @internal — fire onQuery for a settled pipelined command. */
  fireQuerySuccess(
    sql: string,
    params: ReadonlyArray<unknown>,
    startMs: number,
    rowCount: number,
    command: string,
  ): void {
    if (this.onQuery !== undefined) {
      this.onQuery({
        sql,
        params,
        durationMs: Date.now() - startMs,
        rowCount,
        command,
        connectionId: this.id,
      });
    }
  }

  /** @internal — fire onError for a settled pipelined command. */
  fireQueryError(
    sql: string,
    params: ReadonlyArray<unknown>,
    startMs: number,
    error: Error,
  ): void {
    if (this.onError !== undefined) {
      this.onError({
        error,
        sql,
        params,
        durationMs: Date.now() - startMs,
        connectionId: this.id,
      });
    }
  }

  private drain(): void {
    // Phase 1: SSL-negotiation byte (single byte, no framing).
    if (this.negotiationWaiter !== null) {
      const b = this.reader.readNegotiationByte();
      if (b === null) return;
      const w = this.negotiationWaiter;
      this.negotiationWaiter = null;
      w.resolve(b);
    }
    // Phase 2: framed messages. Two consumers may be waiting:
    //
    //   * `messageWaiter` — single-message-at-a-time, used by handshake /
    //     simple-query / cursor. Wins when set: the underlying loop
    //     `awaitMessage()` -> step -> `awaitMessage()` requires us to
    //     stop draining after each delivery.
    //   * `commandQueue` — pipelined `extQuery` commands. When no
    //     messageWaiter is registered, drain feeds messages straight to the
    //     queue head's step() and keeps going until the queue is empty or
    //     the reader runs dry.
    while (true) {
      const msg = this.reader.next();
      if (msg === null) return;

      // Session-level messages are handled inline regardless of who's
      // waiting; neither the awaiter nor the queue head should see them.
      if (msg.kind === BackendKind.NoticeResponse) {
        if (this.onNotice !== undefined) {
          this.fireNotice(msg);
        }
        continue;
      }
      if (msg.kind === BackendKind.ParameterStatus) {
        const name = readCString(
          this.reader.bytes,
          msg.offset,
          msg.offset + msg.length,
        );
        const value = readCString(
          this.reader.bytes,
          name.next,
          msg.offset + msg.length,
        );
        this.serverParameters.set(name.value, value.value);
        continue;
      }
      if (msg.kind === BackendKind.NotificationResponse) {
        if (this.onNotification !== undefined) {
          this.fireNotification(msg);
        }
        continue;
      }

      // Single-message waiter wins. Used by handshake, simple-query,
      // cursor — paths that need to inspect each message in turn from an
      // async caller.
      if (this.messageWaiter !== null) {
        const w = this.messageWaiter;
        this.messageWaiter = null;
        w.resolve(msg);
        return;
      }

      // Pipelined command path: feed the head, advance on completion.
      if (this.commandQueue.length > 0) {
        const head = this.commandQueue[0] as PipelinedCommand;
        const done = head.step(msg, this);
        if (done) {
          this.commandQueue.shift();
          if (this.commandQueue.length === 0 && this.state === "pipelining") {
            this.state = "ready";
          }
        }
        continue;
      }

      // No waiter, no queue, but the server sent us a (non-session) message.
      // This is a wire-protocol violation; tear the connection down.
      this.fatal(
        new ProtocolError(
          `unexpected unsolicited message: 0x${msg.kind.toString(16).padStart(2, "0")}`,
        ),
      );
      return;
    }
  }

  private fireNotice(msg: BackendMessage): void {
    let severity = "";
    let message = "";
    let code = "";
    for (const f of readErrorFields(
      this.reader.bytes,
      msg.offset,
      msg.length,
    )) {
      switch (f.code) {
        case FieldCode.SeverityNonLocal:
          severity = f.value;
          break;
        case FieldCode.Severity:
          if (severity === "") severity = f.value;
          break;
        case FieldCode.Message:
          message = f.value;
          break;
        case FieldCode.Code:
          code = f.value;
          break;
        default:
          break;
      }
    }
    // Hook is checked before this method is called; the bang asserts that.
    (this.onNotice as OnNotice)({
      severity,
      message,
      code,
      connectionId: this.id,
    });
  }

  /**
   * Parse a NotificationResponse body — int32 process-id, then two C-strings
   * (channel name, payload) — and dispatch to the onNotification hook. Hook
   * presence is checked at the call site so we don't allocate the event
   * object on connections that aren't listening.
   */
  private fireNotification(msg: BackendMessage): void {
    const buf = this.reader.bytes;
    const view = this.reader.view;
    const processId = view.getInt32(msg.offset, false);
    const end = msg.offset + msg.length;
    const channel = readCString(buf, msg.offset + 4, end);
    const payload = readCString(buf, channel.next, end);
    (this.onNotification as OnNotification)({
      processId,
      channel: channel.value,
      payload: payload.value,
      connectionId: this.id,
    });
  }

  private awaitNegotiationByte(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.closeError !== null) {
        reject(this.closeError);
        return;
      }
      this.negotiationWaiter = { resolve, reject };
      this.drain();
    });
  }

  private awaitMessage(): Promise<BackendMessage> {
    return new Promise((resolve, reject) => {
      if (this.closeError !== null) {
        reject(this.closeError);
        return;
      }
      this.messageWaiter = { resolve, reject };
      this.drain();
    });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Wire body parsers (private to this module — extended-query path will
// motivate a dedicated wire.ts later).

function readSaslMechanisms(
  buf: Uint8Array,
  offset: number,
  end: number,
): string[] {
  const mechanisms: string[] = [];
  let pos = offset;
  while (pos < end) {
    const cstr = readCString(buf, pos, end);
    if (cstr.value === "") break;
    mechanisms.push(cstr.value);
    pos = cstr.next;
  }
  return mechanisms;
}

/**
 * Per-statement row decoder. Holds the column names and pre-resolved decode
 * functions so the per-DataRow inner loop is a tight {pick decoder → decode
 * → assign}. Resolving the codec once per RowDescription (not per cell) is
 * the core wide-row-scan optimisation: a 20-column × 1000-row query goes
 * from 20,000 registry lookups + megamorphic call sites to 20 lookups + a
 * stable function-call IC.
 *
 * Each entry in `decoders` is unified to the binary signature `(buf, view,
 * offset, length) → unknown`. Text codecs are wrapped to read UTF-8 inside
 * the closure; binary codecs (int/float/bool/uuid/timestamp/bytea) are
 * called directly. Unknown OIDs fall through to `identityDecoder`, which
 * returns the raw text. That keeps the inner-loop call site unconditional.
 *
 * The format choice (text vs binary) per column is decided by the server in
 * RowDescription, which itself reflects whatever `resultFormats` we passed
 * to Bind. The decoder only sees that final choice.
 */
type CellDecoder = (
  buf: Uint8Array,
  view: DataView,
  offset: number,
  length: number,
) => unknown;

interface RowDecoder {
  readonly fields: readonly FieldDescription[];
  readonly names: readonly string[];
  readonly decoders: ReadonlyArray<CellDecoder>;
}

const identityDecoder: CellDecoder = (buf, _view, offset, length) =>
  readUtf8(buf, offset, length);

function makeTextDecoder(codec: {
  decode(text: string): unknown;
}): CellDecoder {
  // One closure per column at parseRowDescription time. The codec ref is
  // captured by closure so the call site stays monomorphic on its decode.
  return (buf, _view, offset, length) =>
    codec.decode(readUtf8(buf, offset, length));
}

function makeBinaryDecoder(
  codec: NonNullable<{
    decodeBinary?: (
      buf: Uint8Array,
      view: DataView,
      offset: number,
      length: number,
    ) => unknown;
  }>,
): CellDecoder {
  // Caller has already verified decodeBinary exists; the bang here is the
  // type-system bridge.
  const fn = codec.decodeBinary as CellDecoder;
  return (buf, view, offset, length) => fn(buf, view, offset, length);
}

function parseRowDescription(
  buf: Uint8Array,
  view: DataView,
  offset: number,
  codecs: CodecRegistry,
): RowDecoder {
  const count = view.getInt16(offset, false);
  const fields: FieldDescription[] = new Array(count);
  const names: string[] = new Array(count);
  const decoders: CellDecoder[] = new Array(count);
  let pos = offset + 2;
  for (let i = 0; i < count; i++) {
    const name = readCString(buf, pos, buf.length);
    pos = name.next;
    const tableOid = view.getInt32(pos, false);
    pos += 4;
    const columnAttr = view.getInt16(pos, false);
    pos += 2;
    const dataTypeOid = view.getInt32(pos, false);
    pos += 4;
    const typeSize = view.getInt16(pos, false);
    pos += 2;
    const typeMod = view.getInt32(pos, false);
    pos += 4;
    const format = view.getInt16(pos, false);
    pos += 2;
    fields[i] = {
      name: name.value,
      tableOid,
      columnAttr,
      dataTypeOid,
      typeSize,
      typeMod,
      format,
    };
    names[i] = name.value;
    const codec = codecs.get(dataTypeOid);
    if (codec === undefined) {
      decoders[i] = identityDecoder;
    } else if (format === Format.Binary && codec.decodeBinary !== undefined) {
      decoders[i] = makeBinaryDecoder(codec);
    } else {
      decoders[i] = makeTextDecoder(codec);
    }
  }
  return { fields, names, decoders };
}

function decodeRow(
  buf: Uint8Array,
  view: DataView,
  offset: number,
  decoder: RowDecoder,
): Row {
  const count = view.getInt16(offset, false);
  const names = decoder.names;
  const decoders = decoder.decoders;
  if (count !== names.length) {
    throw new ProtocolError(
      `DataRow column count mismatch: ${count} vs ${names.length}`,
    );
  }
  let pos = offset + 2;
  const out: Row = {};
  for (let i = 0; i < count; i++) {
    const len = view.getInt32(pos, false);
    pos += 4;
    const name = names[i] as string;
    if (len === -1) {
      out[name] = null;
    } else {
      // Inline-decode: the column's pre-bound decoder reads either the UTF-8
      // text or the binary bytes directly out of the reader's buffer. Property
      // assignment uses the same name V8 saw on the previous row, so the row
      // literal stays on a stable hidden class for the duration of the query.
      out[name] = (decoders[i] as CellDecoder)(buf, view, pos, len);
      pos += len;
    }
  }
  return out;
}

/**
 * Build the result-formats array passed to Bind. On the first run of a
 * statement (`oids === null`) we fall back to the length-1 text default and
 * the server formats every column as text. On subsequent runs we expand to
 * length-N: each column requests `Binary` if its codec advertises a binary
 * decoder, else `Text`. Unknown OIDs always stay text.
 *
 * Per-column formats are slightly larger on the wire than the length-1 array,
 * but the wide-row-scan win from skipping `Number.parseInt`, `BigInt(text)`,
 * `new Date(iso)`, hex-decoding bytea, and the trailing `TextDecoder.decode`
 * call easily pays for the few bytes.
 */
function computeResultFormats(
  oids: readonly number[] | null,
  codecs: CodecRegistry,
): Format[] {
  if (oids === null) return [Format.Text];
  const out = new Array<Format>(oids.length);
  for (let i = 0; i < oids.length; i++) {
    const codec = codecs.get(oids[i] as number);
    out[i] =
      codec !== undefined && codec.decodeBinary !== undefined
        ? Format.Binary
        : Format.Text;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Parameter inference + encoding.
//
// Maps JS values to Postgres OIDs and text-format byte strings. Round-trips
// through the registry so user-installed codecs participate without
// special-casing here. Values whose JS type doesn't have an obvious Postgres
// counterpart (functions, symbols) raise a TypeError.

interface EncodedParam {
  readonly oid: number;
  readonly bytes: Uint8Array | null;
}

function encodeParam(value: unknown, codecs: CodecRegistry): EncodedParam {
  if (value === null || value === undefined) {
    return { oid: 0, bytes: null };
  }
  if (typeof value === "boolean") {
    return encodeVia(codecs, Oid.Bool, value);
  }
  if (typeof value === "number") {
    if (
      Number.isInteger(value) &&
      value >= -2147483648 &&
      value <= 2147483647
    ) {
      return encodeVia(codecs, Oid.Int4, value);
    }
    return encodeVia(codecs, Oid.Float8, value);
  }
  if (typeof value === "bigint") {
    return encodeVia(codecs, Oid.Int8, value);
  }
  if (typeof value === "string") {
    // text passes through verbatim; no codec lookup needed.
    return { oid: Oid.Text, bytes: utf8Encoder.encode(value) };
  }
  if (value instanceof Uint8Array) {
    return encodeVia(codecs, Oid.Bytea, value);
  }
  if (value instanceof Date) {
    return encodeVia(codecs, Oid.TimestampTz, value);
  }
  if (Array.isArray(value)) {
    // JS array → Postgres array. The element type is inferred from the JS
    // values: int4 / int8 / float8 / bool / text by default, with mixing
    // collapsed to text. Empty arrays default to text — Postgres can cast
    // `text[]` to anything explicit at the call site (`$1::int[]`).
    const oid = inferArrayOid(value);
    return encodeVia(codecs, oid, value);
  }
  if (typeof value === "object") {
    // Plain objects fall back to JSON; arrays were caught above.
    return encodeVia(codecs, Oid.Jsonb, value);
  }
  throw new TypeError(
    `pg-rocket: cannot encode parameter of type ${typeof value}`,
  );
}

/**
 * Pick a Postgres array OID for a JS array based on its element types.
 *
 * Walk once, tracking the dominant element kind. `null` / `undefined` entries
 * don't contribute (mixed-with-null is fine). Mixed numeric/bigint, or any
 * mix that can't be unified, falls through to `text[]` and the call site
 * handles the cast (`$1::int[]`, `$1::uuid[]`, …).
 *
 *   [1, 2, 3]      → int4[]
 *   [1.5, 2]       → float8[]   (int + float collapses to float)
 *   [1n, 2n]       → int8[]
 *   [true, false]  → bool[]
 *   ['a', 'b']     → text[]
 *   ['a', 1]       → text[]      (mixed)
 *   []             → text[]      (the cast wins on empty)
 */
function inferArrayOid(items: readonly unknown[]): number {
  let kind: "int" | "float" | "bigint" | "bool" | "string" | "mixed" | null =
    null;
  for (let i = 0; i < items.length; i++) {
    const v = items[i];
    if (v === null || v === undefined) continue;
    let k: "int" | "float" | "bigint" | "bool" | "string" | "mixed";
    if (typeof v === "boolean") k = "bool";
    else if (typeof v === "bigint") k = "bigint";
    else if (typeof v === "string") k = "string";
    else if (typeof v === "number") {
      k =
        Number.isInteger(v) && v >= -2147483648 && v <= 2147483647
          ? "int"
          : "float";
    } else {
      k = "mixed";
    }
    if (kind === null) {
      kind = k;
    } else if (kind !== k) {
      // int + float → float; everything else heterogeneous → text fallback.
      if (
        (kind === "int" && k === "float") ||
        (kind === "float" && k === "int")
      ) {
        kind = "float";
      } else {
        kind = "mixed";
        break;
      }
    }
  }
  switch (kind) {
    case "int":
      return Oid.Int4Array;
    case "float":
      return Oid.Float8Array;
    case "bigint":
      return Oid.Int8Array;
    case "bool":
      return Oid.BoolArray;
    default:
      // string / mixed / null → text[]; user can cast at the call site.
      return Oid.TextArray;
  }
}

function encodeVia(
  codecs: CodecRegistry,
  oid: number,
  value: unknown,
): EncodedParam {
  const codec = codecs.get(oid) as Codec<unknown> | undefined;
  if (codec === undefined) {
    throw new TypeError(`pg-rocket: no codec registered for OID ${oid}`);
  }
  return { oid, bytes: utf8Encoder.encode(codec.encode(value)) };
}

async function resolvePassword(
  spec: PasswordSpec | undefined,
): Promise<string> {
  if (spec === undefined) return "";
  if (typeof spec === "string") return spec;
  return await spec();
}

/**
 * Auto-reprepare trigger codes:
 *   0A000 — feature_not_supported, raised when a cached plan references
 *           something a DDL change has invalidated (e.g. dropped column).
 *   26000 — invalid_sql_statement_name, raised when the server's plan cache
 *           doesn't have the statement we referenced (manual `DEALLOCATE`,
 *           or a server restart we didn't notice).
 *
 * In both cases the fix is: forget the cache entry, retry with a fresh Parse.
 * We retry exactly once per call; if the second attempt also errors the
 * caller sees the real error.
 */
function shouldRepreparedRetry(err: unknown): boolean {
  if (!(err instanceof PgError)) return false;
  return err.code === "0A000" || err.code === "26000";
}

// ────────────────────────────────────────────────────────────────────────
// Pipelined extQuery command
//
// Encapsulates the Parse/Bind/Describe/Execute/Sync response accounting
// so the queue dispatcher can step through messages without knowing what
// kind of work is at the head. Holds the resolve/reject of the calling
// Promise; settles on ReadyForQuery (success or error) or `abort()`
// (transport-level failure).

class ExtQueryCommand<R> implements PipelinedCommand {
  readonly promise: Promise<QueryResult<R>>;
  private resolveFn!: (value: QueryResult<R>) => void;
  private rejectFn!: (err: unknown) => void;
  private rowDecoder: RowDecoder | null = null;
  private rows: R[] = [];
  private commandTag = "";
  private pendingError: PgError | null = null;
  /** True once this command has resolved/rejected — guards against double-settle. */
  private settled = false;

  constructor(
    private readonly sql: string,
    private readonly params: ReadonlyArray<unknown>,
    private readonly startMs: number,
    /**
     * The prepared-cache entry this execution is bound to. Once we observe
     * the response's RowDescription we record the column OIDs into it so
     * the *next* execution can request per-column binary result formats at
     * Bind time. Cache-disabled connections still get a transient entry
     * (the cache itself just discards it), so this is always non-null.
     */
    private readonly entry: PreparedEntry,
  ) {
    this.promise = new Promise<QueryResult<R>>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
  }

  step(msg: BackendMessage, conn: Connection): boolean {
    switch (msg.kind) {
      case BackendKind.ParseComplete:
      case BackendKind.BindComplete:
      case BackendKind.CloseComplete:
      case BackendKind.NoData:
      case BackendKind.ParameterDescription:
      case BackendKind.PortalSuspended:
      case BackendKind.EmptyQueryResponse:
        return false;
      case BackendKind.RowDescription: {
        this.rowDecoder = parseRowDescription(
          conn.reader.bytes,
          conn.reader.view,
          msg.offset,
          conn.codecs,
        );
        // Record the column OIDs in the prepared-cache entry so the *next*
        // execution of this statement can request per-column binary result
        // formats at Bind time. Only set on the first observation: once
        // resultOids is non-null, subsequent runs are already on the binary
        // fast path and the OID list cannot change without a re-Parse (which
        // would have allocated a fresh entry via auto-reprepare).
        if (this.entry.resultOids === null) {
          const decoder = this.rowDecoder;
          const oids = new Array<number>(decoder.fields.length);
          for (let i = 0; i < decoder.fields.length; i++) {
            oids[i] = (decoder.fields[i] as FieldDescription).dataTypeOid;
          }
          // PreparedEntry is intentionally readonly to callers; we mutate
          // through a write-once cast so the rest of the cache surface stays
          // immutable to consumers.
          (this.entry as { resultOids: readonly number[] }).resultOids = oids;
        }
        return false;
      }
      case BackendKind.DataRow: {
        if (this.rowDecoder === null) {
          // Server protocol error — should never happen. Force-fatal the
          // connection rather than just rejecting this command, since the
          // queue is now out of sync.
          const err = new ProtocolError("DataRow before RowDescription");
          conn.fatalForPipeline(err);
          this.reject(err);
          return true;
        }
        this.rows.push(
          decodeRow(
            conn.reader.bytes,
            conn.reader.view,
            msg.offset,
            this.rowDecoder,
          ) as R,
        );
        return false;
      }
      case BackendKind.CommandComplete:
        this.commandTag = readCString(
          conn.reader.bytes,
          msg.offset,
          msg.offset + msg.length,
        ).value;
        return false;
      case BackendKind.ErrorResponse:
        this.pendingError = decodeErrorResponse(
          conn.reader.bytes,
          msg.offset,
          msg.length,
        );
        return false;
      case BackendKind.ReadyForQuery: {
        conn.txStatus = conn.reader.bytes[msg.offset] as number;
        if (this.pendingError !== null) {
          conn.fireQueryError(
            this.sql,
            this.params,
            this.startMs,
            this.pendingError,
          );
          this.reject(this.pendingError);
        } else {
          const { command, rowCount } = parseCommandTag(this.commandTag);
          conn.fireQuerySuccess(
            this.sql,
            this.params,
            this.startMs,
            rowCount,
            command,
          );
          this.resolve({ rows: this.rows, rowCount, command });
        }
        return true;
      }
      default: {
        // Unexpected message kind. Mid-pipeline this is not recoverable —
        // the queue's send-order assumption is broken, so the whole
        // connection has to be torn down.
        const err = new ProtocolError(
          `unexpected message in pipeline: 0x${msg.kind.toString(16).padStart(2, "0")}`,
        );
        conn.fatalForPipeline(err);
        this.reject(err);
        return true;
      }
    }
  }

  abort(err: Error): void {
    this.reject(err);
  }

  private resolve(value: QueryResult<R>): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFn(value);
  }

  private reject(err: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(err);
  }
}

// ────────────────────────────────────────────────────────────────────────
// CopyIn controller — handed back from `Connection.copyIn()` once the server
// has confirmed it's in CopyIn substate. The connection stays `busy` for the
// controller's lifetime; settling (end / fail / dispose) returns it to ready.

/**
 * Driver for an in-progress `COPY ... FROM STDIN`. Built by {@link Connection.copyIn}.
 *
 *   * `write(chunk)` pushes a CopyData frame and flushes.
 *   * `end()` writes CopyDone and resolves with the QueryResult once the
 *     server reaches ReadyForQuery (throws on ErrorResponse).
 *   * `fail(message)` writes CopyFail, drains the resulting ErrorResponse +
 *     ReadyForQuery, and returns the server's error (or null in the unlikely
 *     case the server settled without one).
 *   * Disposal sends a `fail()` on best effort if the user dropped the writer
 *     without explicitly settling, so `await using` is safe to use.
 */
export class CopyInController implements AsyncDisposable {
  private settled = false;

  /** @internal — built by Connection.copyIn(). */
  constructor(
    private readonly conn: Connection,
    private readonly sql: string,
    private readonly startMs: number,
    private readonly signal: AbortSignal | undefined,
    private readonly abortHandler: (() => void) | null,
  ) {}

  /** True once `end` / `fail` / dispose has run; further writes throw. */
  get isSettled(): boolean {
    return this.settled;
  }

  /**
   * Send one `CopyData` frame. Empty chunks short-circuit (they'd produce a
   * zero-payload CopyData which the server tolerates but is wasted bandwidth).
   * Multiple writes between flushes coalesce naturally — each call awaits a
   * full flush, so for maximum throughput batch your bytes upstream.
   */
  async write(chunk: Uint8Array): Promise<void> {
    if (this.settled) {
      throw new ConnectionError("copyIn: writer already settled");
    }
    this.signal?.throwIfAborted();
    if (chunk.length === 0) return;
    await this.conn._copyPushData(chunk);
  }

  /**
   * Finish the COPY: send `CopyDone`, then wait for `CommandComplete` +
   * `ReadyForQuery`. Resolves with the COPY result (rowCount = number of
   * rows successfully ingested). If the server returned an `ErrorResponse`
   * instead, the connection drains to ReadyForQuery and the error throws.
   */
  async end(): Promise<QueryResult> {
    if (this.settled) {
      throw new ConnectionError("copyIn: writer already settled");
    }
    this.settled = true;
    try {
      return await this.conn._copyEnd(this.sql, this.startMs);
    } finally {
      this.cleanup();
    }
  }

  /**
   * Abort the COPY: send `CopyFail`, drain the server's `ErrorResponse` and
   * `ReadyForQuery`. Returns the server's `PgError` (or null if the server
   * somehow finished without one). Safe to call after `end()` — second call
   * is a no-op and returns null.
   */
  async fail(message = "copyIn aborted by client"): Promise<PgError | null> {
    if (this.settled) return null;
    this.settled = true;
    try {
      return await this.conn._copyFail(this.sql, this.startMs, message);
    } finally {
      this.cleanup();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.settled) {
      try {
        await this.fail("copyIn aborted by client");
      } catch {
        // Best-effort: if the connection died mid-fail there's nothing useful
        // to report from the dispose path; the next acquire will see a
        // non-usable connection and the pool will drop it.
      }
    }
  }

  private cleanup(): void {
    if (this.abortHandler !== null && this.signal !== undefined) {
      this.signal.removeEventListener("abort", this.abortHandler);
    }
  }
}
