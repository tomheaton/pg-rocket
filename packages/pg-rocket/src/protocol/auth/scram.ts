// SCRAM-SHA-256 client (RFC 5802 / 7677), tailored for the PostgreSQL SASL flow.
//
// Postgres-specific notes:
//   * The username in SCRAM messages is empty; the real username travels in
//     StartupMessage. Server-side this is documented and intentional.
//   * SASLprep on the password is not applied — Postgres does not require or
//     verify it, so we pass the password through as raw UTF-8.
//   * Only `SCRAM-SHA-256` (no `-PLUS` channel binding) is supported in v0.
//
// Wire flow:
//   client → AuthenticationSASL                ──── server
//   client ← SASLInitialResponse(client-first) ──── server
//          → AuthenticationSASLContinue (server-first)
//   client ← SASLResponse(client-final)        ──── server
//          → AuthenticationSASLFinal (server-verifier)

import { base64Decode, base64Encode } from "../base64.js";
import type { CryptoProvider } from "../crypto.js";

const MECHANISM = "SCRAM-SHA-256";

const utf8 = new TextEncoder();
const CLIENT_KEY = utf8.encode("Client Key");
const SERVER_KEY = utf8.encode("Server Key");

export interface ScramFirstResult {
  /** SASL mechanism name, ready to drop into SASLInitialResponse. */
  mechanism: typeof MECHANISM;
  /** UTF-8 bytes of the client-first-message. */
  initialResponse: Uint8Array;
}

export interface ScramSession {
  readonly clientNonce: string;
  readonly clientFirstBare: string;
  /** Set during {@link clientFinal}; checked by {@link verifyServerFinal}. */
  serverSignature: Uint8Array | null;
}

/** Begin a SCRAM-SHA-256 exchange. Returns a session to thread through the next two steps. */
export function clientFirst(crypto: CryptoProvider): {
  session: ScramSession;
  result: ScramFirstResult;
} {
  // 18 random bytes → 24 base64 chars; comfortably above the 16-byte minimum suggested by RFC 5802.
  const clientNonce = base64Encode(crypto.randomBytes(18));
  // Empty username in the SCRAM exchange (Postgres convention).
  const clientFirstBare = `n=,r=${clientNonce}`;
  // gs2-cbind-flag "n" (no channel binding), empty authzid → "n,,"
  const clientFirstMessage = `n,,${clientFirstBare}`;
  return {
    session: { clientNonce, clientFirstBare, serverSignature: null },
    result: {
      mechanism: MECHANISM,
      initialResponse: utf8.encode(clientFirstMessage),
    },
  };
}

/**
 * Process the server-first-message and emit the client-final-message.
 *
 * Mutates `session` to remember the expected server signature so {@link verifyServerFinal}
 * can validate the server's reply without re-deriving keys.
 */
export async function clientFinal(
  crypto: CryptoProvider,
  session: ScramSession,
  password: string,
  serverFirstMessage: Uint8Array,
): Promise<Uint8Array> {
  const serverFirst = decodeAscii(serverFirstMessage);
  const fields = parseScramAttributes(serverFirst);
  const combinedNonce = fields.get("r");
  const saltB64 = fields.get("s");
  const iterStr = fields.get("i");
  if (
    combinedNonce === undefined ||
    saltB64 === undefined ||
    iterStr === undefined
  ) {
    throw new Error("SCRAM: server-first-message missing one of r/s/i");
  }
  if (!combinedNonce.startsWith(session.clientNonce)) {
    throw new Error("SCRAM: server nonce does not begin with client nonce");
  }
  const iterations = Number.parseInt(iterStr, 10);
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error(`SCRAM: invalid iteration count "${iterStr}"`);
  }
  const salt = base64Decode(saltB64);
  const passwordBytes = utf8.encode(password);

  // SaltedPassword := PBKDF2-HMAC-SHA-256(password, salt, i, 32)
  const saltedPassword = await crypto.pbkdf2Sha256(
    passwordBytes,
    salt,
    iterations,
    32,
  );

  // ClientKey := HMAC(SaltedPassword, "Client Key")
  // StoredKey := H(ClientKey)
  // ServerKey := HMAC(SaltedPassword, "Server Key")
  const clientKey = await crypto.hmacSha256(saltedPassword, CLIENT_KEY);
  const storedKey = await crypto.sha256(clientKey);
  const serverKey = await crypto.hmacSha256(saltedPassword, SERVER_KEY);

  // base64("n,,") == "biws"
  const clientFinalNoProof = `c=biws,r=${combinedNonce}`;
  const authMessage = utf8.encode(
    `${session.clientFirstBare},${serverFirst},${clientFinalNoProof}`,
  );

  const clientSignature = await crypto.hmacSha256(storedKey, authMessage);
  const clientProof = xorBytes(clientKey, clientSignature);
  session.serverSignature = await crypto.hmacSha256(serverKey, authMessage);

  return utf8.encode(`${clientFinalNoProof},p=${base64Encode(clientProof)}`);
}

/** Verify the server-final-message. Throws if the server's signature does not match. */
export function verifyServerFinal(
  session: ScramSession,
  serverFinalMessage: Uint8Array,
): void {
  const fields = parseScramAttributes(decodeAscii(serverFinalMessage));
  const error = fields.get("e");
  if (error !== undefined) {
    throw new Error(`SCRAM: server reported error "${error}"`);
  }
  const verifier = fields.get("v");
  if (verifier === undefined) {
    throw new Error("SCRAM: server-final-message missing verifier");
  }
  if (session.serverSignature === null) {
    throw new Error(
      "SCRAM: clientFinal() must be called before verifyServerFinal()",
    );
  }
  if (
    !constantTimeEqualString(base64Encode(session.serverSignature), verifier)
  ) {
    throw new Error("SCRAM: server signature mismatch");
  }
}

// ────────────────────────────────────────────────────────────────────────
// helpers

function parseScramAttributes(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of s.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

function decodeAscii(bytes: Uint8Array): string {
  // SCRAM messages are restricted to printable 7-bit ASCII per RFC 5802 §5.1.
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i] as number);
  }
  return result;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error(`SCRAM: xor length mismatch (${a.length} vs ${b.length})`);
  }
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = (a[i] as number) ^ (b[i] as number);
  }
  return out;
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
