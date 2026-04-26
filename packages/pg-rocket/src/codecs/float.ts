// Float codecs (float4, float8). Postgres text format renders specials as
// "NaN" / "Infinity" / "-Infinity"; Number.parseFloat handles all three.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

function makeFloatCodec(oid: number): Codec<number> {
  return {
    oid,
    decode(text) {
      // parseFloat handles "NaN", "Infinity", "-Infinity" via fast paths.
      const n = Number.parseFloat(text);
      if (Number.isNaN(n) && text !== "NaN") {
        throw new Error(`float${oid}: cannot parse ${JSON.stringify(text)}`);
      }
      return n;
    },
    encode(value) {
      if (Number.isNaN(value)) return "NaN";
      if (value === Number.POSITIVE_INFINITY) return "Infinity";
      if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
      return value.toString();
    },
  };
}

export const float4Codec = makeFloatCodec(Oid.Float4);
export const float8Codec = makeFloatCodec(Oid.Float8);
