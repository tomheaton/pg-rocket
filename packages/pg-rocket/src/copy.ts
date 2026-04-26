// Bulk-load API on top of the Connection layer's COPY primitives.
//
// `db.copy.in(table, columns, opts)` returns a {@link CopyInWriter} the user
// can push rows / pre-formatted bytes into; `db.copy.out(query, opts)` returns
// a {@link CopyOutReader} that yields raw `CopyData` chunks (with `.text()` for
// row decoding in text format).
//
// COPY holds one connection from the pool for the duration of the writer /
// reader. The client layer is responsible for releasing it back when the user
// is done — even if the user never calls `end()` (we surface that through the
// `await using` disposal path).
//
// Format support in v0:
//
//   * **Text** (default): rows of plain objects → tab-separated values with
//     `\\N` for null and the escape conventions Postgres uses (\\, \b, \f, \n,
//     \r, \t, \v). Decoder reverses the same. Robust for ergonomic usage,
//     slower than binary.
//   * **Binary**: caller supplies pre-encoded `Uint8Array` chunks (for COPY
//     IN) or consumes raw bytes (for COPY OUT). The binary header / trailer
//     and per-column length-prefixed encoding are the user's responsibility
//     today; per-codec binary encoders land in v0.0.x.
//
// The "give me bytes" mode means users with their own `pg-copy-streams`-style
// encoder (or with files already in COPY format) can ship today; the
// row-shaped ergonomics layer lands in front of that primitive.

import type {
  Connection,
  CopyInController,
  QueryResult,
} from "./connection/index.js";
import { ConnectionError } from "./errors.js";
import type { Pool } from "./pool/index.js";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

// ────────────────────────────────────────────────────────────────────────
// Public types

export type CopyFormat = "text" | "binary";

/** Common shape for COPY in/out — the format choice that ends up in the SQL. */
export interface CopyOptions {
  /** Wire format. Defaults to `text`. */
  readonly format?: CopyFormat;
  /** Optional `WITH (...)` extras, appended verbatim. Use sparingly. */
  readonly with?: string;
  /** Cancel the copy when this signal fires. */
  readonly signal?: AbortSignal;
}

/**
 * Streaming writer for `COPY ... FROM STDIN`. Produced by `db.copy.in(...)`.
 *
 * Two write modes:
 *
 *   * `write(rows)` accepts an array of plain objects matching the columns
 *     declared at start. The values are encoded as text-format COPY data
 *     (only valid when the writer was opened with `format: "text"`).
 *   * `writeBytes(chunk)` accepts pre-formatted bytes — the right choice
 *     when the user has their own encoder (binary format, files already in
 *     COPY format, etc.).
 *
 * Settle the writer with `end()` (returns the row count) or `fail(message)`
 * (rolls back). Disposal sends `fail(...)` for un-settled writers.
 */
export interface CopyInWriter extends AsyncDisposable {
  readonly format: CopyFormat;
  readonly columns: readonly string[];
  /** Push one or more rows of plain objects (text-format only). */
  write(rows: ReadonlyArray<Record<string, unknown>>): Promise<void>;
  /** Push raw COPY-formatted bytes — works in both text and binary mode. */
  writeBytes(chunk: Uint8Array): Promise<void>;
  /** Finalize: send CopyDone, await CommandComplete. Returns the row count. */
  end(): Promise<{ rowCount: number; command: string }>;
  /** Abort: send CopyFail. Surfaces the server's PgError (if any) as the return value. */
  fail(message?: string): Promise<void>;
}

/**
 * Streaming reader for `COPY ... TO STDOUT`. Produced by `db.copy.out(...)`.
 *
 * Iterating the reader directly yields raw `CopyData` chunks — the format
 * (text or binary) matches whatever the SQL produced. `text()` is a
 * convenience that splits a text-format stream into per-row records. `result()`
 * resolves once the stream is fully drained, with the COPY's row count.
 */
export interface CopyOutReader
  extends AsyncIterable<Uint8Array>,
    AsyncDisposable {
  readonly format: CopyFormat;
  /** Per-row text-format iteration. Throws if `format !== "text"`. */
  text(
    columns: readonly string[],
  ): AsyncIterable<Record<string, string | null>>;
  /** Settle once the stream drains. Resolves with rowCount + command tag. */
  result(): Promise<{ rowCount: number; command: string }>;
}

// ────────────────────────────────────────────────────────────────────────
// Public API attached to `db.copy`

export interface CopyInOptions extends CopyOptions {}
export interface CopyOutOptions extends CopyOptions {}

/**
 * The `db.copy` namespace. Built once per Db; both methods acquire a
 * connection from the pool for the lifetime of the writer/reader, releasing
 * it through the same `releaseOrDestroy` path that `db.sql` uses so a
 * connection that errored mid-COPY is dropped rather than poisoning the pool.
 */
export class CopyApi {
  /** @internal — built by client.ts. */
  constructor(
    private readonly pool: Pool,
    private readonly release: (conn: Connection) => void,
  ) {}

  /**
   * Begin a `COPY <table> ({columns}) FROM STDIN` against an acquired pool
   * connection. Returns a {@link CopyInWriter} once the server confirms it's
   * in COPY substate.
   */
  async in(
    table: string,
    columns: readonly string[],
    options: CopyInOptions = {},
  ): Promise<CopyInWriter> {
    if (columns.length === 0) {
      throw new TypeError("db.copy.in: at least one column is required");
    }
    const format = options.format ?? "text";
    const sql = buildCopyFromSql(table, columns, format, options.with);
    const conn = await this.pool.acquire();
    let controller: CopyInController;
    try {
      controller = await conn.copyIn(sql, signalOpt(options.signal));
    } catch (err) {
      this.release(conn);
      throw err;
    }
    return new CopyInWriterImpl(
      conn,
      controller,
      format,
      columns,
      this.release,
    );
  }

  /**
   * Begin a `COPY (<query>) TO STDOUT` against an acquired pool connection.
   * The `query` is taken verbatim — pass a SELECT or a table name, with the
   * caller responsible for SQL safety. Returns a {@link CopyOutReader} that
   * yields raw `CopyData` chunks until the server reports CommandComplete.
   */
  out(query: string, options: CopyOutOptions = {}): CopyOutReader {
    const format = options.format ?? "text";
    const sql = buildCopyToSql(query, format, options.with);
    return new CopyOutReaderImpl(
      this.pool,
      this.release,
      sql,
      format,
      options.signal,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// Internals: SQL builders

function buildCopyFromSql(
  table: string,
  columns: readonly string[],
  format: CopyFormat,
  withClause: string | undefined,
): string {
  const cols = columns.map(quoteIdentifier).join(", ");
  const fmt = format === "binary" ? "BINARY" : "TEXT";
  const extras = withClause !== undefined ? `, ${withClause}` : "";
  return `COPY ${quoteRef(table)} (${cols}) FROM STDIN WITH (FORMAT ${fmt}${extras})`;
}

function buildCopyToSql(
  query: string,
  format: CopyFormat,
  withClause: string | undefined,
): string {
  const fmt = format === "binary" ? "BINARY" : "TEXT";
  const extras = withClause !== undefined ? `, ${withClause}` : "";
  // If the user passed a SELECT (anything containing whitespace + `select`)
  // we wrap in parens; otherwise treat as a table name.
  const looksLikeQuery = /\b(select|with|values)\b/i.test(query);
  const target = looksLikeQuery ? `(${query})` : quoteRef(query);
  return `COPY ${target} TO STDOUT WITH (FORMAT ${fmt}${extras})`;
}

/** Quote a possibly-dotted reference like `schema.table`. */
function quoteRef(ref: string): string {
  return ref.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(part: string): string {
  if (part.indexOf("\0") >= 0) {
    throw new TypeError("copy: identifier contains NUL byte");
  }
  return `"${part.replace(/"/g, '""')}"`;
}

function signalOpt(
  signal: AbortSignal | undefined,
): { signal: AbortSignal } | undefined {
  return signal !== undefined ? { signal } : undefined;
}

// ────────────────────────────────────────────────────────────────────────
// CopyInWriter implementation

class CopyInWriterImpl implements CopyInWriter {
  private released = false;

  constructor(
    private readonly conn: Connection,
    private readonly controller: CopyInController,
    public readonly format: CopyFormat,
    public readonly columns: readonly string[],
    private readonly releaseConn: (conn: Connection) => void,
  ) {}

  async write(rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
    if (this.format !== "text") {
      throw new ConnectionError(
        "copy.in: write(rows) is only supported in text format — use writeBytes() for binary",
      );
    }
    if (rows.length === 0) return;
    const chunk = encodeTextRows(rows, this.columns);
    await this.controller.write(chunk);
  }

  async writeBytes(chunk: Uint8Array): Promise<void> {
    await this.controller.write(chunk);
  }

  async end(): Promise<{ rowCount: number; command: string }> {
    try {
      const result: QueryResult = await this.controller.end();
      return { rowCount: result.rowCount, command: result.command };
    } finally {
      this.releaseOnce();
    }
  }

  async fail(message?: string): Promise<void> {
    try {
      await this.controller.fail(message);
    } finally {
      this.releaseOnce();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.controller.isSettled) {
      try {
        await this.controller.fail("copyIn aborted by client");
      } catch {
        /* best-effort */
      }
    }
    this.releaseOnce();
  }

  private releaseOnce(): void {
    if (this.released) return;
    this.released = true;
    this.releaseConn(this.conn);
  }
}

// ────────────────────────────────────────────────────────────────────────
// CopyOutReader implementation

class CopyOutReaderImpl implements CopyOutReader {
  private acquired: Promise<{
    conn: Connection;
    iterator: AsyncGenerator<Uint8Array, QueryResult, undefined>;
  }> | null = null;
  private resultValue: QueryResult | null = null;
  private resultErr: unknown = null;
  private done = false;

  constructor(
    private readonly pool: Pool,
    private readonly release: (conn: Connection) => void,
    private readonly sql: string,
    public readonly format: CopyFormat,
    private readonly signal: AbortSignal | undefined,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array, void, undefined> {
    return this.iterate();
  }

  text(
    columns: readonly string[],
  ): AsyncIterable<Record<string, string | null>> {
    if (this.format !== "text") {
      throw new ConnectionError(
        "copy.out: text() is only supported when format is 'text'",
      );
    }
    return this.iterateText(columns);
  }

  async result(): Promise<{ rowCount: number; command: string }> {
    const cached = this.resultValue;
    if (cached !== null) {
      return { rowCount: cached.rowCount, command: cached.command };
    }
    if (this.resultErr !== null) throw this.resultErr;
    // Drain whatever's left to surface a final result.
    for await (const _ of this) {
      /* skip */
    }
    if (this.resultErr !== null) throw this.resultErr;
    const final = this.resultValue;
    if (final === null) {
      throw new ConnectionError("copy.out: stream ended without a result");
    }
    return { rowCount: final.rowCount, command: final.command };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.done) return;
    if (this.acquired === null) {
      // Nothing was started; nothing to clean up.
      this.done = true;
      return;
    }
    try {
      const { iterator } = await this.acquired;
      await iterator.return(undefined as unknown as QueryResult).catch(() => {
        /* swallow — the generator's finally already ran */
      });
    } finally {
      this.releaseAcquired();
      this.done = true;
    }
  }

  private async *iterate(): AsyncGenerator<Uint8Array, void, undefined> {
    if (this.done) return;
    const handle = await this.ensureStarted();
    try {
      while (true) {
        const next = await handle.iterator.next();
        if (next.done) {
          this.resultValue = next.value;
          return;
        }
        yield next.value;
      }
    } catch (err) {
      this.resultErr = err;
      throw err;
    } finally {
      this.releaseAcquired();
      this.done = true;
    }
  }

  private async *iterateText(
    columns: readonly string[],
  ): AsyncGenerator<Record<string, string | null>, void, undefined> {
    let leftover = "";
    for await (const chunk of this) {
      // CopyData chunks aren't aligned to row boundaries — buffer until we
      // see a newline, then split. UTF-8 decoding via `stream: true` keeps
      // multi-byte characters intact across chunk boundaries.
      leftover += utf8Decoder.decode(chunk, { stream: true });
      let nl = leftover.indexOf("\n");
      while (nl >= 0) {
        const line = leftover.slice(0, nl);
        leftover = leftover.slice(nl + 1);
        if (line.length > 0) {
          yield decodeTextRow(line, columns);
        }
        nl = leftover.indexOf("\n");
      }
    }
    // Flush any partial trailing line. Postgres writes each row including
    // the trailing newline, so leftover should normally be empty.
    leftover += utf8Decoder.decode();
    if (leftover.length > 0) {
      yield decodeTextRow(leftover, columns);
    }
  }

  private async ensureStarted(): Promise<{
    conn: Connection;
    iterator: AsyncGenerator<Uint8Array, QueryResult, undefined>;
  }> {
    if (this.acquired !== null) return this.acquired;
    this.acquired = (async () => {
      const conn = await this.pool.acquire();
      try {
        const iterator = conn.copyOut(this.sql, signalOpt(this.signal));
        return { conn, iterator };
      } catch (err) {
        this.release(conn);
        throw err;
      }
    })();
    return this.acquired;
  }

  private releaseAcquired(): void {
    if (this.acquired === null) return;
    const acquired = this.acquired;
    this.acquired = null;
    acquired
      .then(({ conn }) => this.release(conn))
      .catch(() => {
        /* the acquire itself failed — already handled at the rejection site */
      });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Text-format row codec (Postgres COPY default).
//
// Encoding: columns separated by \t, rows by \n. NULL is the literal string
// `\N`. Values may not contain NUL; the special characters \\, \b, \f, \n, \r,
// \t, \v are escaped with a leading backslash. Other characters pass through.

function encodeTextRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[],
): Uint8Array {
  // Cheap upper-bound: assume each character takes 2 bytes (worst case for an
  // escaped char), plus separators. We start a rough estimate and let the
  // encoder grow on demand.
  let out = "";
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as Record<string, unknown>;
    for (let c = 0; c < columns.length; c++) {
      if (c > 0) out += "\t";
      const value = row[columns[c] as string];
      out += encodeTextValue(value);
    }
    out += "\n";
  }
  return utf8Encoder.encode(out);
}

function encodeTextValue(value: unknown): string {
  if (value === null || value === undefined) return "\\N";
  let s: string;
  if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "bigint")
    s = String(value);
  else if (typeof value === "boolean") s = value ? "t" : "f";
  else if (value instanceof Date) s = value.toISOString();
  else if (value instanceof Uint8Array) {
    // bytea hex format is what Postgres expects in text mode.
    s = `\\x${bytesToHex(value)}`;
  } else {
    s = JSON.stringify(value);
  }
  return escapeTextValue(s);
}

function escapeTextValue(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0b:
        out += "\\v";
        break;
      case 0x00:
        throw new TypeError("copy: NUL byte not allowed in COPY text format");
      default:
        out += s[i];
    }
  }
  return out;
}

function decodeTextRow(
  line: string,
  columns: readonly string[],
): Record<string, string | null> {
  const fields = splitTextFields(line);
  if (fields.length !== columns.length) {
    throw new ConnectionError(
      `copy.out text: column count mismatch (got ${fields.length}, expected ${columns.length})`,
    );
  }
  const out: Record<string, string | null> = {};
  for (let i = 0; i < columns.length; i++) {
    const raw = fields[i] as string;
    out[columns[i] as string] = raw === "\\N" ? null : unescapeTextValue(raw);
  }
  return out;
}

function splitTextFields(line: string): string[] {
  // Tabs are unescaped (they're escaped to `\t` inside values), so a plain
  // split on \t is safe.
  return line.split("\t");
}

function unescapeTextValue(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 0x5c) {
      out += s[i];
      i++;
      continue;
    }
    if (i + 1 >= s.length) {
      out += "\\";
      i++;
      continue;
    }
    const next = s[i + 1];
    switch (next) {
      case "\\":
        out += "\\";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "v":
        out += "\v";
        break;
      default:
        // Unknown escape — pass through verbatim (Postgres tolerates this).
        out += `\\${next}`;
    }
    i += 2;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}
