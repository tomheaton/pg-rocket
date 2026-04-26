/// <reference types="node" />

// Node-backed CryptoProvider. The protocol layer accepts any provider, so
// alternate runtimes can supply a Web-Crypto-backed one without touching this file.
//
// All Node primitives we use (createHash, createHmac, pbkdf2, randomBytes) are
// synchronous; we wrap them in resolved Promises to match the async interface.
// Buffer outputs are returned as-is — Buffer extends Uint8Array, the consumer
// only reads bytes, and there's no Buffer-pool aliasing for digest output.

import { createHash, createHmac, pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";

import type { CryptoProvider } from "../protocol/crypto.js";

const pbkdf2Async = promisify(pbkdf2);

export const nodeCryptoProvider: CryptoProvider = {
  randomBytes(byteLength) {
    return randomBytes(byteLength);
  },
  async sha256(data) {
    return createHash("sha256").update(data).digest();
  },
  async hmacSha256(key, data) {
    return createHmac("sha256", key).update(data).digest();
  },
  async pbkdf2Sha256(password, salt, iterations, keyLength) {
    return pbkdf2Async(password, salt, iterations, keyLength, "sha256");
  },
  async md5Hex(data) {
    return createHash("md5").update(data).digest("hex");
  },
};
