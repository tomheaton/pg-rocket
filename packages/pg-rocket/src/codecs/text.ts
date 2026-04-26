// Text-like codecs. text / varchar / bpchar / name / char all share the same
// wire representation (raw UTF-8) — only the OID differs, so they share an
// identity codec function.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

function makeTextCodec(oid: number): Codec<string> {
  return {
    oid,
    decode(text) {
      return text;
    },
    encode(value) {
      return value;
    },
  };
}

export const textCodec = makeTextCodec(Oid.Text);
export const varcharCodec = makeTextCodec(Oid.Varchar);
export const bpcharCodec = makeTextCodec(Oid.Bpchar);
export const nameCodec = makeTextCodec(Oid.Name);
export const charCodec = makeTextCodec(Oid.Char);

// Numeric — preserved as a string to avoid Number-precision loss. Matches the
// behaviour of `pg` and `postgres.js` for the same reason.
export const numericCodec: Codec<string> = {
  oid: Oid.Numeric,
  decode(text) {
    return text;
  },
  encode(value) {
    return value;
  },
};
