// Public package entry. v0 surface:
//
//   createClient, Db, Cursor                — headline factory + facade + streaming
//   sql, sql.id / .unsafe / .cast / etc.    — template tag + helpers
//   Transaction, Savepoint                  — transaction primitives
//   ListenerManager, Subscription           — LISTEN/NOTIFY
//   Connection, Pool                        — lower-level escape hatches
//   PgError + SQLSTATE class hierarchy      — server-side errors
//   ConnectionError + transport-side errors — client-side errors
//
// The protocol layer is reachable via `pg-rocket/protocol` for embedders
// implementing alternative transports.

export {
  type CreateClientOptions,
  Cursor,
  createClient,
  Db,
  type DbOptions,
  type SqlMethod,
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
  CopyInController,
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
  CopyApi,
  type CopyFormat,
  type CopyInOptions,
  type CopyInWriter,
  type CopyOptions,
  type CopyOutOptions,
  type CopyOutReader,
} from "./copy.js";
export {
  AuthenticationError,
  CheckViolation,
  CodecError,
  ConnectionError,
  DeadlockDetected,
  DecodingError,
  decodeErrorResponse,
  EncodingError,
  ExclusionViolation,
  ForeignKeyViolation,
  InsufficientResources,
  IntegrityError,
  NotNullViolation,
  PgError,
  type PgErrorFields,
  PgSyntaxError,
  ProtocolError,
  QueryCanceled,
  SerializationFailure,
  TimeoutError,
  TransactionError,
  UndefinedColumn,
  UndefinedFunction,
  UndefinedTable,
  UniqueViolation,
} from "./errors.js";
export {
  ListenerManager,
  type NotificationHandler,
  type Subscription,
} from "./listen.js";
export type {
  ErrorEvent,
  NoticeEvent,
  NotificationEvent,
  OnError,
  OnNotice,
  OnNotification,
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
  ArrayParam,
  array,
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
  ValuesList,
  values,
} from "./sql/index.js";
export {
  type BeginOptions,
  type IsolationLevel,
  Savepoint,
  Transaction,
} from "./transaction.js";
