// Integer codecs (int2, int4, int8). int8 decodes as bigint always — `pg`
// defaulting to string here is a 2026 anti-default; bigint is what callers
// actually want for 64-bit values.
//
// Binary wire format per `format_code = 1`:
//   * int2 → 2-byte network-order signed integer
//   * int4 → 4-byte network-order signed integer
//   * int8 → 8-byte network-order signed integer (BigInt64)

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

export const int2Codec: Codec<number> = {
  oid: Oid.Int2,
  decode(text) {
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`int2: cannot parse ${JSON.stringify(text)}`);
    }
    return n;
  },
  encode(value) {
    if (!Number.isInteger(value)) {
      throw new TypeError(`int2: expected integer, got ${value}`);
    }
    return value.toString(10);
  },
  decodeBinary(_buf, view, offset, _length) {
    return view.getInt16(offset, false);
  },
};

export const int4Codec: Codec<number> = {
  oid: Oid.Int4,
  decode(text) {
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`int4: cannot parse ${JSON.stringify(text)}`);
    }
    return n;
  },
  encode(value) {
    if (!Number.isInteger(value)) {
      throw new TypeError(`int4: expected integer, got ${value}`);
    }
    return value.toString(10);
  },
  decodeBinary(_buf, view, offset, _length) {
    return view.getInt32(offset, false);
  },
};

export const int8Codec: Codec<bigint> = {
  oid: Oid.Int8,
  decode(text) {
    return BigInt(text);
  },
  encode(value) {
    return value.toString(10);
  },
  decodeBinary(_buf, view, offset, _length) {
    return view.getBigInt64(offset, false);
  },
};

// `oid` is 32-bit unsigned; Postgres sends it as int4 in binary. We decode as
// unsigned to avoid surprising negative OIDs on values above 2^31.
export const oidCodec: Codec<number> = {
  oid: Oid.OidOid,
  decode(text) {
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`oid: cannot parse ${JSON.stringify(text)}`);
    }
    return n;
  },
  encode(value) {
    if (!Number.isInteger(value)) {
      throw new TypeError(`oid: expected integer, got ${value}`);
    }
    return value.toString(10);
  },
  decodeBinary(_buf, view, offset, _length) {
    return view.getUint32(offset, false);
  },
};
