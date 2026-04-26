# pg-rocket design doc 0002: the connection layer

This is the layer that turns the protocol codec into a working PostgreSQL connection. It owns the socket, the state machine, the prepared-statement cache, and the pipeliner. It does not know about pools, transactions as a user-facing concept, or the `sql` tag. Its job is to let a caller send commands and receive results, in the right order, with the right error semantics, as fast as possible.

## Boundaries

The connection layer imports the protocol layer and a `Transport` interface. It exposes a `Connection` class to the layer above. It does not import `node:net` or `node:tls` directly — that's the transport adapter's job, and in v0 we ship exactly one adapter (`tcp.ts`) but the boundary stays clean so we don't have to refactor when adding more.

```
[client layer: sql tag, pool, transactions]
            ↓
   [connection layer: Connection]
       ↓                  ↓
[protocol layer]    [Transport]
                          ↓
                  [tcp.ts → node:net/tls]
```

The connection layer is allowed to import from `src/codecs/` because it needs to dispatch codecs by OID when assembling rows. Codecs themselves only depend on the protocol layer, so the dependency graph stays acyclic.

## The Transport interface

```ts
interface Transport {
  connect(options: TransportOptions): Promise<void>;
  write(bytes: Uint8Array): void;       // synchronous fire-and-forget
  read(): Promise<Uint8Array | null>;   // null = EOF
  upgradeToTls(options: TlsOptions): Promise<void>;
  peerCertificate(): Uint8Array | null; // DER bytes, for SCRAM-PLUS
  close(): void;
  readonly closed: boolean;
}
```

Three things to notice. First, `write` is synchronous and unbuffered at this level — the connection layer's writer already buffers, and double-buffering wastes copies. The transport just hands the bytes to the OS. Second, `read` returns chunks as they arrive; the connection layer is responsible for assembling messages from chunks. Third, the TLS upgrade is a method on the transport rather than a separate transport type, because the choreography (`SSLRequest` → one byte → upgrade) crosses layers.

The Node TCP transport wraps a `net.Socket` (later upgraded to `tls.TLSSocket`). It uses `socket.write(bytes)` for writes, ignoring the return value because backpressure at this level is the kernel's problem and we have a bounded write buffer above. Reads come from `'data'` events queued into a small ring buffer; `read()` awaits the next chunk or returns immediately if one is queued. `TCP_NODELAY` is set unconditionally — Nagle is wrong for our workload because we already coalesce.

## The Connection class

A `Connection` is a long-lived object that owns one socket, one read buffer, one write buffer, one prepared-statement cache, and one queue of in-flight commands. It exposes a small async surface to the layer above:

```ts
class Connection {
  constructor(options: ConnectionOptions);

  connect(): Promise<void>;              // socket + auth + ready
  query<T>(cmd: Command): Promise<QueryResult<T>>;
  beginCopyIn(cmd: CopyInCommand): Promise<CopyInStream>;
  beginCopyOut(cmd: CopyOutCommand): Promise<CopyOutStream>;
  cursor<T>(cmd: Command, batchSize: number): AsyncIterable<T[]>;
  cancel(): Promise<void>;               // sends CancelRequest on side connection
  close(): Promise<void>;                // sends Terminate, closes socket

  readonly status: 'connecting' | 'idle' | 'busy' | 'in_transaction'
                 | 'in_failed_transaction' | 'closed';
  readonly parameters: ReadonlyMap<string, string>;  // server's ParameterStatus
  readonly processId: number;
  readonly secretKey: number;            // for cancel
}
```

The shape is deliberately flat. There's no `Client` vs `Pool` vs `PoolClient` distinction at this layer — that's a complication the pool introduces above. A `Connection` is a connection.

Commands aren't strings; they're records:

```ts
interface Command {
  sql: string;
  params: ParameterValue[];          // already encoded values + their OIDs
  resultMode: 'objects' | 'raw' | 'values';
  signal?: AbortSignal;
}
```

The `sql` tag's job is to produce these from a template literal. The connection layer doesn't know about template literals or about identifier helpers — it just sees finished SQL with `$1`, `$2`, etc.

## State machine

The state machine has six states and the transitions are driven by `ReadyForQuery`'s status byte from the server, not by client-side bookkeeping. This is non-negotiable: if the client and server disagree about whether we're in a transaction, weird things happen, and the disagreement is always the client's fault.

```
            connect()
              ↓
       ┌─────────────┐
       │ connecting  │
       └──────┬──────┘
              │ AuthenticationOk + ReadyForQuery(I)
              ↓
       ┌─────────────┐  ←─────────────────────────────┐
       │    idle     │                                │
       └──────┬──────┘                                │
              │ query() / beginCopy* / cursor()       │
              ↓                                       │
       ┌─────────────┐                                │
       │    busy     │                                │
       └──────┬──────┘                                │
              │ ReadyForQuery(I) → idle               │
              │ ReadyForQuery(T) → in_transaction ────┤
              │ ReadyForQuery(E) → in_failed_tx  ─────┤
              │ CopyInResponse → copy_in (sub-state)  │
              │ CopyOutResponse → copy_out (sub-state)│
              │ network/protocol error → closed       │
              ↓                                       │
       ┌─────────────┐                                │
       │   closed    │ (terminal)                     │
       └─────────────┘                                │
```

`in_transaction` and `in_failed_transaction` behave like `idle` for command dispatch — they accept new queries — but they're surfaced to the layer above so it can refuse to release a connection back to the pool while a transaction is open.

Two subtle rules. First, the status from `ReadyForQuery` overrides any client-side guess. If the user runs `BEGIN` via raw SQL instead of through `db.begin()`, we still notice because the server tells us. Second, `in_failed_transaction` is sticky until the user sends `ROLLBACK` or `COMMIT` (which also rolls back, with a warning) — every other query in this state will return an error from the server, and we surface those errors as-is.

The state machine doesn't run on a separate task or async generator. It's a synchronous dispatch from the read loop: the read loop pulls a chunk from the transport, feeds the protocol reader, and for each `MessageRecord` the reader produces, the state machine handles it. Handling is a switch on the message type with effects on the in-flight command queue and the connection state. No promises, no generators, no async/await on the message-handling path. Promises happen at the boundary where commands enter (`query()` returns a promise) and where their results resolve.

## The in-flight command queue

A pipelined connection can have many commands in flight. We need to know which response messages belong to which command. The queue is a singly-linked list (cheap to enqueue/dequeue, no array shifting):

```ts
interface InFlightCommand {
  // What we're waiting for:
  expectingParseComplete: boolean;
  expectingBindComplete: boolean;
  expectingDescribe: 'rowdesc' | 'parameter' | 'either' | null;
  expectingExecuteComplete: boolean;     // CommandComplete or PortalSuspended
  expectingSync: boolean;                // ReadyForQuery

  // Where to put the data:
  preparedStatement: PreparedStatement | null;  // populated on Parse path
  rowDescription: ColumnDescription[] | null;   // from cache or RowDescription
  rows: unknown[];                              // accumulator
  rowAssembler: (record: MessageRecord) => unknown;

  // How to settle:
  resolve: (result: QueryResult) => void;
  reject: (error: Error) => void;

  // Linkage:
  next: InFlightCommand | null;
}
```

Why "expecting" flags rather than a per-command sub-state machine? Because the message ordering for an extended-query sequence is fully determined by what we sent. If we sent `Parse`+`Bind`+`Describe`+`Execute`+`Sync`, we get exactly `ParseComplete`+`BindComplete`+(`RowDescription`|`NoData`)+`DataRow`*+`CommandComplete`+`ReadyForQuery`. Set the flags when we send, clear them as messages arrive, settle the promise on `ReadyForQuery`.

The queue head is the current command. When `ReadyForQuery` arrives, we settle the head's promise and shift to the next. If the head fails (an `ErrorResponse` arrives), we settle with an error but we don't drop subsequent in-flight commands from the queue — Postgres handles that for us: in extended-query mode, after an error, the server discards everything up to the next `Sync` and returns `ReadyForQuery(E)` for each. We see one `ReadyForQuery` per `Sync` we sent, and we settle one queue entry per `ReadyForQuery`. Each settles with the appropriate error (`InFailedSqlTransaction` or the original error propagated).

This is the right way to handle pipelined errors and it's the place that's easiest to get wrong. The contract we expose to callers is: if you pipeline N queries and the third one fails, the first two settle normally, the third settles with its actual error, and queries four through N settle with `QueryCanceled`-shaped errors carrying `cause: <the original error>`. This matches what `postgres.js` does for pipelines and what most callers expect.

## Sending an extended query

The fast path for a query with N parameters, given a hit in the prepared cache:

```
write Bind 'p_<hex>' 's_<hex>' [params]
write Execute 'p_<hex>' 0
write Sync
flush()
```

That's three messages, one syscall, one TLS record. The portal name and statement name are deterministic hex strings derived from the SQL hash, so the client and server agree without negotiation. We use named portals (rather than the unnamed portal `''`) so concurrent pipelined commands can each have their own — the unnamed portal is overwritten by every `Bind`, which serializes everything.

Cache miss path:

```
write Parse 's_<hex>' <sql> [param OIDs]
write Bind 'p_<hex>' 's_<hex>' [params]
write Describe 'S' 's_<hex>'      # ask for parameter and row descriptions
write Execute 'p_<hex>' 0
write Sync
flush()
```

We send `Describe` against the statement (`'S'`, not `'P'`) and only on the miss path. The server returns `ParameterDescription` followed by either `RowDescription` or `NoData`. We cache both on the `PreparedStatement` record — parameter OIDs (so we can validate types on subsequent calls without a round trip), and the column metadata with codecs already resolved. Subsequent hits skip the `Describe` entirely; `RowDescription` would have been on every execution otherwise, and skipping it is meaningful savings on small-row workloads.

The `Bind` message is where the codec system meets the wire. For each parameter:

1. Look up the codec by the parameter's declared OID (or by the JS value's runtime type if the user didn't declare).
2. The codec writes a placeholder int32 length, encodes the value into the writer's buffer in binary format, then patches the length retroactively.
3. Null values write `-1` for the length and no payload.

Format codes for `Bind`: we send a single `1` (binary) for all parameters and a single `1` (binary) for all results. The "single format code applies to all" is a wire-level shortcut that saves bytes on every bind.

## Prepared statement cache

Per-connection LRU, keyed on the SQL string, default capacity 100. The data structure is a `Map` plus a doubly-linked list — `Map` for O(1) lookup, list for O(1) eviction. JavaScript's `Map` preserves insertion order, which is tempting to use as the LRU directly, but `Map.delete` + `Map.set` to bump-to-MRU is two map ops per access; the explicit list is one pointer rewire.

```ts
interface PreparedStatement {
  name: string;                          // 's_' + 16 hex chars
  sql: string;                           // for re-prepare on invalidation
  parameterOids: number[];
  columns: ColumnDescription[] | null;   // null = no result rows
  parameterEncoders: BinaryEncoder[];    // resolved at prepare time
  columnDecoders: BinaryDecoder[];       // ditto
  rowAssembler: RowAssembler;            // pre-built closure

  // LRU linkage:
  prev: PreparedStatement | null;
  next: PreparedStatement | null;
}
```

The hash for the name is FNV-1a 64-bit over the UTF-8 bytes of the SQL string. We compute it once when the `sql` tag freezes the strings array (template literals' `strings` array is reference-stable across calls to the same tagged template at the same call site, so we can attach the hash as a `WeakMap` entry and reuse it). The name is `'s_' + hash.toString(16).padStart(16, '0')`. Determinism matters for two reasons: it makes `pg_prepared_statements` debugging readable, and it means two different connections preparing the same query end up with the same name on the server, which makes connection-pooler scenarios (PgBouncer in transaction mode) behave more predictably.

Eviction: when the cache is full, the LRU tail is evicted. Eviction sends a `Close` message for the statement so the server frees its plan. This is fire-and-forget — we don't wait for `CloseComplete` before reusing the connection. It rides along with the next batch.

Invalidation: two SQLSTATEs trigger automatic re-prepare. `0A000` (`feature_not_supported`) and `26000` (`invalid_sql_statement_name`) — the first happens when a cached plan is invalidated by a schema change, the second if the server lost the statement (e.g., PgBouncer reset the session). On either, we evict the cache entry, re-prepare, and retry the query exactly once. Any other error is surfaced as-is. The retry is invisible to the caller and counts as one query for observability purposes (we record the re-prepare in the `onQuery` hook with a `prepared: 'retry'` flag for visibility).

A user-facing knob: `db.discardPrepared({ matching?: RegExp })`. Default scope is the calling connection, but the pool variant fans out to every connection. This is the escape hatch for cases the SQLSTATE-based invalidation misses — for example, when the user knows they just ran a migration and wants to be sure.

## Pipelining

Pipelining is not a flag, it's the default. The mechanic is: `query()` puts a command on the queue, schedules a microtask to flush the writer, and returns a promise. Multiple `query()` calls in the same microtask all enqueue, and the flush at the end of the microtask sends them all in one `socket.write`.

```ts
async query(cmd: Command): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const inflight = this.encodeAndEnqueue(cmd, resolve, reject);
    this.scheduleFlush();
  });
}

private scheduleFlush(): void {
  if (this.flushScheduled) return;
  this.flushScheduled = true;
  queueMicrotask(() => {
    this.flushScheduled = false;
    if (this.writer.hasBytes()) {
      this.transport.write(this.writer.drain());
    }
  });
}
```

`queueMicrotask` is the right primitive here, not `setImmediate` or `process.nextTick`. It runs at the end of the current synchronous tick, after all `Promise.all` siblings have enqueued, but before any I/O or timers. The result is that `await Promise.all([db.query(a), db.query(b), db.query(c)])` produces exactly one `socket.write` call carrying all three queries' bytes.

The pipeliner has no maximum batch size in v0. Postgres's protocol has no batch limit either — you can send as many `Bind`+`Execute`+`Sync` triples back-to-back as you want, bounded only by the server's `max_stack_depth` for very large counts. In practice the writer's buffer growth handles this naturally; if a user pipelines 10000 queries we just grow the buffer.

There's one subtlety with `Sync`: it sets a transaction boundary. In an extended-query batch without `Sync` between queries, an error in query 3 would prevent queries 4-N from running. We send `Sync` after every `Execute`, which means each query is independent for error purposes — query 3 fails, queries 4-N still execute. This matches `pg`'s semantics (which also syncs per query) and avoids surprising users who are used to "errors don't cascade." For users who want all-or-nothing semantics, that's what transactions are for; the connection layer doesn't try to be clever about it.

## Row assembly

When `Parse` is processed and codecs are resolved, we build a row-assembler closure for the prepared statement. Three flavors, one per result mode:

```ts
// resultMode: 'objects'
function assembleObject(record, view): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  let offset = record.start + 2;  // skip int16 field count
  for (let i = 0; i < columns.length; i++) {
    const len = view.getInt32(offset, false);
    offset += 4;
    row[columnNames[i]] = len < 0
      ? null
      : decoders[i](view, offset, len);
    if (len > 0) offset += len;
  }
  return row;
}
```

The `columnNames` and `decoders` arrays are closed over — no property access into a `ColumnDescription` per cell. The row object is built with assignment to known string keys, which V8 optimizes into a hidden class once the same column set is observed twice (and our prepared cache makes that the common case). The shape is stable for the lifetime of the prepared statement.

For `'raw'` mode the body builds an array. For `'values'` mode (single column) it returns the decoded value directly without wrapping. Three flavors exist because the assembler is on the per-row hot path and a runtime branch on the mode would cost real cycles.

A small but real optimization: when all decoders in the row are "trivial" (the int4, int8, float8, bool, text fast paths that read a known fixed width or a length-prefixed string and don't allocate beyond the result), we can generate a specialized assembler at prepare time using `new Function(...)`. We keep this behind a flag for v0 — `Function` constructor invocations are blocked by some content security policies and we don't want the default to surprise people. For v0 we rely on V8's monomorphic-call-site optimization, which handles the common case nearly as well.

## Cursors and large result sets

The default `query()` accumulates all rows in memory. For large result sets, the connection layer exposes `cursor(cmd, batchSize)` which returns an async iterable of row batches:

```ts
const cursor = conn.cursor({ sql: 'select * from big', params: [] }, 1000);
for await (const batch of cursor) {
  for (const row of batch) {
    // ...
  }
}
```

Implementation: at the protocol level this uses a non-zero `Execute` row limit. Send `Execute 'p_<hex>' 1000`, the server returns up to 1000 `DataRow`s followed by `PortalSuspended` (not `CommandComplete`). Send another `Execute` for the next batch. When the server eventually returns `CommandComplete`, the cursor is exhausted. We send `Sync` only at the end (not per batch), so the prepared statement and portal stay alive across batches.

The async iterable's `return()` and the `await using` pattern (`await using cursor = ...`) close the portal early, sending `Close 'P' 'p_<hex>'` followed by `Sync`. This is the only place in v0 where we explicitly close a portal — for non-cursor queries the implicit close at `Sync` end-of-transaction handles cleanup.

Backpressure: the cursor's `next()` only sends the next `Execute` after the consumer awaits. The protocol's row-limit semantics give us natural backpressure at the server boundary — the server stops producing rows when it hits the limit. The transport's read buffer bounds memory in the meantime (chunks accumulate but the read buffer is sized to a few MB max; if the consumer is slow enough that we'd overflow, we apply transport-level backpressure by pausing the socket until the read buffer drains).

## COPY in and out

`COPY FROM STDIN` (insert) and `COPY TO STDOUT` (select) are first-class because bulk insert is a major performance lever and `pg`'s ergonomics here are notoriously bad.

`beginCopyIn(cmd)` sends `Query` with the COPY statement, awaits `CopyInResponse`, and returns a `CopyInStream` that exposes `write(bytes)` and `end()`/`fail(reason)`. Each `write` produces a `CopyData` frontend message; `end()` produces `CopyDone`. The stream is a `WritableStream<Uint8Array>` so it composes with `pipeTo`/`pipeFrom` and other streams.

`beginCopyOut(cmd)` similarly returns a `CopyOutStream` that's a `ReadableStream<Uint8Array>`. The stream emits chunks corresponding to `CopyData` messages from the server.

Format: we expose both text and binary COPY formats. Binary is dramatically faster for bulk insert because it skips server-side text parsing. We provide a small helper, `copyBinaryEncoder([oids])`, that encodes rows in binary COPY format using the same codec table as `Bind`. Text COPY is the default (more debuggable, more familiar) but binary is one option flag away.

The COPY substate is non-trivial because the connection is in a special protocol mode where only `CopyData`, `CopyDone`, and `CopyFail` are valid frontend messages. We track this with a `copyMode` enum on the connection (`'in' | 'out' | null`) and the state machine refuses non-COPY commands while it's set. Exiting COPY mode happens on `CommandComplete`, which arrives after `CopyDone` (in) or after the server finishes streaming (out).

## LISTEN and NOTIFY

`db.listen(channel, handler)` runs `LISTEN <channel>` (with the channel quoted as an identifier) and registers the handler. The connection layer accumulates handlers in a `Map<string, Set<NotificationHandler>>`. When `NotificationResponse` arrives — which can happen at any time the server has something to deliver, between commands or even during the read of a result — the dispatch fires synchronously into all registered handlers for that channel.

There's a wrinkle: a connection that's in the middle of a query will buffer notifications until `ReadyForQuery`. Postgres only delivers `NotificationResponse` between commands (or when the backend processes a `Sync`), so this is the server's behavior, not ours. For users who need low-latency notifications, the right pattern is a dedicated listener connection that's always idle; the pool layer above provides a `db.listen()` API that pulls and holds a connection just for this.

Notifications carry: process ID of the sender, channel name, and a payload string. Payload size is bounded by Postgres at ~8000 bytes and we don't add restrictions.

## Cancellation

Postgres requires cancellation to ride a separate connection — sending a cancel on the same connection is impossible because that connection is busy executing the query you want to cancel. The protocol spec defines `CancelRequest`, a special message sent on a fresh, unauthenticated connection, carrying the target connection's process ID and secret key (received in `BackendKeyData` at connect time).

`AbortSignal` integration is at the `query()` level. When the signal aborts:

1. Open a new TCP connection (or TLS, matching the original's settings).
2. Send `CancelRequest(processId, secretKey)`.
3. Close the side connection immediately — the protocol doesn't expect a response.
4. The original connection sees its query error with SQLSTATE `57014` (`query_canceled`) and surfaces it as `QueryCanceled` to the awaiting caller.

The caller's `query()` promise rejects with `QueryCanceled`. The connection is still healthy — the next query works fine. Critically, we don't try to cancel a query that hasn't started yet: if the signal fires before `Sync` is written, we just remove the command from the queue and reject locally without involving the server.

The side-connection cost is a real concern: a TCP+TLS handshake is in the ~1-2 ms range for local Postgres, more for remote. We don't pool side connections (cancellation is rare and pooling them would mean keeping idle TCP connections around for a feature most users never use). The cost is documented and acceptable.

## Errors

The connection layer translates wire errors into JS exceptions via the error hierarchy from doc 0000:

- `ErrorResponse` from the server → `PgError` (or one of the SQLSTATE subclasses).
- Transport errors (socket closed unexpectedly, TLS handshake failed) → `ConnectionError`.
- Protocol violations from the server → `ProtocolError` (rare; usually means the server isn't actually Postgres-compatible).
- Auth failures → `AuthenticationError`.
- Cancellation → `QueryCanceled`.

A connection that observes a `ConnectionError` or `ProtocolError` transitions to `closed` and rejects all in-flight commands. The pool above replaces the connection on next acquire. A connection that observes a `PgError` stays open — these are normal query errors and the connection is fine.

One specific case worth calling out: `ErrorResponse` during the connect/auth handshake (e.g., wrong password, role doesn't exist, database doesn't exist) is fatal. The server closes the connection after sending it, and we propagate it as a rejection from `connect()` rather than from a subsequent `query()`. The user sees the error at the point they tried to establish the connection, which is the right place.

## Connection lifecycle

```
new Connection(opts)
  → status: 'connecting'
  → transport.connect()
  → optional: write SSLRequest, read 1 byte, transport.upgradeToTls()
  → write StartupMessage
  → handle Authentication* messages until AuthenticationOk
  → buffer ParameterStatus messages into this.parameters
  → receive BackendKeyData, save processId + secretKey
  → receive ReadyForQuery, transition to 'idle'
  → connect() resolves

[normal operation: query/copy/cursor/listen]

close()
  → write Terminate
  → transport.close()
  → status: 'closed'
  → reject all in-flight commands with ConnectionError('closed')

[unexpected close]
  → transport read returns null or throws
  → status: 'closed'
  → reject all in-flight commands
  → emit close event for pool to observe
```

The connection has no automatic reconnection. That's a pool-layer concern. If a connection dies, the pool replaces it; a `Connection` object's lifecycle is "connect once, close once."

## Health checks

The pool layer wants to validate idle connections occasionally. We expose a cheap `Connection.ping()` that sends `Sync` (no `Parse`/`Bind`/`Execute`) and awaits `ReadyForQuery`. This is a single round-trip, no parser work on the server, no log noise. Used by the pool when an acquired connection has been idle past a threshold.

## Configuration

```ts
interface ConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | (() => Promise<string>);  // lazy callback for IAM auth, etc.
  ssl: 'disable' | 'prefer' | 'require';       // verify-* deferred
  applicationName?: string;
  connectionTimeoutMs?: number;                 // for the TCP+TLS+auth phase
  statementCacheSize?: number;                  // default 100
  keepAlive?: boolean;                          // default true, sets SO_KEEPALIVE
  noDelay?: boolean;                            // default true, TCP_NODELAY
  onNotice?: (notice: PgNotice) => void;
  onParameterStatus?: (key: string, value: string) => void;
}
```

`connectionTimeoutMs` covers the entire connect-and-authenticate phase. After `idle` is reached, there's no library-imposed timeout — that's the caller's job via `AbortSignal`. We don't ship a per-query default timeout because the right value is workload-dependent and a default is wrong for somebody.

The `password` field accepts a function for cases where the password is dynamic (AWS RDS IAM tokens, GCP Cloud SQL IAM, vault-fetched secrets). The function is called once per `connect()`, awaited, and the result is used for auth. It's not called on every query.

## Files in this layer

```
src/connection/
├── transport.ts          # Transport interface, TransportOptions, TlsOptions
├── tcp.ts                # Node TCP transport — the only adapter in v0
├── connection.ts         # Connection class
├── state-machine.ts      # State enum, transition table, message dispatcher
├── prepared-cache.ts     # LRU + Map combo, FNV-1a hashing
├── pipeliner.ts          # microtask scheduling, write coalescing
├── command-queue.ts      # InFlightCommand linked list
├── row-assembler.ts      # the three result-mode assemblers
├── copy-stream.ts        # CopyInStream and CopyOutStream
├── cursor.ts             # async-iterable cursor
└── index.ts
```

Target line count: 2500-3500 lines including comments. State machine and connection class are the bulk; everything else is small.

## Performance budgets

Per-query overhead at the connection layer (excludes protocol layer, codec time, network):

- Cache hit: < 200 ns from `query()` call to bytes in writer buffer (excludes await).
- Cache miss: < 500 ns.
- Result assembly: < 50 ns per row of overhead (excludes per-cell codec time).
- Microtask flush dispatch: < 50 ns per batch.

These are enforceable via microbenchmarks against a fake transport that buffers writes and serves canned responses. The fake-transport tests are also where we test pipelining, error cascades, and state transitions deterministically — no real Postgres needed for the unit tests of the state machine.

## Tests

**State machine tests** drive the dispatcher with canned message sequences. For every `(state, message)` pair: assert the resulting state and the side effects on the in-flight queue. Coverage requirement: every cell in the transition table.

**Pipeline tests** issue N concurrent queries against the fake transport, assert that the bytes written form a single coalesced batch, and assert that the responses are dispatched to the right queue entries.

**Error cascade tests**: issue 5 queries, inject an `ErrorResponse` for query 3, assert queries 1-2 settle normally, query 3 settles with the injected error, queries 4-5 settle with `InFailedSqlTransaction` carrying the original as `cause`.

**Prepared cache tests**: assert deterministic statement names, LRU eviction order, automatic re-prepare on `0A000` and `26000`, and that `discardPrepared` evicts and sends `Close`.

**Integration tests** against real Postgres exercise the full stack — these are the same docker-compose harness from doc 0001. New scenarios for this layer: `LISTEN`/`NOTIFY` round trip, `COPY` text and binary, cursor with batches, cancellation via signal, connection death during a query, schema change invalidating prepared plan.

**Soak test**: a connection running for an hour, executing a mix of SELECT/INSERT/UPDATE/notify, with allocation tracking. Asserts steady-state heap is bounded — no leaks in the cache, the queue, or the buffers.

## What's deliberately not here

No pool. No `sql` template tag. No transaction abstraction (we expose connection state but the user-facing `db.begin()` is in the client layer). No retry logic, no circuit breaker, no failover. No URL parsing. No observability framework — we expose hooks but don't dictate how they're wired. No automatic reconnection — that's the pool's job because reconnection only makes sense in the context of a pool's "give me a working connection" semantics.

A concrete example: if you want a query to retry on `40001` (serialization failure), the right place is the client layer or the user's code, not the connection layer. The connection layer surfaces the error and returns to `idle`; what to do about it is a policy decision and policy lives above us.
