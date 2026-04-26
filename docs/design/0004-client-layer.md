# pg-rocket design doc 0004: the client layer

This is the layer users actually touch. Everything below it has been about correctness and throughput; this layer is about ergonomics without giving back the performance the lower layers worked for. The core pieces are the `sql` template tag, the pool, transactions, and the observability hooks. Each is small in code but every choice shows up immediately in the API surface.

## Boundaries

The client layer imports the connection layer, the codec layer, and the protocol layer's error types. It does not import `node:*` directly — that's still the transport's job. The public API (`createClient`, the `sql` tag, `db.begin`, `db.listen`, `db.copy`) all lives here. Nothing imports this layer except user code.

```
[user code]
     ↓
[client layer: createClient, sql tag, pool, transactions]
     ↓
[connection layer]
     ↓
[protocol + codecs]
```

The client layer is also where URL parsing lives, because connection strings are the user-facing entry point and have nothing to do with the wire protocol.

## The shape of the public API

```ts
import { createClient } from 'pg-rocket';

const db = createClient({
  url: process.env.DATABASE_URL!,
  // pool, ssl, types, observability — all optional
});

// Simple query
const users = await db.sql<User[]>`
  select id, email from users where org_id = ${orgId}
`;

// Transaction
await using tx = await db.begin();
await tx.sql`update accounts set balance = balance - ${amount} where id = ${from}`;
await tx.sql`update accounts set balance = balance + ${amount} where id = ${to}`;
await tx.commit();

// Streaming
for await (const batch of db.cursor<Row>(sql`select * from huge_table`, 1000)) {
  for (const row of batch) process(row);
}

// Bulk insert
const stream = await db.copy.in('users', ['email', 'name']);
await stream.write(rows);
await stream.end();

// LISTEN
await db.listen('user_events', (payload) => { /* ... */ });

// Cleanup
await db.close();
```

Six top-level entry points on `db`: `sql`, `begin`, `cursor`, `copy`, `listen`, `close`. That's the entire surface. Helpers hang off `sql` (`sql.id`, `sql.unsafe`, `sql.values`, `sql.array`, `sql.raw`, `sql.cast`). Internal classes (`Connection`, `PreparedStatement`, etc.) are not exported.

## The sql template tag

This is the API choice that defines the library, so it deserves its own section.

A tagged template call gives the function two arguments: a `strings: TemplateStringsArray` (the literal pieces) and `...values: unknown[]` (the interpolated expressions). The job of the `sql` tag is to convert these into a `Command` that the connection layer can execute.

The transformation is parameter-substitution, not string-substitution. For `sql\`select * from users where id = ${id} and name = ${name}\``, we produce SQL `select * from users where id = $1 and name = $2` and a parameters array `[id, name]`. The user's values never become part of the SQL string, which is the entire point.

The fast path:

```ts
function sql<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
  // For most calls, every value is a plain parameter.
  let text = strings[0];
  for (let i = 0; i < values.length; i++) {
    text += '$' + (i + 1) + strings[i + 1];
  }
  return execute({ sql: text, params: values });
}
```

This is the 95% case: simple string concatenation with `$N` placeholders, no helpers, no fragments. Runs in tens of nanoseconds. The hot path stays hot.

The slow path is when an interpolated value is itself a "fragment" produced by `sql\`...\``, or an identifier wrapped by `sql.id(...)`, or an unsafe string from `sql.unsafe(...)`, or a values-list from `sql.values(...)`. Those values aren't parameters — they need to be inlined into the SQL text in some way, with parameter renumbering. We detect by checking if the value is an instance of an internal `SqlPart` class. The check is `value instanceof SqlPart`, which is a single hidden-class compare in V8 and adds maybe 1 ns per value when the result is false. Once we see one `SqlPart`, we drop into a more careful builder.

The internal types (not exported, but the user sees them through helpers):

```ts
class Fragment {
  constructor(
    public readonly strings: readonly string[],
    public readonly values: readonly unknown[],
  ) {}
}

class Identifier {
  constructor(public readonly name: string) {}
}

class Unsafe {
  constructor(public readonly text: string) {}
}

class ValuesList {
  constructor(
    public readonly rows: readonly Record<string, unknown>[],
    public readonly columns: readonly string[],
  ) {}
}

class Cast {
  constructor(public readonly value: unknown, public readonly type: string) {}
}
```

The slow-path builder walks the `(strings, values)` pair, accumulating a `text: string[]` (joined at the end with `''.join`) and a `params: unknown[]`. For each value:

- A `Fragment` recursively flattens, with parameter renumbering. Its strings are appended; its values are processed in turn.
- An `Identifier` is quoted (per Postgres rules: replace `"` with `""`, wrap in `"..."`) and inlined as text.
- An `Unsafe` is inlined as raw text. Documented as the escape hatch for cases like dynamic ORDER BY columns with whitelisted values, and named loudly so it shows up in code review.
- A `ValuesList` expands to `(($1, $2, ...), ($N+1, $N+2, ...), ...)` syntax with parameters appended to the params array. A 1000-row insert produces one large bind with 1000×K parameters.
- A `Cast` becomes `$N::type` and the value is added to params.
- Anything else (a plain JS value) becomes `$N` and the value is added to params.

Parameter numbers are assigned in left-to-right traversal order, which means a fragment composed of `[outer-prefix-params, inner-fragment-params, outer-suffix-params]` gets a contiguous numbering. This matters for nested fragments like `sql\`select * from t where ${someCondition} and ${anotherCondition}\`` where each condition is itself a fragment.

The critical efficiency choice: we don't build the SQL string until we know we have to. For the fast path, where all values are plain parameters, we don't need any of the `SqlPart` machinery — we go straight to `Command` construction. For the slow path, we build once and cache the result on the template's `strings` array via a `WeakMap`. Subsequent calls with the same template (which means the same `strings` reference, because tagged templates reuse the literal array across calls) skip the rebuild and just plug in the new parameter values.

```ts
const fragmentCache = new WeakMap<TemplateStringsArray, CompiledFragment>();

interface CompiledFragment {
  text: string;            // 'select * from users where id = $1'
  paramIndices: number[];  // which value-slots of the original template are params
  // (and indices of which inner fragments to flatten, etc.)
}
```

For nested fragments, the cache key is the outermost `strings`. Inner fragments are recompiled if their cached form is invalidated, but in practice the inner fragment's `strings` is also stable — fragments built at a stable call site reuse their compilation.

This caching matters because `sql.values(rows)` with a fixed column list and a varying number of rows produces a different SQL string per call (with a different number of `($N, ...)` groups), but the rest of the template stays stable. We split the cache key to include the row count for `ValuesList` cases.

## The fragment composition rule

A user writes:

```ts
const filter = sql`active = ${true} and verified = ${true}`;
const result = await db.sql<User[]>`select * from users where org_id = ${orgId} and ${filter}`;
```

The result should be `select * from users where org_id = $1 and active = $2 and verified = $3` with params `[orgId, true, true]`. This means fragment composition flattens, renumbers, and is type-stable.

The flattening rule, stated precisely: every value position in the outer template that holds a `Fragment` is replaced by the fragment's text (with its own param positions renumbered to start where the outer template's running count is), and the fragment's values are inserted into the outer params array at the corresponding position.

Implementation walks recursively but avoids reallocating per level. We pre-pass to count total parameters (accumulating a recursive walk to size the params array), then second-pass to fill text and params. The two-pass is faster than one-pass-with-array-grow for fragments with more than ~5 parameters total, which most queries hit.

A user can build SQL programmatically with confidence: writing `where ${conditions.map(c => sql\`...\`)}` is supported (an array of fragments is treated as fragments joined by `' and '` by default, with `sql.join(parts, separator)` for explicit separators). This subsumes most query-builder use cases without us shipping a query builder.

## The identifier and other helpers

```ts
sql`select * from ${sql.id(tableName)} where ${sql.id(columnName)} = ${value}`;
```

`sql.id` is the right answer for "I have a string that needs to go into the SQL text but I want it to be safe." Quoting follows Postgres rules exactly: wrap in `"..."`, escape internal `"` as `""`. Reject strings containing NUL bytes (`\0`) — Postgres doesn't allow them in identifiers, so they're either malicious or buggy.

Multi-part identifiers via `sql.id('schema', 'table')` produce `"schema"."table"`. Useful for dynamic schema selection.

`sql.unsafe(text)` is the documented escape hatch. Users grep for it in code review.

`sql.values(rows)` and `sql.values(rows, columns)`:

```ts
await db.sql`insert into users ${sql.values(records)}`;
// expands to: insert into users ("col1", "col2", ...) values ($1, $2, ...), ...
```

If `columns` isn't passed, it's derived from `Object.keys(rows[0])`. The expansion produces both the column list (as `(col1, col2, ...)`) and the values clause. Each value goes through the codec layer for binary encoding — bulk inserts via `sql.values` are dramatically faster than text-format `INSERT INTO ... VALUES (...)` strings because the encoding happens once per cell at the binary layer rather than once per cell as a string formatter.

For inserts of more than a few hundred rows, `sql.values` is fine but `db.copy.in` is faster. We document the crossover.

`sql.array(values)` for parameterizing array values:

```ts
await db.sql`select * from users where role = any(${sql.array(['admin', 'editor'])})`;
```

Without this, a JS array passed as a parameter would be ambiguous — is it an array parameter or a list-of-positional-parameters? `sql.array` makes the intent explicit and tells the codec layer to use the appropriate array codec.

`sql.cast(value, type)`:

```ts
await db.sql`insert into events (data) values (${sql.cast(payload, 'jsonb')})`;
```

Generates `$N::jsonb`. Useful when the parameter type can't be inferred from context — for example, a `null` parameter has no inferable type, and the server can reject the bind. The cast disambiguates.

`sql.raw(text)` is `sql.unsafe(text)` aliased for one specific use: building dynamic ORDER BY directions. It's still an escape hatch; the alias just reads better at the call site.

`sql.join(parts, separator = ' and ')` for joining fragments:

```ts
const conditions = filters.map(f => sql`${sql.id(f.column)} = ${f.value}`);
const where = sql.join(conditions, ' and ');
await db.sql`select * from users where ${where}`;
```

## Parameter type inference at the type level

Given how the `sql` tag is used, we can do meaningful TypeScript inference:

```ts
declare function sql<T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]>;
```

The user supplies `T` explicitly when they care about the row shape — this is the v0 contract. We don't try to parse the SQL at the type level for column-shape inference; that's a v1 codegen feature.

What we *do* do at the type level is constrain `values`:

```ts
type SqlValue =
  | string | number | bigint | boolean | null | undefined
  | Date | Uint8Array
  | SqlValue[]                       // arrays
  | { [key: string]: SqlValue }      // for jsonb
  | SqlPart;                          // fragments, identifiers, etc.

declare function sql<T = unknown>(
  strings: TemplateStringsArray,
  ...values: SqlValue[]
): Promise<T[]>;
```

This catches at compile time the common error of passing a complex object that isn't intended as JSON (like a class instance, or a function). The constraint isn't perfectly tight — `Record<string, SqlValue>` is permissive — but it's tight enough to catch the obvious bugs.

For result inference, we expose a typed escape:

```ts
const users = await db.sql<{ id: string; email: string }>`
  select id, email from users
`;
// users: { id: string; email: string }[]
```

The result is always an array. Users who want a single row use `await sql\`...\`.then(r => r[0])` or the (slightly-shorter) `await db.sqlOne<User>\`...\``, which we provide as a convenience and which throws if the result isn't exactly one row. We don't ship `sqlOptional` or `sqlMany` — the `[0]` and the array map naturally enough.

## Result modes on the tag

The fast-path `sql` tag returns an array of objects. For hot loops where object construction is the cost, switch modes:

```ts
const counts = await db.sql.values<number>`select count(*) from users group by org_id`;
// counts: number[]

const rows = await db.sql.raw<[string, string]>`select id, email from users`;
// rows: [string, string][]
```

`sql.values` is for single-column queries — returns the column directly, no wrapping. `sql.raw` is for multi-column queries where you want tuples. Both bypass object construction. They route to the same `Command` shape with `resultMode: 'values' | 'raw'`.

Note these are properties on the `sql` function, not separate functions. Users discover them via autocomplete naturally.

## Transactions

```ts
await using tx = await db.begin();
await tx.sql`update ...`;
await tx.commit();
```

Or with explicit isolation:

```ts
await using tx = await db.begin({ isolation: 'serializable', readOnly: false });
```

Or with a callback (some users prefer it, both styles work):

```ts
const result = await db.transaction(async (tx) => {
  const a = await tx.sql`...`;
  const b = await tx.sql`...`;
  return { a, b };
});
```

The callback form rolls back on thrown exceptions, commits on normal return, and propagates the return value. We provide both because the disposable form is cleaner for procedural code and the callback form is cleaner for "run this whole logical operation atomically."

The `tx` object is a `Transaction` that has the same `sql`, `cursor`, and `copy` methods as `db`. It does not have `begin` (no nested transactions — use `savepoint`), `listen` (LISTEN doesn't make sense in a transaction), or `close` (the connection's lifetime is the transaction's lifetime).

Savepoints:

```ts
await using tx = await db.begin();
await tx.sql`...`;
await using sp = await tx.savepoint();
try {
  await sp.sql`risky operation`;
  await sp.commit();  // RELEASE SAVEPOINT
} catch {
  await sp.rollback();  // ROLLBACK TO SAVEPOINT (automatic on dispose if no commit)
}
await tx.commit();
```

A `Savepoint` is a `Transaction` with a different commit/rollback verb on the wire. The implementation is shared: both are subclasses of an internal `TransactionLike` that holds a connection and tracks its commit-or-rollback verb.

The transaction holds one connection from the pool for its entire lifetime. Querying `db.sql` while a transaction is open uses a different connection — they don't share state. We deliberately don't try to detect this case at runtime ("you ran a query on `db` while in a transaction; did you mean `tx`?"). It's the user's prerogative to do work in parallel. Unlike `pg`, we never silently pool-share within a transaction.

The disposal semantics are the place where `await using` earns its keep. If the transaction's body throws (or returns without committing), the dispose path runs `ROLLBACK` on the connection and releases it back to the pool. This is what makes `await using tx = await db.begin()` safe to use in code that might throw — the transaction is always cleaned up.

Disposal cost: one round trip to the server to send `ROLLBACK` (or `RELEASE` for savepoints). We don't try to batch this with a subsequent statement — the transaction state needs to be settled before the connection can be reused.

A subtle point: `await using` resolves the dispose function on synchronous throw or return, but the actual disposal is async. This means the function `async function foo() { await using tx = await db.begin(); ... }` doesn't *complete* (in promise terms) until the transaction has been disposed. Users get the right semantics for free: the next statement after `foo()` completes runs after the rollback has actually happened on the server. This is the killer feature of `await using` for database libraries.

## Pool

The pool is the layer that turns "I have a database" into "I have many connections to the database." Most of the API surface is on `db` directly, with the pool implicit underneath.

```ts
const db = createClient({
  url,
  pool: {
    max: 10,                      // default
    idleTimeoutMs: 30000,         // close idle connections after this
    connectionTimeoutMs: 5000,    // give up acquiring a connection after this
    statementCacheSize: 100,      // per connection
  },
});
```

The pool's behavior:

- Lazy creation: connections are created on demand up to `max`, not eagerly. The first `db.sql\`...\`` after `createClient` triggers one connection. Cold start of the library doesn't open any connections.
- Acquisition queue: when all connections are busy, additional `db.sql\`...\`` calls queue. The queue is FIFO (a doubly-linked list). When a connection becomes free, the head of the queue is woken.
- Idle timeout: connections idle longer than `idleTimeoutMs` are closed and dropped. Implemented via a coarse timer wheel (one `setInterval` per pool, scanning for expirations) instead of per-connection `setTimeout`. The wheel's tick rate is `idleTimeoutMs / 4`, so we close connections within ~25% of the configured timeout.
- Health checks: a connection that's been idle longer than 60 seconds gets a `Connection.ping()` (Sync round-trip) before being handed out. If the ping fails, the connection is dropped and we acquire a fresh one. We don't do periodic health checks — only on acquisition past a threshold, because pinging idle connections wastes round trips for the common case.
- Reconnection: when a connection dies (transport error, server-initiated termination), it's removed from the pool. The pool doesn't automatically replace it — replacement happens lazily on the next acquisition that needs it. This avoids reconnection storms when the database is down.
- Drain: `db.close()` waits for in-flight queries to settle, then closes all connections. With `{ force: true }`, in-flight queries are cancelled.

The pool stores connections in two lists: `idle` (available for acquisition) and `busy` (currently leased). Acquisition is `idle.shift() ?? createOrQueue()`. Release is `busy.delete(c); idle.push(c)`. Both O(1) with the linked-list backing.

For workloads where connection overhead dominates (short-lived processes, lambda-style), we provide `createClient({ pool: { max: 1 } })` which is the same machinery with a one-connection pool. There's no "single connection mode" as a separate API — it's just a configuration.

The pool intentionally has no:

- Retry on query failure. Failed queries surface their errors. The application decides whether to retry, because retry policy is workload-specific (you want to retry `40001` but not `23505`).
- Circuit breaker. Same reason.
- Read-replica routing. v2 concern; v0 connects to one host.
- Load balancing. v0 has one host.
- Adaptive sizing. The pool size is what you set it to. Real workloads tune this manually based on `max_connections` on the server and observed contention; auto-sizing is harder than it sounds.

## Observability

Three hooks, set once at `createClient`:

```ts
createClient({
  url,
  onQuery: (event) => {
    // { sql, params, durationMs, rowCount, prepared, connectionId }
  },
  onError: (event) => {
    // { error, sql, params, durationMs, connectionId }
  },
  onNotice: (event) => {
    // { severity, message, code, connectionId }
  },
});
```

These fire from the connection layer (which knows when a query starts and ends) but are configured at the client. The connection layer doesn't know about the hooks directly; the client passes them down through the connection options.

Implementation: each hook is checked once per connection at construction. If unset, the connection layer skips event-object construction entirely — there's a `if (this.onQuery !== undefined)` guard around the entire event-building block. Hooks set to a function pay for the event allocation; hooks unset pay nothing. This matters because `onQuery` would otherwise fire on every query and even an empty event allocation adds up.

The event objects are not shared or pooled — the user might hold references to them past the synchronous call. Allocating fresh per event is the simplest choice that doesn't surprise anyone.

OpenTelemetry, Datadog, etc. plug in via these hooks. We don't ship adapters for those in the core package; they belong in `pg-rocket-otel` etc. as separate packages. The hook signatures are stable across v0 and v1 — they're API.

A fourth hook, `onConnect`, fires when a connection establishes successfully:

```ts
onConnect: async (conn) => {
  await conn.sql`set search_path to my_schema, public`;
  await conn.sql`set timezone to 'UTC'`;
};
```

This is the right place for per-connection setup. The hook is async and the pool waits for it before returning the connection from the first acquisition. Critically, the hook receives a `Connection`-like interface that exposes `sql` but nothing else (no `begin`, no `close`) — the connection isn't "live" from the user's perspective until the hook completes.

## URL parsing

```ts
parseUrl('postgres://user:pass@host:5432/dbname?sslmode=require');
// {
//   user: 'user', password: 'pass', host: 'host', port: 5432,
//   database: 'dbname', ssl: 'require',
// }
```

The connection string format follows libpq's rules (which JDBC, psycopg, and every other driver also follow, so users have correct intuitions). Both `postgres://` and `postgresql://` schemes are accepted.

Parameters supported in v0:

- `sslmode`: `disable`, `prefer`, `require` (default `prefer`).
- `application_name`: passed in `StartupMessage`.
- `connect_timeout`: maps to `connectionTimeoutMs * 1000`.
- Everything else: passed through as a server parameter in `StartupMessage`. Postgres ignores unknown ones, which is the libpq convention.

We also accept `host`, `port`, `user`, `password`, `database` as top-level fields in `createClient`, so users who get their config from environment variables individually don't have to construct a URL:

```ts
createClient({
  host: process.env.PG_HOST,
  port: 5432,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});
```

URL parsing is pure-string work, no regexes for the hot path (the URL is parsed once at startup). Implementation is hand-rolled rather than using the WHATWG URL parser because the WHATWG parser doesn't handle `postgres://` schemes well (it allows them but doesn't expose ports the same way) and it's slow on cold start.

## Errors

The error hierarchy is exposed from the client layer:

```ts
import { PgError, UniqueViolation, SerializationFailure, ConnectionError } from 'pg-rocket';

try {
  await db.sql`insert into users values (...)`;
} catch (e) {
  if (e instanceof UniqueViolation) {
    // handle gracefully
  } else throw e;
}
```

The full list of subclasses (from the connection layer's hierarchy, re-exported):

- `PgError` (base for server-originated errors)
  - `IntegrityError`: `UniqueViolation` (23505), `ForeignKeyViolation` (23503), `NotNullViolation` (23502), `CheckViolation` (23514), `ExclusionViolation` (23P01)
  - `TransactionError`: `SerializationFailure` (40001), `DeadlockDetected` (40P01)
  - `QueryCanceled` (57014)
  - `InsufficientResources`
  - `SyntaxError`: `UndefinedColumn`, `UndefinedTable`, `UndefinedFunction`
- `ConnectionError` (transport-level)
  - `AuthenticationError`
  - `ProtocolError`
  - `TimeoutError`
- `EncodingError`, `DecodingError` (codec failures)

`UniqueViolation`, `ForeignKeyViolation`, `SerializationFailure` are the ones users actually catch. We pick the SQLSTATE classes that appear in real applications and provide subclass-based dispatch; obscure SQLSTATEs are still surfaced as `PgError` with the `code` field, but they don't get their own subclass.

Each error carries the original SQL and parameters when relevant, plus position information. The error message is structured: `'unique constraint "users_email_key" violated (sql: insert into users (...), params: [...])'`. We truncate parameters in the message at 100 chars per param to avoid logging huge payloads accidentally; the full params are accessible via `error.params`.

A user-facing knob, `errorVerbosity: 'minimal' | 'default' | 'verbose'`, controls how much context errors carry. `minimal` strips SQL and params from the message (still in fields). `default` is what's described above. `verbose` includes the prepared statement name and connection ID in the message.

## Cancellation

Every async method takes `{ signal?: AbortSignal }`:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);

const rows = await db.sql<User[]>({ signal: controller.signal })`
  select * from users where ...
`;
```

The signal is plumbed through to the connection layer, which sends `CancelRequest` on a side connection (per doc 0002).

But wait — the `sql` tag is a tagged template; how does it accept options? Two patterns. Either call it as a function first to get a configured tag:

```ts
const rows = await db.sql.signal(controller.signal)`select ...`;
```

Or pass options at the `db` level:

```ts
const rows = await db.with({ signal: controller.signal }).sql`select ...`;
```

The first is shorter for the common case; the second composes better with multiple options. We support both. The `db.with(...)` returns a new `db`-shaped object that's the same connection pool with options layered on, no new connections.

Timeouts compose with this: `db.with({ timeout: 5000 })` is shorthand for an internally-managed `AbortController` that fires after 5 seconds. Many users want per-query timeouts and don't want to set up `AbortController`s manually.

## LISTEN/NOTIFY

```ts
const subscription = await db.listen('user_events', (payload, channel) => {
  console.log('event:', payload, 'on', channel);
});

// Later
await subscription.unlisten();
```

The pool acquires a dedicated connection for this — `LISTEN` only works on the connection that ran it, and we don't want it competing with regular queries. The dedicated listener connection runs `LISTEN <channel>` (with the channel quoted as an identifier, sql-injection-safe) and stays parked, waiting for `NotificationResponse` messages.

The handler fires synchronously when the notification arrives. If multiple channels are registered, we use one shared listener connection with `LISTEN` for each channel, dispatching by channel name. We don't open a fresh connection per `listen()` call because that's wasteful — a typical app has 5-20 channels and one connection handles all of them.

The subscription object returned from `listen` has an `unlisten()` method that runs `UNLISTEN <channel>` and removes the handler. When the last handler on the listener connection unlistens, the connection goes back to the pool. There's a small grace period (5 seconds) before the connection is released — applications often re-listen shortly after, and this avoids open/close churn.

`notify` for the sender side:

```ts
await db.notify('user_events', JSON.stringify({ userId: 42 }));
```

Just runs `SELECT pg_notify($1, $2)` under the hood. No special connection handling.

## COPY

```ts
const stream = await db.copy.in('users', ['email', 'name'], {
  format: 'binary',  // or 'text' (default)
});
await stream.write([
  { email: 'a@example.com', name: 'Alice' },
  { email: 'b@example.com', name: 'Bob' },
]);
await stream.end();
```

The `copy.in` API takes the table name, optional column list, and format. Returns a stream-like with `write(rows)` and `end()`. `write` accepts an array of plain objects (matching the columns) or a `Uint8Array` of pre-formatted COPY bytes for users who already have the right format.

For binary format, we encode rows using the column types' codecs — same codec table as `Bind`. The header is a fixed 11-byte signature; per-row format is a int16 column count followed by length-prefixed values. End marker is a row count of `-1`.

For text format, we format each row as tab-separated columns with `\\N` for null and the appropriate escaping for tabs/newlines/backslashes within values. Slower than binary but more portable.

`copy.out` is the symmetric thing:

```ts
const stream = await db.copy.out('select email, name from users');
for await (const row of stream) {
  // row is a parsed object with the column types
}
```

Returns an `AsyncIterable<Row>` where rows are decoded using the same codecs. The user can also access raw bytes via `stream.bytes()` for cases where they want to pipe directly to a file or another stream.

The COPY API holds one connection from the pool for the duration. Errors during COPY surface as `PgError` and the connection returns to a usable state (the COPY substate handling in the connection layer takes care of this).

## Cursors

Already covered in doc 0002 from the connection-layer side. The client surface:

```ts
for await (const batch of db.cursor<Row>(sql`select * from huge_table where ...`, 1000)) {
  for (const row of batch) {
    // row: Row
  }
}
```

The `cursor` method takes a `sql\`...\`` fragment and a batch size. Returns an async iterable of row arrays. Each iteration yields up to `batchSize` rows.

A scalar variant for users who don't want to deal with batches:

```ts
for await (const row of db.cursor<Row>(sql`...`, 1000).rows()) {
  // row: Row, one at a time
}
```

This is a thin wrapper that flattens the batches. The batch-level iteration is the primary API because it's faster for users who can process batches in parallel; the per-row variant is for when ergonomics matter more than throughput.

The cursor holds a connection from the pool until the iterable completes or is `return`ed. `await using cursor = ...` works for explicit cleanup.

## File layout for this layer

```
src/
├── client.ts                # createClient, db object, with(), close
├── sql/
│   ├── tag.ts               # the sql tag: fast path + slow path
│   ├── fragment.ts          # Fragment, slow-path builder, recursive flatten
│   ├── helpers.ts           # id, unsafe, values, array, cast, raw, join
│   ├── modes.ts             # sql.values, sql.raw, sqlOne
│   └── types.ts             # SqlValue type, type-level inference
├── transaction.ts           # Transaction class, savepoint, callback form
├── pool/
│   ├── pool.ts              # Pool: acquire, release, drain, queue
│   ├── timer-wheel.ts       # idle-timeout reaping
│   └── url.ts               # connection-string parsing
├── listen.ts                # listener-connection management, subscribe API
├── copy.ts                  # copy.in, copy.out, binary and text formats
├── cursor.ts                # cursor() public API (wraps connection cursor)
├── observability.ts         # event types, hook plumbing
├── errors.ts                # error hierarchy re-exports + client-only errors
├── with.ts                  # db.with() option-layering implementation
└── index.ts                 # public exports
```

Target line count for this layer: 2000-3000 lines. The `sql` tag and pool are the bulk; transactions and the rest are short.

## Performance budgets

Per-call overhead at the client layer (excludes connection layer time, which is budgeted separately):

- `db.sql\`...\`` fast path with all-plain values: < 200 ns from tag invocation to `Command` ready.
- `db.sql\`...\`` slow path with one fragment, cached compilation: < 500 ns.
- `db.sql\`...\`` slow path with `sql.values` of 100 rows: < 50 µs (dominated by 100×K parameter encoding, but the SQL building itself is < 5 µs).
- Pool acquire (warm pool, idle connection available): < 100 ns.
- Pool acquire (cold pool, must create connection): TLS+TCP+auth time, dominates everything else.
- `await using tx = ...` to first usable `tx.sql`: one round trip (`BEGIN`).
- Hook dispatch when set: < 50 ns.
- Hook dispatch when unset: 0 ns (dead-code-eliminated guard).

These are enforceable by microbenchmarks. The fast-path `sql` budget is tight — 200 ns leaves room for the array allocation, the string concatenation, and the param-array allocation, but not much else. We keep it lean by avoiding any helper function calls in the hot path; the loop is inlined in the tag function itself.

## Tests

**Tag tests**: every helper, fragment composition correctness (parameter renumbering across nesting), edge cases (empty fragments, fragments with no parameters, deeply nested fragments). Fast-check property: arbitrary nested fragment structures roundtrip to equivalent SQL+params via independent reference implementation.

**Transaction tests**: commit, rollback on dispose, rollback on throw, savepoint commit/rollback, callback form with normal return, callback form with throw, isolation levels. Integration tests against real Postgres for the actual semantics — that `serializable` actually serializes, that `read only` actually rejects writes.

**Pool tests**: acquisition under contention (more requests than pool size), acquisition timeout, idle timeout, connection death triggers replacement on next acquire, drain waits for in-flight, force-close cancels in-flight.

**LISTEN tests**: subscribe before any notifications, receive notifications, multiple subscribers on same channel, unsubscribe last subscriber releases connection, channel name with special characters (correctly quoted as identifier).

**COPY tests**: text format roundtrip, binary format roundtrip, large bulk insert (1M rows), error during COPY recovers connection state.

**Cancellation tests**: signal aborts in-flight query, signal aborted before query starts skips it entirely, abort during pool wait removes the request from queue.

**URL parsing tests**: every libpq URL form, the parameters we support, malformed URLs error cleanly, URLs with non-ASCII characters in passwords.

**Type-level tests**: `tsd` or similar to assert that the type-level constraints on `SqlValue` reject the right things and accept the right things, that fragment composition preserves types, that result generic flows through.

## What v0 doesn't include

The deliberate omissions:

- No query builder. Building SQL is the user's job; we provide `sql.id` and fragment composition for the dynamic cases.
- No ORM features. No relations, no eager loading, no schema mapping beyond the user's own types.
- No automatic schema introspection. v1 codegen feature.
- No migration runner. Belongs in a separate package.
- No retry-on-failure logic. Application policy.
- No connection-string env-var auto-detection. The user passes the URL explicitly.
- No `pg`-style result format option (mixing text and binary per column from user code). We're binary by default with text fallback for unknown types only.
- No `SELECT FOR UPDATE` helpers, no `WITH` recursive helpers, no domain-specific shortcuts. Users write SQL; we transport it.

These are all defensible additions in later versions, but each adds API surface and the v0 budget is small surface, big performance.

## What lives just above v0

A few features that are designed for but not implemented in v0:

- Multi-host failover (`postgres://primary,replica1,replica2/db`). The URL parser already accepts this format and produces an array of hosts; the connection layer uses only the first in v0 and will round-robin in v1.
- Read-replica routing (`db.read.sql` aliased to `db.sql` in v0). The API placeholder is reserved.
- Codegen for result-shape inference. Implemented as `pg-rocket-cli` in v1.
- Custom-type discovery (composite types, enums). Manual codec registration in v0; auto-discovery in v0.x.

The architecture choices in v0 (pluggable codecs, transport interface, hook system) leave space for these without API breakage.

## What v0 looks like, end to end

A typical real-world usage:

```ts
import { createClient, UniqueViolation } from 'pg-rocket';

const db = createClient({
  url: process.env.DATABASE_URL!,
  pool: { max: 20 },
  onQuery: (e) => metrics.histogram('db.query.duration_ms', e.durationMs),
  onError: (e) => logger.error({ err: e.error, sql: e.sql }, 'db error'),
});

async function createUser(email: string, name: string): Promise<User> {
  try {
    const [user] = await db.sql<User[]>`
      insert into users (email, name) values (${email}, ${name})
      returning id, email, name, created_at
    `;
    return user;
  } catch (e) {
    if (e instanceof UniqueViolation) throw new EmailTakenError(email);
    throw e;
  }
}

async function transferFunds(from: string, to: string, amount: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.sql`update accounts set balance = balance - ${amount} where id = ${from}`;
    const [{ balance }] = await tx.sql<{ balance: string }[]>`
      select balance from accounts where id = ${from}
    `;
    if (Number(balance) < 0) throw new InsufficientFundsError();
    await tx.sql`update accounts set balance = balance + ${amount} where id = ${to}`;
  });
}

async function streamReport(): Promise<void> {
  for await (const batch of db.cursor<Row>(sql`
    select * from events where created_at > now() - interval '7 days'
  `, 5000)) {
    await uploadBatch(batch);
  }
}
```

That code is the API. There's nothing else to learn for v0.

---

This is the last design doc for v0's core. Doc 0005 would be the benchmark methodology and harness — exactly what we measure, how we run it, what acceptance criteria we hold ourselves to before declaring v0 ready. Doc 0006 would be the first ADR that's actually a build-it document: the implementation order, milestones, and what "done" looks like for each.

Want 0005 (benchmarks) next, or 0006 (implementation plan)? Or zoom in on something here — the fragment composition rules, the transaction semantics, the listener-connection management, the type-level constraints?