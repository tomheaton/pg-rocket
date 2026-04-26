# pg-rocket design doc 0005: benchmarks

The benchmark suite is the artifact that keeps us honest. Performance claims that aren't measured are aspirations; performance claims that are measured loosely are marketing. This doc specifies exactly what we measure, how we run it, what we report, and what we hold ourselves to before declaring v0 ready.

The headline target from doc 0000: faster than `pg` and `postgres` on workloads people actually run. "Faster" is meaningless without specifying the workload, the metric, and the conditions, so this doc nails those down.

## What this doc is for

Three audiences. First, us: the suite is a regression gate on every PR. Second, contributors: it tells anyone working on the library which numbers matter and how to interpret them. Third, users: when we publish v0, we publish numbers, and those numbers need to be reproducible by someone with no insider context.

That last audience is the constraint that shapes everything. If a benchmark is sensitive to local kernel tuning, we say so. If a benchmark is meaningful only in a specific Postgres configuration, we say so. The headline numbers we publish need to be reproducible on commodity hardware with the configuration documented in the repo.

## What we are not measuring

Worth saying explicitly because the temptation is real:

- **End-to-end web framework latency.** Stacking pg-rocket inside a web server and measuring HTTP latency tells us about the web server, the JSON serializer, and the network stack. Useful for users; not useful for us as a library benchmark.
- **Cold-start of Node itself.** Cold-import of pg-rocket is in scope (and budgeted to under 5 ms), but `node` startup time is not our problem.
- **Server-side query plan time.** A complex query that takes Postgres 200 ms to plan looks the same regardless of driver. We benchmark queries simple enough that the driver overhead is the dominant or near-dominant factor.
- **Network-bound throughput.** Across a real network, the speed of light dominates. Our suite runs against a Postgres on the same host, over a Unix socket where possible, to keep network effects out of the measurement.

## The hardware and software baseline

The reference rig:

- Linux x86_64, kernel ≥ 6.6, governor `performance`, CPU pinning available.
- Postgres 16 (also 14, 15, 17 in the matrix), built from source with default optimization, configured with `shared_buffers=2GB`, `max_connections=200`, `synchronous_commit=off` (we measure driver overhead, not WAL fsync), `fsync=off` for the bench runs (same reason; documented and reset between runs).
- Node 20 LTS (also 22 LTS in the matrix), run with `--no-warnings --expose-gc`. We do not pass `--turbo-fast-api-calls` or other experimental flags.
- pg-rocket main, `pg@8.x` latest, `postgres@3.x` latest (versions pinned in `bench/package.json` and updated quarterly with explicit notes when an update changes a number meaningfully).

Postgres runs on the same machine as the bench client. The connection is over a Unix domain socket (`/var/run/postgresql/.s.PGSQL.5432`) for the suites that don't specifically test TCP behavior. This removes loopback TCP overhead and the noise it introduces; for the small number of suites where we want to measure TCP/TLS specifically, we override.

Apple Silicon (M-series) is the secondary baseline because half of us develop on it. Numbers there are reported but not the primary publishable set, because Apple's macOS scheduling makes microbenchmark variance higher than on a tuned Linux box.

## The harness

Each suite is a standalone TS file under `packages/bench/suites/`. A driver script (`packages/bench/run.ts`) invokes the suites in subprocesses and aggregates results. Subprocess isolation matters: V8's optimization state from one benchmark contaminates the next if they share a process, and we want each suite to start cold.

Within a suite, the structure is:

```ts
import { run } from '../harness';

await run({
  name: 'simple-select',
  drivers: ['pg-rocket', 'pg', 'postgres'],
  warmupIterations: 10_000,
  measureIterations: 100_000,
  procedure: async (db, i) => {
    await db.sql`select 1`;
  },
});
```

The harness handles: setting up each driver against the same Postgres, running the warmup loop (V8 optimization, prepared-statement cache fill, kernel page cache fill), running the measurement loop, recording per-iteration timing via `process.hrtime.bigint()`, and reporting p50/p95/p99 plus ops/sec plus standard deviation.

Three runs per suite, median reported as the headline. The other two runs are reported as the variance band — if they differ from the median by more than 5%, the run is unstable and we annotate it.

`mitata` is the right tool for the microbench-scale suites (single-statement, prepared-loop) because it has lower self-overhead than `tinybench` or `benchmark.js` and reports per-iteration distributions cleanly. For the macrobench suites (bulk insert, pool contention) we use the harness's own timing because we need access to total elapsed time, not per-call distribution.

## The suites, exhaustively

Seven suites. Each has a defined acceptance criterion that v0 must hit before release.

### 1. Simple-statement latency

The "how much overhead does the library add" baseline. `select 1`, 100k iterations, sequential, one connection, one client.

```sql
select 1
```

We report p50, p95, p99 of per-call latency, plus ops/sec. The query is so cheap that the Postgres-side time is in the low microseconds — what we measure is the round-trip plus the driver overhead.

This suite has three variants: with prepared-statement caching enabled (the default for pg-rocket and `postgres`, off for `pg` since `pg` doesn't auto-prepare), with caching disabled, and against a Unix socket vs. local TCP vs. local TLS. The prepared-on variant is the headline number.

**Acceptance:** pg-rocket within 10% of `postgres.js` p50, ahead of `pg` p50 by ≥ 15%. The `postgres` parity bound is realistic given how lean its hot path already is; out-of-the-box `pg` overhead leaves room.

### 2. Prepared loop

The realistic single-row OLTP read. One prepared statement, varying parameter, 100k iterations, sequential, one connection.

```sql
select id, email, name, created_at, status
from users
where id = $1
```

The user table has 1M rows, the parameter is randomized over the full range, the index lookup is point-select. Postgres-side time is consistent (a few hundred microseconds for the index walk and tuple fetch).

We report the same distribution metrics. This is where the prepared-statement cache earns its keep — the second iteration onward should skip `Parse`, and pg-rocket and `postgres` should both demonstrate this. `pg` does not auto-prepare and we measure it both with manual `client.query({ name, text, values })` (its prepare API) and with plain text queries, reporting both.

**Acceptance:** pg-rocket within 5% of `postgres.js` p50, ahead of `pg` (auto-text mode) by ≥ 25%, ahead of `pg` (manual prepare mode) by ≥ 10%.

### 3. Pipelined batch throughput

Where pipelining shines. N queries issued via `Promise.all` on one connection, varying N from 2 to 100 in eight steps (2, 5, 10, 20, 30, 50, 75, 100). Each query is a `select id, email from users where id = $1`.

We measure total wall time for the batch and compute ops/sec. The interesting curve is how the ratio between drivers changes as N grows. At N=2, all three drivers are similar — there's barely anything to coalesce. At N=100, pg-rocket should pull meaningfully ahead because of the single-`socket.write` per batch and the single TLS record.

We run the suite twice — once over Unix socket, once over local TLS. The TLS variant is where coalescing matters most because each `tls.write` is a separate record.

**Acceptance:** pg-rocket ≥ 30% faster than `postgres.js` and ≥ 50% faster than `pg` at N=20, over TLS. Without TLS the gap is smaller (we still need to win, just less). At N=2 we're allowed to be within noise.

### 4. Wide-row scan

Codec dispatch and row assembly under load. 10k rows from a realistic table:

```sql
create table wide_rows (
  id          bigserial primary key,
  uuid        uuid not null,
  status      text not null,
  email       text,
  count       int not null,
  amount      numeric(10, 2) not null,
  ratio       float8 not null,
  is_active   boolean not null,
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  deleted_at  timestamptz,
  tags        text[] not null default '{}',
  metadata    jsonb not null default '{}',
  position    int4,
  priority    int2 not null,
  flags       int8 not null,
  description text,
  notes       text,
  source      text,
  version     int4 not null
);
```

20 columns spanning the codec types we ship. 10k rows seeded with realistic values: UUIDs, mixed-length texts (some short ASCII, some longer UTF-8), real numerics with decimals, real timestamps, JSON objects of varying sizes, sometimes-null nullable columns. The suite runs `select * from wide_rows order by id limit 10000` and times the full materialization.

Three sub-suites for the result-mode comparison: object mode (default), `.raw()` mode, `.values()` mode. We compare apples to apples (object vs. object) for the headline number but report all three to show the optimization headroom.

**Acceptance:** pg-rocket ≥ 20% faster than both `pg` and `postgres.js` in object mode. The `.raw()` mode should be ≥ 35% faster than object mode within pg-rocket itself, demonstrating that the optimization is real.

### 5. Bulk insert via COPY

1M rows inserted into a table with the same shape as the wide-row test. We measure rows/sec for the full operation, including the streaming.

For pg-rocket: `db.copy.in('wide_rows', cols, { format: 'binary' })`.
For `pg`: `pg-copy-streams` with binary format.
For `postgres`: built-in `sql.copy(...)` with binary format.

We run text format and binary format separately and report both. Text format is interesting because it's what most tutorials use and what most users will hit first; binary is the one we want to be obviously faster on.

The bottleneck on this suite is partly server-side (parsing, WAL write, index updates), so the gap between drivers is smaller than on read-heavy suites. The interesting question is whether we lose anything to the incumbents.

**Acceptance:** pg-rocket within 5% of `postgres.js` rows/sec (both directions — we shouldn't be slower; we're not expected to be dramatically faster either, since the bottleneck is the server). Ahead of `pg` + `pg-copy-streams` by ≥ 15% in binary mode.

### 6. Pool contention

64 concurrent virtual users hitting a pool of 10 connections. Each "user" runs a loop of:

```sql
select id, email from users where id = $1
```

with random parameters, for 30 seconds. We measure: total queries completed, p50/p95/p99/p99.9 latency across all users, and the standard deviation of completed-queries-per-user (fairness measure).

This is where the timer wheel, the FIFO queue, and the no-EventEmitter choices show up. `pg-pool` (which `pg` uses) and `postgres.js`'s built-in pool both have known tail-latency issues at high contention, mostly from `setTimeout`-per-connection overhead and from listener-array growth on long-lived connections.

**Acceptance:** pg-rocket p99 ≤ 80% of the worse of `pg`/`postgres.js` p99. p99.9 ≤ 70% (the gap should widen at the tail). Throughput within 10% of `postgres.js` (we don't expect a throughput win here because the bottleneck is the server's small connection count, but tail latency should be better).

### 7. Memory and steady-state

Run the wide-row scan repeatedly for 60 seconds, collecting RSS and heap-used every second. After the run, compute: peak RSS, steady-state RSS (median of last 30 samples), total GC time (from `--trace-gc` parsing).

The expectation is that pg-rocket's single-buffer-per-connection design produces a flatter heap profile and less GC time. `pg` allocates per-message and per-row aggressively; `postgres.js` is closer to us but still allocates message buffers per response.

**Acceptance:** pg-rocket steady-state RSS ≤ `pg` × 0.7, ≤ `postgres.js` × 0.85. GC time per query ≤ `pg` × 0.5, ≤ `postgres.js` × 0.7. The ratios are smaller than the latency ratios because both incumbents are reasonable in absolute terms; the win here is more about consistency than headline numbers.

## Auxiliary microbenchmarks

Inside `bench/microbench/`, separate from the integration suites, we measure the protocol layer and codec layer in isolation. These exist for regression-detection during development; they're not headline numbers.

**Protocol reader:** parse 1M canned `DataRow` messages of 10 small columns from a pre-filled buffer, measure ns/message. Budget from doc 0001: < 200 ns per row excluding codec time.

**Protocol writer:** encode 1M `Bind`+`Execute`+`Sync` triples to a buffer (no I/O), measure ns/triple. Budget: < 300 ns per group.

**Codec decode:** for each codec, decode 1M values from a pre-filled buffer, measure ns/value. Budgets per type from doc 0003.

**Codec encode:** for each codec, encode 1M values into a buffer, measure ns/value. Budgets within 50% of decode.

**Prepared cache lookup:** 1M lookups against a cache of 100 entries, hot path, measure ns/lookup. Budget: < 30 ns (one Map lookup plus an LRU bump).

**Pipelining flush dispatch:** 100k microtask-flush cycles, measure ns/cycle. Budget: < 50 ns per dispatch.

These run on every PR. Any regression > 10% is investigated before merge.

## What we publish

For v0 release, three outputs:

A `BENCHMARKS.md` in the repo root with the full numbers across the matrix (Linux × {pg14, pg15, pg16, pg17} × {Node 20, Node 22}). Headlines for each suite, with the variance band, plus links to the raw JSON.

A `bench/results/<git-sha>.json` file checked in for every commit on `main`, so we have a continuous history of all numbers.

A simple plot artifact (`bench/results/plots/`) generated from the JSON, showing each suite's headline metric over time. Useful for spotting drift.

We do not publish numbers from contributors' machines, only from a fixed CI runner that holds the machine constant. Contributors run benchmarks locally for confidence; the official numbers come from one place.

## CI integration

Two workflows.

**On every PR, every push:** the microbenchmarks plus a fast subset of the full suites (single-statement, prepared loop, wide-row scan in object mode). Total wall time budget: 5 minutes. The job compares against the merge-base's baseline and fails if any number regresses by more than 5%. The 5% threshold is generous — most real changes don't move numbers at all, and the threshold absorbs CI machine variance.

**Nightly, on `main`:** the full suite across the full matrix. Results uploaded to `bench/results/<sha>.json`, plots regenerated, the BENCHMARKS.md updated. If the nightly regresses by more than 2% on any headline metric, an issue is auto-opened.

The CI runner is a dedicated bare-metal machine, not a GitHub-hosted runner. GitHub-hosted runners have noisy neighbors and inconsistent CPU performance — fine for correctness tests, useless for performance regression detection. The dedicated runner is documented in `bench/RUNNER.md` so someone reproducing our numbers can spec-match.

## Methodology notes

Some choices are non-obvious enough to call out.

**Warmup.** 10k iterations, not the smaller numbers `mitata` defaults to. The reason is the prepared-statement cache and the pg side query-plan cache: the first iteration is qualitatively different from the steady state, and 10k is enough that the steady state dominates the measurement window. We discard warmup samples entirely; only the measure phase counts.

**Iteration count.** 100k for the latency suites. At ~10 µs per iteration that's a 1-second measurement window, which is long enough that scheduler noise averages out and short enough that the bench suite finishes in reasonable time. For the bulk-insert suite the iteration count *is* the row count (1M), and the "iterations" notion doesn't apply.

**Distribution metrics.** p50, p95, p99, ops/sec. We don't report mean — it's misleading when the distribution is skewed, which it always is for I/O-bound work. p99.9 is reported only for pool contention, where the tail is the headline.

**Standard deviation across runs.** The three-run median is the headline; the standard deviation across the three runs is reported as the variance. If variance is high (> 5%), we run two more times and either the variance settles or we mark the suite unstable in the output.

**No GC manipulation between iterations.** Some bench suites force `global.gc()` between iterations to control for GC noise. We don't, because the steady-state behavior includes GC, and forcing it makes the measurement unrealistic. We do report total GC time as a separate metric for the memory suite.

**Same Postgres for all three drivers.** Each driver runs in turn against the same Postgres instance, with the same data, with no restart between drivers (only between suites). This means the page cache is hot for all three; we're measuring driver overhead, not cold-cache performance.

**Driver setup is excluded.** The time to call `createClient` and establish the first connection is not part of the measurement. For `postgres.js` and pg-rocket this is lazy anyway; for `pg` we explicitly `await pool.query('select 1')` once before the warmup to ensure the first connection is up.

**Each driver gets its idiomatic API.** pg-rocket uses the `sql` tag. `postgres.js` uses its `sql` tag. `pg` uses `pool.query({ text, values })` for parameterized queries and `pool.query({ name, text, values })` for the prepared variant. We don't try to make one driver use another driver's idiom.

**Connection count per driver matches.** All three pools are sized to the same max. For single-connection suites it's max=1 (or a single client where applicable).

## What "winning" looks like

Tying it all together, the numbers we want to publish for v0:

- **Simple-statement latency (Unix socket, prepared on):** within 10% of `postgres.js`, 15-25% ahead of `pg`.
- **Prepared loop (1M-row table, point select):** within 5% of `postgres.js`, 25-40% ahead of `pg` text mode.
- **Pipelined batch (N=20, TLS):** 30-60% ahead of both.
- **Wide-row scan (10k rows, object mode):** 20-40% ahead of both.
- **Bulk insert (1M rows, binary COPY):** within 5% of `postgres.js`, 15-25% ahead of `pg`.
- **Pool contention (64×10, p99):** 20-30% better tail than the worse of the two.
- **Memory (steady-state RSS):** 30% lower than `pg`, 15% lower than `postgres.js`.

These are the targets, not the predictions. If we hit them, v0 is honestly faster than the incumbents on the workloads that matter, and we can publish those numbers without hedging. If we don't hit them, v0 isn't ready to release as "the fast one" — we either fix the gap or rephrase the value proposition.

## Tracking and visibility

`bench/RESULTS.md` lists the most recent numbers from main, refreshed nightly. PRs that affect performance (anything in `protocol/`, `connection/`, `codecs/`, the `sql` tag, or the pool) get a comment from the CI bot showing the diff against main for the relevant suites.

We don't publish micro-improvements as marketing — "0.3% faster on simple-select since last week" is noise. We publish numbers at v0 release and again at major milestones (v0.5, v1).

## Failure modes worth pre-empting

Things that can make benchmarks lie, with mitigations:

**Benchmarking the wrong thing.** Easy to do: write a bench that exercises a fast path the incumbents don't have, then declare victory. Mitigation: every suite is reviewed against "is this a workload a real user would run?" If the answer is no, the suite isn't published. The `wide-row scan` would be vulnerable to this — we'd be tempted to use 50 columns of int4 to maximize the codec advantage — so we deliberately use a realistic schema mix.

**JIT warmup not actually warming.** A function called only in measurement, not in warmup, optimizes during measurement and the early samples are slow. Mitigation: warmup uses the same code path as measurement, no separate harness functions. The suite definition's `procedure` is what runs in both phases.

**Garbage collection during measurement.** A long-running suite hits a major GC mid-measurement and skews p99. Mitigation: report GC time separately; if a single suite shows multi-millisecond GC pauses in its measurement window, we flag it and investigate. For most suites the steady-state nursery GC is fast enough that this is not a problem.

**Postgres-side variance.** Auto-vacuum kicks in mid-suite and slows queries. Mitigation: `autovacuum=off` during bench runs, manual `VACUUM ANALYZE` between suites. Documented in the harness setup.

**Network noise even on loopback.** Even on `localhost` TCP, scheduler interaction can produce occasional 1ms outliers. Mitigation: Unix socket for the suites that don't specifically test TCP. For the TLS pipelined-batch suite (which we do want over TCP), we accept higher variance and report it as a band.

**Asymmetric driver configurations.** Easy to forget that `pg` defaults to text format and we're binary; comparing without normalizing makes us look better than we are. Mitigation: every suite runs the incumbents in their *fastest* documented mode. For `pg`, that means manual prepare and explicit binary format flags where they support them. The "out of the box vs. tuned" comparison is also reported separately, but the headline number is fastest-vs-fastest.

**Postgres version sensitivity.** A new version changes a server-side cost and we look 5% slower across the board through no fault of our own. Mitigation: running the matrix means we see this; we report each version's results separately and don't average across versions.

## When the suite tells us we're not ready

A scenario worth taking seriously: we run the suite at v0-feature-complete and we're at parity, not 30% ahead. What then?

The first answer is profile. The CPU-flame-graph workflow is part of the bench package: `pnpm bench:profile <suite>` runs the suite under `--cpu-prof` and produces a flame graph. Most regressions or unexpected gaps show up obviously — a hot codec function, a missed call-site monomorphization, an allocation in a tight loop.

The second answer is that a feature we haven't implemented might be the cause. The biggest risk on this front is the `Function`-constructor row assembler — we're shipping v0 with the closure-based version (which relies on V8's monomorphic optimization) and benchmarking against `postgres.js`'s comparable approach. If we're at parity, generating the assembler dynamically might be worth ~15-20% extra. We'd ship v0 without it (CSP concerns), then add it as an opt-in for users who want the last drop.

The third answer is that we accept parity for v0 if every other claim holds. Smaller bundle, ESM-only, modern API, real types, `using` integration — these are values that exist independently of being faster, and v0 is releasable on those terms. But we'd want to be honest in the README rather than claiming a speed win we can't back up.

## What's deliberately not in the suite

For v0, we don't benchmark:

- HTTP/WebSocket transports (not implemented in v0).
- Cold start in serverless environments (not v0's target).
- Cancellation latency (correct-and-fast-enough, not a competitive axis).
- Memory under adversarial workloads (long strings, wide arrays — the codec layer handles these but they're not the headline).
- TLS handshake performance (out of our control; it's the runtime's TLS impl).
- Reconnection storms (no automatic reconnection in v0).

These are added to the suite as the corresponding features land. Doc 0006 (implementation plan) sequences this — benchmarks track features.

## Files

```
packages/bench/
├── package.json            # pinned versions of pg, postgres
├── run.ts                  # top-level driver, subprocess orchestration
├── harness.ts              # the run() function, timing, distribution math
├── setup/
│   ├── postgres.sh         # configure pg with bench-specific settings
│   ├── seed-users.ts       # 1M-row users table
│   ├── seed-wide-rows.ts   # 10k wide_rows table
│   └── reset.ts            # vacuum analyze, reset between suites
├── suites/
│   ├── simple-select.ts
│   ├── prepared-loop.ts
│   ├── pipelined-batch.ts
│   ├── wide-row-scan.ts
│   ├── bulk-copy.ts
│   ├── pool-contention.ts
│   └── memory.ts
├── microbench/
│   ├── reader.ts
│   ├── writer.ts
│   ├── codec-decode.ts
│   ├── codec-encode.ts
│   └── prepared-cache.ts
├── compare/
│   ├── pg-rocket.ts        # adapter to common interface
│   ├── pg.ts
│   └── postgres.ts
├── results/                # JSON history, committed
│   ├── README.md
│   └── *.json
├── plots/
│   └── generate.ts         # results JSON → PNGs
├── BENCHMARKS.md           # the published numbers
├── RUNNER.md               # how to spec-match the CI runner
└── README.md               # how to run locally
```

Total expected size of the bench package: 2000-3000 lines, plus the data seeders. Not in the published `pg-rocket` package — it's a separate workspace member.

## What success looks like, on the day of v0 release

The README has a benchmarks section with seven numbers, each clearly labeled with the workload and the comparison. The numbers are reproducible by anyone with the documented hardware. The variance band on each is small enough that the win is unambiguous. The `BENCHMARKS.md` has the matrix, the methodology, and the raw JSON.

Six months later, we look at the same suite, and the numbers haven't drifted. That's the bigger win.
