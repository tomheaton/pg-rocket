// Bytea — binary blob.
//
// Postgres text format is `\x` followed by lowercase hex. The legacy "escape"
// format (octal escapes) is also accepted but only emitted when bytea_output is
// configured to it; we send `\x...` and accept either on input.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

const HEX = "0123456789abcdef".split("");

export const byteaCodec: Codec<Uint8Array> = {
  oid: Oid.Bytea,
  decode(text) {
    if (text.startsWith("\\x")) return decodeHex(text);
    return decodeEscape(text);
  },
  encode(value) {
    let out = "\\x";
    for (let i = 0; i < value.length; i++) {
      const b = value[i] as number;
      out += HEX[b >> 4] as string;
      out += HEX[b & 0x0f] as string;
    }
    return out;
  },
  decodeBinary(buf, _view, offset, length) {
    // Slice (not subarray) — the reader buffer is reused on the next message;
    // we hand the user a buffer they own.
    return buf.slice(offset, offset + length);
  },
};

function decodeHex(text: string): Uint8Array {
  const len = text.length - 2;
  if ((len & 1) !== 0) {
    throw new Error("bytea: hex form must have even number of nibbles");
  }
  const out = new Uint8Array(len >> 1);
  for (let i = 0; i < out.length; i++) {
    const hi = parseHexNibble(text.charCodeAt(2 + i * 2));
    const lo = parseHexNibble(text.charCodeAt(2 + i * 2 + 1));
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function parseHexNibble(ch: number): number {
  if (ch >= 0x30 && ch <= 0x39) return ch - 0x30; // '0'-'9'
  if (ch >= 0x61 && ch <= 0x66) return ch - 0x57; // 'a'-'f'
  if (ch >= 0x41 && ch <= 0x46) return ch - 0x37; // 'A'-'F'
  throw new Error(`bytea: invalid hex nibble 0x${ch.toString(16)}`);
}

function decodeEscape(text: string): Uint8Array {
  // Streamed decode: the output cannot exceed the input length in bytes.
  const out = new Uint8Array(text.length);
  let outIdx = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch !== 0x5c /* '\\' */) {
      out[outIdx++] = ch;
      i++;
      continue;
    }
    // Doubled backslash → literal backslash.
    if (text.charCodeAt(i + 1) === 0x5c) {
      out[outIdx++] = 0x5c;
      i += 2;
      continue;
    }
    // \nnn — three-digit octal escape.
    const a = text.charCodeAt(i + 1) - 0x30;
    const b = text.charCodeAt(i + 2) - 0x30;
    const c = text.charCodeAt(i + 3) - 0x30;
    if (a < 0 || a > 7 || b < 0 || b > 7 || c < 0 || c > 7) {
      throw new Error(`bytea: invalid escape at offset ${i}`);
    }
    out[outIdx++] = (a << 6) | (b << 3) | c;
    i += 4;
  }
  return out.subarray(0, outIdx);
}
