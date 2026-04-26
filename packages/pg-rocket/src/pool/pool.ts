/// <reference types="node" />

// Connection pool — lazy, fixed-size, FIFO acquisition queue, idle reaping.
//
// What's in this slice:
//   * Lazy creation up to `max`. The first acquire after createClient triggers
//     the first connection; cold-starting the library opens nothing.
//   * FIFO waiter queue when all connections are busy.
//   * Idle-timeout reaping via a single coarse `setInterval` per pool. Tick
//     rate is `idleTimeoutMs / 4` so we close connections within ~25% of the
//     configured deadline. The interval is `unref()`-ed so it doesn't keep
//     the Node event loop alive on its own.
//   * Pool-level `close()` — drains in-flight, closes idles, rejects waiters.
//
// Deliberately deferred (next slice):
//   * Health checks on long-idle connections (Sync round-trip on acquire).
//   * Replacement of dead connections (transport error → drop, lazy recreate).
//   * acquireTimeoutMs.

import { Connection, type ConnectOptions } from "../connection/index.js";
import { ConnectionError } from "../errors.js";

export interface PoolOptions {
  /** Per-connection options forwarded to {@link Connection.connect}. */
  readonly connect: ConnectOptions;
  /** Maximum concurrent connections. Default 10. */
  readonly max?: number;
  /** Close connections idle longer than this (ms). Default 30_000. Set to 0 to disable. */
  readonly idleTimeoutMs?: number;
}

interface Waiter {
  resolve: (conn: Connection) => void;
  reject: (err: Error) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const REAPER_MIN_TICK_MS = 1_000;

export class Pool {
  private readonly idle: Connection[] = [];
  /** Wall-clock ms at which each idle connection was returned. Aligned with `idle` by index. */
  private readonly idleSince: number[] = [];
  private readonly leased = new Set<Connection>();
  private readonly waiters: Waiter[] = [];
  private readonly max: number;
  private readonly idleTimeoutMs: number;
  private reaperTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: PoolOptions) {
    this.max = options.max ?? 10;
    if (this.max < 1) {
      throw new RangeError(`Pool: max must be >= 1, got ${this.max}`);
    }
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (this.idleTimeoutMs < 0) {
      throw new RangeError(
        `Pool: idleTimeoutMs must be >= 0, got ${this.idleTimeoutMs}`,
      );
    }
  }

  /** Total open connections (idle + leased), excluding any in-flight `connect` calls. */
  get size(): number {
    return this.idle.length + this.leased.size;
  }

  /**
   * Borrow a connection. Resolves immediately if idle one exists, otherwise
   * lazy-creates a new one up to `max`, otherwise queues FIFO. Throws if the
   * pool is closed.
   */
  async acquire(): Promise<Connection> {
    if (this.closed) {
      throw new ConnectionError("pool is closed");
    }
    if (this.idle.length > 0) {
      // LIFO acquire keeps the most-recently-used connection warm; older idle
      // ones drift toward the reaper. Stack-like idle list, queue-like waiter list.
      const conn = this.idle.pop() as Connection;
      this.idleSince.pop();
      this.leased.add(conn);
      return conn;
    }
    if (this.size < this.max) {
      // Reserve the slot before the async op so concurrent acquires don't
      // overshoot `max` while a new connection is being established.
      const placeholder = {} as Connection;
      this.leased.add(placeholder);
      try {
        const conn = await Connection.connect(this.options.connect);
        this.leased.delete(placeholder);
        this.leased.add(conn);
        return conn;
      } catch (err) {
        this.leased.delete(placeholder);
        throw err;
      }
    }
    return new Promise<Connection>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Return a connection to the pool. If a waiter is queued, hands it off
   * directly; if the pool is closing, ends the connection instead of pooling.
   */
  release(conn: Connection): void {
    this.leased.delete(conn);
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      this.leased.add(conn);
      waiter.resolve(conn);
      return;
    }
    if (this.closed) {
      void conn.end();
      return;
    }
    this.idle.push(conn);
    this.idleSince.push(Date.now());
    this.scheduleReaper();
  }

  /**
   * Mark a connection unusable and drop it from the pool. The connection is
   * destroyed; the slot frees up so the next acquire can lazy-create a fresh one.
   */
  destroy(conn: Connection, error?: Error): void {
    this.leased.delete(conn);
    const idleIdx = this.idle.indexOf(conn);
    if (idleIdx >= 0) {
      this.idle.splice(idleIdx, 1);
      this.idleSince.splice(idleIdx, 1);
    }
    void conn.end().catch(() => {
      // best-effort; the caller already knows the connection is broken if `error` is set.
      void error;
    });
  }

  /**
   * Drain and close. Waits for in-flight queries to finish (no force option in
   * this slice). Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopReaper();
    // Reject queued waiters — they were never going to get a connection.
    const err = new ConnectionError("pool is closed");
    for (const w of this.waiters) w.reject(err);
    this.waiters.length = 0;
    // End idle connections in parallel.
    const ends = this.idle.map((c) => c.end());
    this.idle.length = 0;
    this.idleSince.length = 0;
    await Promise.allSettled(ends);
    // Leased connections close as they're released; the release path handles it.
  }

  // ────────────────────────────────────────────────────────────────────────
  // Idle reaper

  private scheduleReaper(): void {
    if (this.idleTimeoutMs === 0) return;
    if (this.reaperTimer !== null) return;
    if (this.idle.length === 0) return;
    const tickMs = Math.max(
      REAPER_MIN_TICK_MS,
      Math.floor(this.idleTimeoutMs / 4),
    );
    this.reaperTimer = setInterval(() => this.reap(), tickMs);
    // Don't keep the event loop alive on the reaper alone — typical CLI tools
    // call createClient → run a query → exit; the pool shouldn't pin process exit.
    this.reaperTimer.unref?.();
  }

  private stopReaper(): void {
    if (this.reaperTimer !== null) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  private reap(): void {
    if (this.closed) {
      this.stopReaper();
      return;
    }
    const cutoff = Date.now() - this.idleTimeoutMs;
    // Walk from the bottom (oldest) — we kept idle in LIFO order so [0] is the
    // oldest, [length-1] the youngest. Stop at the first not-yet-expired entry.
    let removed = 0;
    while (removed < this.idle.length) {
      const ts = this.idleSince[removed] as number;
      if (ts > cutoff) break;
      removed++;
    }
    if (removed > 0) {
      const expired = this.idle.splice(0, removed);
      this.idleSince.splice(0, removed);
      for (const conn of expired) {
        void conn.end().catch(() => {
          /* best-effort */
        });
      }
    }
    if (this.idle.length === 0) this.stopReaper();
  }
}
