// Public package entry. v0 surface is intentionally tiny:
//   - Connection — direct connect()/query()/extQuery()/end().
//   - Codec / CodecRegistry — pluggable type decoding.
//   - PgError + SQLSTATE subclasses + ConnectionError hierarchy.
//
// Higher-level APIs (createClient, sql tag, pool) are added in upcoming layers.
// The protocol layer is reachable via `pg-rocket/protocol` for embedders
// implementing alternative transports.

export {
  type Codec,
  CodecRegistry,
  getDefaultRegistry,
  Oid,
} from "./codecs/index.js";
export {
  Connection,
  type ConnectOptions,
  connectTcp,
  type FieldDescription,
  NodeTransport,
  nodeCryptoProvider,
  type PasswordSpec,
  type QueryResult,
  type Row,
  type TlsMode,
  type TlsOptions,
  type TlsUpgradeOptions,
  type Transport,
} from "./connection/index.js";
export {
  AuthenticationError,
  CheckViolation,
  ConnectionError,
  DeadlockDetected,
  decodeErrorResponse,
  ForeignKeyViolation,
  NotNullViolation,
  PgError,
  type PgErrorFields,
  ProtocolError,
  QueryCanceled,
  SerializationFailure,
  UniqueViolation,
} from "./errors.js";
