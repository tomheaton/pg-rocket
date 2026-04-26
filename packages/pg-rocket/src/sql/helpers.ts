// Named helpers attached to the `sql` tag.
//
//   sql.id("schema", "table") → quoted identifier
//   sql.unsafe(text)          → verbatim text (escape hatch — grep for it)
//   sql.raw(text)             → alias for sql.unsafe, reads better at the call site
//   sql.cast(value, "jsonb")  → $N::jsonb
//   sql.join(parts, sep)      → fragments joined with separator (default: " and ")
//
// `values` and `array` helpers ship with the bulk-insert / array slice and are
// not yet implemented.

import { Cast, Fragment, Identifier, Unsafe, ValuesList } from "./types.js";

export function id(...parts: string[]): Identifier {
  if (parts.length === 0) {
    throw new TypeError("sql.id: at least one identifier part is required");
  }
  return new Identifier(parts);
}

export function unsafe(text: string): Unsafe {
  return new Unsafe(text);
}

export function raw(text: string): Unsafe {
  return new Unsafe(text);
}

export function cast(value: unknown, type: string): Cast {
  return new Cast(value, type);
}

/**
 * Join fragments with a separator. The default is " and " because filtering
 * predicates are by far the most common use case:
 *
 *   const where = sql.join(filters.map(f => sql\`${sql.id(f.col)} = ${f.val}\`));
 *   await db.sql\`select * from t where ${where}\`;
 */
export function join(
  parts: readonly Fragment[],
  separator = " and ",
): Fragment {
  if (parts.length === 0) {
    return new Fragment([""], []);
  }
  // Build a wrapper Fragment whose values are the input fragments and whose
  // strings are the separators. The materialiser flattens nested fragments,
  // so this composes correctly with the rest of the query.
  const strings: string[] = [""];
  for (let i = 0; i < parts.length - 1; i++) {
    strings.push(separator);
  }
  strings.push("");
  return new Fragment(strings, parts);
}

/**
 * Multi-row VALUES expansion for bulk insert.
 *
 *   await db.sql`insert into users ${sql.values(records, ["email", "name"])}`;
 *
 * If `columns` is omitted, it's derived from `Object.keys(rows[0])` — handy
 * when the row objects already have exactly the shape you want inserted, less
 * good when row order varies. Pass it explicitly for stable output.
 */
export function values(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  columns?: readonly string[],
): ValuesList {
  if (rows.length === 0) {
    throw new TypeError(
      "sql.values: empty rows array (server would reject the INSERT)",
    );
  }
  const cols =
    columns ?? Object.keys(rows[0] as Readonly<Record<string, unknown>>);
  if (cols.length === 0) {
    throw new TypeError("sql.values: empty column list");
  }
  return new ValuesList(rows, cols);
}
