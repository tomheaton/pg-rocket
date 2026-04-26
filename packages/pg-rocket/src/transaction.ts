// Transaction & Savepoint.
//
// Two API shapes (per doc 0004):
//
//   const tx = await db.begin();
//   await using tx = await db.begin();         // disposal rolls back if uncommitted
//   await db.transaction(async (tx) => {...}); // commits on return, rolls back on throw
//
// A Savepoint is a Transaction with `savepoint`/`release`/`rollback to` verbs
// instead of `begin`/`commit`/`rollback`. The shared `TransactionLike` base
// class holds the connection and tracks settled-state.
//
// Connection ownership: a transaction holds one connection from the pool for
// its entire lifetime. Disposal releases the connection back to the pool —
// after the rollback round-trip has completed, not before. This is the
// guarantee that makes `await using` safe to use in throwing code: the next
// statement after the disposing scope runs after the server has acknowledged
// the rollback.

import type { Connection, QueryResult, Row } from "./connection/index.js";
import { ConnectionError } from "./errors.js";
import type { Pool } from "./pool/index.js";
import { Fragment, materialize } from "./sql/index.js";

export type IsolationLevel =
  | "read uncommitted"
  | "read committed"
  | "repeatable read"
  | "serializable";

export interface BeginOptions {
  readonly isolation?: IsolationLevel;
  readonly readOnly?: boolean;
  readonly deferrable?: boolean;
}

interface SavepointHandle {
  release(): Promise<void>;
}

abstract class TransactionLike implements AsyncDisposable {
  /** Settled state: true once commit() or rollback() has resolved. */
  protected settled = false;
  protected savepointCounter = 0;

  protected constructor(protected readonly conn: Connection) {}

  /**
   * Run a parameterised query inside this transaction. The fragment is
   * materialised to (sql, params) and dispatched via the underlying
   * connection's extended-query path.
   */
  async sql<R extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<R[]> {
    if (this.settled) {
      throw new ConnectionError("transaction has already settled");
    }
    const m = materialize(new Fragment(strings, values));
    const result: QueryResult<R> = await this.conn.extQuery<R>(m.sql, m.params);
    return result.rows;
  }

  /** One-shot variant that asserts a single row. Throws if rowCount !== 1. */
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

  abstract commit(): Promise<void>;
  abstract rollback(): Promise<void>;

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.settled) {
      try {
        await this.rollback();
      } catch {
        // Best-effort: if rollback fails (connection already dead), the dispose
        // path still needs to settle the transaction state from the user's POV.
      }
    }
  }
}

/**
 * Top-level transaction. Holds a connection lease from the pool from `begin()`
 * to settlement (commit / rollback / dispose). Concurrent `db.sql` calls go to
 * a *different* connection — transactions never silently pool-share.
 */
export class Transaction extends TransactionLike {
  /** @internal */
  constructor(
    conn: Connection,
    private readonly pool: Pool,
  ) {
    super(conn);
  }

  async commit(): Promise<void> {
    if (this.settled) return;
    try {
      await this.conn.query("commit");
    } finally {
      this.settled = true;
      this.pool.release(this.conn);
    }
  }

  async rollback(): Promise<void> {
    if (this.settled) return;
    try {
      await this.conn.query("rollback");
    } catch {
      // If rollback itself fails, the connection state is suspect — drop it
      // rather than risk handing a poisoned connection back to the pool.
      this.pool.destroy(this.conn);
      this.settled = true;
      return;
    }
    this.settled = true;
    this.pool.release(this.conn);
  }

  /**
   * Open a nested SAVEPOINT. Names are auto-generated (`sp_<n>`) for clean
   * release/rollback verbs. Disposal of the savepoint rolls back to it; the
   * outer transaction stays open.
   */
  async savepoint(): Promise<Savepoint> {
    if (this.settled) {
      throw new ConnectionError("transaction has already settled");
    }
    const name = `sp_${++this.savepointCounter}`;
    await this.conn.query(`savepoint ${name}`);
    return new Savepoint(this.conn, name);
  }
}

export class Savepoint extends TransactionLike implements SavepointHandle {
  /** @internal */
  constructor(
    conn: Connection,
    private readonly name: string,
  ) {
    super(conn);
  }

  async commit(): Promise<void> {
    return this.release();
  }

  async release(): Promise<void> {
    if (this.settled) return;
    await this.conn.query(`release savepoint ${this.name}`);
    this.settled = true;
  }

  async rollback(): Promise<void> {
    if (this.settled) return;
    await this.conn.query(`rollback to savepoint ${this.name}`);
    this.settled = true;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Factories used by client.ts. Kept here so the connection-acquisition logic
// lives next to the verb composition.

export async function beginTransaction(
  pool: Pool,
  options?: BeginOptions,
): Promise<Transaction> {
  const conn = await pool.acquire();
  try {
    await conn.query(buildBeginSql(options));
    return new Transaction(conn, pool);
  } catch (err) {
    pool.release(conn);
    throw err;
  }
}

export async function runInTransaction<T>(
  pool: Pool,
  fn: (tx: Transaction) => Promise<T>,
  options?: BeginOptions,
): Promise<T> {
  const tx = await beginTransaction(pool, options);
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // see Transaction.rollback — connection already destroyed if rollback failed.
    }
    throw err;
  }
}

function buildBeginSql(options: BeginOptions | undefined): string {
  if (options === undefined) return "begin";
  const parts: string[] = ["begin"];
  if (options.isolation !== undefined) {
    parts.push(`isolation level ${options.isolation}`);
  }
  if (options.readOnly === true) parts.push("read only");
  else if (options.readOnly === false) parts.push("read write");
  if (options.deferrable === true) parts.push("deferrable");
  return parts.join(" ");
}
