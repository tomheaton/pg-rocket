// PostgreSQL v3 wire-protocol message-type bytes and inline enum values.
//
// Pure data tables: no I/O, no allocation beyond module init. Values are the
// raw bytes that appear on the wire so call sites stay self-explanatory under
// hex inspection.

// Frontend (client → server) message-type bytes.
export const FrontendKind = {
  Bind: 0x42, // 'B'
  Close: 0x43, // 'C'
  CopyData: 0x64, // 'd'
  CopyDone: 0x63, // 'c'
  CopyFail: 0x66, // 'f'
  Describe: 0x44, // 'D'
  Execute: 0x45, // 'E'
  Flush: 0x48, // 'H'
  Parse: 0x50, // 'P'
  PasswordMessage: 0x70, // 'p' — also covers SASLInitialResponse, SASLResponse, GSSResponse
  Query: 0x51, // 'Q'
  Sync: 0x53, // 'S'
  Terminate: 0x58, // 'X'
} as const;
export type FrontendKind = (typeof FrontendKind)[keyof typeof FrontendKind];

// Backend (server → client) message-type bytes.
export const BackendKind = {
  AuthenticationRequest: 0x52, // 'R'
  BackendKeyData: 0x4b, // 'K'
  BindComplete: 0x32, // '2'
  CloseComplete: 0x33, // '3'
  CommandComplete: 0x43, // 'C'
  CopyBothResponse: 0x57, // 'W'
  CopyData: 0x64, // 'd'
  CopyDone: 0x63, // 'c'
  CopyInResponse: 0x47, // 'G'
  CopyOutResponse: 0x48, // 'H'
  DataRow: 0x44, // 'D'
  EmptyQueryResponse: 0x49, // 'I'
  ErrorResponse: 0x45, // 'E'
  FunctionCallResponse: 0x56, // 'V'
  NegotiateProtocolVersion: 0x76, // 'v'
  NoData: 0x6e, // 'n'
  NoticeResponse: 0x4e, // 'N'
  NotificationResponse: 0x41, // 'A'
  ParameterDescription: 0x74, // 't'
  ParameterStatus: 0x53, // 'S'
  ParseComplete: 0x31, // '1'
  PortalSuspended: 0x73, // 's'
  ReadyForQuery: 0x5a, // 'Z'
  RowDescription: 0x54, // 'T'
} as const;
export type BackendKind = (typeof BackendKind)[keyof typeof BackendKind];

// AuthenticationRequest sub-codes (the int32 immediately after the message header).
export const AuthRequest = {
  Ok: 0,
  KerberosV5: 2,
  CleartextPassword: 3,
  Md5Password: 5,
  ScmCredential: 6,
  Gss: 7,
  GssContinue: 8,
  Sspi: 9,
  Sasl: 10,
  SaslContinue: 11,
  SaslFinal: 12,
} as const;
export type AuthRequest = (typeof AuthRequest)[keyof typeof AuthRequest];

// ErrorResponse / NoticeResponse field-code bytes.
export const FieldCode = {
  Severity: 0x53, // 'S' (localized)
  SeverityNonLocal: 0x56, // 'V'
  Code: 0x43, // 'C' — SQLSTATE
  Message: 0x4d, // 'M'
  Detail: 0x44, // 'D'
  Hint: 0x48, // 'H'
  Position: 0x50, // 'P'
  InternalPosition: 0x70, // 'p'
  InternalQuery: 0x71, // 'q'
  Where: 0x57, // 'W'
  Schema: 0x73, // 's'
  Table: 0x74, // 't'
  Column: 0x63, // 'c'
  DataType: 0x64, // 'd'
  Constraint: 0x6e, // 'n'
  File: 0x46, // 'F'
  Line: 0x4c, // 'L'
  Routine: 0x52, // 'R'
} as const;
export type FieldCode = (typeof FieldCode)[keyof typeof FieldCode];

// ReadyForQuery transaction-status indicator (single byte after header).
export const TxStatus = {
  Idle: 0x49, // 'I' — not in a transaction
  InTransaction: 0x54, // 'T'
  Failed: 0x45, // 'E' — failed transaction, awaiting ROLLBACK
} as const;
export type TxStatus = (typeof TxStatus)[keyof typeof TxStatus];

// Format codes used by Bind, RowDescription, DataRow.
export const Format = {
  Text: 0,
  Binary: 1,
} as const;
export type Format = (typeof Format)[keyof typeof Format];

// Describe / Close kind-byte: targets either a prepared statement or a portal.
export const StatementOrPortal = {
  Statement: 0x53, // 'S'
  Portal: 0x50, // 'P'
} as const;
export type StatementOrPortal =
  (typeof StatementOrPortal)[keyof typeof StatementOrPortal];

// v3 wire-protocol version: major 3, minor 0.
export const PROTOCOL_VERSION = 196608; // (3 << 16) | 0

// Special request codes that ride in place of a protocol version on an untyped frame.
export const SSL_REQUEST_CODE = 80877103;
export const GSSENC_REQUEST_CODE = 80877104;
export const CANCEL_REQUEST_CODE = 80877102;
