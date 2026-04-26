# pg-rocket design doc 0000: overview and performance plan

A TypeScript-first, ESM-only PostgreSQL client targeting Node ≥ 20. Standard TCP/TLS connection only in v0. The goal is to be measurably faster than both `pg` and `postgres.js` on the workloads people actually run, with a smaller install footprint and a smaller API surface.

## Scope for v0

In: TCP and TLS, SCRAM-SHA-256 and MD5 auth, the v3 wire protocol, extended query with automatic prepared-statement caching, transparent pipelining, binary codecs for the common scalar and array types, the `sql` template tag with parameter and identifier helpers, transactions via `using` / `await using`, a connection pool, `LISTEN`/`NOTIFY`, `COPY` in and out, `AbortSignal` end-to-end, structured errors with SQLSTATE subclasses.

Out: WebSocket and HTTP transports, edge-runtime adapters, codegen CLI, logical replication, ORM features, query builder, migrations, multi-host failover, read replicas. All deferred to later versions; the architecture leaves room without committing to surface area now.

The benchmark target is `pg@8.x` and `postgres@3.x` running against Postgres 16 on the same machine, same connection settings, in three regimes: single-statement latency, pipelined batch throughput, and bulk insert via `COPY`.

## What "lightweight" means concretely

Zero runtime dependencies in the published package. The only things imported at runtime are `node:net`, `node:tls`, `node:crypto`, `node:stream`, and `node:buffer` — and `node:buffer` only at the transport edge, never in the protocol or codec layers. ESM only, no dual build, no bundler shims. Total install size budget: ≤ 150 KB unpacked, ≤ 40 KB min+gzip for the main entry. For comparison, `pg` pulls in `pg-types`, `pg-protocol`, `pg-connection-string`, `pg-pool`, `pgpass`, and `pg-cloudflare`; `postgres` is single-package but ships ~80 KB unpacked. We should be smaller than both.

API surface budget: one factory (`createClient`), one tag (`sql`), one transaction primitive (`db.begin()`), one streaming primitive (`db.cursor()`), one bulk primitive (`db.copy()`), one pub/sub primitive (`db.listen()`). Everything else is helpers on those.

Cold import budget: under 5 ms on a warm Node process, measured by `node --eval "console.time('i'); await import('pg-rocket'); console.timeEnd('i')"`. This means no top-level `await`, no eager regex compilation, no eager codec table population, and no class hierarchies built at module load.

## Where the speed actually comes from

The honest accounting of why `pg` is slower than `postgres.js`, and why both leave performance on the table, comes down to four things: text protocol vs. binary, per-message allocation, write coalescing, and the cost of constructing result rows. Each is addressable.

**Binary protocol everywhere.** `pg` uses text format by default for most types; `postgres.js` uses binary for many but still falls back to text for several. Text format means the server formats numbers, timestamps, arrays, and JSON as strings, the client parses those strings back into values, and both sides eat allocation and CPU. Binary format means fixed-width integers are a single `DataView.getInt32` call, timestamps are two integers, and arrays are a length-prefixed walk. We do binary for everything we ship a codec for, and we ship codecs for every common type on day one. Estimated win on integer-heavy and timestamp-heavy workloads: 20–40%.

**Single read buffer, slice-as-view.** Both incumbents allocate a fresh `Buffer` per backend message in the hot path. We allocate one growable `Uint8Array` per connection, parse messages as offset+length pairs into that buffer, and only materialize a `Buffer` or string when a codec actually needs one. Strings are decoded with an inline ASCII fast path (a tight loop over `charCodeAt`-equivalent byte reads, valid for the ~80% of identifier and short-string cases that are pure ASCII) and fall through to a shared `TextDecoder` instance for anything else. The buffer is compacted opportunistically rather than on every message, so the steady state is one large allocation per connection lifetime rather than thousands per second. Estimated win: 10–15% on small-row workloads where allocation dominates.

**Single write buffer, coalesced syscall.** When the user awaits multiple queries concurrently, `pg` and `postgres.js` both serialize them but write each `Bind`/`Execute`/`Sync` set as a separate `socket.write`. The kernel coalesces some of this via Nagle, but TLS makes that worse because each `tls.write` produces its own record. We maintain a single growable write buffer per connection, write all pending frames into it, and call `socket.write` exactly once per pipelined batch. With Nagle disabled (`TCP_NODELAY`) this is the difference between one TLS record and N. Estimated win on pipelined batches of 10+ queries: 30–60% in throughput.

**Result-row shape opt-in at the call site.** Default is plain objects (the ergonomic choice), but the hot-loop case gets `.raw()` returning `Array<unknown[]>` (skip the object construction) and `.values()` returning `Array<unknown>` for single-column selects (skip the array construction too). The codecs are shared across all three modes; only the row assembler differs. This is the move that makes the benchmark of "select 1 from generate_series(1, 100000)" honest: nobody actually wants 100k objects with one key each, and the libraries that benchmark well on this query do so by quietly returning arrays. We make it explicit instead of misleading.

**Automatic prepared statements with a per-connection LRU.** Every `sql\`…\`` invocation hashes the SQL text (FNV-1a over the bytes, 64-bit, allocation-free) and looks up a parsed/described statement. Hit: send `Bind` + `Execute` + `Sync`. Miss: send `Parse` + `Bind` + `Describe` + `Execute` + `Sync` and remember the result. The cache is keyed on the SQL string, capped at 100 entries, evicted LRU. Statements are named `s_<hex>` deterministically so two connections converge on the same name for the same query, which makes server-side `pg_prepared_statements` debugging sane. Estimated win on repeated queries: 15–25%, mostly from skipping `Parse` and the round-trip-implicit work the server does to plan.

**No EventEmitter in the hot path.** `pg` is built on `EventEmitter` for query lifecycle events; every `emit` allocates an arguments array and dispatches through a listeners list. We use direct callbacks stored on the in-flight command record. Observability hooks (`onQuery`, `onError`, `onNotice`) are checked once per connection at construction and the dispatch is a function-pointer call, no event emitter. Estimated win: small but consistent, 3–5%.

**Codec dispatch is a flat array, not a Map.** The OID space for built-in types is dense and small (under 4000). The codec registry is a `Array<Codec | undefined>` indexed directly by OID for built-ins, with a `Map<number, Codec>` fallback for user-registered types and types with high OIDs. Lookup in the hot path is `registry[oid] ?? slowMap.get(oid)`. Estimated win: small per-cell, but rows have many cells, so it adds up.

**Numeric handling.** `numeric` decoded as `string` by default (preserves precision, matches incumbents, no allocation beyond the string itself). `int8` decoded as `bigint` always — `pg` defaults to `string` here for safety, which is the wrong default in 2026. We use the binary form which is two `Int32` reads, then a single `BigInt` constructor call.

**No `node:buffer` dependence in codecs.** Codecs operate on `DataView` over the connection's read buffer. This means codecs work unchanged when we add non-Node transports later, and it avoids the `Buffer.from(uint8, offset, length)` pattern which allocates a wrapper in V8 even though it's "zero-copy" in spirit.

## Architecture

Three layers, strict boundaries.

The **protocol layer** (`src/protocol/`) is `Uint8Array` in, `Uint8Array` out, no I/O, no `node:*` imports. A reader that parses backend messages as `{ type, offset, length }` records into a single buffer, and a writer that encodes frontend messages into a single growable buffer. Auth (SCRAM, MD5) lives here because it's pure protocol — it gets a `crypto` interface injected rather than importing `node:crypto` directly, so the layer stays portable.

The **connection layer** (`src/connection/`) owns the socket, the state machine, the prepared cache, and the pipeliner. It imports the protocol layer and a `Transport` interface (the only Node-specific thing in v0; later, other adapters implement the same interface). State transitions are driven by `ReadyForQuery` boundaries, not by counting messages, so we always agree with the server about transaction state.

The **client layer** (`src/client/`, `src/sql/`, `src/pool/`) is the public API: `createClient`, the `sql` tag, the pool, transactions, cursors, COPY, LISTEN. This layer is where ergonomics live and where we spend allocation budget on developer experience.

A clean dependency graph: protocol has no imports outside itself; connection imports protocol; client imports connection; the Node transport adapter imports `node:net`/`node:tls` and is the only file that does. Enforced by Biome's `noRestrictedImports` and a CI check that compiles `protocol/` against a constrained `tsconfig` with no DOM and no Node lib types.

## The `sql` tag

```ts
const rows = await sql<User[]>`
  select id, email from users where org_id = ${orgId} and active = ${true}
`;
```

Parameter slots come from the template literal, not from string parsing of the SQL. Identifier helper for cases parameters can't cover:

```ts
sql`select * from ${sql.id(tableName)} where id = ${id}`;
```

Composition: embedding a `sql\`…\`` fragment inside another flattens with correct parameter renumbering, no string concatenation at the call site. Multi-row insert helper:

```ts
sql`insert into users ${sql.values(records, ['email', 'name'])}`;
```

The values helper encodes in binary directly into the write buffer rather than building a string. `sql.unsafe(string)` for the rare case where a SQL fragment is genuinely dynamic and the user has audited it; named loudly so it shows up in code review.

Type inference: the tag returns `Promise<T[]>` where `T` is the explicit generic. We're not committing to result-shape inference from the SQL text in v0 — that's a v1 feature behind codegen, not a runtime feature. Parameter type inference from the literal slots is straightforward and we do that.

## Transactions

```ts
await using tx = await db.begin();
await tx.sql`update accounts set balance = balance - ${amount} where id = ${from}`;
await tx.sql`update accounts set balance = balance + ${amount} where id = ${to}`;
await tx.commit();
```

If `commit()` isn't called, disposal rolls back. Savepoints are `tx.savepoint(name)` returning the same disposable shape. Isolation levels via `db.begin({ isolation: 'serializable', readOnly: true })`. The transaction holds a connection from the pool for its entire lifetime; if the user does work outside `tx.sql\`…\`` while the transaction is open, that's fine, but they can't run a query on `db` directly without it going to a different connection — and we throw a clear error if they try to nest a `db.begin()` inside an existing transaction's scope without using `tx.savepoint()`.

## Pool

Fixed-size with a queue, default `max = 10`. Connections are created lazily up to `max`, then requests queue. Idle connections are reaped after a configurable timeout using a coarse timer wheel (one `setInterval` per pool, not per connection — `setTimeout` per connection is one of the things `pg-pool` does that costs more than people realize at scale). Health checks via a cheap protocol no-op (an empty `Sync`) on connection acquire after some idle threshold. No retry logic at the pool level in v0; failed queries surface their errors and the caller decides.

## Errors

`PgError extends Error` with `code` (SQLSTATE), `severity`, `position`, `detail`, `hint`, `schema`, `table`, `column`, `constraint`, `routine`. SQLSTATE-class subclasses for the codes people actually `catch` on: `UniqueViolation` (23505), `ForeignKeyViolation` (23503), `NotNullViolation` (23502), `CheckViolation` (23514), `SerializationFailure` (40001), `DeadlockDetected` (40P01), `QueryCanceled` (57014). Subclassing means `instanceof` works without the user memorizing SQLSTATE numbers. Connection-level errors are a separate hierarchy (`ConnectionError`, `AuthenticationError`, `ProtocolError`) so the user can distinguish "the server rejected my query" from "the connection is broken".

## Cancellation

Every async method takes `{ signal?: AbortSignal }`. On abort, we open a side connection to send the `CancelRequest` (PostgreSQL requires this — cancel can't ride the same connection), wait for the in-flight query to error with `57014`, and surface that as a `QueryCanceled`. The side-connection cost is real (~1 ms locally), so we also support cooperative cancellation between queries in a transaction, which is allocation-free.

## Observability

Three hooks, set once at `createClient`:

```ts
createClient({
  url,
  onQuery: (e) => { /* { sql, params, durationMs, rowCount, prepared } */ },
  onError: (e) => { /* { error, sql, params } */ },
  onNotice: (e) => { /* { severity, message, code } */ },
});
```

No event emitter, no listener arrays, no allocation when the hooks are unset (we check `=== undefined` and skip the event-object construction entirely). OpenTelemetry/Datadog/etc. plug in via these hooks; we don't take a dependency on any of them.

## Benchmark plan

A separate `bench/` workspace, not in the published package. Each suite runs against pg-rocket, `pg`, and `postgres`, in that order, with results posted to a tracked file in the repo so regressions are visible in PRs.

The suites:

A **single-statement latency** suite that runs `select 1` 100k times sequentially on one connection, measuring p50/p95/p99 and ops/sec. This is the "how much overhead does the library add" measurement and it's where binary protocol and prepared cache matter.

A **prepared loop** suite that runs `select * from users where id = $1` 100k times with a varying parameter, also sequential, also one connection. This is the realistic OLTP single-row read and it's where the prepared-statement cache earns its keep.

A **pipelined batch** suite that issues N queries concurrently via `Promise.all` on one connection, varying N from 2 to 100. This is where write coalescing matters most; expect the gap to widen as N grows.

A **wide-row scan** suite that selects 10k rows of a realistic 20-column table mixing integers, timestamps, text, jsonb, and a small array. This stresses codec dispatch and row assembly. Three variants: object mode, raw-array mode, values mode. We compare apples to apples (object mode vs. object mode) but report all three so the ceiling is visible.

A **bulk insert** suite using `COPY FROM STDIN` to insert 1M rows, measuring rows/sec. `pg` has the `pg-copy-streams` package; `postgres.js` has built-in COPY. We compare against both.

A **pool contention** suite with 64 concurrent virtual users hitting a pool of 10 for short queries, measuring tail latency. This is where the timer-wheel and the no-EventEmitter choices show up.

A **memory** suite running the wide-row scan repeatedly and reporting RSS, heap used, and GC time from `--trace-gc`. We expect the single-buffer-per-connection design to produce a flatter profile.

The harness uses `mitata` for the microbench portions (it has lower self-overhead than `tinybench`), the actual queries hit Postgres 16 on localhost over a Unix socket to remove network noise, and each suite runs three times with the median reported. CI runs the suites on every PR and fails if any number regresses by more than 5% against the main branch's baseline.

Honest expectations: parity-to-slightly-faster on the single-statement latency suite (overhead is small in absolute terms), 15–25% faster on the prepared loop, 30–60% faster on pipelined batches at N=20+, 20–40% faster on the wide-row scan in object mode (codec wins), comparable or slightly faster on bulk insert (the bottleneck is the server, not us), meaningfully better tail latency on pool contention, lower steady-state memory.

## Repo skeleton, scoped to v0

```
pg-rocket/
├── packages/
│   ├── pg-rocket/
│   │   ├── src/
│   │   │   ├── protocol/
│   │   │   │   ├── reader.ts
│   │   │   │   ├── writer.ts
│   │   │   │   ├── messages.ts
│   │   │   │   └── auth/
│   │   │   │       ├── scram.ts
│   │   │   │       └── md5.ts
│   │   │   ├── codecs/
│   │   │   │   ├── registry.ts
│   │   │   │   ├── int.ts
│   │   │   │   ├── float.ts
│   │   │   │   ├── numeric.ts
│   │   │   │   ├── bool.ts
│   │   │   │   ├── text.ts
│   │   │   │   ├── bytea.ts
│   │   │   │   ├── uuid.ts
│   │   │   │   ├── temporal.ts
│   │   │   │   ├── json.ts
│   │   │   │   └── arrays.ts
│   │   │   ├── connection/
│   │   │   │   ├── transport.ts
│   │   │   │   ├── tcp.ts
│   │   │   │   ├── state-machine.ts
│   │   │   │   ├── prepared-cache.ts
│   │   │   │   ├── pipeliner.ts
│   │   │   │   └── connection.ts
│   │   │   ├── pool/
│   │   │   │   ├── pool.ts
│   │   │   │   └── timer-wheel.ts
│   │   │   ├── sql/
│   │   │   │   ├── tag.ts
│   │   │   │   ├── fragment.ts
│   │   │   │   └── helpers.ts
│   │   │   ├── client.ts
│   │   │   ├── transaction.ts
│   │   │   ├── cursor.ts
│   │   │   ├── copy.ts
│   │   │   ├── listen.ts
│   │   │   ├── errors.ts
│   │   │   ├── url.ts
│   │   │   └── index.ts
│   │   └── package.json
│   ├── bench/
│   │   ├── suites/
│   │   │   ├── single-statement.ts
│   │   │   ├── prepared-loop.ts
│   │   │   ├── pipelined-batch.ts
│   │   │   ├── wide-row-scan.ts
│   │   │   ├── bulk-copy.ts
│   │   │   ├── pool-contention.ts
│   │   │   └── memory.ts
│   │   ├── compare/
│   │   │   ├── pg.ts
│   │   │   ├── postgres.ts
│   │   │   └── pg-rocket.ts
│   │   ├── results/                # JSON, committed for tracking
│   │   └── package.json
│   └── test-utils/
│       └── docker-compose.yaml      # pg14, pg15, pg16, pg17
├── docs/
│   └── design/
│       └── 0000-overview.md        # this doc
├── .github/workflows/
│   ├── test.yaml
│   └── bench.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
└── package.json
```

## Implementation order

Protocol reader and writer first, with golden tests captured from libpq traffic. Then the SCRAM and MD5 auth flows, tested against a real Postgres in `test-utils`. Then the connection state machine over a `Transport` interface, with the Node TCP adapter as the only implementation. Then the codecs for the day-one types, with property-based tests checking roundtrip equality against a real Postgres. Then the prepared cache and pipeliner. Then the `sql` tag and helpers. Then the pool. Then transactions, cursors, COPY, LISTEN. Then the benchmarks against `pg` and `postgres`, and we iterate on the hot path until the numbers are where we want them.

Estimated time to v0 alpha (working `sql` tag, pool, transactions, benchmarks running): three to four weeks of focused work for one engineer. The protocol layer is the biggest single piece and the most worth getting right; everything else is shorter once that's solid.

## Risks and mitigations

The biggest risk is that binary codecs have edge cases the text protocol hides (composite types with embedded arrays, ranges with infinite bounds, timestamp infinity, numeric NaN) and we'll find them in production. Mitigation: the property-based codec tests roundtrip against a real Postgres for every type, and we ship `decode: 'text'` as a per-type escape hatch from day one. The second risk is that prepared statements interact badly with schema migrations (the cached plan becomes invalid). Mitigation: we already detect `feature_not_supported` (0A000) and `invalid_sql_statement_name` (26000) and re-prepare automatically. The third risk is that pipelining changes error semantics — when query 3 fails, queries 4-10 are skipped server-side after the implicit rollback. Mitigation: documented clearly, errors carry which-query-in-the-batch context, and the `sql` tag awaiting individually still works because it only pipelines what's actually concurrent.
