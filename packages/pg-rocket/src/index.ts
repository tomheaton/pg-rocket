// Public package entry. v0 surface:
//
//   createClient, Db                       — the headline factory + facade
//   sql, sql.id / .unsafe / .cast / etc.   — the template tag + helpers
//   Transaction, Savepoint                 — transaction primitives
//   Connection, Pool                       — lower-level escape hatches
//   PgError + SQLSTATE subclasses          — error hierarchy
//
// The protocol layer is reachable via `pg-rocket/protocol` for embedders
// implementing alternative transports.

export {
  type CreateClientOptions,
  createClient,
  Db,
  type DbOptions,
} from "./client.js";
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
  type OnConnect,
  type PasswordSpec,
  type QueryOptions,
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
export type {
  ErrorEvent,
  NoticeEvent,
  OnError,
  OnNotice,
  OnQuery,
  QueryEvent,
} from "./observability.js";
export {
  type ParsedConnectionString,
  Pool,
  type PoolOptions,
  parseConnectionString,
} from "./pool/index.js";
export {
  Cast,
  cast,
  Fragment,
  Identifier,
  id,
  join,
  type MaterializedSql,
  materialize,
  raw,
  SqlPart,
  sql,
  Unsafe,
  unsafe,
} from "./sql/index.js";
export {
  type BeginOptions,
  type IsolationLevel,
  Savepoint,
  Transaction,
} from "./transaction.js";
