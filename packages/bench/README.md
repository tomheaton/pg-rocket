# bench

Local head-to-head benchmarks: **pg-rocket** vs **pg** vs **postgres** (postgres.js).

Single-machine, single Postgres, single Node version. No matrix, no JSON archiving — this is for "is the new change faster" iteration, not for publishing numbers. The full suite + matrix per [doc 0005](../../docs/design/0005-benchmarks.md) lands later.

## What's covered

| Suite             | What it measures                                                |
| ----------------- | --------------------------------------------------------------- |
| `simple-select`   | `select 1` overhead — driver round-trip cost.                   |
| `prepared-loop`   | Single-row OLTP read with a varying parameter.                  |
| `pipelined-batch` | `Promise.all` of N=20 concurrent queries (pool.max=20).         |
| `wide-row-scan`   | 1k rows × 20 mixed-type columns — codec dispatch under load.    |
| `pool-contention` | 32 concurrent virtual users hitting a pool of 8.                |

Not (yet): bulk-COPY (pg-rocket has no COPY yet), memory/GC.

## Quick start

```sh
pnpm db:up        # start Postgres in Docker (port 5433)
pnpm bench:seed   # create + populate users (10k) and wide_rows (1k)
pnpm bench        # run all five suites against all three drivers
pnpm db:down      # stop the container (preserves the volume)
```

To wipe the volume too (clean slate next `db:up`):

```sh
pnpm db:reset
```

The default `DATABASE_URL` (used by `seed` and `bench`) matches the docker-compose: `postgres://postgres:postgres@localhost:5433/pgrocket_bench`. Override the env var to point at a different Postgres if you have one running already:

```sh
DATABASE_URL=postgres://you@localhost:5432/your_bench_db pnpm bench
```

## Bigger sample sizes

Seed sizes default to 10k users and 1k wide_rows for fast turnaround. Bump them when you want closer-to-real numbers:

```sh
USER_ROWS=1000000 WIDE_ROWS=10000 pnpm bench:seed
```

The seed currently inserts via plain SQL batches, which gets slow past ~100k rows. Switching it to COPY lands when pg-rocket grows COPY support.

## What the docker-compose gives you

- Postgres 16, persistent named volume.
- Bench-friendly tuning: `synchronous_commit=off`, `fsync=off`, `autovacuum=off`, `full_page_writes=off`, `shared_buffers=512MB`, `max_connections=200`.
- These settings sacrifice durability for measurement noise reduction — re-seed after any hard restart.
- Listens on **5433** (host) → 5432 (container) so it doesn't collide with a system-installed Postgres.

## Why no mitata

The bench suites here are async + I/O-bound, not microbench-scale. The harness in `src/harness.ts` uses `process.hrtime.bigint()` directly because we need control over warmup vs. measurement and per-driver comparison. mitata is the right tool for the codec / writer / reader microbenches, which land separately.
