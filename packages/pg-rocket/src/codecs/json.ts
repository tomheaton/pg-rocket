// json / jsonb — text format is just literal JSON for both. The on-wire binary
// format for jsonb has a 1-byte version prefix; that lands with the binary
// codec slice. For now both decode via JSON.parse and encode via JSON.stringify.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

function makeJsonCodec(oid: number): Codec<unknown> {
  return {
    oid,
    decode(text) {
      return JSON.parse(text);
    },
    encode(value) {
      return JSON.stringify(value);
    },
  };
}

export const jsonCodec = makeJsonCodec(Oid.Json);
export const jsonbCodec = makeJsonCodec(Oid.Jsonb);
