// Legacy md5 password authentication.
//
//   token = "md5" + md5_hex( md5_hex(password ‖ user) ‖ salt )
//
// This is what the server expects in PasswordMessage in response to
// AuthenticationMD5Password. SCRAM is preferred on Postgres ≥ 10; md5 is kept
// for older servers and pg_hba.conf configurations that still use it.

import type { CryptoProvider } from "../crypto.js";

const utf8 = new TextEncoder();

export async function md5PasswordToken(
  crypto: CryptoProvider,
  user: string,
  password: string,
  salt: Uint8Array,
): Promise<string> {
  if (salt.length !== 4) {
    throw new Error(`md5: expected 4-byte salt, got ${salt.length}`);
  }
  const inner = await crypto.md5Hex(utf8.encode(password + user));
  const innerBytes = utf8.encode(inner);
  const buf = new Uint8Array(innerBytes.length + salt.length);
  buf.set(innerBytes, 0);
  buf.set(salt, innerBytes.length);
  const outer = await crypto.md5Hex(buf);
  return `md5${outer}`;
}
