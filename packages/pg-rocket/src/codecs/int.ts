// Integer codecs (int2, int4, int8). int8 decodes as bigint always — `pg`
// defaulting to string here is a 2026 anti-default; bigint is what callers
// actually want for 64-bit values.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

function makeIntCodec(oid: number): Codec<number> {
  return {
    oid,
    decode(text) {
      const n = Number.parseInt(text, 10);
      if (!Number.isFinite(n)) {
        throw new Error(`int${oid}: cannot parse ${JSON.stringify(text)}`);
      }
      return n;
    },
    encode(value) {
      if (!Number.isInteger(value)) {
        throw new TypeError(`int${oid}: expected integer, got ${value}`);
      }
      return value.toString(10);
    },
  };
}

export const int2Codec = makeIntCodec(Oid.Int2);
export const int4Codec = makeIntCodec(Oid.Int4);

export const int8Codec: Codec<bigint> = {
  oid: Oid.Int8,
  decode(text) {
    return BigInt(text);
  },
  encode(value) {
    return value.toString(10);
  },
};

export const oidCodec = makeIntCodec(Oid.OidOid);
