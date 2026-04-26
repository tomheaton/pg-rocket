// Backend message parser.
//
// One growable Uint8Array per connection. `push()` accepts transport bytes;
// `next()` peels off framed messages as `{ kind, offset, length }` records that
// borrow into the internal buffer. Consumers parse the body inline before the
// next call into the reader — no per-message allocation in the steady state.
//
// Compaction is opportunistic. The buffer slides only when the read pointer
// has advanced and an incoming chunk wouldn't otherwise fit; in steady state
// the buffer reaches a high-water mark and stays there.

const INITIAL_CAPACITY = 4096;
const HEADER_SIZE = 5; // 1-byte type + 4-byte length

export interface BackendMessage {
  /** Single-byte message-type code (e.g. 0x52 for AuthenticationRequest). */
  readonly kind: number;
  /** Offset of the first body byte in the reader's buffer. */
  readonly offset: number;
  /** Number of body bytes (length field minus the 4 bytes the field itself occupies). */
  readonly length: number;
}

export class MessageReader {
  private buf: Uint8Array;
  private viewRef: DataView;
  // First unparsed byte.
  private readPos = 0;
  // One past the last buffered byte.
  private writePos = 0;

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.buf = new Uint8Array(initialCapacity);
    this.viewRef = new DataView(
      this.buf.buffer,
      this.buf.byteOffset,
      this.buf.byteLength,
    );
  }

  /** Bytes buffered but not yet parsed. */
  get available(): number {
    return this.writePos - this.readPos;
  }

  /** Underlying buffer. Read-only access only — do not mutate. */
  get bytes(): Uint8Array {
    return this.buf;
  }

  /** DataView over the underlying buffer, for body decoding by consumers. */
  get view(): DataView {
    return this.viewRef;
  }

  /** Append transport bytes. Allocates only if growth or compaction is needed. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.ensureWritable(chunk.length);
    this.buf.set(chunk, this.writePos);
    this.writePos += chunk.length;
  }

  /**
   * Try to parse one complete framed message. Returns null if fewer than a
   * full frame is buffered. Offsets in the returned record are valid only
   * until the next call into the reader.
   */
  next(): BackendMessage | null {
    if (this.writePos - this.readPos < HEADER_SIZE) return null;
    const kind = this.buf[this.readPos] as number;
    const length = this.viewRef.getInt32(this.readPos + 1, false);
    if (length < 4) {
      throw new Error(
        `MessageReader: invalid length ${length} for kind 0x${kind.toString(16)}`,
      );
    }
    const total = length + 1; // include the 1-byte type
    if (this.writePos - this.readPos < total) return null;
    const message: BackendMessage = {
      kind,
      offset: this.readPos + HEADER_SIZE,
      length: length - 4,
    };
    this.readPos += total;
    return message;
  }

  /**
   * Read the single-byte response the server sends in reply to SSLRequest /
   * GSSENCRequest before the framed message stream begins. Returns null if no
   * byte is buffered yet.
   */
  readNegotiationByte(): number | null {
    if (this.writePos - this.readPos < 1) return null;
    return this.buf[this.readPos++] as number;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Buffer growth / compaction

  private ensureWritable(extra: number): void {
    if (this.writePos + extra <= this.buf.length) return;
    const unread = this.writePos - this.readPos;
    // If sliding the unread bytes to offset 0 would create enough room, prefer that
    // over allocating — keeps the steady state at one allocation per connection.
    if (this.readPos > 0 && unread + extra <= this.buf.length) {
      this.buf.copyWithin(0, this.readPos, this.writePos);
      this.writePos = unread;
      this.readPos = 0;
      return;
    }
    let cap = this.buf.length * 2;
    while (cap < unread + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(this.readPos, this.writePos));
    this.writePos = unread;
    this.readPos = 0;
    this.buf = next;
    this.viewRef = new DataView(next.buffer, next.byteOffset, next.byteLength);
  }
}
