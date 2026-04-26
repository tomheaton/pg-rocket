// Array codecs for the Postgres 1-D array text format.
//
// Wire format:
//   * `{}`                — empty array
//   * `{1,2,3}`           — bare elements (numbers, bools, uuids, dates, …)
//   * `{"a","b\\"c"}`     — quoted strings, with `\` and `"` escaped
//   * `{NULL,1,NULL}`     — bare NULL token marks a null element
//
// Multi-dimensional arrays use nested braces (`{{1,2},{3,4}}`); we decode
// those as flat arrays per row would be wrong, so this v0 slice only handles
// 1-D. Higher dimensions throw at decode time, with a clear message pointing
// to the deferred work.
//
// The factory takes an element codec and produces an array codec for one
// specific array OID. The encoder/decoder use the element codec's text
// `decode` / `encode` methods — binary array format is deferred (it needs
// per-element length-prefixed encoding plus the element OID in the header).

import { boolCodec } from "./bool.js";
import { float4Codec, float8Codec } from "./float.js";
import { int2Codec, int4Codec, int8Codec } from "./int.js";
import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";
import { dateCodec, timestampCodec, timestampTzCodec } from "./temporal.js";
import { numericCodec, textCodec, varcharCodec } from "./text.js";
import { uuidCodec } from "./uuid.js";

/**
 * Build a codec for a 1-D Postgres array of `element`. The returned codec's
 * `oid` is the *array* OID (e.g. `_int4` = 1007), distinct from the element
 * codec's scalar OID. Register array codecs in the registry alongside their
 * scalar siblings — the decode path looks them up by column OID, and the
 * encode path looks them up via element-type inference in the connection.
 */
export function makeArrayCodec<T>(
  arrayOid: number,
  element: Codec<T>,
): Codec<ReadonlyArray<T | null>> {
  return {
    oid: arrayOid,
    decode(text) {
      return decodeArrayText(text, element);
    },
    encode(value) {
      return encodeArrayText(value, element);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Decoding

function decodeArrayText<T>(
  text: string,
  element: Codec<T>,
): ReadonlyArray<T | null> {
  if (text.length < 2 || text.charCodeAt(0) !== 0x7b /* '{' */) {
    throw new Error(`array: expected '{...}', got ${JSON.stringify(text)}`);
  }
  if (text.charCodeAt(1) === 0x7b /* '{' */) {
    throw new Error("array: multi-dimensional arrays are not supported in v0");
  }
  if (text === "{}") return [];

  const out: Array<T | null> = [];
  const end = text.length - 1; // position of closing '}'
  let i = 1;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c === 0x2c /* ',' */) {
      // Adjacent commas would be a server bug — defensive skip.
      i++;
      continue;
    }
    if (c === 0x22 /* '"' */) {
      // Quoted scalar: collect with backslash unescape until closing quote.
      let j = i + 1;
      let raw = "";
      while (j < end) {
        const cc = text.charCodeAt(j);
        if (cc === 0x5c /* '\\' */) {
          raw += text[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (cc === 0x22 /* '"' */) break;
        raw += text[j];
        j++;
      }
      out.push(element.decode(raw));
      i = j + 1; // skip closing quote
    } else {
      // Unquoted token: NULL marker or a bare scalar literal.
      let j = i;
      while (j < end && text.charCodeAt(j) !== 0x2c) j++;
      const token = text.slice(i, j);
      if (token === "NULL") {
        out.push(null);
      } else {
        out.push(element.decode(token));
      }
      i = j;
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Encoding

function encodeArrayText<T>(
  items: ReadonlyArray<T | null>,
  element: Codec<T>,
): string {
  if (items.length === 0) return "{}";
  let out = "{";
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out += ",";
    const v = items[i];
    if (v === null || v === undefined) {
      out += "NULL";
      continue;
    }
    // Strings always need quoting (the element codec returns the raw text).
    // Other element types — int, float, bool, uuid, date, timestamp — never
    // produce reserved characters so we emit them bare. JSON-in-array is
    // explicitly out of scope; users with that need can store as `jsonb`.
    if (typeof v === "string") {
      out += quoteArrayElement(v);
    } else {
      const text = element.encode(v);
      // Defensive: if the element happens to look like NULL or contains a
      // comma/brace/quote, fall back to the quoted-element path so it
      // round-trips. Most numeric / temporal codecs never trigger this.
      if (
        text === "NULL" ||
        text.indexOf(",") >= 0 ||
        text.indexOf("{") >= 0 ||
        text.indexOf("}") >= 0 ||
        text.indexOf('"') >= 0 ||
        text.indexOf("\\") >= 0
      ) {
        out += quoteArrayElement(text);
      } else {
        out += text;
      }
    }
  }
  out += "}";
  return out;
}

function quoteArrayElement(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c /* '\\' */ || c === 0x22 /* '"' */) {
      out += "\\";
    }
    out += s[i];
  }
  out += '"';
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Default-registry entries.
//
// One array codec per common element type, registered alongside the scalars
// in `getDefaultRegistry`. The element codec is bound at module-load time;
// it is the *same* instance the registry uses for the scalar column.

export const boolArrayCodec = makeArrayCodec(Oid.BoolArray, boolCodec);
export const int2ArrayCodec = makeArrayCodec(Oid.Int2Array, int2Codec);
export const int4ArrayCodec = makeArrayCodec(Oid.Int4Array, int4Codec);
export const int8ArrayCodec = makeArrayCodec(Oid.Int8Array, int8Codec);
export const float4ArrayCodec = makeArrayCodec(Oid.Float4Array, float4Codec);
export const float8ArrayCodec = makeArrayCodec(Oid.Float8Array, float8Codec);
export const numericArrayCodec = makeArrayCodec(Oid.NumericArray, numericCodec);
export const textArrayCodec = makeArrayCodec(Oid.TextArray, textCodec);
export const varcharArrayCodec = makeArrayCodec(Oid.VarcharArray, varcharCodec);
export const uuidArrayCodec = makeArrayCodec(Oid.UuidArray, uuidCodec);
export const dateArrayCodec = makeArrayCodec(Oid.DateArray, dateCodec);
export const timestampArrayCodec = makeArrayCodec(
  Oid.TimestampArray,
  timestampCodec,
);
export const timestampTzArrayCodec = makeArrayCodec(
  Oid.TimestampTzArray,
  timestampTzCodec,
);
