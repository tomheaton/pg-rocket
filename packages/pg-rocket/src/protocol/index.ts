// Protocol-layer surface. Pure data + pure functions; no I/O, no node:* imports.

export { md5PasswordToken } from "./auth/md5.js";
export * as scram from "./auth/scram.js";
export { base64Decode, base64Encode } from "./base64.js";
export type { CryptoProvider } from "./crypto.js";
export {
  AuthRequest,
  BackendKind,
  CANCEL_REQUEST_CODE,
  FieldCode,
  Format,
  FrontendKind,
  GSSENC_REQUEST_CODE,
  PROTOCOL_VERSION,
  SSL_REQUEST_CODE,
  StatementOrPortal,
  TxStatus,
} from "./messages.js";
export { type BackendMessage, MessageReader } from "./reader.js";
export { MessageWriter } from "./writer.js";
