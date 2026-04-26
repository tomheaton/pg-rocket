// Codec registry.
//
// Built-in OIDs are dense and small (under ~4000), so the hot-path lookup is
// a flat-array index rather than a Map. Higher-OID user-registered types fall
// into a Map fallback. Lookup is `builtins[oid] ?? overflow.get(oid)`.
//
// Codecs in this slice operate on text-format wire bytes only — Bind requests
// all-text results, params are encoded as text. Binary codecs land with the
// prepared-cache slice (where Describe-statement gives us column OIDs ahead of
// Bind, so we can request binary per-column).

const MAX_BUILTIN_OID = 4096;

export interface Codec<T> {
  readonly oid: number;
  /** Parse a server-formatted text value. */
  decode(text: string): T;
  /** Render a value as Postgres-acceptable text. The server parses it on the other side. */
  encode(value: T): string;
}

export class CodecRegistry {
  private readonly builtins: Array<Codec<unknown> | undefined> = new Array(
    MAX_BUILTIN_OID,
  );
  private readonly overflow = new Map<number, Codec<unknown>>();

  register<T>(codec: Codec<T>): void {
    if (codec.oid < 0) {
      throw new Error(`CodecRegistry: invalid OID ${codec.oid}`);
    }
    if (codec.oid < MAX_BUILTIN_OID) {
      this.builtins[codec.oid] = codec as Codec<unknown>;
    } else {
      this.overflow.set(codec.oid, codec as Codec<unknown>);
    }
  }

  get(oid: number): Codec<unknown> | undefined {
    if (oid < MAX_BUILTIN_OID) return this.builtins[oid];
    return this.overflow.get(oid);
  }
}
