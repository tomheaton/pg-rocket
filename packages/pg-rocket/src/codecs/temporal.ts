// Temporal codecs — date / timestamp / timestamptz only in this slice.
//
// Postgres text formats:
//   date           → 'YYYY-MM-DD'
//   timestamp      → 'YYYY-MM-DD HH:MM:SS[.ffffff]'      (no offset; assumed UTC by the codec)
//   timestamptz    → 'YYYY-MM-DD HH:MM:SS[.ffffff]±HH'   (offset present)
//
// Binary formats (per Postgres docs, format_code = 1):
//   date           → int32: days since 2000-01-01
//   timestamp      → int64: microseconds since 2000-01-01 00:00:00 (UTC reading)
//   timestamptz    → int64: microseconds since 2000-01-01 00:00:00 UTC
//
// Decoding produces a JS `Date`. Sub-millisecond precision is lost — JS Date is
// millisecond-resolution. Microsecond-precise consumers can opt into a string
// codec by overriding the registry entry.
//
// time / timetz / interval need their own representations and are deferred.

import { Oid } from "./oids.js";
import type { Codec } from "./registry.js";

// Postgres counts time from 2000-01-01; JS Date counts from 1970-01-01. The
// gap is exactly 30 years of UTC milliseconds.
const PG_EPOCH_MS = Date.UTC(2000, 0, 1);
const PG_EPOCH_MS_BIGINT = BigInt(PG_EPOCH_MS);
const MS_PER_DAY = 86_400_000;

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
  decodeBinary(_buf, view, offset, _length) {
    const days = view.getInt32(offset, false);
    return new Date(PG_EPOCH_MS + days * MS_PER_DAY);
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
  decodeBinary(_buf, view, offset, _length) {
    return microsToDate(view.getBigInt64(offset, false));
  },
};

export const timestampTzCodec: Codec<Date> = {
  oid: Oid.TimestampTz,
  decode(text) {
    // Postgres may emit offsets as ±HH; JS Date wants ±HH:MM.
    return new Date(normalizeTimestampTz(text));
  },
  encode(value) {
    // ISO 8601 with explicit 'Z' offset. Server stores in UTC regardless of input offset.
    return value.toISOString();
  },
  decodeBinary(_buf, view, offset, _length) {
    return microsToDate(view.getBigInt64(offset, false));
  },
};

function microsToDate(micros: bigint): Date {
  // Round half-toward-zero to milliseconds, then add the JS epoch offset.
  // BigInt division truncates toward zero, which matches the Postgres /
  // libpq convention of dropping the sub-millisecond fraction.
  const ms = micros / 1000n + PG_EPOCH_MS_BIGINT;
  return new Date(Number(ms));
}

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

function normalizeTimestampTz(text: string): string {
  return text
    .replace(" ", "T")
    .replace(
      /([+-]\d{2})(\d{2})?$/,
      (_match, hours: string, minutes: string | undefined) =>
        `${hours}:${minutes ?? "00"}`,
    );
}
