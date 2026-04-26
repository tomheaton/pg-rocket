// Codec barrel + lazy default registry.
//
// Cold-import budget matters: we don't construct the registry at module load.
// `getDefaultRegistry()` builds it on first call and memoises; re-exporters
// who only want the Codec interface and Oid table pay nothing.

import { boolCodec } from "./bool.js";
import { byteaCodec } from "./bytea.js";
import { float4Codec, float8Codec } from "./float.js";
import { int2Codec, int4Codec, int8Codec, oidCodec } from "./int.js";
import { jsonbCodec, jsonCodec } from "./json.js";
import { CodecRegistry } from "./registry.js";
import { dateCodec, timestampCodec, timestampTzCodec } from "./temporal.js";
import {
  bpcharCodec,
  charCodec,
  nameCodec,
  numericCodec,
  textCodec,
  varcharCodec,
} from "./text.js";
import { uuidCodec } from "./uuid.js";

export { Oid } from "./oids.js";
export type { Codec } from "./registry.js";
export { CodecRegistry } from "./registry.js";

export {
  boolCodec,
  bpcharCodec,
  byteaCodec,
  charCodec,
  dateCodec,
  float4Codec,
  float8Codec,
  int2Codec,
  int4Codec,
  int8Codec,
  jsonbCodec,
  jsonCodec,
  nameCodec,
  numericCodec,
  oidCodec,
  textCodec,
  timestampCodec,
  timestampTzCodec,
  uuidCodec,
  varcharCodec,
};

let cached: CodecRegistry | null = null;

/**
 * Lazy singleton registry populated with codecs for the day-one scalar types.
 * Idempotent; subsequent calls return the same instance. Mutating it (via
 * `register`) affects all consumers — clone a fresh one if you want isolation.
 */
export function getDefaultRegistry(): CodecRegistry {
  if (cached !== null) return cached;
  const r = new CodecRegistry();
  r.register(boolCodec);
  r.register(byteaCodec);
  r.register(charCodec);
  r.register(nameCodec);
  r.register(int2Codec);
  r.register(int4Codec);
  r.register(int8Codec);
  r.register(oidCodec);
  r.register(float4Codec);
  r.register(float8Codec);
  r.register(numericCodec);
  r.register(textCodec);
  r.register(varcharCodec);
  r.register(bpcharCodec);
  r.register(uuidCodec);
  r.register(jsonCodec);
  r.register(jsonbCodec);
  r.register(dateCodec);
  r.register(timestampCodec);
  r.register(timestampTzCodec);
  cached = r;
  return r;
}
