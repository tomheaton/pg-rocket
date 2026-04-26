# pg-rocket design doc 0001: the protocol layer

This is the layer everything else sits on. It's the smallest part of the codebase and the most performance-critical. Get it right and the rest of the library has room to be ergonomic; get it wrong and no amount of cleverness above it recovers the lost cycles.

## Boundaries

The protocol layer is `Uint8Array` in, `Uint8Array` out. It has no concept of sockets, no `node:*` imports, no `Buffer`, no async, no timers, no errors thrown for I/O. It parses bytes into message records and encodes message records into bytes. That's it.

Concretely, that means `protocol/` imports from nothing except itself and the standard library subset that exists in every JavaScript runtime: `DataView`, `Uint8Array`, `TextEncoder`, `TextDecoder`, the `Math` and `Number` globals. Auth needs hashing and HMAC, which is the one place a runtime-specific dependency leaks in — we solve that with a `Crypto` interface injected from above, not by importing `node:crypto` here. This is enforced in CI: the `protocol/` directory compiles against a `tsconfig.protocol.json` that omits `lib: ["dom"]` and `types: ["node"]`, so any accidental dependency fails the build.

The interface this layer exposes upward is three things: a `Reader` that parses backend messages from a buffer, a `Writer` that builds frontend messages into a buffer, and a `Crypto` interface that auth requires. Nothing else.

## Wire-format primer (the bits that matter)

PostgreSQL's frontend/backend protocol v3 frames every message as a one-byte type code (except the startup message, which has none), a four-byte big-endian length including the length field itself but excluding the type byte, and a payload. Backend message types are single ASCII letters: `R` for authentication, `S` for parameter status, `K` for backend key data, `Z` for ready-for-query, `T` for row description, `D` for data row, `C` for command complete, `E` for error, `N` for notice, `1` for parse complete, `2` for bind complete, `3` for close complete, `n` for no data, `s` for portal suspended, `t` for parameter description, `A` for notification, `G`/`H`/`W` for copy-in/copy-out/copy-both response, `d` for copy data, `c` for copy done. Frontend messages mirror the relevant ones plus `Q` (simple query), `P` (parse), `B` (bind), `D` (describe — same letter as data row, disambiguated by direction), `E` (execute), `S` (sync), `X` (terminate), `H` (flush), `f` (copy fail), `p` (password/SASL response).

Strings are null-terminated UTF-8. Integers are big-endian. Field counts are `int16`. Lengths within messages are `int32`. Parameter values in `Bind` and field values in `DataRow` are length-prefixed with `-1` meaning NULL. Format codes are `int16`: 0 for text, 1 for binary.

That's the whole protocol at the framing level. The complexity is in the message-specific payloads and in the state transitions, not in the framing.

## Reader: one buffer, view-based parsing

The reader's job is to turn a stream of bytes (which arrive in arbitrary chunks from the transport) into a stream of message records, without allocating per message.

The data structure is a single growable `Uint8Array` per connection — call it the read buffer. Two indices into it: `readPos` (where the parser is up to) and `writePos` (where the transport has written up to). When the transport hands us bytes, we copy them in at `writePos` and advance it. When the parser consumes a message, it advances `readPos`. The buffer is "full" when `writePos === buffer.length` and we still need more bytes; at that point we either grow it or compact it.

```ts
class Reader {
  private buf: Uint8Array;
  private view: DataView;
  private readPos = 0;
  private writePos = 0;

  feed(chunk: Uint8Array): void {
    this.ensureCapacity(chunk.length);
    this.buf.set(chunk, this.writePos);
    this.writePos += chunk.length;
  }

  next(): MessageRecord | null { /* ... */ }
}
```

A `MessageRecord` is `{ type: number, start: number, end: number }` — three integers, no allocation per message in the steady state if we reuse a single record object. The fields the parser needs from the payload are read on demand by the codec or the consumer, using the reader's cursor methods (`readInt16`, `readInt32`, `readString`, `readBytes`) operating against the offsets in the record.

The compaction strategy matters. Naive compaction (memmove every time we want to grow) is wasteful; never compacting wastes memory unboundedly. The rule: when the parser has consumed more than half of the buffer (`readPos > buf.length / 2`), and the transport wants to write more bytes than fit between `writePos` and `buf.length`, compact by copying `buf.subarray(readPos, writePos)` to position 0 and resetting indices. When the unconsumed portion plus the incoming chunk exceeds the buffer size, double the buffer. Initial size is 16 KB, which fits the vast majority of single-row responses without growing.

Parsing a message is constant work: read one byte for the type, four bytes for the length, that's the record. The reader doesn't decode the payload — it just tells the consumer "here's a `DataRow` from offset 5 to offset 312, go look." The consumer (the connection state machine) hands the record to a codec or a row assembler that reads fields off it directly.

Two subtleties.

First, the `DataRow` message contains an `int16` field count followed by `int32` length-prefixed values. A naive parser reads each field into its own slot. We don't — we leave the `DataRow` as an opaque slice and let the row assembler walk it once, applying the codec for each column in lockstep with the columns from the previous `RowDescription`. This means a single pass over the bytes per row, with no intermediate array of field slices.

Second, the `RowDescription` message is parsed eagerly because we need to remember the column metadata (name, OID, format code, type modifier) for the rows that follow. But we cache the parsed description on the prepared statement, keyed by the statement name, so repeated executions of the same prepared statement reuse it — `Describe` is sent once at prepare time and never again. This is one of the prepared-cache wins.

The reader exposes a small surface:

```ts
interface Reader {
  feed(chunk: Uint8Array): void;
  next(): MessageRecord | null;       // null = need more bytes
  // Cursor reads against a record:
  readInt16(record: MessageRecord, offset: number): number;
  readInt32(record: MessageRecord, offset: number): number;
  readCString(record: MessageRecord, offset: number): { value: string, next: number };
  readLengthPrefixed(record: MessageRecord, offset: number): { start: number, end: number, isNull: boolean };
}
```

String decoding is the place we spend most of our parsing time on real workloads, so the implementation matters. The fast path checks the byte range: if every byte is `< 0x80`, decode inline with a tight loop building the string from `String.fromCharCode` calls (chunked to avoid argument-count limits). The slow path uses a shared `TextDecoder` instance with `fatal: false`. The break-even is around 16 bytes — below that, the fast path wins because `TextDecoder` has a per-call overhead that swamps short-string decoding. We benchmark both and pick the threshold per-runtime.

Crucially, the `Buffer` type is never used here. Codecs receive the `DataView` and offsets, not a `Buffer.subarray`. This is for portability later, but it also avoids the V8 wrapper allocation that `Buffer.subarray` performs (it's "zero-copy" in terms of the underlying ArrayBuffer, but the Buffer wrapper object itself is fresh).

## Writer: one buffer, coalesced syscall

The writer mirrors the reader's design. One growable `Uint8Array` per connection, one `writePos`. Frontend messages are encoded in place. When the connection wants to flush, it hands `buf.subarray(0, writePos)` to the transport in one call and resets `writePos` to 0.

```ts
class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  startMessage(type: number): number {
    this.ensure(5);
    this.buf[this.pos++] = type;
    const lengthPos = this.pos;
    this.pos += 4;          // reserved for length, filled in at endMessage
    return lengthPos;
  }

  endMessage(lengthPos: number): void {
    this.view.setInt32(lengthPos, this.pos - lengthPos, false);
  }

  drain(): Uint8Array {
    const out = this.buf.subarray(0, this.pos);
    this.pos = 0;
    return out;
  }
}
```

The pattern is: caller calls `startMessage('B'.charCodeAt(0))`, writes the bind payload field by field using the writer's primitives (`writeInt16`, `writeInt32`, `writeString`, `writeBytes`), then calls `endMessage(lengthPos)` which fills in the length retroactively. This avoids the alternative of computing the length up front, which would mean either two passes over the data or a sub-buffer per message.

The big lever here is that `Bind` + `Execute` + `Sync` for one query, or for ten pipelined queries, all go into the same buffer before a single `drain()` call. The transport sees one chunk of bytes, makes one `socket.write` call, and the kernel sees one TCP segment (modulo MTU). With TLS, that's one TLS record instead of N. This is the dominant win on pipelined workloads.

The growth strategy is doubling, starting at 4 KB. The buffer never shrinks. That's intentional — a connection that has done a large query has paid for the buffer once and will probably do another large query later. Steady-state memory per connection is bounded by the largest single batch ever written.

Encoding strings: `TextEncoder.encodeInto` writes directly into the writer's buffer with no intermediate `Uint8Array`, then we write the null terminator. The shared encoder is constructed once per connection. For pure-ASCII strings (which is most identifiers and most short literal values), there's an inline fast path: if every code point is `< 0x80`, write byte-by-byte without invoking `TextEncoder`. The check is cheap (one loop, no allocation) and the win is meaningful for short strings where `encodeInto`'s setup dominates.

Encoding integers and floats is `DataView.setInt32`/`setBigInt64`/`setFloat64` with `littleEndian: false`. There's a temptation to inline this with manual byte arithmetic; in V8's current state, `DataView` is fully optimized and the manual version is a wash or a small loss. We use `DataView` and let the JIT do its job.

## Frontend messages, exhaustively

For v0 we encode: `StartupMessage` (no type byte, version int32 + key/value pairs + null terminator), `PasswordMessage` (`p`), `SASLInitialResponse` (`p`), `SASLResponse` (`p`), `Query` (`Q`), `Parse` (`P`), `Bind` (`B`), `Describe` (`D`), `Execute` (`E`), `Sync` (`S`), `Close` (`C`), `Flush` (`H`), `CopyData` (`d`), `CopyDone` (`c`), `CopyFail` (`f`), `Terminate` (`X`).

The `SSLRequest` is special — it's the magic int32 `80877103` with no type byte, sent before the startup message. The transport handles the response (`S` = upgrade to TLS, `N` = plaintext) and the writer is told to start the real conversation only after the upgrade completes.

`CancelRequest` is also special and goes on a side connection — magic `80877102` followed by the process ID and secret key from the original connection's `BackendKeyData`.

`Bind` is the most complex frontend message and the one we send most often, so its encoding deserves care. Format: portal name (cstring), statement name (cstring), parameter format code count (int16), parameter format codes (int16 each), parameter count (int16), parameters (int32 length + bytes, repeated), result format code count (int16), result format codes (int16 each).

Two optimizations. First, if every parameter is binary (which is our default), we send a single format code of 1 with count 1, not N codes. Same for results. This saves `2 * N` bytes per bind. Second, the parameter values are encoded directly into the writer's buffer by the codec — the codec receives the writer and writes into it, rather than producing a `Uint8Array` that we copy in. This is a "sink" pattern and it avoids one intermediate allocation per parameter:

```ts
interface BinaryEncoder<T> {
  encode(writer: Writer, value: T): void;
}
```

The codec writes a placeholder length, encodes the value, and patches the length retroactively — exactly the same pattern the writer uses for message lengths.

## Backend messages, parsing strategy

For v0 we parse: `Authentication*` (R, with its many subtypes), `ParameterStatus` (S), `BackendKeyData` (K), `ReadyForQuery` (Z), `RowDescription` (T), `DataRow` (D), `CommandComplete` (C), `EmptyQueryResponse` (I), `ErrorResponse` (E), `NoticeResponse` (N), `ParameterDescription` (t), `ParseComplete` (1), `BindComplete` (2), `CloseComplete` (3), `NoData` (n), `PortalSuspended` (s), `NotificationResponse` (A), `CopyInResponse` (G), `CopyOutResponse` (H), `CopyData` (d), `CopyDone` (c).

The reader parses framing only. Payload parsing is the consumer's job, and most messages don't need full parsing on the hot path:

`ParseComplete`, `BindComplete`, `CloseComplete`, `NoData`, `EmptyQueryResponse`, `PortalSuspended` have no payload beyond the length — they're acknowledgments. The state machine increments a counter and moves on.

`RowDescription` is parsed once when a statement is prepared, into a `ColumnDescription[]` that's cached on the prepared-statement record. Each column is `{ name, tableOid, columnAttr, typeOid, typeSize, typeModifier, formatCode }`. We resolve OIDs to codecs at this point and cache the codec function pointers alongside the column metadata, so the `DataRow` hot path doesn't do a registry lookup per cell.

`DataRow` is the hottest message. The parser hands the consumer the record (offsets into the read buffer) and the cached column descriptions. The row assembler walks: read int16 field count, then for each field, read int32 length, read `length` bytes by handing them to the codec. The codec reads from the buffer using `DataView` methods at the given offsets and returns the JS value. The row assembler puts that value into either an object (default), an array (`.raw()` mode), or a single slot (`.values()` mode for single-column selects). No intermediate `Uint8Array` slices, no per-cell allocation beyond what the codec inherently needs.

`ErrorResponse` and `NoticeResponse` share a format: a series of `(field code byte, cstring value)` pairs terminated by a zero byte. We parse all fields eagerly because errors are rare relative to data rows and users want the full structured error. The fields populate a `PgError` (or notice object) directly — no intermediate map.

`ReadyForQuery` carries one byte of payload: `I` (idle), `T` (in transaction), `E` (in failed transaction). The state machine reads this byte and updates the transaction status. Crucially, this is the source of truth for transaction state; we never track it client-side independently.

`NotificationResponse` (for `LISTEN`/`NOTIFY`) is parsed eagerly into `{ processId, channel, payload }`. Rare enough that the allocation is fine.

`Authentication*` is a mini-dispatcher inside the `R` message: read int32 subtype, then dispatch to subtype-specific parsing. Subtypes we handle: 0 (OK), 3 (cleartext password), 5 (MD5), 10 (SASL), 11 (SASL continue), 12 (SASL final). Other subtypes (2 KerberosV5, 6 SCMCredential, 7 GSS, 8 GSSContinue, 9 SSPI) are rejected with a clear error in v0.

## Authentication

SCRAM-SHA-256 is the modern default. The flow:

The server sends `AuthenticationSASL` (subtype 10) listing supported mechanisms. We pick `SCRAM-SHA-256-PLUS` if TLS is in use (channel binding) and `SCRAM-SHA-256` otherwise. We send `SASLInitialResponse` with the mechanism name and a client-first message: `n,,n=<user>,r=<nonce>` for non-PLUS, or `p=tls-server-end-point,,n=<user>,r=<nonce>` for PLUS.

The server replies with `AuthenticationSASLContinue` containing a server-first message: `r=<combined nonce>,s=<salt>,i=<iterations>`. We parse those, derive the salted password (PBKDF2-SHA-256 with the given salt and iteration count), compute the client and server keys (HMAC-SHA-256 of fixed strings under the salted password), build the auth message, compute the client signature, and send `SASLResponse` with the client-final message: `c=<channel-binding-data-base64>,r=<combined nonce>,p=<client-proof-base64>`.

The server replies with `AuthenticationSASLFinal` containing `v=<server signature>`. We verify it (HMAC-SHA-256 of the auth message under the server key) and require `AuthenticationOk` next. Mismatch is a fatal authentication error — this is the mutual-auth property of SCRAM that prevents server impersonation.

Channel binding (`SCRAM-SHA-256-PLUS`) requires the TLS server's certificate's `tls-server-end-point` channel binding data. This is a SHA-256 (or whatever hash the cert's signature algorithm specifies, with the rule for SHA-1 promoting to SHA-256) of the DER-encoded server certificate. Computing this requires reaching into the TLS layer to extract the peer certificate. The `Crypto` interface includes a `tlsServerEndPoint(): Uint8Array | null` method that the transport implementation provides; for the Node TCP transport this calls `tlsSocket.getPeerCertificate(true)` and digests the raw DER bytes.

```ts
interface Crypto {
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
  pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number, length: number): Uint8Array;
  randomBytes(length: number): Uint8Array;
}
```

This is all synchronous because SCRAM is synchronous and the runtime crypto primitives are synchronous in every relevant runtime. PBKDF2 with high iteration counts can take milliseconds, but it happens once per connection, and offloading it would complicate the API for no real gain.

MD5 auth is the legacy path. The server sends `AuthenticationMD5Password` (subtype 5) with a four-byte salt. We compute `md5(md5(password + username) + salt)` (yes, double-MD5, that's the protocol), prefix with `md5`, and send `PasswordMessage`. Done. We log a warning when MD5 is used because Postgres has been recommending against it for years; it's still the default on plenty of older deployments.

Cleartext password (`AuthenticationCleartextPassword`, subtype 3) is allowed only when TLS is active. Otherwise we error out — sending a cleartext password over an unencrypted channel is a security bug regardless of what the user thinks they want.

## TLS handshake

Strictly speaking this is the transport's job, not the protocol's, but the choreography crosses the boundary so it's worth describing here.

The transport opens a plaintext TCP connection. The protocol writer emits the `SSLRequest` magic. The transport reads exactly one byte: `S` means proceed with TLS, `N` means the server doesn't support it. On `S`, the transport hands the existing socket to `tls.connect({ socket: existingSocket, ... })` (Node-specific) which performs the upgrade. Once the TLS handshake completes, the transport tells the protocol layer "we're encrypted now," and the protocol layer sends the `StartupMessage`. On `N`, the user's config decides: `sslmode=require` errors out, `sslmode=prefer` falls back to plaintext, `sslmode=disable` would never have sent `SSLRequest` in the first place.

For channel binding, the transport stashes the peer certificate's DER bytes at handshake time and exposes them via the `Crypto` interface so SCRAM-PLUS can use them. The protocol layer doesn't know what TLS is; it just asks "is there channel binding data available?"

`sslmode` values supported in v0: `disable`, `prefer`, `require`. `verify-ca` and `verify-full` deferred to v0.x — they require CA bundle handling and hostname verification that's straightforward but not core. Default is `prefer`, matching libpq.

## Errors thrown by this layer

The protocol layer throws synchronously for malformed bytes — anything that violates the framing or contains values outside the spec's range. These are programmer errors at the protocol level (a misbehaving server, or our own bug) and they crash loud:

`ProtocolError` for framing violations (negative length, type byte outside the valid set, truncated message that the framing said should be complete). `EncodingError` for codec failures during write (a JS value that can't be represented in the column's type). `DecodingError` for codec failures during read.

It does not throw for `ErrorResponse` from the server — that's a normal protocol message and the consumer decides what to do with it. The protocol layer's job is to deliver it intact, not to interpret it.

## Tests

Three categories.

**Golden tests** capture byte sequences from real interactions with libpq and assert that our writer produces them. We use a Postgres instance behind a TCP proxy that logs both directions to a file, run a series of canonical operations from `psql`, and check the resulting bytes into the repo as fixtures. The writer tests build the same logical messages and compare bytes. For the reader, we feed the captured server-to-client bytes and assert the message records match expected offsets and types. These catch any deviation from libpq's behavior at the byte level, which is the level that matters for compatibility with the universe of Postgres-compatible servers (CockroachDB, Yugabyte, AlloyDB, Aurora, etc., which all aim for byte-level libpq compat).

**Property-based tests** for the writer/reader roundtrip: generate arbitrary messages, encode, decode, assert equality. Use `fast-check`. This catches edge cases at length boundaries, NUL bytes in strings, empty payloads, etc.

**Integration tests** run against real Postgres 14, 15, 16, 17 in Docker. The `test-utils` package boots them with `docker compose up`. Tests cover: connection establishment, all three auth flows (SCRAM, MD5, cleartext-over-TLS), TLS upgrade with and without channel binding, channel-binding mismatch (must fail), pipelined extended-query sequences with mixed success and failure messages, COPY in and out, NOTIFY delivery.

A protocol fuzzer runs nightly: a corpus of captured server bytes, plus mutations via `fast-check`'s shrinking, fed to the reader. Any crash or hang is a P0 bug.

## Performance budgets for this layer

Per-message overhead, measured against a do-nothing baseline that just consumes bytes:

Reader, `DataRow` of 10 small columns: < 200 ns per row (excludes codec time, which is per-type and budgeted separately). Reader, `RowDescription`: < 1 µs per description (one-time cost per prepared statement, doesn't matter much). Writer, `Bind` for 5 `int4` parameters + `Execute` + `Sync`: < 300 ns per group. SCRAM auth round trip excluding network: < 5 ms (dominated by PBKDF2 with 4096 iterations, which is the Postgres default).

These are budgets for the protocol layer itself, not the full library. They're enforceable by microbenchmarks in `bench/protocol/`.

## Files in this layer

```
src/protocol/
├── reader.ts          # Reader class, MessageRecord type
├── writer.ts          # Writer class
├── messages.ts        # Type byte constants, error/notice field codes
├── auth/
│   ├── scram.ts       # SCRAM-SHA-256 and -PLUS state machine
│   ├── md5.ts         # MD5 hash and message construction
│   └── crypto.ts      # The Crypto interface (no implementation)
└── index.ts           # Public exports of the layer
```

`messages.ts` is just constants and types — message type bytes, error field codes, format codes, auth subtypes, the `MessageRecord` interface, the `ColumnDescription` interface. No logic. Importing it should be free.

The total line count for this layer should sit around 1500-2000 lines, including comments. If it grows beyond that, something has crept in that doesn't belong.

## What's deliberately not here

No connection management, no retry, no timeouts, no socket. Those are the connection layer's responsibility, which the next doc covers. No codecs — those live in `src/codecs/` and import from the protocol layer (they need the `Writer` and `DataView` types) but the protocol layer doesn't import them. No `sql` tag, no pool, no transactions. No observability hooks. No URL parsing.

The protocol layer is small on purpose. Every line here is on the hot path of every query, and the way to keep it fast is to keep it small.
