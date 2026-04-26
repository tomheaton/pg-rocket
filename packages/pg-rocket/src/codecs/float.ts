// Float codecs (float4, float8). Postgres text format renders specials as
// "NaN" / "Infinity" / "-Infinity"; Number.parseFloat handles all three.
//
// Binary: float4 → IEEE 754 binary32 (4 bytes, big-endian); float8 → IEEE
// 754 binary64 (8 bytes, big-endian). DataView round-trips NaN / Infinity
// naturally, so no special-casing required.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

export const float4Codec: Codec<number> = {
  oid: Oid.Float4,
  decode(text) {
    const n = Number.parseFloat(text);
    if (Number.isNaN(n) && text !== "NaN") {
      throw new Error(`float4: cannot parse ${JSON.stringify(text)}`);
    }
    return n;
  },
  encode(value) {
    if (Number.isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
    return value.toString();
  },
  decodeBinary(_buf, view, offset, _length) {
    return view.getFloat32(offset, false);
  },
};

export const float8Codec: Codec<number> = {
  oid: Oid.Float8,
  decode(text) {
    const n = Number.parseFloat(text);
    if (Number.isNaN(n) && text !== "NaN") {
      throw new Error(`float8: cannot parse ${JSON.stringify(text)}`);
    }
    return n;
  },
  encode(value) {
    if (Number.isNaN(value)) return "NaN";
    if (value === Number.POSITIVE_INFINITY) return "Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
    return value.toString();
  },
  decodeBinary(_buf, view, offset, _length) {
    return view.getFloat64(offset, false);
  },
};
