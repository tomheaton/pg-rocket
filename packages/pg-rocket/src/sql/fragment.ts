// Fragment materialisation.
//
// Two paths:
//
//   Fast path — every value in the outer fragment is a plain parameter
//   (no SqlPart). One scan to confirm, then string concat. ~tens of ns.
//
//   Slow path — a Fragment / Identifier / Unsafe / Cast appears in `values`.
//   Recursive walk, parameter renumbering as we emit (no post-hoc regex
//   rewriting). Identifier quoting per Postgres rules.
//
// Fragment composition:
//   const filter = sql`active = ${true}`;
//   await db.sql`select * from u where org = ${org} and ${filter}`;
//
// The outer materialise sees the inner fragment in its `values`; the inner's
// strings/values are walked recursively into the same `parts`/`params` arrays
// the outer is building, so parameter numbers form a single contiguous left-
// to-right sequence — no renumbering pass needed.

import {
  ArrayParam,
  Cast,
  Fragment,
  Identifier,
  SqlPart,
  Unsafe,
  ValuesList,
} from "./types.js";

export interface MaterializedSql {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export function materialize(fragment: Fragment): MaterializedSql {
  const values = fragment.values;
  const strings = fragment.strings;

  // Fast path: scan for SqlPart. The check is a single hidden-class compare.
  let hasPart = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i] instanceof SqlPart) {
      hasPart = true;
      break;
    }
  }
  if (!hasPart) {
    let sql = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) {
      sql += `$${i + 1}${strings[i + 1] ?? ""}`;
    }
    // The values array becomes the params array directly; the Fragment is
    // throwaway after materialisation, so aliasing is safe.
    return { sql, params: values };
  }

  // Slow path: recursive walk that emits $N as we go.
  const parts: string[] = [];
  const params: unknown[] = [];
  emit(fragment, parts, params);
  return { sql: parts.join(""), params };
}

function emit(fragment: Fragment, parts: string[], params: unknown[]): void {
  const strings = fragment.strings;
  const values = fragment.values;
  parts.push(strings[0] ?? "");
  for (let i = 0; i < values.length; i++) {
    emitValue(values[i], parts, params);
    parts.push(strings[i + 1] ?? "");
  }
}

function emitValue(value: unknown, parts: string[], params: unknown[]): void {
  if (value instanceof Fragment) {
    // Nested fragment: walk its strings/values into the same arrays. Parameter
    // numbering naturally extends because params.length is the running count.
    emit(value, parts, params);
    return;
  }
  if (value instanceof Identifier) {
    parts.push(quoteIdentifier(value.parts));
    return;
  }
  if (value instanceof Unsafe) {
    parts.push(value.text);
    return;
  }
  if (value instanceof Cast) {
    params.push(value.value);
    parts.push(`$${params.length}::${value.type}`);
    return;
  }
  if (value instanceof ValuesList) {
    emitValuesList(value, parts, params);
    return;
  }
  if (value instanceof ArrayParam) {
    // One $N whose value is the array — distinguishes "single array parameter"
    // from "spread positional parameters" at the call site.
    params.push(value.items);
    parts.push(`$${params.length}`);
    return;
  }
  // Plain value — becomes a parameter.
  params.push(value);
  parts.push(`$${params.length}`);
}

/**
 * Expand a multi-row VALUES list. Emits the column tuple once, then one
 * parenthesised group per row — every cell becomes a `$N` parameter so
 * codecs handle encoding the same way as any other slot.
 */
function emitValuesList(
  vl: ValuesList,
  parts: string[],
  params: unknown[],
): void {
  parts.push("(");
  for (let i = 0; i < vl.columns.length; i++) {
    if (i > 0) parts.push(", ");
    parts.push(quoteIdentifier([vl.columns[i] as string]));
  }
  parts.push(") values ");
  for (let r = 0; r < vl.rows.length; r++) {
    if (r > 0) parts.push(", ");
    parts.push("(");
    const row = vl.rows[r] as Readonly<Record<string, unknown>>;
    for (let c = 0; c < vl.columns.length; c++) {
      if (c > 0) parts.push(", ");
      const col = vl.columns[c] as string;
      params.push(row[col]);
      parts.push(`$${params.length}`);
    }
    parts.push(")");
  }
}

/**
 * Postgres identifier quoting: wrap in `"…"`, double any internal `"`. Reject
 * NUL bytes (Postgres doesn't allow them in identifiers). Multi-part names are
 * joined with `.` between quoted parts: `sql.id("public", "users")` → `"public"."users"`.
 */
function quoteIdentifier(parts: readonly string[]): string {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out += ".";
    const part = parts[i] as string;
    if (part.indexOf("\0") >= 0) {
      throw new Error("sql.id: identifier contains NUL byte");
    }
    out += `"${part.replace(/"/g, '""')}"`;
  }
  return out;
}
