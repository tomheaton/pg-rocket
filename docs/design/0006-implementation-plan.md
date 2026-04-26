# pg-rocket design doc 0006: implementation plan

This is the document that turns plans into a sequence of commits. The five preceding docs specified the architecture; this one specifies how we actually build it, in what order, with what we'd cut if we ran behind, and what "v0 done" means as a hard line.

The shape of the work is six milestones, each ending in something demonstrable, each gated by tests. Total estimated effort: 14-18 weeks for one engineer working full time, faster for two engineers if the right pieces are parallelizable. Calendar time will be longer than effort time; this is normal.

## Principles

A few decisions about how we work that shape every milestone.

**Tests before optimization, always.** Every milestone ships with a passing test suite for the features it adds. Optimization happens only after correctness is locked in. The temptation to optimize a hot path before the tests exist is strong and consistently wrong — we'd be optimizing something that turns out to be slightly the wrong shape.

**Benchmarks running from milestone 2 onward.** As soon as we can execute a query at all, the benchmark harness from doc 0005 starts running, even if the numbers are bad. Numbers that get worse over a milestone are a signal we've taken on debt; numbers that get better are a signal the optimization landed. Without continuous measurement, the final benchmark run at milestone 6 is a cliff with no warning.

**Real Postgres in tests, not mocks.** The `test-utils` Docker harness boots Postgres 14, 15, 16, 17 from milestone 0. Every integration test runs against real Postgres. Mocking the wire protocol means we test our model of Postgres, not Postgres itself.

**ESM only, TS strict, no exceptions.** Every file checked in is `tsc --strict --noUncheckedIndexedAccess` clean. Linting is Biome with the strictest rules turned on. No `any` without a comment explaining why. No `// @ts-ignore` ever; `// @ts-expect-error` with a comment when truly necessary.

**Each milestone closes with a release tag, even pre-v0.** v0.0.1, v0.0.2, etc. The package isn't published to npm until v0.1.0 (which is v0 release), but git tags exist and the bench results are pinned to them. This makes "what changed when" answerable.

## Milestone 0: foundations (1 week)

Repo skeleton, tooling, the test harness, the bench harness skeleton. No library code yet.

What ships:

- The pnpm workspace with `pg-rocket`, `bench`, `test-utils` packages.
- `tsconfig.base.json` with strict everything, plus a `tsconfig.protocol.json` that excludes Node lib types for boundary enforcement.
- `biome.json` with the rules. `noRestrictedImports` configured so `protocol/` can't import from outside itself, `connection/` can't import `node:*` directly, etc.
- The Docker compose for Postgres 14/15/16/17, with the seed scripts for the bench tables (`users` 1M rows, `wide_rows` 10k rows). `pnpm test:up` boots them, `pnpm test:down` tears down.
- The bench harness shell from doc 0005: `harness.ts` with the `run()` function, the subprocess driver, the JSON output format. No actual suites yet — just the framework.
- GitHub Actions for: type-check on PR, Biome on PR, `pnpm test:integration` on PR (which is fast because there are no tests yet), microbench-no-regression on PR (which is also a no-op).
- `CONTRIBUTING.md` with the v0 scope statement: explicit list of what's in and what's out, so well-meaning PRs don't pile up adding ORM features.
- `.github/ISSUE_TEMPLATE/*` and `SECURITY.md`. The security policy is important for database infra; bug bounty intent is signaled even if we're not paying out yet.

Definition of done: `pnpm install && pnpm test:up && pnpm bench:setup` works on a clean checkout, on Linux and macOS. CI is green.

What we'd cut: nothing. This milestone is short and everything in it is structural.

## Milestone 1: protocol layer (2 weeks)

The `protocol/` directory, fully tested, with no I/O — `Uint8Array` in, `Uint8Array` out.

What ships:

- `reader.ts`: the streaming parser with one read buffer per connection, `feed`/`next` API, view-based message records. Compaction strategy from doc 0001 (compact when readPos > buf.length / 2, double when needed).
- `writer.ts`: the encoder with one write buffer, `startMessage`/`endMessage` length-patching pattern, `drain()` to hand bytes off.
- `messages.ts`: the constants. Message type bytes, error/notice field codes, format codes, auth subtypes, the `MessageRecord` and `ColumnDescription` interfaces.
- `auth/scram.ts`: SCRAM-SHA-256 and SCRAM-SHA-256-PLUS, depending on the injected `Crypto` interface for hashing/HMAC/PBKDF2.
- `auth/md5.ts`: legacy MD5 auth.
- `auth/crypto.ts`: just the interface; no implementation here.

The hard parts: the buffer compaction edge cases (don't compact when there's an in-flight message that spans the read pointer), the SCRAM channel-binding flow with the `tls-server-end-point` data threading.

Tests written for this milestone:

- **Golden tests:** byte-level fixtures captured from libpq via `tcpdump` on a session running canonical operations (connect, simple query, prepared query, COPY, error, notice, NOTIFY). The writer tests build the same logical messages and assert byte-equal output. The reader tests feed the captured server bytes and assert the message records have the right type bytes and offsets.
- **Property-based tests:** `fast-check` generates arbitrary-but-valid messages, encodes them, decodes them, asserts equality. Includes edge cases at length boundaries, NUL bytes in strings, empty payloads, max-int field counts.
- **SCRAM tests:** test vectors from RFC 5802 plus our own captured-from-real-Postgres traces. Channel binding tested with mocked TLS peer-certificate data.
- **Buffer growth tests:** feed a series of chunks that should trigger compaction at specific boundaries; assert the right behavior at each.

A protocol fuzzer (`fast-check` with shrinking, plus a corpus of captured server bytes) runs nightly. Any crash or hang is P0.

Definition of done: 100% statement coverage on `protocol/`, all golden tests pass byte-for-byte against fixtures captured from Postgres 14/15/16/17, the fuzzer runs for 30 minutes without finding anything new. Microbenchmarks for reader and writer hit their budgets from doc 0005 (< 200 ns/row reader, < 300 ns/group writer).

What we'd cut: nothing critical, but if we're behind, we cut SCRAM-PLUS (channel binding) and ship MD5 + plain SCRAM. Channel binding is recommended but not required by the protocol; we'd document it as deferred to v0.x with a note about the security trade-off. Personally I'd keep it; it's not that much code and TLS-without-channel-binding is exactly the kind of thing security-conscious users notice.

## Milestone 2: connection layer with single-query path (3 weeks)

The connection layer, but only enough of it to execute a simple query end to end. Pipelining, COPY, cursors, LISTEN deferred.

What ships:

- `connection/transport.ts`: the `Transport` interface, `TransportOptions`, `TlsOptions`.
- `connection/tcp.ts`: the Node TCP transport. `node:net` for plain, `node:tls` for upgraded. `TCP_NODELAY` set unconditionally.
- `connection/state-machine.ts`: the state enum, the transition table, the synchronous message dispatcher driven by `ReadyForQuery` boundaries. For this milestone the dispatcher only handles the single-query path — `Parse`/`Bind`/`Describe`/`Execute`/`Sync` and the corresponding response sequence, plus auth and `ReadyForQuery`.
- `connection/connection.ts`: the `Connection` class. `connect()`, `query()`, `close()`. No `cursor`, no `copy`, no `listen`, no `cancel` yet.
- `connection/command-queue.ts`: the linked-list queue, but in this milestone it's effectively a queue of one (no pipelining).
- `connection/row-assembler.ts`: just the `'objects'` mode for now.
- `codecs/`: the day-one types — int2/4/8, float4/8, bool, text/varchar/bpchar/name, bytea, json/jsonb. Numeric, uuid, timestamps, arrays, the rest of the codecs deferred to milestone 3.
- `codecs/registry.ts`: the dense + sparse split, the unknown-type sentinel.
- The `node:crypto` implementation of the `Crypto` interface (small wrapper, lives in `connection/`).

The hard parts: the SSL upgrade choreography (write `SSLRequest`, read 1 byte, upgrade transport, then send `StartupMessage`). The auth flow's interleaving with `ParameterStatus`/`BackendKeyData` accumulation. Getting the state machine right so it agrees with `ReadyForQuery`'s status byte rather than tracking transaction state independently.

Tests:

- **State machine unit tests:** drive the dispatcher with canned message sequences. For every `(state, message)` pair: assert resulting state and side effects.
- **Integration tests against real Postgres:** connect with SCRAM, connect with MD5 over TLS, connect with cleartext-over-TLS, refuse cleartext-without-TLS, refuse server with no TLS in `require` mode. Run a simple `select 1`, parameterized `select $1::int`, query that errors (`select 1/0`), notice during query.
- **Codec roundtrip tests:** for each shipped codec, generate values via `fast-check`, send via `select $1::type`, decode response, assert equality. Boundary tests for each: min/max, zero, NaN/Infinity, empty string, etc.

Bench suites that start running here: simple-statement latency, prepared loop. Wide-row scan partial (only the columns whose codecs ship in this milestone). Numbers are recorded but not yet held to acceptance criteria — they exist so we see the trajectory.

Definition of done: a Node REPL session can `import { createClient } from './packages/pg-rocket'` (well, the internal `Connection` directly, since the client layer doesn't exist yet), connect, run a parameterized query, get typed results, close. All integration tests pass on Postgres 14/15/16/17. Codec roundtrip tests pass for the shipped types. The single-statement bench is producing numbers within 50% of `postgres.js` (we'll close the gap in later milestones).

What we'd cut: nothing. This is the smallest milestone that demonstrates the library works. Cutting from here means cutting features we promised.

## Milestone 3: pipelining, prepared cache, and the codec rest (3 weeks)

The features that turn the connection layer from "works" into "fast." Plus the long tail of codecs.

What ships:

- `connection/pipeliner.ts`: `queueMicrotask`-based write coalescing. Multiple `query()` calls in the same microtask flush as one `socket.write`.
- `connection/prepared-cache.ts`: the LRU + Map combo, FNV-1a hashing, deterministic statement names, eviction with fire-and-forget `Close`.
- The auto-reprepare logic for SQLSTATE `0A000` and `26000`.
- The error-cascade handling for pipelined queries: query 3 fails, queries 4-N settle with `InFailedSqlTransaction` carrying the original as `cause`.
- The remaining codecs: numeric, uuid, the temporal family (date, time, timetz, timestamp, timestamptz, interval), arrays.
- Row assembler `'raw'` and `'values'` modes.
- A first pass at the pipelined-batch and wide-row-scan benchmarks running, with all codecs.

The hard parts: numeric (the binary format is mechanical but tedious, easy to get wrong at the digit-group boundaries). The closure-per-prepared-statement row assembler shape that keeps V8's call sites monomorphic. The auto-reprepare retry logic — exactly-once retry, marked clearly in observability so users see what happened.

Tests:

- **Pipeline tests:** issue N concurrent queries against a fake transport that captures writes; assert exactly one `socket.write` per pipelined batch with N queries' bytes.
- **Error cascade tests:** inject `ErrorResponse` for query 3 of 5; assert queries 1-2 succeed normally, 3 fails with the injected error, 4-5 fail with `InFailedSqlTransaction` and the right `cause`.
- **Prepared cache tests:** deterministic statement names across connections, LRU eviction order under contention, auto-reprepare on `0A000` after a `DROP TABLE; CREATE TABLE` migration during a session, auto-reprepare on `26000` (simulated by manually `DEALLOCATE`-ing).
- **Numeric edge cases:** all the special values (NaN, ±Infinity, zero, negative zero, very small, very large, full-precision round-trip with `numeric(38, 20)`).
- **Megamorphic protection test:** prepare 20 statements with different column-type sets, run them in a tight loop, assert per-row decode time stays within 1.5x of monomorphic baseline.

Bench suites running with full acceptance criteria: simple-statement, prepared loop, wide-row scan (object mode), pipelined batch.

Definition of done: pipelined batch suite hits its acceptance criterion (≥ 30% ahead of `postgres.js` at N=20, TLS). Wide-row scan hits its criterion (≥ 20% ahead of both, object mode). Megamorphic test passes. All codec roundtrips pass.

What we'd cut: the auto-reprepare logic could ship as documented-behavior-fails-loudly in v0.0.x and proper auto-retry in v0.1.0 if we're behind. Ranges, multiranges, composite types, geometric types — not in v0 anyway, so no cutting needed. Multidimensional array support (>1-D) is in scope but optimization for it isn't; we keep the recursive-walk fallback and document it as slow.

## Milestone 4: the client layer (3 weeks)

The user-facing API. Everything from doc 0004.

What ships:

- `sql/tag.ts`: the `sql` template tag. Fast path (all-plain values) and slow path (helpers/fragments) with `WeakMap` caching of compiled fragments.
- `sql/fragment.ts`: the recursive flattening for nested `sql` fragments.
- `sql/helpers.ts`: `id`, `unsafe`, `values`, `array`, `cast`, `raw`, `join`.
- `sql/modes.ts`: `sql.values<T>`, `sql.raw<T>`, `db.sqlOne<T>`.
- `transaction.ts`: the `Transaction` class with `await using` disposal, savepoints, the callback form `db.transaction(async (tx) => {...})`.
- `pool/pool.ts`: the FIFO acquire queue, the lazy connection creation, the idle-timeout reaping via the timer wheel.
- `pool/timer-wheel.ts`: one `setInterval` per pool, scanning for idle expirations.
- `pool/url.ts`: the connection-string parser.
- `client.ts`: `createClient`, the `db` object, `db.with({ signal, timeout })` for option-layering.
- `errors.ts`: the full hierarchy, re-exported.
- `observability.ts`: the hook plumbing — connection layer fires the events, client layer wires them up at construction with the no-op fast path when unset.

The hard parts: the `sql` tag's fast path needs to stay in tens-of-nanoseconds territory. The `WeakMap` cache hits matter. The slow-path fragment compiler needs to handle recursive nesting correctly with parameter renumbering, including the parameter-count two-pass.

The transaction disposal semantics are subtle: `await using tx = await db.begin()` means the function doesn't complete until the rollback round-trip has settled. Get this right or we ship a footgun.

The pool acquire queue under contention: the FIFO discipline with a doubly-linked list, the connection-death replacement on next acquire, the drain-vs-force-close distinction.

Tests:

- **Tag tests:** every helper, fragment composition correctness, deeply-nested fragments, fragments-in-arrays for `sql.join`. `fast-check` generates arbitrary nested fragment structures and roundtrips to expected SQL+params.
- **Transaction tests:** commit, rollback on dispose, rollback on throw, savepoint commit/rollback, callback form normal return, callback form throw, isolation levels exercised against real Postgres (assert `serializable` actually rejects conflicting writes).
- **Pool tests:** acquisition under contention (more requests than max), acquisition timeout, idle timeout fires, connection death triggers replacement, drain waits for in-flight, force-close cancels in-flight, the queue is FIFO under high contention.
- **URL parsing tests:** every libpq URL form, malformed URLs error cleanly, non-ASCII passwords work.
- **Type-level tests:** `tsd` checks that `SqlValue` accepts/rejects the right types, fragment composition preserves types, generic flows through.

Bench suites running: pool contention.

Definition of done: the user-facing examples from doc 0004 all run end-to-end. Pool contention bench hits its criterion (p99 ≤ 80% of the worse of `pg`/`postgres.js`). All tests pass. The `sql` tag's fast path is at < 200 ns from invocation to `Command` ready (microbenched).

What we'd cut: the `db.with()` option layering is nice-to-have; if behind, we ship just `{ signal, timeout }` as positional options on `db.sql({ signal })\`...\`` and add `db.with()` in v0.0.x. The savepoint API is also negotiable — savepoints work via raw SQL (`tx.sql\`savepoint sp1\``) and the structured `tx.savepoint()` is ergonomic but not strictly required for v0.

The callback-form transaction is harder to cut — half the existing user base of `pg`/`postgres.js` uses callback transactions and the migration story is worse without it. Keep.

## Milestone 5: streaming, COPY, LISTEN, cancellation (2 weeks)

The features that turn v0 from "fast small library" into "complete enough to migrate from `pg`."

What ships:

- `connection/cursor.ts`: portal-based cursor with batch-size-limited `Execute`.
- `client/cursor.ts`: the public `db.cursor(sql, batchSize)` API.
- `connection/copy-stream.ts`: COPY in/out at the protocol level.
- `client/copy.ts`: `db.copy.in(table, cols, opts)` and `db.copy.out(query)`. Binary and text formats. Binary uses the same codec table as `Bind`.
- `connection/cancel.ts`: side-connection `CancelRequest` for `AbortSignal` integration.
- `client/listen.ts`: shared listener-connection management, multi-channel dispatch, `subscription.unlisten()`.
- `db.notify(channel, payload)` as the sender-side helper.

The hard parts: the COPY substate handling — the connection is in a special protocol mode where only `CopyData`, `CopyDone`, `CopyFail` are valid frontend messages. The state machine refuses everything else while the substate is active. Recovering cleanly when the user errors mid-COPY.

The listener-connection lifecycle: one connection per pool for all listeners, channels added/removed dynamically, the 5-second grace before releasing the connection on last unsubscribe (so re-listen doesn't churn).

Cancellation's race conditions: the signal fires while the query bytes are still in the writer buffer (cancel locally, don't open side connection); the signal fires after the bytes are sent but before the query starts on the server (server gets `CancelRequest` for a query it hasn't started; correct behavior); the signal fires after the query completes but before we've read the response (no-op cancel).

Tests:

- **Cursor tests:** iterate batches, early `return()` closes the portal, `await using` disposes correctly, error mid-cursor recovers connection.
- **COPY tests:** text format roundtrip with edge cases (tabs, newlines, backslashes, null), binary format roundtrip, large bulk insert (1M rows in the bench), error during COPY (server rejects a row) recovers connection state.
- **LISTEN tests:** subscribe, receive notification, multiple subscribers same channel, unsubscribe last releases connection after grace period, channel name with quoting-required characters.
- **Cancellation tests:** signal aborts in-flight query, signal aborted before query starts skips the round-trip, abort during pool wait removes from queue, abort race conditions (signal fires at exactly the wrong moment, repeatedly, in a stress test).

Bench suites running: bulk-copy.

Definition of done: bulk-copy bench hits acceptance criterion (within 5% of `postgres.js`, ≥ 15% ahead of `pg`+`pg-copy-streams` in binary mode). All tests pass. The cancellation stress test runs for 10 minutes without leaking connections.

What we'd cut: the COPY text format. Binary format is the headline performance feature; text is for ergonomics and compatibility with `psql`-format files. If we're behind, ship binary-only in v0 and add text in v0.0.x. The listener connection's grace period is also a polish feature; ship without it (immediate release on last unsubscribe) and add the grace in v0.0.x.

`db.notify` is one line of code (`select pg_notify($1, $2)`); not cuttable.

## Milestone 6: hardening, benchmark publication, v0 release (2-3 weeks)

The work between "features complete" and "we'd be willing to put our names on it."

What happens:

- **Benchmark suite runs to completion** across the matrix (Linux × {pg14, pg15, pg16, pg17} × {Node 20, Node 22}). Numbers go in `BENCHMARKS.md`. Any acceptance criterion that doesn't hit gets either fixed or honestly reported as "parity, not ahead."
- **Profiler-driven optimization pass.** Run the benchmarks under `--cpu-prof` for each suite, find the unexpected hot spots, fix what's fixable. Limited scope: this is not "rewrite anything that looks slow"; it's "the suite says X is slower than expected, the profiler says it's because of Y, Y is a one-line fix."
- **Documentation:** the README, the migration guides (from `pg`, from `postgres`), the API reference (TypeDoc-generated), the design docs themselves cleaned up and published. Examples for the common patterns (transactions, listen, copy, cursor).
- **Bundle-size check:** `size-limit` configured with the budgets from doc 0000 (≤ 40 KB min+gzip for the main entry, ≤ 150 KB unpacked total). CI gate on these.
- **Cold-import budget:** measure `node --eval "console.time('i'); await import('pg-rocket'); console.timeEnd('i')"` on a warm Node process, must be under 5 ms. Fix any top-level work that pushes us over.
- **Soak test:** a connection running for an hour, executing a mix of SELECT/INSERT/UPDATE/notify, allocation tracked. Steady-state heap must be bounded (no leaks in cache, queue, buffers).
- **Security review:** SQL injection paths audited (the `id`/`unsafe`/`values` helpers — every code path that produces SQL text). Auth flows audited (SCRAM channel binding, MD5 deprecation warning). Error messages reviewed for sensitive-data leakage.
- **Real-world test:** port a small but non-trivial open-source app (something with ~30 distinct queries, transactions, real schema) from `pg` to `pg-rocket`. Document any rough edges. Fix the rough edges, not the documentation.
- **npm publish dry runs:** `npm publish --provenance --dry-run` works. SBOM generated. The `package.json`'s `exports` map matches what we ship.
- **Changelog:** human-readable, what's in v0, what's not, what's coming in v0.1.

Then we publish. v0.1.0 to npm with `--provenance`. Git tag, GitHub release with the bench numbers and the README excerpt. A blog post or `/r/node` thread or whatever the launch surface is.

Definition of done: the package is on npm, the docs are live, someone outside the team has installed it and run the examples and reported success.

What we'd cut: the real-world port test is the most cuttable thing — it's high-value but it's a one-time investment. If we're behind, we cut it and rely on early users to find the rough edges. The TypeDoc reference can launch as "in progress" with the design docs as the primary source of truth. The migration guides from `pg`/`postgres` can be one page each rather than thorough.

The bench publication and the security review are not cuttable. We don't ship without them.

## What "v0 done" actually means

The hard line, in order of decreasing negotiability:

**Must:**

1. The seven benchmark suites all run, and the acceptance criteria from doc 0005 are either met or honestly reported with the gap acknowledged in the README.
2. The integration test suite is green on Postgres 14, 15, 16, 17 and on Node 20, 22.
3. The codec roundtrip tests pass for every shipped type, against every Postgres version.
4. The bundle-size and cold-import budgets are met.
5. The soak test runs for an hour with bounded heap.
6. SQL injection paths and auth flows are audited.
7. The README has runnable examples and a migration guide of some form.
8. `npm publish --provenance` works.

**Should:**

9. A real-world port from `pg` succeeds with documented rough edges.
10. The TypeDoc reference is generated.
11. The `BENCHMARKS.md` is comprehensive across the matrix.
12. Bug bounty / security disclosure policy is explicit.

**Nice:**

13. Migration guide is detailed rather than skeletal.
14. There's a launch blog post.
15. The wsproxy reference binary exists for users who later want to self-host serverless (defers to v0.x but doesn't block v0).

The "must" list is what we reject a release candidate for. The "should" and "nice" lists are what we acknowledge in the launch notes if they're not done.

## Risk register

The things most likely to slow us down or change the plan, with mitigations.

**Codec correctness on edge cases.** Numeric and the temporal family are where we'll find bugs in production. Property-based tests against real Postgres in milestone 3 are the primary mitigation. The text-format-fallback escape hatch is the secondary mitigation — any codec we get wrong, the user can disable per-type.

**V8 deoptimization in row assembly.** The closure-per-prepared-statement design depends on V8's call-site monomorphization. If V8 changes its optimization strategy or our closure shape doesn't quite hit the inline cache the way we expect, the wide-row-scan benchmark suffers. Mitigation: the megamorphic-protection test in milestone 3 catches regressions early. If we hit a fundamental gap, the `Function`-constructor-based assembler is the escape hatch (gated behind a flag for CSP reasons).

**Pipeline ordering bugs.** Pipelining is the place where async + protocol + state machine all meet, and it's the place where bugs are subtle (queries succeed individually, but in some specific batch ordering, a response is dispatched to the wrong queue entry). Mitigation: a stress test in CI that runs random batches with random injected errors and asserts every settled promise has the right outcome.

**Pool tail-latency under unfair scheduling.** The FIFO discipline plus the timer wheel should give us the tail-latency win over `pg-pool`, but pool dynamics interact with V8's scheduler in subtle ways and the bench could come back disappointing. Mitigation: this is where the milestone-4 acceptance criterion is the gate. If we don't hit it, we profile and either fix or honestly report.

**Auth flow incompatibility with hosted Postgres.** AWS RDS, GCP Cloud SQL, Azure Postgres each have their own quirks (IAM token auth, certificate verification rules, custom SSL CAs). Our `password` callback handles dynamic tokens; certificate verification is deferred to v0.x (we ship `disable`/`prefer`/`require` only). Some users won't be able to use v0 against verify-full deployments. Mitigation: clearly documented limitation, fast follow-up in v0.0.x.

**Schema-migration-during-session breakage.** Cached prepared plans become invalid when a migration runs against the database. We auto-detect via SQLSTATE `0A000`/`26000` and reprepare. There are corner cases: the migration changes a function's return type, the cached plan returns mismatched binary data, we get a decoding error not a SQLSTATE. Mitigation: integration test with explicit migration-during-session scenarios. Document the residual risk.

**Time pressure causing test cuts.** The temptation to cut tests to make a milestone date is real and consistently catastrophic. Mitigation: tests are not cuttable. If a milestone is behind, we cut features, not tests. The CI gate on each milestone's tests is the enforcement mechanism.

## Calendar arithmetic

For one engineer working full time:

- M0: 1 week
- M1: 2 weeks
- M2: 3 weeks
- M3: 3 weeks
- M4: 3 weeks
- M5: 2 weeks
- M6: 2-3 weeks

Total: 16-17 weeks of effort, about 4 months of calendar with normal overhead.

For two engineers, the parallelizable splits are: M2 (one builds the connection state machine, the other builds the codecs), M3 (one builds pipelining + prepared cache, the other builds the codec long tail and the row-assembler closure work), M5 (one builds COPY, the other builds LISTEN + cursor + cancellation). M1, M4, M6 are harder to parallelize — they're either deeply sequential (the protocol layer in M1) or cross-cutting (the client layer in M4, hardening in M6).

Realistic two-engineer estimate: 10-12 weeks.

The biggest variance driver is how fast the first engineer can hit a productive flow on the protocol layer. M1 looks short on paper but the golden-test discipline and the SCRAM intricacies make it the most likely milestone to slip. If M1 ships in 3 weeks instead of 2, the rest of the schedule slides by a week and we don't try to make it up.

## What's after v0

For continuity. v0 ships, then:

- **v0.0.x** is bug fixes plus the small features deferred from v0: SCRAM channel binding if cut, COPY text format if cut, the savepoint structured API if cut, listener grace period if cut. Plus whatever real users find.
- **v0.5** adds the v0-out-of-scope features that don't change the architecture: ranges, multiranges, composite types and enums (with auto-discovery), the geometric types, network types, hstore. SSL `verify-ca` and `verify-full` modes.
- **v1.0** adds the codegen CLI for result-shape inference, multi-host failover, and read-replica routing. The architecture from v0 already supports the latter two; codegen is the big new surface.
- **v1.x** adds the alternative transports (HTTP, WebSocket) and the Bun/Deno/Workers adapters. This is where the serverless story from doc 0000 lands; it's a fair bit of work but it's all additive.
- **v2.0** is whatever we've learned by then. Logical replication, maybe. ORM-adjacent helpers, maybe (probably not in core). Whatever the migration story for the remaining `pg` users requires.

Each major version after v0 has its own design doc. We don't try to plan v2 right now — we plan v0 carefully and ship it, then learn from real usage.

## Definition of "ready to start"

What needs to be true for engineering to begin:

- Doc 0000 through doc 0006 are reviewed and approved (this one).
- The repository is created with the layout from doc 0000.
- The CI runner machine is provisioned and accessible (for milestone 0's bench harness setup).
- There's at least one engineer with full-time availability for the first 4 weeks (M0+M1+start of M2).

That's it. Everything else is in the docs.
