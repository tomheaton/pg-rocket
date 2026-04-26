// Temporal codecs — date / timestamp / timestamptz only in this slice.
//
// Postgres text formats:
//   date           → 'YYYY-MM-DD'
//   timestamp      → 'YYYY-MM-DD HH:MM:SS[.ffffff]'      (no offset; assumed UTC by the codec)
//   timestamptz    → 'YYYY-MM-DD HH:MM:SS[.ffffff]±HH'   (offset present)
//
// Decoding produces a JS `Date`. Sub-millisecond precision is lost — JS Date is
// millisecond-resolution. Microsecond-precise consumers can opt into a string
// codec by overriding the registry entry.
//
// time / timetz / interval need their own representations and are deferred.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

export const dateCodec: Codec<Date> = {
  oid: Oid.Date,
  decode(text) {
    // Append explicit UTC midnight so JS doesn't apply the local timezone.
    return new Date(`${text}T00:00:00Z`);
  },
  encode(value) {
    const y = value.getUTCFullYear().toString().padStart(4, "0");
    const m = (value.getUTCMonth() + 1).toString().padStart(2, "0");
    const d = value.getUTCDate().toString().padStart(2, "0");
    return `${y}-${m}-${d}`;
  },
};

export const timestampCodec: Codec<Date> = {
  oid: Oid.Timestamp,
  decode(text) {
    // 'YYYY-MM-DD HH:MM:SS[.ffffff]' → ISO. No timezone in the source, so we
    // append 'Z' to interpret the value as UTC. This matches Postgres' own
    // documentation: timestamp without time zone is "wall clock" but our
    // bridge to Date forces a stable interpretation.
    return new Date(`${text.replace(" ", "T")}Z`);
  },
  encode(value) {
    return formatIsoNoZone(value);
  },
};

export const timestampTzCodec: Codec<Date> = {
  oid: Oid.TimestampTz,
  decode(text) {
    // 'YYYY-MM-DD HH:MM:SS[.ffffff]±HH[:MM]' parses fine once the space becomes 'T'.
    return new Date(text.replace(" ", "T"));
  },
  encode(value) {
    // ISO 8601 with explicit 'Z' offset. Server stores in UTC regardless of input offset.
    return value.toISOString();
  },
};

function formatIsoNoZone(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const da = d.getUTCDate().toString().padStart(2, "0");
  const h = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  const ms = d.getUTCMilliseconds().toString().padStart(3, "0");
  return `${y}-${mo}-${da} ${h}:${mi}:${s}.${ms}`;
}
