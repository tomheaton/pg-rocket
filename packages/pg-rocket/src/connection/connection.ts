// Connection — the v3-protocol state machine over a Transport.
//
// State transitions are driven by `ReadyForQuery` boundaries, not by counting
// individual messages, so we always agree with the server about transaction
// state. `query()` ends only when ReadyForQuery arrives, even if an
// ErrorResponse came earlier in the same exchange.
//
// What's implemented in this slice:
//   * SSL negotiation + TLS upgrade
//   * StartupMessage + ParameterStatus + BackendKeyData accumulation
//   * Auth: AuthenticationOk, CleartextPassword, MD5Password, SCRAM-SHA-256
//   * Simple-query path (Q → RowDescription/DataRow*/CommandComplete → ReadyForQuery)
//   * Graceful end() (Terminate + FIN)
//
// Deliberately not yet implemented (next layers):
//   * Extended query (Parse/Bind/Describe/Execute/Sync) and prepared cache
//   * Pipeliner (multiple commands, one coalesced write)
//   * Codecs (everything is text-format strings here)
//   * COPY, LISTEN/NOTIFY, cursors, cancellation

import {
  AuthenticationError,
  ConnectionError,
  decodeErrorResponse,
  type PgError,
  ProtocolError,
} from "../errors.js";
import { md5PasswordToken } from "../protocol/auth/md5.js";
import * as scram from "../protocol/auth/scram.js";
import { parseCommandTag, readCString, readUtf8 } from "../protocol/body.js";
import type { CryptoProvider } from "../protocol/crypto.js";
import { AuthRequest, BackendKind, TxStatus } from "../protocol/messages.js";
import { type BackendMessage, MessageReader } from "../protocol/reader.js";
import { MessageWriter } from "../protocol/writer.js";
import { nodeCryptoProvider } from "./node-crypto.js";
import { connectTcp } from "./tcp.js";
import type { TlsUpgradeOptions, Transport } from "./transport.js";

// ────────────────────────────────────────────────────────────────────────
// Public types

export type TlsMode = "disable" | "prefer" | "require";

export interface TlsOptions extends TlsUpgradeOptions {
  readonly mode: TlsMode;
}

export type PasswordSpec = string | (() => string | Promise<string>);

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
}

export type SimpleQueryRow = Record<string, string | null>;

export interface QueryResult<Row = SimpleQueryRow> {
  readonly rows: Row[];
  readonly rowCount: number;
  readonly command: string;
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
  | "closing"
  | "closed"
  | "errored";

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

export class Connection {
  // Public, observable connection-level state populated during handshake.
  readonly serverParameters = new Map<string, string>();
  processId = 0;
  secretKey = 0;
  txStatus: number = TxStatus.Idle;

  private state: ConnectionState = "connecting";
  private readonly writer = new MessageWriter();
  private readonly reader = new MessageReader();
  private negotiationWaiter: NegotiationWaiter | null = null;
  private messageWaiter: MessageWaiter | null = null;
  private closeError: Error | null = null;

  private constructor(
    private readonly transport: Transport,
    private readonly crypto: CryptoProvider,
    private readonly options: ConnectOptions,
  ) {
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
      options,
    );
    try {
      await conn.handshake();
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
  // Public query API (simple-query path only in this slice)

  async query<Row = SimpleQueryRow>(sql: string): Promise<QueryResult<Row>> {
    if (this.state !== "ready") {
      throw new ConnectionError(`connection not ready (state=${this.state})`);
    }
    this.state = "busy";

    this.writer.writeQuery(sql);
    await this.flush();

    let rowDescription: FieldDescription[] | null = null;
    const rows: Row[] = [];
    let commandTag = "";
    let pendingError: PgError | null = null;

    while (true) {
      const msg = await this.awaitMessage();
      switch (msg.kind) {
        case BackendKind.RowDescription:
          rowDescription = parseRowDescription(
            this.reader.bytes,
            this.reader.view,
            msg.offset,
          );
          break;
        case BackendKind.DataRow: {
          if (rowDescription === null) {
            this.fatal(new ProtocolError("DataRow before RowDescription"));
            throw (
              this.closeError ??
              new ProtocolError("DataRow before RowDescription")
            );
          }
          const row = parseDataRowAsObject(
            this.reader.bytes,
            this.reader.view,
            msg.offset,
            rowDescription,
          );
          rows.push(row as Row);
          break;
        }
        case BackendKind.CommandComplete:
          commandTag = readCString(
            this.reader.bytes,
            msg.offset,
            msg.offset + msg.length,
          ).value;
          break;
        case BackendKind.EmptyQueryResponse:
          // No-op: empty input string. ReadyForQuery still follows.
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
            `unexpected message in simple-query path: 0x${msg.kind.toString(16).padStart(2, "0")}`,
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
    // Phase 2: framed messages.
    while (true) {
      if (this.messageWaiter === null) return;
      const msg = this.reader.next();
      if (msg === null) return;
      // Session-level messages are handled inline; the awaiter never sees them.
      if (msg.kind === BackendKind.NoticeResponse) {
        // Notices are diagnostic; for now we just drop them. onNotice hook will be added later.
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
        // LISTEN/NOTIFY support lands later; for now we drop the message.
        continue;
      }
      const w = this.messageWaiter;
      this.messageWaiter = null;
      w.resolve(msg);
      return;
    }
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

function parseRowDescription(
  buf: Uint8Array,
  view: DataView,
  offset: number,
): FieldDescription[] {
  const count = view.getInt16(offset, false);
  const fields: FieldDescription[] = new Array(count);
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
  }
  return fields;
}

function parseDataRowAsObject(
  buf: Uint8Array,
  view: DataView,
  offset: number,
  fields: readonly FieldDescription[],
): SimpleQueryRow {
  const count = view.getInt16(offset, false);
  if (count !== fields.length) {
    throw new ProtocolError(
      `DataRow column count mismatch: ${count} vs ${fields.length}`,
    );
  }
  let pos = offset + 2;
  const out: SimpleQueryRow = {};
  for (let i = 0; i < count; i++) {
    const len = view.getInt32(pos, false);
    pos += 4;
    const field = fields[i] as FieldDescription;
    if (len === -1) {
      out[field.name] = null;
    } else {
      out[field.name] = readUtf8(buf, pos, len);
      pos += len;
    }
  }
  return out;
}

async function resolvePassword(
  spec: PasswordSpec | undefined,
): Promise<string> {
  if (spec === undefined) return "";
  if (typeof spec === "string") return spec;
  return await spec();
}
