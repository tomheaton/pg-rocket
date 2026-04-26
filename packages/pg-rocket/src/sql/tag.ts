// The `sql` template tag — the entry point users interact with most.
//
// Used standalone, it builds a Fragment for composition:
//
//   const filter = sql`active = ${true} and verified = ${true}`;
//   await db.sql`select * from u where org = ${orgId} and ${filter}`;
//
// `db.sql` (in client.ts) is a separate tag function that builds a Fragment
// AND immediately schedules execution against the pool. Both share the same
// Fragment shape and materialise via the same code path.

import { cast, id, join, raw, unsafe, values } from "./helpers.js";
import { Fragment } from "./types.js";

interface SqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): Fragment;
  readonly id: typeof id;
  readonly unsafe: typeof unsafe;
  readonly raw: typeof raw;
  readonly cast: typeof cast;
  readonly join: typeof join;
  readonly values: typeof values;
}

function sqlImpl(
  strings: TemplateStringsArray,
  ...templateValues: unknown[]
): Fragment {
  return new Fragment(strings, templateValues);
}

export const sql: SqlTag = Object.assign(sqlImpl, {
  id,
  unsafe,
  raw,
  cast,
  join,
  values,
});
