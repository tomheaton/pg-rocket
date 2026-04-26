# pg-rocket design doc 0003: the codec system

This is where bytes become JS values and JS values become bytes. Codecs are small in absolute size but they run on every cell of every row, so the per-call overhead is the dominant factor in result-set throughput. The design goal is: codec dispatch is a single array index, codec execution does the minimum allocation possible, and adding a custom type takes one function call.

## Boundaries

The codec layer imports from the protocol layer (it needs `DataView` semantics, the `Writer` class for encoding, and the `MessageRecord` shape) and is imported by the connection layer (which dispatches codecs at row-assembly and bind time). It does not import anything else, and nothing imports it except the connection layer and — eventually — user code that registers custom types.

```
[connection layer]
       ↓
   [codecs]
       ↓
[protocol layer]
```

A codec is two functions plus an OID. There is no class hierarchy, no "codec context," no plugins-of-plugins. The simplicity matters because the call site is hot and indirection is expensive.

## The Codec interface

```ts
interface Codec<T = unknown> {
  oid: number;                      // PostgreSQL type OID
  arrayOid?: number;                // OID of the array form, if any
  decode: (view: DataView, offset: number, length: number) => T;
  encode: (writer: Writer, value: T) => void;
  name: string;                     // 'int4', 'timestamptz', etc., for errors
}
```

The decoder receives the connection's read buffer as a `DataView`, the offset where the value's bytes start, and the length of the value in bytes. It returns the JS value. The encoder receives the connection's write buffer (wrapped in the `Writer` class for length-patching) and the JS value, and writes the binary representation including its own length prefix. Note the asymmetry: decoders don't read their own length prefix (the row assembler did that already and either passed `length` or recognized null and skipped the call), but encoders write their own. This matches the message layout — `DataRow` has the field-length array embedded in it before each value, but `Bind` has each parameter's length contiguous with the value.

Why `DataView` and not `Uint8Array`? Because `DataView` is the only way to get the right endianness without manual byte arithmetic, and PostgreSQL is big-endian end-to-end. V8 optimizes `DataView` calls well in 2026 — they're inlined and turn into a single load instruction in JIT-compiled code. The benchmarks confirm this; manual `(buf[o] << 24) | (buf[o+1] << 16) | ...` is no faster and is more bug-prone (it sign-extends incorrectly for high values).

## The registry

```ts
class CodecRegistry {
  // Dense array indexed by OID for built-in types (OIDs < 4096).
  // Sparse Map for custom types and high OIDs.
  private dense: Codec[] = new Array(4096);
  private sparse: Map<number, Codec> = new Map();

  get(oid: number): Codec | undefined {
    return oid < 4096 ? this.dense[oid] : this.sparse.get(oid);
  }

  register(codec: Codec): void {
    if (codec.oid < 4096) this.dense[codec.oid] = codec;
    else this.sparse.set(codec.oid, codec);
    if (codec.arrayOid !== undefined) {
      const arrayCodec = makeArrayCodec(codec);
      if (codec.arrayOid < 4096) this.dense[codec.arrayOid] = arrayCodec;
      else this.sparse.set(codec.arrayOid, arrayCodec);
    }
  }
}
```

All built-in PostgreSQL type OIDs are below 4096 — int4 is 23, text is 25, timestamptz is 1184, the highest built-in is around 3831 for some pg_catalog types we'll never touch. Custom types created with `CREATE TYPE` start above 16384. Splitting the registry into a dense array for built-ins and a sparse Map for everything else makes the hot path a single array index that's almost always a hit, with fallback to a Map lookup that's rare and tolerable.

A small subtlety: the dense array is allocated once with `new Array(4096)`, leaving slots `undefined` for OIDs we don't register. JavaScript engines special-case "holey" arrays in ways that can be slower than packed ones, so we explicitly fill the array with a sentinel codec that throws an informative error on call:

```ts
const UNKNOWN_TYPE_CODEC: Codec = {
  oid: 0,
  name: 'unknown',
  decode: (_v, _o, _l) => { throw new DecodingError('unknown type OID'); },
  encode: (_w, _v) => { throw new EncodingError('unknown type OID'); },
};
```

This means a missing-codec hit is a clear error rather than a `cannot read property 'decode' of undefined`. And the array is fully packed, which V8 optimizes more aggressively.

Registry lookup is amortized at prepare time, not per-row. When we receive a `RowDescription`, we resolve each column's OID to a codec function reference and cache it on the `PreparedStatement.columnDecoders` array. The row assembler reads from that pre-resolved array, never the registry. Same for parameters: the `Bind` path resolves `parameterEncoders` once per prepare. The registry is only touched in two places: (1) when a prepared statement is being built or invalidated, and (2) when a query bypasses the prepare path entirely (which doesn't happen in the `sql` tag's normal mode, but does for one-shot `simple query` use).

## What "format" means and why we're binary by default

PostgreSQL supports two wire formats per value: text (format code 0) and binary (format code 1). Text is what you'd see in `psql` — `'2025-01-15 10:30:00+00'`, `'42'`, `'{"hello": "world"}'`. Binary is the server's internal representation, with some endianness adjustments. Format is per-parameter on `Bind` and per-column on `Execute`.

Text is forgiving. If we don't have a codec for a type, decoding to a string is always safe — Postgres formats it, the client gets a string, the user does what they want with it. This is `pg`'s default for most types.

Binary is faster but unforgiving. Each type has its own binary layout that has to be implemented exactly. The wins:

- Integer types: a single `getInt32` instead of `parseInt` over decimal digits. ~5x faster for the inner loop.
- Floats: a single `getFloat64` instead of `parseFloat` over decimal+exponent. ~10x faster.
- Timestamps: two `getInt32`s and arithmetic instead of parsing `'2025-01-15 10:30:00.123456+00'`. ~20x faster, no DST/timezone surprises.
- JSON: pass through with no double-parsing (text format requires `JSON.parse(text)`, binary `jsonb` is `0x01` + UTF-8 bytes which is the same parse, but binary `json` is just bytes — no escaping concerns).
- Booleans: one byte read instead of comparing against `'t'`/`'f'`.
- Numerics: a sequence of int16 digit groups instead of decimal-string parsing.

The cost is implementation complexity, but the binary formats are stable and well-documented in the Postgres source (`src/backend/utils/adt/*.c` is the reference).

We send `format=1` for all parameters and request `format=1` for all results. There's a single per-codec opt-out via `decode: 'text'` for users who hit a binary-format edge case in production and need to bypass it; this is wired up at `createSql({ types: [...] })` time rather than per-query, because mixing formats per-column is a wire-level option but not a usability win.

## v0 type coverage

Day-one types, with their OIDs and the JS type they decode to:

| Type          | OID  | Array OID | JS type            | Notes                        |
| ------------- | ---- | --------- | ------------------ | ---------------------------- |
| `bool`        | 16   | 1000      | `boolean`          | one byte                     |
| `bytea`       | 17   | 1001      | `Uint8Array`       | not `Buffer`                 |
| `int8`        | 20   | 1016      | `bigint`           | always                       |
| `int2`        | 21   | 1005      | `number`           |                              |
| `int4`        | 23   | 1007      | `number`           |                              |
| `oid`         | 26   | 1028      | `number`           |                              |
| `text`        | 25   | 1009      | `string`           |                              |
| `varchar`     | 1043 | 1015      | `string`           |                              |
| `bpchar`      | 1042 | 1014      | `string`           | trimmed                      |
| `name`        | 19   | 1003      | `string`           |                              |
| `float4`      | 700  | 1021      | `number`           |                              |
| `float8`      | 701  | 1022      | `number`           |                              |
| `numeric`     | 1700 | 1231      | `string`           | configurable                 |
| `uuid`        | 2950 | 2951      | `string`           | canonical form               |
| `json`        | 114  | 199       | `unknown` (parsed) |                              |
| `jsonb`       | 3802 | 3807      | `unknown` (parsed) |                              |
| `date`        | 1082 | 1182      | `Date`             | UTC midnight                 |
| `time`        | 1083 | 1183      | `string`           | `'HH:MM:SS.ffffff'`          |
| `timetz`      | 1266 | 1270      | `string`           | with offset                  |
| `timestamp`   | 1114 | 1115      | `Date`             | local-ish, see below         |
| `timestamptz` | 1184 | 1185      | `Date`             | UTC                          |
| `interval`    | 1186 | 1187      | object             | `{months,days,microseconds}` |

That's the headline set. We also need OID-only support (no codec, but recognized) for a handful of system types that might appear in metadata queries: `oid`, `regproc`, `regtype`, etc. For v0 these decode-as-text via the fallback path.

The deliberate omissions for v0: ranges, multiranges, composite types, enum types (decoded as text in v0), geometric types (point/line/box/polygon/circle/path/lseg), network types (inet/cidr/macaddr), tsvector/tsquery, hstore, money, xml. These all have working binary formats but they're rare enough on the hot path that putting them in v0 isn't worth the surface area. They're high-priority for v0.x.

## The hot-path codecs in detail

### Integers

```ts
const int4Codec: Codec<number> = {
  oid: 23, arrayOid: 1007, name: 'int4',
  decode: (v, o, _l) => v.getInt32(o, false),
  encode: (w, value) => {
    w.writeInt32(4);              // length prefix
    w.writeInt32(value);          // value, big-endian
  },
};

const int8Codec: Codec<bigint> = {
  oid: 20, arrayOid: 1016, name: 'int8',
  decode: (v, o, _l) => v.getBigInt64(o, false),
  encode: (w, value) => {
    w.writeInt32(8);
    w.writeBigInt64(value);
  },
};
```

`int4` decoded as `number` because every int32 fits safely in a JS number (`Number.MAX_SAFE_INTEGER` is 2^53 - 1). `int8` decoded as `bigint` always — we don't try to detect whether the value fits in a number, because a column whose values "happened to fit" until they don't is a latent bug waiting to bite.

The encode path is the place to be careful about runtime types. A user writing `sql\`...where id = ${userId}\`` where `userId` is a number, but the column is `int8`, will pass a `number` to the int8 encoder. We coerce: if the runtime type is `number`, convert via `BigInt(value)` — but only if it's a safe integer. Otherwise throw `EncodingError`. Same direction is more annoying: user passes `bigint` for an `int4` column, we try to fit and throw if it's out of range. These coercions are real overhead, so we hoist the type check: the encoder is selected at prepare time based on the parameter's declared OID, but the actual runtime value's JS type is checked at bind time. For monomorphic call sites (the same query running with the same JS types every time), V8 inlines the check away.

### Floats

```ts
const float8Codec: Codec<number> = {
  oid: 701, arrayOid: 1022, name: 'float8',
  decode: (v, o, _l) => v.getFloat64(o, false),
  encode: (w, value) => {
    w.writeInt32(8);
    w.writeFloat64(value);
  },
};
```

`getFloat64` handles `NaN`, `±Infinity`, `±0`, and subnormals correctly. No special-casing needed.

### Booleans

```ts
const boolCodec: Codec<boolean> = {
  oid: 16, arrayOid: 1000, name: 'bool',
  decode: (v, o, _l) => v.getUint8(o) !== 0,
  encode: (w, value) => {
    w.writeInt32(1);
    w.writeUint8(value ? 1 : 0);
  },
};
```

The simplest case. One byte.

### Text family

```ts
const textCodec: Codec<string> = {
  oid: 25, arrayOid: 1009, name: 'text',
  decode: (v, o, l) => decodeUtf8(v, o, l),
  encode: (w, value) => {
    const lenPos = w.writeInt32Placeholder();
    const start = w.position;
    w.writeUtf8(value);
    w.patchInt32(lenPos, w.position - start);
  },
};
```

`decodeUtf8` is the protocol layer's string decoder with the ASCII fast path. `writeUtf8` is the writer's `TextEncoder.encodeInto` wrapper with its own ASCII fast path. Both paths matter — column values are dominated by short ASCII strings (UUIDs as text, email addresses, slugs, status enums) and the fast path is meaningfully faster.

`varchar` (1043) and `text` (25) share the same codec function with different OIDs registered. `bpchar` (1042, "blank-padded char") is `text` with a trailing-space-trim on decode, because Postgres preserves the column-defined width with spaces and that's almost never what the application wants. `name` (19) is short text used in catalog tables; same codec.

### bytea

```ts
const byteaCodec: Codec<Uint8Array> = {
  oid: 17, arrayOid: 1001, name: 'bytea',
  decode: (v, o, l) => {
    // Slice into a new buffer so the value outlives the connection's read buffer.
    return new Uint8Array(v.buffer, v.byteOffset + o, l).slice();
  },
  encode: (w, value) => {
    w.writeInt32(value.byteLength);
    w.writeBytes(value);
  },
};
```

Decoding to `Uint8Array` rather than `Buffer` is intentional. `Buffer` is Node-specific; `Uint8Array` is universal. Users who want a `Buffer` can wrap with `Buffer.from(uint8)` which is zero-copy. The `.slice()` is necessary because the row assembler reuses the read buffer across messages — without it, the user's reference would point at bytes that get overwritten by the next response.

This is the one codec that always allocates per call. The cost is unavoidable; the user wants to keep the bytes.

### UUID

```ts
const uuidCodec: Codec<string> = {
  oid: 2950, arrayOid: 2951, name: 'uuid',
  decode: (v, o, _l) => formatUuid(v, o),
  encode: (w, value) => {
    w.writeInt32(16);
    parseUuidInto(w, value);
  },
};
```

UUIDs are 16 bytes on the wire. Decoding produces the canonical 36-char string `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. `formatUuid` uses a precomputed hex lookup table and assembles the string with `String.fromCharCode` calls — about 5x faster than `bytes.toString('hex')` plus dash insertion. Encoding parses the canonical form back to bytes; we accept lowercase, uppercase, and mixed, and reject anything else with a clear error.

A flag, `uuid: 'string' | 'bytes'`, lets the user opt for `Uint8Array` instead of string. Default is string because every Postgres user we've seen treats UUIDs as opaque strings.

### JSON and JSONB

```ts
const jsonCodec: Codec<unknown> = {
  oid: 114, arrayOid: 199, name: 'json',
  decode: (v, o, l) => JSON.parse(decodeUtf8(v, o, l)),
  encode: (w, value) => {
    const json = JSON.stringify(value);
    const lenPos = w.writeInt32Placeholder();
    const start = w.position;
    w.writeUtf8(json);
    w.patchInt32(lenPos, w.position - start);
  },
};

const jsonbCodec: Codec<unknown> = {
  oid: 3802, arrayOid: 3807, name: 'jsonb',
  decode: (v, o, l) => {
    if (v.getUint8(o) !== 1) throw new DecodingError('jsonb version');
    return JSON.parse(decodeUtf8(v, o + 1, l - 1));
  },
  encode: (w, value) => {
    const json = JSON.stringify(value);
    const lenPos = w.writeInt32Placeholder();
    const start = w.position;
    w.writeUint8(1);              // jsonb version byte
    w.writeUtf8(json);
    w.patchInt32(lenPos, w.position - start);
  },
};
```

`jsonb`'s binary format is "version byte (always 1) + JSON text." The promise of binary format here is mostly about not having to escape it — there's no double-parsing benefit because the server sends UTF-8 JSON either way, and parsing JSON is the same JSON.parse cost. The wins are real but small: skipping the escaping that text format requires, and the fact that the parser doesn't have to handle Postgres's text-format escaping rules.

A flag, `json: 'parsed' | 'string'`, lets the user opt out of `JSON.parse`/`stringify` and exchange raw strings. Useful when the application has already parsed (or wants to defer parsing to a worker) and the round-trip through Postgres is just storage.

### Numeric

`numeric` is the one that makes implementers cry. The binary format is a sequence of `int16` "digits" in base 10000, plus header fields for sign, exponent, and weight. The implementation is mechanical but tedious:

```
int16 ndigits      // count of digits that follow
int16 weight       // exponent in base-10000 (0 = ones place)
int16 sign         // 0x0000 = positive, 0x4000 = negative,
                   // 0xC000 = NaN, 0xD000 = +Inf, 0xF000 = -Inf
int16 dscale       // display scale (digits after decimal point)
int16 digits[ndigits]
```

Decoded to a string by default — preserves arbitrary precision and matches what users expect when they write `numeric(20, 4)`. The decoder walks the digits, formats each as a 4-character zero-padded decimal, concatenates with the appropriate decimal point insertion based on `weight` and `dscale`, and slaps a sign in front. About 100 lines of careful code with comprehensive tests.

For the encode path we accept `string` (the default), `bigint` (only for whole numbers), `number` (with a warning that precision may be lost — gated by a flag), or a `Decimal` instance from our optional sibling export. Encoding is the inverse walk: parse the string into digit groups, compute weight and dscale, write the header and digits.

Special values: `'NaN'` round-trips. `'Infinity'` and `'-Infinity'` round-trip on Postgres ≥ 14, error before. We document the `Infinity` minimum and don't try to polyfill.

The configuration knob:

```ts
createClient({
  url,
  numeric: 'string'        // default
       // | 'number'       // lossy, for users who know what they're doing
       // | 'bigint'       // errors on values with scale > 0
       // | DecimalClass,  // a class with parse(string)/toString() methods
});
```

### Date and time

This is the part of the type system that has the most footguns, so the choices need to be deliberate.

`timestamptz` decoded to `Date`. The server sends microseconds since 2000-01-01 00:00:00 UTC as an int64. Convert to milliseconds since 1970-01-01 by adding the offset (`946684800000` ms) and dividing microseconds by 1000. The microsecond-to-millisecond conversion loses the bottom 3 digits of precision, which `Date` can't represent anyway. Document this loss; users who need microsecond precision opt into `Temporal` or a string codec.

```ts
const POSTGRES_EPOCH_MS = 946684800000;  // 2000-01-01T00:00:00Z

const timestamptzCodec: Codec<Date> = {
  oid: 1184, arrayOid: 1185, name: 'timestamptz',
  decode: (v, o, _l) => {
    const microseconds = v.getBigInt64(o, false);
    if (microseconds === INFINITY_MICROS) return new Date(POS_INF_MS);
    if (microseconds === NEG_INFINITY_MICROS) return new Date(NEG_INF_MS);
    return new Date(POSTGRES_EPOCH_MS + Number(microseconds / 1000n));
  },
  encode: (w, value) => {
    w.writeInt32(8);
    if (value === POS_INF) w.writeBigInt64(INFINITY_MICROS);
    else if (value === NEG_INF) w.writeBigInt64(NEG_INFINITY_MICROS);
    else {
      const ms = value.getTime();
      const us = BigInt(ms - POSTGRES_EPOCH_MS) * 1000n;
      w.writeBigInt64(us);
    }
  },
};
```

`timestamp` (without time zone) is the one that's genuinely ambiguous. Postgres stores it as wall-clock microseconds since 2000-01-01 with no timezone information. JS `Date` is always UTC-internal. Three choices:

1. Treat the wall clock as UTC and produce a `Date` that displays the same wall clock if the user's runtime is in UTC. This is what `pg` does. Users in non-UTC environments get a `Date` that represents "the same numbers, interpreted as UTC."
2. Treat the wall clock as local time and produce a `Date` for the equivalent UTC instant. Users in non-UTC environments get a `Date` whose `.toISOString()` differs from their input string.
3. Refuse to map to `Date` and require a string or a structured object.

We pick option 1 for v0, matching `pg`. It's the least-surprising default for users who store UTC timestamps in `timestamp` columns (which is a common pattern on systems where `timestamptz` was deemed too "magical"). Document the gotcha. Option 3 becomes available via the `Temporal` opt-in path, where `timestamp` decodes to `Temporal.PlainDateTime` and the ambiguity goes away.

`date` decoded to `Date` set to UTC midnight of the given day. The wire format is days since 2000-01-01 as int32. Conversion is `new Date((days + DAYS_FROM_EPOCH_TO_2000) * 86400000)`. Users wanting "just a date, no time" get a clean object whose `.toISOString()` is `'2025-01-15T00:00:00.000Z'`. Encode: read the date's UTC year/month/day and reverse the calculation. We don't try to handle time-zone-shifted `Date` values intelligently — if you pass `new Date('2025-01-15T22:00:00-05:00')` (which is `2025-01-16T03:00:00Z`), we encode `2025-01-16`, because that's the UTC date.

`time` and `timetz` decoded to strings. The wire format is microseconds-since-midnight (int64) for `time`, and same plus int32 timezone offset for `timetz`. JS has no first-class "time of day" type at the `Date` level, so we format as `'HH:MM:SS.ffffff'` (or with `±HH:MM` suffix for `timetz`). The `Temporal` path decodes these to `Temporal.PlainTime` and `Temporal.ZonedTime` respectively.

`interval` is the one with no good `Date`-equivalent. Wire format is `(int64 microseconds, int32 days, int32 months)`. The fields are kept separate because they're not interchangeable — "1 month" added to a date is calendar arithmetic, not 30 days. We decode to a structured object:

```ts
interface PgInterval {
  months: number;
  days: number;
  microseconds: bigint;
}
```

We provide a `formatInterval(interval)` helper that produces an ISO 8601 duration string `'P1Y2M3DT4H5M6S'`, and a `parseInterval(string)` that parses both ISO 8601 and Postgres's verbose form. The structured object is the canonical representation; the string is for when users want to log or display.

### Arrays

PostgreSQL has true generic arrays — every type with an `arrayOid` can be an array. The wire format:

```
int32 ndim                   // number of dimensions
int32 has_nulls              // 0 or 1
int32 element_oid            // OID of the element type
[per dimension: int32 size, int32 lower_bound]
[for each element: int32 length, bytes]
```

The codec generator:

```ts
function makeArrayCodec<T>(elementCodec: Codec<T>): Codec<T[]> {
  return {
    oid: elementCodec.arrayOid!,
    name: elementCodec.name + '[]',
    decode: (v, o, l) => decodeArray(v, o, l, elementCodec),
    encode: (w, value) => encodeArray(w, value, elementCodec),
  };
}
```

For v0 we only support 1-D arrays in the common-case path, with multidimensional arrays falling back to a recursive walk. The 1-D path:

```ts
function decodeArray1D<T>(v: DataView, o: number, _l: number, ec: Codec<T>): (T | null)[] {
  const ndim = v.getInt32(o, false); o += 4;
  // skip has_nulls and element_oid (we already know)
  o += 8;
  if (ndim === 0) return [];
  if (ndim !== 1) return decodeArrayND(v, o - 12, ec);
  const size = v.getInt32(o, false); o += 4;
  o += 4;  // skip lower_bound
  const result: (T | null)[] = new Array(size);
  for (let i = 0; i < size; i++) {
    const len = v.getInt32(o, false); o += 4;
    if (len < 0) {
      result[i] = null;
    } else {
      result[i] = ec.decode(v, o, len);
      o += len;
    }
  }
  return result;
}
```

Pre-sizing the array via `new Array(size)` and assigning by index gives V8 a packed array from the start. We don't validate the element OID against `elementCodec.oid` — it's redundant work; if the registry handed us an array codec, the type matches.

Encoding 1-D arrays:

```ts
function encodeArray1D<T>(w: Writer, value: (T | null)[], ec: Codec<T>): void {
  const lenPos = w.writeInt32Placeholder();
  const start = w.position;
  w.writeInt32(1);                            // ndim
  w.writeInt32(value.some(x => x === null) ? 1 : 0);  // has_nulls
  w.writeInt32(ec.oid);
  w.writeInt32(value.length);                 // dim 1 size
  w.writeInt32(1);                            // lower bound (PG default is 1)
  for (const item of value) {
    if (item === null || item === undefined) {
      w.writeInt32(-1);
    } else {
      const itemLenPos = w.writeInt32Placeholder();
      const itemStart = w.position;
      // Element codec's encode method writes the value bytes, but it expects to
      // write its own length prefix. We bypass that by calling a "value-only"
      // variant. For codecs registered via defineType, this is auto-generated.
      ec.encodeValue(w, item);
      w.patchInt32(itemLenPos, w.position - itemStart);
    }
  }
  w.patchInt32(lenPos, w.position - start);
}
```

Note the asymmetry: in `Bind`, each parameter has a length prefix. In an array, each element has a length prefix. So the inner element encoder needs to write *just* the value, not its own length. We split the codec into two encode operations internally — `encode` (length + value, for top-level params) and `encodeValue` (value only, for nested). The user-facing `encode` is auto-derived from `encodeValue` plus the standard length-patching pattern.

Multi-dimensional arrays in v0 work but aren't optimized — they go through the same recursive walk that decodes a tree of arrays. Postgres semantically treats them as rectangular (every row of a 2-D array has the same width), but we don't enforce this on encode; we let the server reject malformed input. Most real workloads use 1-D only.

## Custom types

```ts
import { defineType, createClient } from 'pg-rocket';

const ltreeCodec = defineType<string>({
  oid: 16385,                  // discovered from pg_type
  name: 'ltree',
  decode: (v, o, l) => decodeUtf8(v, o, l),
  encode: (w, value) => {
    w.writeInt32(value.length);
    w.writeUtf8(value);
  },
});

const db = createClient({ url, types: [ltreeCodec] });
```

That's the whole API. Pass codecs at client creation time. They register at startup, before any query runs. No runtime type discovery in the hot path.

For users who don't want to hardcode OIDs (they vary across databases for user-created types), we provide a discovery helper:

```ts
const types = await discoverTypes(db, ['ltree', 'citext']);
// returns Codec[] resolved against pg_type
```

It runs `SELECT oid, typname FROM pg_type WHERE typname = ANY($1)` once and patches the OIDs into pre-built codec templates. Used as `createClient({ url, types: await discoverTypes(...) })`.

For composite types and enums, full automatic discovery is a v1 feature that's out of scope here. v0 falls back to text decoding for anything not registered, which is "works correctly, slower."

## The text fallback

If a codec isn't registered for an OID, the connection layer requests `format=0` (text) for that column at `Bind` time and decodes the result as a string. This is the safety net: an unknown type doesn't crash, it just comes back as a Postgres-formatted string. The user sees `'(1.5, 2.5)'` for a `point` instead of an object, which is a reasonable degradation.

Implementation: at prepare time, when we resolve column codecs, columns whose OIDs miss the registry get marked as text-format. The result-format-codes array sent in `Bind` becomes per-column instead of single-code-applies-to-all (we drop into a slightly slower path when this happens). Decoded values are strings.

Encoding parameters for unknown types: we look at the JS value's runtime type and pick a default — strings encode as text-format unknown, numbers as int4 if integer else float8, bigints as int8, booleans as bool, `Date` as timestamptz, `Uint8Array` as bytea, anything else as JSON. This is the "best guess" path for users who don't declare parameter types and is what `postgres.js` does. The user can override with `sql\`...where x = ${sql.cast(value, 'jsonb')}\``.

## A note on the codec call site

The row assembler calls `decoders[i](view, offset, len)` per cell. This is the hottest call site in the entire library, and its performance depends on whether V8 keeps it monomorphic.

If a connection runs many different prepared statements, the call site sees many different codec functions, and the dispatch turns megamorphic. V8 falls back to a slower lookup path. The fix isn't avoiding diversity — that's the user's prerogative — but is to give each prepared statement its own row-assembler closure, not a shared one. The closure captures a specific `decoders` array, and the call site within that closure sees only the codec types relevant to that statement. Different statements use different closures, each monomorphic at its own call site.

This is why the row assembler is per-prepared-statement, not global. It costs a few hundred bytes per statement (the closure plus the captured arrays) and buys monomorphic dispatch on the row hot path.

## Decoder allocation accounting

For a row of ten int4s, the codecs collectively allocate zero objects — just ten number-typed slots in the result. For a row of ten texts averaging 20 ASCII chars, it's ten strings (allocations are unavoidable) but no intermediate `Uint8Array`s. For a row of ten timestamptzs, it's ten `Date` objects (also unavoidable) plus ten transient `bigint` objects from `getBigInt64`; the bigints are dead immediately and get GC'd in the nursery cheaply.

The result row itself is one object (or array, in `.raw()` mode). Pre-creating the object via `{}` and assigning known string keys is the fastest path for object mode; V8 gives us a stable hidden class once it sees the same keys twice, which our prepared-statement caching guarantees.

The total allocation budget for a 10-column row of mixed scalar types: under 30 short-lived objects, all of which are nursery-collected on the next GC. This is in the same ballpark as the absolute floor for "a row of values exists in JS-land at all."

## Files in this layer

```
src/codecs/
├── registry.ts           # CodecRegistry, the dense+sparse split
├── codec.ts              # Codec interface, defineType, helpers
├── int.ts                # int2, int4, int8, oid
├── float.ts              # float4, float8
├── numeric.ts            # the painful one
├── bool.ts
├── text.ts               # text, varchar, bpchar, name; ASCII fast paths
├── bytea.ts
├── uuid.ts
├── json.ts               # json, jsonb
├── temporal.ts           # date, time, timetz, timestamp, timestamptz, interval
├── arrays.ts             # makeArrayCodec, decodeArray1D, encodeArray1D
├── unknown.ts            # the text-format fallback
├── discover.ts           # discoverTypes helper
└── index.ts
```

Target line count: 1500-2000 lines. The numeric and temporal modules are the biggest; everything else is short.

## Performance budgets

Per-cell decode time, measured against a baseline that just advances offsets without producing values:

- int4: < 15 ns per cell.
- int8: < 25 ns per cell.
- float8: < 15 ns per cell.
- bool: < 10 ns per cell.
- text (20-byte ASCII): < 60 ns per cell.
- text (20-byte UTF-8 multibyte): < 120 ns per cell.
- uuid: < 80 ns per cell.
- timestamptz: < 50 ns per cell.
- jsonb (small object): < 800 ns per cell, dominated by `JSON.parse`.
- numeric (mid-precision): < 200 ns per cell.

These are V8 budgets on modern hardware (Apple M-series and recent Intel/AMD). They're enforceable by microbenchmarks in `bench/codecs/`. Numeric is the worst-case; everything else is below 100 ns and on the same order as the function-call overhead itself.

Per-cell encode budgets are within 50% of the decode budgets across the board. Encoding has slightly more overhead because of the length-patching pattern (one extra `setInt32` per value).

## Tests

**Roundtrip property tests** for every codec. For each type, generate arbitrary JS values via `fast-check`, encode them, decode them back, assert equality. For types where the JS representation can't represent every Postgres value (numeric, interval), constrain the generator to representable values. Run against a real Postgres in the integration suite — encode a value, send via `SELECT $1::type`, decode the response, assert equality. This catches both directions and catches asymmetries between our codec and the server.

**Boundary tests** for each codec: minimum value, maximum value, zero, NaN/Infinity where applicable, empty string, single-character string, string with embedded NULs (text columns can contain them; we should not), maximum-length string within Postgres's per-column limit.

**Format-fallback tests**: a custom type with no codec, ensure result comes back as a string and parameter encodes as text-format unknown.

**Megamorphic-protection tests**: prepare 20 different statements with different column types, run them in a loop, assert that per-row decode time stays within 1.5x of the monomorphic baseline. This is a regression test for the closure-per-statement design.

**Codec-registration tests**: register a custom codec, prepare a statement that uses it, assert correct round-trip. Register a codec with a colliding OID (built-in), assert it overrides. Register an array codec, assert it's auto-derived.

## What's deliberately not here

No automatic composite/enum/range/multirange handling — those are v0.x. No type discovery as a runtime hook (codecs are registered up front). No "schema-aware" inference based on parameter source (we don't try to peek at the SQL to figure out what type a parameter should be). No JSON schema validation of jsonb columns. No cross-codec policies (no "treat all numerics from this table as numbers"). No multi-format pipelines (we don't mix text and binary results in the same `Bind`'s result-format-codes; it's all binary or, on fallback, per-column from a fixed array).

The codec layer is small for the same reason the protocol layer is small: every line runs on every cell of every row, and discipline here pays for itself many times over in throughput.
