// Per-connection prepared-statement cache.
//
// Maps SQL text → entry. The entry tracks "this connection has Parse'd this
// server-side already" plus, once we've seen a result, the column OIDs from
// the RowDescription. The latter unlocks per-column binary-format negotiation
// at Bind time — on the *second* run of a statement we know which columns
// have binary decoders available.
//
// Stored as a Map with insertion-order LRU semantics (JS `Map` preserves
// insertion order, so iterating `keys().next()` yields the oldest entry).
//
// Statement names are derived from the SQL via FNV-1a 64-bit and prefixed
// `s_<hex>`. Two connections that prepare the same SQL converge on the same
// name, which keeps `pg_prepared_statements` legible during debugging.
//
// Eviction: the oldest entry is dropped when `add()` would push the cache
// past its size limit. The caller of `add()` gets the evicted SQL back so it
// can emit a `Close-statement` to the server in the same write batch.
//
// Auto-reprepare: when the server replies with SQLSTATE `0A000` (cached plan
// invalidated by DDL) or `26000` (statement name unknown — server-side cache
// out of sync), the consumer calls `forget(sql)` and retries with a fresh
// Parse. The retry happens at most once per query.

const DEFAULT_MAX_SIZE = 100;

/**
 * One slot in the LRU. Currently we only persist the column OIDs from the
 * first observed RowDescription so subsequent Binds can pre-negotiate binary
 * result formats; future slices may add the resolved RowDecoder itself.
 */
export interface PreparedEntry {
  /**
   * Column OIDs from the first response's RowDescription. `null` until the
   * first DataRow batch has come back — the *second* execution can then use
   * this to compute per-column result formats at Bind time.
   */
  resultOids: readonly number[] | null;
}

export class PreparedCache {
  private readonly entries = new Map<string, PreparedEntry>();
  private readonly maxSize: number;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    if (maxSize < 1) {
      throw new RangeError(
        `PreparedCache: maxSize must be >= 1, got ${maxSize}`,
      );
    }
    this.maxSize = maxSize;
  }

  /** Deterministic statement name for `sql`. */
  static nameFor(sql: string): string {
    return `s_${fnv1a64Hex(sql)}`;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Bump `sql` to most-recently-used and report whether it was already cached.
   * Returns the existing entry on hit (no Parse needed); null on miss.
   */
  bump(sql: string): PreparedEntry | null {
    const entry = this.entries.get(sql);
    if (entry === undefined) return null;
    // Re-insert to move to MRU position.
    this.entries.delete(sql);
    this.entries.set(sql, entry);
    return entry;
  }

  /**
   * Mark `sql` as Parse'd. Returns the entry plus the evicted SQL — the
   * caller is expected to emit a server-side `Close-statement` for the
   * evicted name. The entry starts with `resultOids: null`; populate it via
   * {@link recordResultOids} once the first RowDescription arrives.
   */
  add(sql: string): { entry: PreparedEntry; evicted: string | null } {
    const existing = this.entries.get(sql);
    if (existing !== undefined) {
      // Already known (race or double-prepare). Bump and bail.
      this.entries.delete(sql);
      this.entries.set(sql, existing);
      return { entry: existing, evicted: null };
    }
    let evicted: string | null = null;
    if (this.entries.size >= this.maxSize) {
      const next = this.entries.keys().next();
      if (!next.done) {
        evicted = next.value;
        this.entries.delete(evicted);
      }
    }
    const entry: PreparedEntry = { resultOids: null };
    this.entries.set(sql, entry);
    return { entry, evicted };
  }

  /** Drop a single entry. Used on auto-reprepare so the next call re-Parses. */
  forget(sql: string): void {
    this.entries.delete(sql);
  }

  /** Drop everything. Used on connection teardown / fatal errors. */
  clear(): void {
    this.entries.clear();
  }
}

// ────────────────────────────────────────────────────────────────────────
// FNV-1a 64-bit
//
// Implemented in 32-bit halves so we don't pay BigInt allocation per byte.
// The multiplier 0x100000001b3 has high=1, low=0x1b3, which collapses the
// 64×64 multiplication to:
//
//   result_lo = (lo * 0x1b3) mod 2^32
//   carry     = floor((lo * 0x1b3) / 2^32)
//   result_hi = (hi * 0x1b3 + lo + carry) mod 2^32
//
// `lo * 0x1b3` and `hi * 0x1b3` both stay safely under 2^53, so plain Number
// arithmetic is exact.
//
// Bytes are derived from UTF-16 code units (high byte then low byte) rather
// than encoding to UTF-8 — for cache keying, what matters is determinism, not
// matching some other tool's hash. Hashing inline avoids the allocation
// `TextEncoder.encode()` would cost on the hot path.

const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LO = 0x1b3;

function fnv1a64Hex(input: string): string {
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;
  for (let i = 0; i < input.length; i++) {
    const cu = input.charCodeAt(i);
    // High byte first, then low byte. Skips the high byte's xor for ASCII
    // (where it's zero) only marginally — branch cost outweighs the save —
    // so we always do both.
    lo ^= (cu >>> 8) & 0xff;
    {
      const product = lo * FNV_PRIME_LO;
      const newLo = product >>> 0;
      const carry = Math.floor(product / 0x100000000);
      hi = (hi * FNV_PRIME_LO + lo + carry) >>> 0;
      lo = newLo;
    }
    lo ^= cu & 0xff;
    {
      const product = lo * FNV_PRIME_LO;
      const newLo = product >>> 0;
      const carry = Math.floor(product / 0x100000000);
      hi = (hi * FNV_PRIME_LO + lo + carry) >>> 0;
      lo = newLo;
    }
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}
