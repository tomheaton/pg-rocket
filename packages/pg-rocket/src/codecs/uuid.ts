// UUID — 8-4-4-4-12 canonical hex string. The text form on the wire already
// matches the canonical representation, so decode is the identity function.
// Encode validates lightly (length + hyphen positions) so a malformed string
// fails here rather than at the server.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

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
};
