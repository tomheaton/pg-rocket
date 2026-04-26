// Frontend message encoder.
//
// One growable Uint8Array per connection. Helpers reserve a header slot, fill
// the body, then back-fill the int32 length. The pipeliner encodes any number
// of messages between flushes and calls `bytes()` once to hand the whole batch
// to the transport — that's the single coalesced syscall the design depends on.

import {
  CANCEL_REQUEST_CODE,
  type Format,
  FrontendKind,
  PROTOCOL_VERSION,
  SSL_REQUEST_CODE,
  type StatementOrPortal,
} from "./messages.js";

const INITIAL_CAPACITY = 4096;
const HEADER_SIZE = 5; // 1-byte type + 4-byte length

const utf8Encoder = new TextEncoder();

export class MessageWriter {
  private buf: Uint8Array;
  private view: DataView;
  private offset = 0;
  // Offset of the int32 length slot for the open frame; -1 when no frame is open.
  private headerStart = -1;

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(
      this.buf.buffer,
      this.buf.byteOffset,
      this.buf.byteLength,
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Buffer management

  /** Bytes currently encoded since the last reset. */
  get length(): number {
    return this.offset;
  }

  /** Window over the encoded bytes. Valid until the next mutation. */
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.offset);
  }

  /** Mark all encoded bytes as consumed; capacity is preserved. */
  reset(): void {
    this.offset = 0;
  }

  private ensure(extra: number): void {
    const required = this.offset + extra;
    if (required <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < required) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.offset));
    this.buf = next;
    this.view = new DataView(next.buffer, next.byteOffset, next.byteLength);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Primitive writers (private; helpers below are the public surface)

  private writeUint8(value: number): void {
    this.ensure(1);
    this.buf[this.offset++] = value;
  }

  private writeInt16(value: number): void {
    this.ensure(2);
    this.view.setInt16(this.offset, value, false);
    this.offset += 2;
  }

  private writeInt32(value: number): void {
    this.ensure(4);
    this.view.setInt32(this.offset, value, false);
    this.offset += 4;
  }

  private writeBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  private writeCString(s: string): void {
    // Worst-case UTF-8 expansion is 3 bytes per UTF-16 code unit; +1 for the trailing NUL.
    const reserve = s.length * 3 + 1;
    this.ensure(reserve);
    const { written } = utf8Encoder.encodeInto(
      s,
      this.buf.subarray(this.offset),
    );
    this.offset += written;
    this.buf[this.offset++] = 0;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Frame helpers

  private startFrame(kind: number): void {
    this.ensure(HEADER_SIZE);
    this.buf[this.offset] = kind;
    this.headerStart = this.offset + 1;
    this.offset += HEADER_SIZE;
  }

  private startUntypedFrame(): void {
    this.ensure(4);
    this.headerStart = this.offset;
    this.offset += 4;
  }

  private finishFrame(): void {
    if (this.headerStart < 0) {
      throw new Error(
        "MessageWriter: finishFrame() called without an open frame",
      );
    }
    // Length includes the 4-byte length field itself but not the type byte.
    const len = this.offset - this.headerStart;
    this.view.setInt32(this.headerStart, len, false);
    this.headerStart = -1;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Frontend messages

  /**
   * StartupMessage: untyped frame; body is protocol version + zero or more
   * (key\0value\0) pairs + a final \0 terminator. `parameters` should at minimum
   * include `user`; `database` and `application_name` are typical additions.
   */
  writeStartup(parameters: Readonly<Record<string, string>>): void {
    this.startUntypedFrame();
    this.writeInt32(PROTOCOL_VERSION);
    for (const key of Object.keys(parameters)) {
      const value = parameters[key];
      if (value === undefined) continue;
      this.writeCString(key);
      this.writeCString(value);
    }
    this.writeUint8(0);
    this.finishFrame();
  }

  writeSslRequest(): void {
    this.startUntypedFrame();
    this.writeInt32(SSL_REQUEST_CODE);
    this.finishFrame();
  }

  writeCancelRequest(processId: number, secretKey: number): void {
    this.startUntypedFrame();
    this.writeInt32(CANCEL_REQUEST_CODE);
    this.writeInt32(processId);
    this.writeInt32(secretKey);
    this.finishFrame();
  }

  /** Cleartext or md5-prefixed password token. */
  writePasswordMessage(password: string): void {
    this.startFrame(FrontendKind.PasswordMessage);
    this.writeCString(password);
    this.finishFrame();
  }

  /** SASLInitialResponse: PasswordMessage frame carrying mechanism name + initial-response bytes. */
  writeSaslInitialResponse(
    mechanism: string,
    initialResponse: Uint8Array,
  ): void {
    this.startFrame(FrontendKind.PasswordMessage);
    this.writeCString(mechanism);
    if (initialResponse.length === 0) {
      this.writeInt32(-1);
    } else {
      this.writeInt32(initialResponse.length);
      this.writeBytes(initialResponse);
    }
    this.finishFrame();
  }

  /** SASLResponse: PasswordMessage frame carrying continuation bytes. */
  writeSaslResponse(response: Uint8Array): void {
    this.startFrame(FrontendKind.PasswordMessage);
    this.writeBytes(response);
    this.finishFrame();
  }

  /** Simple-query (text protocol). The extended-query path uses Parse/Bind/Execute instead. */
  writeQuery(sql: string): void {
    this.startFrame(FrontendKind.Query);
    this.writeCString(sql);
    this.finishFrame();
  }

  /** Parse: prepares a (possibly named) statement. Empty `paramTypes` lets the server infer. */
  writeParse(
    name: string,
    sql: string,
    paramTypes: readonly number[] = [],
  ): void {
    this.startFrame(FrontendKind.Parse);
    this.writeCString(name);
    this.writeCString(sql);
    this.writeInt16(paramTypes.length);
    for (const oid of paramTypes) {
      this.writeInt32(oid);
    }
    this.finishFrame();
  }

  /**
   * Bind: associates a portal with a prepared statement and supplies parameters.
   *
   * Format-array semantics match the wire spec: length 0 = all text, length 1 =
   * applies to every parameter, length N = per-parameter. Parameters are passed
   * pre-encoded so codecs own the binary representation.
   */
  writeBind(args: {
    portal: string;
    statement: string;
    paramFormats: readonly Format[];
    params: ReadonlyArray<Uint8Array | null>;
    resultFormats: readonly Format[];
  }): void {
    this.startFrame(FrontendKind.Bind);
    this.writeCString(args.portal);
    this.writeCString(args.statement);

    this.writeInt16(args.paramFormats.length);
    for (const f of args.paramFormats) this.writeInt16(f);

    this.writeInt16(args.params.length);
    for (const p of args.params) {
      if (p === null) {
        this.writeInt32(-1);
      } else {
        this.writeInt32(p.length);
        this.writeBytes(p);
      }
    }

    this.writeInt16(args.resultFormats.length);
    for (const f of args.resultFormats) this.writeInt16(f);

    this.finishFrame();
  }

  writeDescribe(kind: StatementOrPortal, name: string): void {
    this.startFrame(FrontendKind.Describe);
    this.writeUint8(kind);
    this.writeCString(name);
    this.finishFrame();
  }

  writeClose(kind: StatementOrPortal, name: string): void {
    this.startFrame(FrontendKind.Close);
    this.writeUint8(kind);
    this.writeCString(name);
    this.finishFrame();
  }

  writeExecute(portal: string, maxRows = 0): void {
    this.startFrame(FrontendKind.Execute);
    this.writeCString(portal);
    this.writeInt32(maxRows);
    this.finishFrame();
  }

  writeSync(): void {
    this.startFrame(FrontendKind.Sync);
    this.finishFrame();
  }

  writeFlush(): void {
    this.startFrame(FrontendKind.Flush);
    this.finishFrame();
  }

  writeTerminate(): void {
    this.startFrame(FrontendKind.Terminate);
    this.finishFrame();
  }

  writeCopyData(data: Uint8Array): void {
    this.startFrame(FrontendKind.CopyData);
    this.writeBytes(data);
    this.finishFrame();
  }

  writeCopyDone(): void {
    this.startFrame(FrontendKind.CopyDone);
    this.finishFrame();
  }

  writeCopyFail(message: string): void {
    this.startFrame(FrontendKind.CopyFail);
    this.writeCString(message);
    this.finishFrame();
  }
}
