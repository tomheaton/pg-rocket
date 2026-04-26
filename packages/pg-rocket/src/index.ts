// Public package entry. v0 surface is intentionally tiny:
//   - Connection — direct connect()/query()/end() (this slice).
//   - createClient(), sql tag, pool — added in upcoming layers.
//
// The protocol layer is reachable via `pg-rocket/protocol` for embedders
// implementing alternative transports.

export {
  Connection,
  type ConnectOptions,
  connectTcp,
  type FieldDescription,
  NodeTransport,
  nodeCryptoProvider,
  type PasswordSpec,
  type QueryResult,
  type SimpleQueryRow,
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
