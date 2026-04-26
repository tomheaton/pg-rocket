// Three driver adapters behind a common Driver interface so the harness
// stays driver-agnostic. Each driver gets its idiomatic API per doc 0005:
// pg-rocket uses extQuery on a pool, pg uses pool.query (and pool.query with
// `name` for the prepared variant), postgres.js uses sql.unsafe(text, params)
// — its supported escape hatch for raw SQL with positional params.
//
// The pool size is set per-suite by the caller; for single-connection suites
// we use max=1, and the suite runs all iterations against that one connection.

import pg from "pg";
import { createClient, type Db } from "pg-rocket";
import postgres from "postgres";

export type Row = Record<string, unknown>;

export interface DriverSetup {
  /** `postgres://user:pass@host:port/db` */
  readonly url: string;
  /** Pool size. Default 1. */
  readonly max?: number;
}

export interface Driver {
  readonly name: string;
  setup(opts: DriverSetup): Promise<void>;
  /** Run a parameterised query, return rows. */
  query<R extends Row = Row>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  /**
   * Optional prepared-mode variant. If absent, `prepared` suites fall back to
   * `query`. Used to give `pg` its prepared API a fair shot — its `query()`
   * with a `name` argument lets the server cache the plan.
   */
  prepared?<R extends Row = Row>(
    name: string,
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  teardown(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────
// pg-rocket

export class PgRocketDriver implements Driver {
  readonly name = "pg-rocket";
  private db: Db | null = null;

  async setup(opts: DriverSetup): Promise<void> {
    this.db = createClient({
      url: opts.url,
      ...(opts.max !== undefined ? { pool: { max: opts.max } } : {}),
    });
    // Warm: open at least one connection so the first measured query doesn't
    // include connect+auth time.
    await this.db.sql`select 1`;
  }

  async query<R extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    // We don't have direct sql/params on Db (the public surface is the tag),
    // so synthesise a Fragment with no template values and inject params via
    // the underlying pool's connection. Cleaner than constructing a TemplateStringsArray.
    if (this.db === null) throw new Error("PgRocketDriver: not set up");
    return this.db._unsafeExtQuery<R>(sql, params);
  }

  async teardown(): Promise<void> {
    if (this.db !== null) {
      await this.db.close();
      this.db = null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// pg (`pg@8`)

export class PgDriver implements Driver {
  readonly name = "pg";
  private pool: pg.Pool | null = null;

  async setup(opts: DriverSetup): Promise<void> {
    this.pool = new pg.Pool({
      connectionString: opts.url,
      max: opts.max ?? 1,
    });
    await this.pool.query("select 1");
  }

  async query<R extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    if (this.pool === null) throw new Error("PgDriver: not set up");
    const result = await this.pool.query<
      R extends pg.QueryResultRow ? R : never
    >(sql, params as unknown[]);
    return result.rows as R[];
  }

  async prepared<R extends Row = Row>(
    name: string,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    if (this.pool === null) throw new Error("PgDriver: not set up");
    const result = await this.pool.query<
      R extends pg.QueryResultRow ? R : never
    >({
      name,
      text: sql,
      values: params as unknown[],
    });
    return result.rows as R[];
  }

  async teardown(): Promise<void> {
    if (this.pool !== null) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// postgres.js (`postgres@3`)

export class PostgresJsDriver implements Driver {
  readonly name = "postgres";
  private sql: postgres.Sql | null = null;

  async setup(opts: DriverSetup): Promise<void> {
    this.sql = postgres(opts.url, { max: opts.max ?? 1 });
    await this.sql`select 1`;
  }

  async query<R extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    if (this.sql === null) throw new Error("PostgresJsDriver: not set up");
    // postgres.js's documented escape hatch for raw SQL + positional parameters.
    // Internally still uses prepared statements; that's the point — its hot
    // path matches the one we want to measure against.
    const result = await this.sql.unsafe<R[]>(
      sql,
      params as readonly unknown[] as never[],
    );
    return result as unknown as R[];
  }

  async teardown(): Promise<void> {
    if (this.sql !== null) {
      await this.sql.end({ timeout: 5 });
      this.sql = null;
    }
  }
}
