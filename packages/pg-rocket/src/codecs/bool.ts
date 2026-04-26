// Bool codec. Postgres text format uses "t" / "f"; we accept the long forms on
// decode for tolerance but always emit single-char on encode for terseness.
// Binary format is a single byte: 0 → false, 1 → true.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

export const boolCodec: Codec<boolean> = {
  oid: Oid.Bool,
  decode(text) {
    if (text === "t" || text === "true") return true;
    if (text === "f" || text === "false") return false;
    throw new Error(`bool: cannot parse ${JSON.stringify(text)}`);
  },
  encode(value) {
    return value ? "t" : "f";
  },
  decodeBinary(buf, _view, offset, _length) {
    return buf[offset] !== 0;
  },
};
