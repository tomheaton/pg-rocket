// Standard base64 (RFC 4648) for SCRAM nonces, salts, signatures, proofs.
//
// Implemented inline rather than via `globalThis.btoa`/`atob` because those
// operate on binary strings, which means an extra `String.fromCharCode` round
// trip when the source is already a Uint8Array. SCRAM payloads are small but
// they're on the connection-establishment hot path.

// Lookup as a Uint8Array of ASCII codepoints rather than a string lets the encoder
// emit each character via String.fromCharCode without the index-into-string
// `string | undefined` dance under noUncheckedIndexedAccess.
const ALPHA = new Uint8Array([
  0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d,
  0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a,
  0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d,
  0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a,
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x2b, 0x2f,
]);

export function base64Encode(bytes: Uint8Array): string {
  const len = bytes.length;
  // 4 ASCII chars per 3 input bytes, rounded up.
  const out = new Uint8Array(((len + 2) / 3) << 2);
  let outIdx = 0;
  let i = 0;
  for (; i + 3 <= len; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    const c = bytes[i + 2] as number;
    out[outIdx++] = ALPHA[a >> 2] as number;
    out[outIdx++] = ALPHA[((a & 0x03) << 4) | (b >> 4)] as number;
    out[outIdx++] = ALPHA[((b & 0x0f) << 2) | (c >> 6)] as number;
    out[outIdx++] = ALPHA[c & 0x3f] as number;
  }
  const rem = len - i;
  if (rem === 1) {
    const a = bytes[i] as number;
    out[outIdx++] = ALPHA[a >> 2] as number;
    out[outIdx++] = ALPHA[(a & 0x03) << 4] as number;
    out[outIdx++] = 0x3d; // '='
    out[outIdx++] = 0x3d;
  } else if (rem === 2) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    out[outIdx++] = ALPHA[a >> 2] as number;
    out[outIdx++] = ALPHA[((a & 0x03) << 4) | (b >> 4)] as number;
    out[outIdx++] = ALPHA[(b & 0x0f) << 2] as number;
    out[outIdx++] = 0x3d;
  }
  // String.fromCharCode of the ASCII bytes — base64 alphabet is all ≤ 0x7f.
  let result = "";
  for (let j = 0; j < outIdx; j++)
    result += String.fromCharCode(out[j] as number);
  return result;
}

export function base64Decode(s: string): Uint8Array {
  // Trim trailing padding once; the loop below tolerates inputs without padding.
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 61 /* '=' */) end--;

  const out = new Uint8Array((end * 3) >> 2);
  let outIdx = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < end; i++) {
    const ch = s.charCodeAt(i);
    let v: number;
    if (ch >= 65 && ch <= 90) {
      v = ch - 65; // A-Z → 0-25
    } else if (ch >= 97 && ch <= 122) {
      v = ch - 71; // a-z → 26-51
    } else if (ch >= 48 && ch <= 57) {
      v = ch + 4; // 0-9 → 52-61
    } else if (ch === 43) {
      v = 62; // '+'
    } else if (ch === 47) {
      v = 63; // '/'
    } else {
      throw new Error(`base64Decode: invalid character at index ${i}`);
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIdx++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
