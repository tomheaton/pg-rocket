// Bench-table seeder.
//
// Creates `users` and `wide_rows`, populates them with deterministic synthetic
// data so re-runs are stable. Sized small by default (10k users, 1k wide_rows)
// for fast local iteration; tune via env vars when you want closer-to-real
// numbers.

import postgres from "postgres";

const URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/pgrocket_bench";
const USER_ROWS = Number.parseInt(process.env.USER_ROWS ?? "10000", 10);
const WIDE_ROWS = Number.parseInt(process.env.WIDE_ROWS ?? "1000", 10);
const BATCH = 1000;

const STATUSES = ["active", "pending", "suspended", "deleted"];
const TAGS_POOL = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

async function main(): Promise<void> {
  const sql = postgres(URL);
  console.log(`seeding ${URL}`);
  console.log(`  users:     ${USER_ROWS.toLocaleString()}`);
  console.log(`  wide_rows: ${WIDE_ROWS.toLocaleString()}`);

  await sql`drop table if exists users`;
  await sql`drop table if exists wide_rows`;

  await sql`
    create table users (
      id          bigint primary key,
      email       text not null,
      name        text,
      status      text not null,
      created_at  timestamptz not null default now()
    )
  `;
  await sql`
    create table wide_rows (
      id          bigserial primary key,
      uuid        uuid not null,
      status      text not null,
      email       text,
      "count"     int not null,
      amount      numeric(10, 2) not null,
      ratio       float8 not null,
      is_active   boolean not null,
      created_at  timestamptz not null,
      updated_at  timestamptz not null,
      deleted_at  timestamptz,
      tags        text[] not null default '{}',
      metadata    jsonb not null default '{}',
      "position"  int4,
      priority    int2 not null,
      flags       int8 not null,
      description text,
      notes       text,
      source      text,
      version     int4 not null
    )
  `;

  const tStart = Date.now();
  await seedUsers(sql);
  await seedWideRows(sql);
  console.log(`done in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  // Indexes after the bulk insert is faster than maintaining them during.
  await sql`create index on users (email)`;
  await sql`vacuum analyze users`;
  await sql`vacuum analyze wide_rows`;

  await sql.end({ timeout: 5 });
}

async function seedUsers(sql: postgres.Sql): Promise<void> {
  for (let start = 1; start <= USER_ROWS; start += BATCH) {
    const end = Math.min(start + BATCH, USER_ROWS + 1);
    const rows: Array<{
      id: number;
      email: string;
      name: string;
      status: string;
    }> = [];
    for (let i = start; i < end; i++) {
      rows.push({
        id: i,
        email: `user${i}@example.com`,
        name: `User ${i}`,
        status: STATUSES[i % STATUSES.length] as string,
      });
    }
    await sql`insert into users ${sql(rows, "id", "email", "name", "status")}`;
  }
}

// Column list for wide_rows insert. Order matters — `seedWideRows` builds
// the parameter array in this exact order.
const WIDE_COLS: readonly string[] = [
  "uuid",
  "status",
  "email",
  '"count"',
  "amount",
  "ratio",
  "is_active",
  "created_at",
  "updated_at",
  "deleted_at",
  "tags",
  "metadata",
  '"position"',
  "priority",
  "flags",
  "description",
  "notes",
  "source",
  "version",
];

async function seedWideRows(sql: postgres.Sql): Promise<void> {
  for (let start = 1; start <= WIDE_ROWS; start += BATCH) {
    const end = Math.min(start + BATCH, WIDE_ROWS + 1);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (let i = start; i < end; i++) {
      const tuple: string[] = [];
      // Same column order as WIDE_COLS.
      tuple.push(pushParam(params, pseudoUuid(i)));
      tuple.push(pushParam(params, STATUSES[i % STATUSES.length] as string));
      tuple.push(
        pushParam(params, i % 7 === 0 ? null : `wide${i}@example.com`),
      );
      tuple.push(pushParam(params, i * 3));
      tuple.push(pushParam(params, (((i * 13) % 100000) / 100).toFixed(2)));
      tuple.push(pushParam(params, (i % 1000) / 1000));
      tuple.push(pushParam(params, i % 2 === 0));
      tuple.push(pushParam(params, new Date(2024, 0, 1 + (i % 365))));
      tuple.push(pushParam(params, new Date(2024, 6, 1 + (i % 180))));
      tuple.push(pushParam(params, i % 11 === 0 ? new Date(2024, 9, 1) : null));
      tuple.push(
        pushParam(params, [
          TAGS_POOL[i % TAGS_POOL.length] as string,
          TAGS_POOL[(i + 1) % TAGS_POOL.length] as string,
        ]),
      );
      tuple.push(
        pushParam(
          params,
          JSON.stringify({
            idx: i,
            kind: STATUSES[i % STATUSES.length],
            score: i % 100,
          }),
        ),
      );
      tuple.push(pushParam(params, i % 5 === 0 ? null : i));
      tuple.push(pushParam(params, i % 32767));
      tuple.push(pushParam(params, String(BigInt(i) * 1000n)));
      tuple.push(
        pushParam(
          params,
          i % 13 === 0 ? null : `description for row ${i}`.repeat(2),
        ),
      );
      tuple.push(pushParam(params, null));
      tuple.push(pushParam(params, `source-${i % 17}`));
      tuple.push(pushParam(params, 1 + (i % 7)));
      tuples.push(`(${tuple.join(",")})`);
    }
    const stmt = `insert into wide_rows (${WIDE_COLS.join(",")}) values ${tuples.join(",")}`;
    await sql.unsafe(stmt, params as never[]);
  }
}

function pushParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

/**
 * Deterministic pseudo-UUID. Not cryptographically uniform, but stable across
 * seed runs so the data — and any cached query plans / page-cache layout —
 * stays the same between bench runs.
 */
function pseudoUuid(seed: number): string {
  const hex = (n: number, len: number): string =>
    Math.abs(n).toString(16).padStart(len, "0").slice(0, len);
  return `${hex(seed * 1103515245 + 12345, 8)}-${hex(seed * 22695477, 4)}-${hex(
    seed * 1664525 + 1013904223,
    4,
  )}-${hex(seed * 16807, 4)}-${hex(seed * 65539, 12)}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
