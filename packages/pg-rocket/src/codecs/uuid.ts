// UUID — 8-4-4-4-12 canonical hex string. The text form on the wire already
// matches the canonical representation, so decode is the identity function.
// Encode validates lightly (length + hyphen positions) so a malformed string
// fails here rather than at the server.
//
// Binary form is 16 raw bytes; we render to canonical hex via a small lookup
// table so the hot path stays branch-free.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

// Pre-built byte → "xx" table. Indexing into a string table is faster than
// `padStart(2, "0")` at decode time.
const HEX_TABLE: string[] = new Array(256);
for (let i = 0; i < 256; i++) {
  HEX_TABLE[i] = i.toString(16).padStart(2, "0");
}

export const uuidCodec: Codec<string> = {
  oid: Oid.Uuid,
  decode(text) {
    return text;
  },
  encode(value) {
    if (value.length !== 36) {
      throw new TypeError(
        `uuid: expected 36-character string, got length ${value.length}`,
      );
    }
    if (
      value.charCodeAt(8) !== 0x2d ||
      value.charCodeAt(13) !== 0x2d ||
      value.charCodeAt(18) !== 0x2d ||
      value.charCodeAt(23) !== 0x2d
    ) {
      throw new TypeError(
        `uuid: hyphens missing in expected positions in ${JSON.stringify(value)}`,
      );
    }
    return value;
  },
  decodeBinary(buf, _view, offset, _length) {
    // 16 bytes → "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
    return (
      `${HEX_TABLE[buf[offset] as number]}${HEX_TABLE[buf[offset + 1] as number]}${HEX_TABLE[buf[offset + 2] as number]}${HEX_TABLE[buf[offset + 3] as number]}-` +
      `${HEX_TABLE[buf[offset + 4] as number]}${HEX_TABLE[buf[offset + 5] as number]}-` +
      `${HEX_TABLE[buf[offset + 6] as number]}${HEX_TABLE[buf[offset + 7] as number]}-` +
      `${HEX_TABLE[buf[offset + 8] as number]}${HEX_TABLE[buf[offset + 9] as number]}-` +
      `${HEX_TABLE[buf[offset + 10] as number]}${HEX_TABLE[buf[offset + 11] as number]}${HEX_TABLE[buf[offset + 12] as number]}${HEX_TABLE[buf[offset + 13] as number]}${HEX_TABLE[buf[offset + 14] as number]}${HEX_TABLE[buf[offset + 15] as number]}`
    );
  },
};
