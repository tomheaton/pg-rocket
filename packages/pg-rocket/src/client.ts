// `createClient` and the `Db` object — the user-facing entry point.
//
// `Db` exposes the four headline verbs from doc 0004:
//
//   db.sql`...`            — execute a parameterised query (returns Promise<Row[]>)
//   db.begin()             — open a transaction (returns Transaction, AsyncDisposable)
//   db.transaction(fn)     — callback form (commits on return, rolls back on throw)
//   db.close()             — drain and close the pool
//
// `db.with({ signal, timeout })` returns a `Db`-shaped facade that layers an
// AbortSignal and/or a per-call timeout onto every query / transaction it
// dispatches. Re-aliasing is fine: `db.with({ timeout: 1000 }).with({ signal })`
// stacks the inner signal on top of the timeout.
//
// Cursor / copy / listen will hang off this object in the next slice.
//
// `createClient` accepts either a connection-string `url` or the same fields
// individually. Either way we end up with the same {@link ConnectOptions} the
// pool feeds to {@link Connection.connect}.

import type {
  Connection,
  ConnectOptions,
  QueryOptions,
  Row,
} from "./connection/index.js";
import { ConnectionError } from "./errors.js";
import { Pool, type PoolOptions, parseConnectionString } from "./pool/index.js";
import { Fragment, materialize } from "./sql/index.js";
import {
  type BeginOptions,
  beginTransaction,
  runInTransaction,
  type Transaction,
} from "./transaction.js";

export interface CreateClientOptions {
  /** Connection string (`postgres://user:pass@host:port/db?sslmode=…`). */
  readonly url?: string;
  /** Inline alternative to `url`. Either path produces the same internal config. */
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: ConnectOptions["password"];
  readonly database?: string;
  readonly applicationName?: string;
  readonly tls?: ConnectOptions["tls"];
  readonly crypto?: ConnectOptions["crypto"];
  readonly codecs?: ConnectOptions["codecs"];
  readonly onQuery?: ConnectOptions["onQuery"];
  readonly onError?: ConnectOptions["onError"];
  readonly onNotice?: ConnectOptions["onNotice"];
  readonly onConnect?: ConnectOptions["onConnect"];
  /** Pool sizing + lifecycle. */
  readonly pool?: { readonly max?: number; readonly idleTimeoutMs?: number };
}

/** Layered options applied to every query/transaction dispatched through this Db. */
export interface DbOptions {
  /** Cancel queries when this signal fires. Combines with `timeout` if both set. */
  readonly signal?: AbortSignal | undefined;
  /** Per-query timeout (milliseconds). Internal AbortController fires after the deadline. */
  readonly timeout?: number | undefined;
}

export class Db {
  /** @internal — user code goes through `createClient`. */
  constructor(
    protected readonly pool: Pool,
    protected readonly connectOptions: ConnectOptions,
    protected readonly opts: DbOptions = {},
  ) {}

  /**
   * Layer extra options on top of this Db. Returns a new `Db`-shaped facade
   * sharing the same underlying pool — no new connections are opened. Calls
   * compose: `db.with({ timeout: 1000 }).with({ signal })` produces a Db that
   * applies both.
   */
  with(options: DbOptions): Db {
    return new Db(this.pool, this.connectOptions, {
      signal: options.signal ?? this.opts.signal,
      timeout: options.timeout ?? this.opts.timeout,
    });
  }

  /**
   * Execute a parameterised query against the pool. Acquires a connection,
   * runs the extended-query path, releases the connection — even on error.
   */
  async sql<R extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<R[]> {
    const m = materialize(new Fragment(strings, values));
    return this.runOnConnection(async (conn, queryOpts) => {
      const result = await conn.extQuery<R>(m.sql, m.params, queryOpts);
      return result.rows;
    });
  }

  /**
   * One-row variant. Throws if the query returns anything other than exactly
   * one row — saves the call site from repeated `[0]`-or-throw boilerplate.
   */
  async sqlOne<R extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<R> {
    const rows = await this.sql<R>(strings, ...values);
    if (rows.length !== 1) {
      throw new ConnectionError(`sqlOne: expected 1 row, got ${rows.length}`);
    }
    return rows[0] as R;
  }

  /**
   * Stream a query in batches. Holds a connection from the pool for the
   * lifetime of the iterator; releases it when the iterator completes or is
   * abandoned (`break`, `throw`, `return()` — `for await` handles all three).
   *
   *   for await (const batch of db.cursor<Row>(sql`select * from t`, 1000)) {
   *     for (const row of batch) process(row);
   *   }
   *
   * Layered options (`db.with({ signal, timeout })`) apply: aborting the signal
   * cancels the in-flight Execute via the side-channel CancelRequest, after
   * which the iterator throws.
   */
  async *cursor<R extends Row = Row>(
    fragment: Fragment,
    batchSize = 100,
  ): AsyncGenerator<R[], void, undefined> {
    const m = materialize(fragment);
    const { queryOpts, cleanup } = this.buildPerCallOptions();
    const conn = await this.pool.acquire();
    try {
      yield* conn.cursor<R>(m.sql, m.params, batchSize, queryOpts);
    } finally {
      this.releaseOrDestroy(conn);
      cleanup?.();
    }
  }

  /**
   * Open a transaction. Returns an AsyncDisposable — the dispose path rolls
   * back if the user didn't explicitly commit, and the function calling
   * `await using tx = ...` doesn't complete until the rollback round-trip
   * has resolved on the server.
   */
  begin(options?: BeginOptions): Promise<Transaction> {
    return beginTransaction(this.pool, options);
  }

  /**
   * Callback-form transaction. Commits on normal return, rolls back on throw.
   * The return value of `fn` is forwarded to the caller.
   */
  transaction<T>(
    fn: (tx: Transaction) => Promise<T>,
    options?: BeginOptions,
  ): Promise<T> {
    return runInTransaction(this.pool, fn, options);
  }

  /** Drain and close the pool. Idempotent. */
  async close(): Promise<void> {
    await this.pool.close();
  }

  /** @internal — escape hatch for tests / observability. Don't expose. */
  get _connectOptions(): ConnectOptions {
    return this.connectOptions;
  }

  /**
   * @internal — escape hatch for benchmarks. Bypasses the `sql` tag so callers
   * can supply raw SQL + parameters they've already produced (e.g. via fixture
   * data). Application code should use the tag instead.
   */
  async _unsafeExtQuery<R extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return this.runOnConnection(async (conn, queryOpts) => {
      const result = await conn.extQuery<R>(sql, params, queryOpts);
      return result.rows;
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // internals

  /**
   * Acquire a connection, build per-call QueryOptions (signal + timeout
   * combined), invoke `fn`, release the connection. Cleans up the timeout
   * timer in the finally block so it can't leak even if `fn` throws.
   */
  private async runOnConnection<R>(
    fn: (conn: Connection, queryOpts: QueryOptions | undefined) => Promise<R>,
  ): Promise<R> {
    const { queryOpts, cleanup } = this.buildPerCallOptions();
    const conn = await this.pool.acquire();
    try {
      return await fn(conn, queryOpts);
    } finally {
      this.releaseOrDestroy(conn);
      cleanup?.();
    }
  }

  /**
   * Return a connection to the pool, or drop it if it's no longer usable
   * (e.g. cursor cleanup failed, transport errored mid-query). Putting a
   * dead connection back into the idle list would poison the next acquire.
   */
  protected releaseOrDestroy(conn: Connection): void {
    if (conn.isUsable) {
      this.pool.release(conn);
    } else {
      this.pool.destroy(conn);
    }
  }

  private buildPerCallOptions(): {
    queryOpts: QueryOptions | undefined;
    cleanup: (() => void) | null;
  } {
    const userSignal = this.opts.signal;
    const timeoutMs = this.opts.timeout;
    if (userSignal === undefined && timeoutMs === undefined) {
      return { queryOpts: undefined, cleanup: null };
    }

    // Timeout-only: a private controller that aborts after the deadline.
    // Signal-only: pass it through unchanged.
    // Both: chain with addEventListener so the first to fire wins. We avoid
    // AbortSignal.any so the code stays portable to runtimes that haven't
    // shipped it yet.
    let signal: AbortSignal;
    let cleanup: (() => void) | null = null;

    if (timeoutMs === undefined && userSignal !== undefined) {
      signal = userSignal;
    } else {
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          ctrl.abort(
            new Error(`pg-rocket: query exceeded timeout of ${timeoutMs}ms`),
          );
        }, timeoutMs);
      }
      let userAbortHandler: (() => void) | null = null;
      if (userSignal !== undefined) {
        if (userSignal.aborted) {
          ctrl.abort(userSignal.reason);
        } else {
          userAbortHandler = (): void => ctrl.abort(userSignal.reason);
          userSignal.addEventListener("abort", userAbortHandler, {
            once: true,
          });
        }
      }
      signal = ctrl.signal;
      cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        if (userAbortHandler !== null && userSignal !== undefined) {
          userSignal.removeEventListener("abort", userAbortHandler);
        }
      };
    }

    return { queryOpts: { signal }, cleanup };
  }
}

export function createClient(options: CreateClientOptions): Db {
  const connect = resolveConnectOptions(options);
  const poolOptions: PoolOptions = { connect };
  if (options.pool?.max !== undefined) {
    (
      poolOptions as { -readonly [K in keyof PoolOptions]: PoolOptions[K] }
    ).max = options.pool.max;
  }
  if (options.pool?.idleTimeoutMs !== undefined) {
    (
      poolOptions as { -readonly [K in keyof PoolOptions]: PoolOptions[K] }
    ).idleTimeoutMs = options.pool.idleTimeoutMs;
  }
  const pool = new Pool(poolOptions);
  return new Db(pool, connect);
}

function resolveConnectOptions(options: CreateClientOptions): ConnectOptions {
  // URL parsing is the cheap path: parse once, then layer inline overrides on top.
  const fromUrl =
    options.url !== undefined ? parseConnectionString(options.url) : undefined;

  const host = options.host ?? fromUrl?.host ?? "localhost";
  const port = options.port ?? fromUrl?.port ?? 5432;
  const user = options.user ?? fromUrl?.user ?? "";
  const database = options.database ?? fromUrl?.database ?? "";
  const password = options.password ?? fromUrl?.password;
  const applicationName = options.applicationName ?? fromUrl?.applicationName;
  const tls = options.tls ?? fromUrl?.tls;

  if (user.length === 0) {
    throw new TypeError(
      "createClient: `user` is required (set it inline or in the URL)",
    );
  }
  if (database.length === 0) {
    throw new TypeError(
      "createClient: `database` is required (set it inline or in the URL)",
    );
  }

  const connect: ConnectOptions = {
    host,
    port,
    user,
    database,
    ...(password !== undefined ? { password } : {}),
    ...(applicationName !== undefined ? { applicationName } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(options.crypto !== undefined ? { crypto: options.crypto } : {}),
    ...(options.codecs !== undefined ? { codecs: options.codecs } : {}),
    ...(options.onQuery !== undefined ? { onQuery: options.onQuery } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.onNotice !== undefined ? { onNotice: options.onNotice } : {}),
    ...(options.onConnect !== undefined
      ? { onConnect: options.onConnect }
      : {}),
  };
  return connect;
}
