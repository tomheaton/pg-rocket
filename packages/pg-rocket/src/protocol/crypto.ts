// CryptoProvider — the only piece of the protocol layer that the embedder must
// supply. Auth (SCRAM, MD5) is pure protocol; it does not import `node:crypto`,
// so it accepts a provider whose backing primitives can come from `node:crypto`,
// the WebCrypto SubtleCrypto API, a fixture for tests, or anywhere else.

export interface CryptoProvider {
  /** Cryptographically-secure random bytes. */
  randomBytes(byteLength: number): Uint8Array;

  /** SHA-256 digest of `data`. */
  sha256(data: Uint8Array): Promise<Uint8Array>;

  /** HMAC-SHA-256 of `data` keyed with `key`. */
  hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;

  /** PBKDF2 with HMAC-SHA-256, returning `keyLength` bytes. */
  pbkdf2Sha256(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keyLength: number,
  ): Promise<Uint8Array>;

  /** MD5 digest as a 32-character lowercase-hex string. Used only by the legacy md5 auth path. */
  md5Hex(data: Uint8Array): Promise<string>;
}
