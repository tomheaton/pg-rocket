// Connection-layer surface. Imports the protocol layer + a Transport; the
// Node TCP/TLS adapter is the only concrete transport in v0.

export {
  Connection,
  type ConnectOptions,
  type FieldDescription,
  type OnConnect,
  type PasswordSpec,
  type QueryOptions,
  type QueryResult,
  type Row,
  type TlsMode,
  type TlsOptions,
} from "./connection.js";
export { nodeCryptoProvider } from "./node-crypto.js";
export { connectTcp, NodeTransport } from "./tcp.js";
export type { TlsUpgradeOptions, Transport } from "./transport.js";
