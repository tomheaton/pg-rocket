// Postgres pg_type system catalog OIDs for the day-one scalar types and
// their array siblings. Values are stable across Postgres versions; comments
// list the canonical type names so a grep for an OID lands here.

export const Oid = {
  // Booleans, bytes, text-likes
  Bool: 16,
  Bytea: 17,
  Char: 18,
  Name: 19,
  Text: 25,
  Varchar: 1043,
  Bpchar: 1042,

  // Integers and floats
  Int8: 20,
  Int2: 21,
  Int4: 23,
  OidOid: 26, // the OID type itself
  Float4: 700,
  Float8: 701,
  Numeric: 1700,

  // Identifiers and structured payloads
  Uuid: 2950,
  Json: 114,
  Jsonb: 3802,

  // Temporal (binary epoch is 2000-01-01 for date/timestamp/timestamptz)
  Date: 1082,
  Time: 1083,
  Timetz: 1266,
  Timestamp: 1114,
  TimestampTz: 1184,
  Interval: 1186,

  // Array OIDs (array-of-T type for each scalar above)
  BoolArray: 1000,
  ByteaArray: 1001,
  Int2Array: 1005,
  Int4Array: 1007,
  TextArray: 1009,
  Int8Array: 1016,
  VarcharArray: 1015,
  Float4Array: 1021,
  Float8Array: 1022,
  TimestampArray: 1115,
  DateArray: 1182,
  TimeArray: 1183,
  TimestampTzArray: 1185,
  NumericArray: 1231,
  UuidArray: 2951,
  JsonArray: 199,
  JsonbArray: 3807,
} as const;

export type Oid = (typeof Oid)[keyof typeof Oid];
