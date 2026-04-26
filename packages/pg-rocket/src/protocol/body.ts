// Body-parsing primitives, shared between the protocol layer and consumers.
//
// Operates on the connection's read buffer + DataView, returning value/next-offset
// pairs so callers can chain reads without recomputing positions. No allocation
// beyond strings and the occasional throwaway slice.

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

export interface CStringResult {
  readonly value: string;
  readonly next: number;
}

/**
 * Read a NUL-terminated UTF-8 string.
 *
 * `end` bounds the search so a malformed (un-terminated) string raises rather
 * than reading past the message body.
 */
export function readCString(
  buf: Uint8Array,
  offset: number,
  end: number,
): CStringResult {
  let i = offset;
  while (i < end && buf[i] !== 0) i++;
  if (i === end) {
    throw new Error("protocol: unterminated C-string");
  }
  return { value: utf8Decoder.decode(buf.subarray(offset, i)), next: i + 1 };
}

/** Decode `length` bytes at `offset` as UTF-8. */
export function readUtf8(
  buf: Uint8Array,
  offset: number,
  length: number,
): string {
  return utf8Decoder.decode(buf.subarray(offset, offset + length));
}

/** Iterate ErrorResponse / NoticeResponse field codes and values. Stops at the trailing NUL terminator. */
export function* readErrorFields(
  buf: Uint8Array,
  offset: number,
  length: number,
): Generator<{ code: number; value: string }> {
  const end = offset + length;
  let pos = offset;
  while (pos < end) {
    const code = buf[pos++] as number;
    if (code === 0) return;
    const cstr = readCString(buf, pos, end);
    yield { code, value: cstr.value };
    pos = cstr.next;
  }
}

/**
 * Parse a CommandComplete tag like "SELECT 5", "INSERT 0 3", "UPDATE 7".
 *
 * The last numeric chunk is the row count; INSERT carries an extra leading OID.
 * Returns 0 for tags that don't include a count (e.g. "BEGIN", "SET").
 */
export function parseCommandTag(tag: string): {
  command: string;
  rowCount: number;
} {
  const space = tag.indexOf(" ");
  if (space < 0) return { command: tag, rowCount: 0 };
  const command = tag.slice(0, space);
  const lastSpace = tag.lastIndexOf(" ");
  const num = Number.parseInt(tag.slice(lastSpace + 1), 10);
  return { command, rowCount: Number.isFinite(num) ? num : 0 };
}
