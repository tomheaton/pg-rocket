// LISTEN/NOTIFY listener-connection management.
//
// `db.listen` returns a `Subscription`. Multiple channels share one dedicated
// connection — a typical app has 5-20 channels and we don't want to burn a
// connection per channel.
//
// Lifecycle:
//   * First `listen()` lazy-creates the listener connection (separate from
//     the pool — pool connections don't park waiting for notifications).
//   * Each first subscriber on a channel sends `LISTEN "<channel>"`.
//   * Unsubscribing the last handler on a channel sends `UNLISTEN "<channel>"`.
//   * When all channels are empty, schedule connection close after a 5-second
//     grace period — apps often re-listen shortly after, and immediate close
//     would churn the connection.
//   * `close()` aborts the grace timer and ends the connection immediately.
//
// LISTEN/NOTIFY targets a Postgres identifier (the channel name); we quote
// it with `"…"` and double internal quotes for safety. Empty channels and
// channels containing NUL are rejected — Postgres doesn't allow them.

import { Connection, type ConnectOptions } from "./connection/index.js";
import type { NotificationEvent } from "./observability.js";

export type NotificationHandler = (
  payload: string,
  channel: string,
) => void | Promise<void>;

export interface Subscription {
  /** Stop receiving notifications on this channel for this handler. Idempotent. */
  unlisten(): Promise<void>;
}

const RELEASE_GRACE_MS = 5_000;

export class ListenerManager {
  private conn: Connection | null = null;
  private connectPromise: Promise<Connection> | null = null;
  private readonly channels = new Map<string, Set<NotificationHandler>>();
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly connectOptions: ConnectOptions) {}

  /**
   * Subscribe `handler` to `channel`. Lazy-creates the listener connection
   * on first call; reuses it for subsequent calls. Returns a Subscription
   * whose `unlisten()` removes just this handler.
   */
  async subscribe(
    channel: string,
    handler: NotificationHandler,
  ): Promise<Subscription> {
    if (this.closed) {
      throw new Error("ListenerManager: closed");
    }
    validateChannel(channel);
    this.cancelRelease();
    const conn = await this.ensureConnection();

    let handlers = this.channels.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      this.channels.set(channel, handlers);
      // First subscriber on this channel — issue LISTEN. The channel name is
      // an identifier, not a parameter, so we quote it ourselves rather than
      // bind it.
      await conn.query(`LISTEN ${quoteChannel(channel)}`);
    }
    handlers.add(handler);
    return { unlisten: () => this.unsubscribe(channel, handler) };
  }

  /** Drop everything. The listener connection is closed; pending grace timers are cancelled. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelRelease();
    this.channels.clear();
    const conn = this.conn;
    this.conn = null;
    if (conn !== null) {
      await conn.end().catch(() => {
        /* best-effort */
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // internals

  private async unsubscribe(
    channel: string,
    handler: NotificationHandler,
  ): Promise<void> {
    const handlers = this.channels.get(channel);
    if (handlers === undefined) return;
    handlers.delete(handler);
    if (handlers.size > 0) return;

    this.channels.delete(channel);
    if (this.conn?.isUsable) {
      // Best-effort UNLISTEN — if this fails (connection already gone) the
      // server stops sending us notifications anyway.
      await this.conn.query(`UNLISTEN ${quoteChannel(channel)}`).catch(() => {
        /* ignore */
      });
    }
    if (this.channels.size === 0) {
      this.scheduleRelease();
    }
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.conn?.isUsable) return this.conn;
    if (this.connectPromise !== null) return this.connectPromise;

    // Override onNotification on the listener connection — our dispatcher
    // is the receiver. Other hooks (onQuery / onError / onNotice) inherit
    // from the user's connectOptions so observability still works.
    const opts: ConnectOptions = {
      ...this.connectOptions,
      onNotification: (event: NotificationEvent) => this.dispatch(event),
    };
    this.connectPromise = Connection.connect(opts).then((conn) => {
      this.conn = conn;
      this.connectPromise = null;
      return conn;
    });
    try {
      return await this.connectPromise;
    } catch (err) {
      this.connectPromise = null;
      throw err;
    }
  }

  private dispatch(event: NotificationEvent): void {
    const handlers = this.channels.get(event.channel);
    if (handlers === undefined) return;
    // Snapshot to avoid mutation-during-iteration if a handler unsubscribes.
    for (const handler of [...handlers]) {
      try {
        const ret = handler(event.payload, event.channel);
        // Async handlers are awaited fire-and-forget; we don't block the
        // dispatch loop on a slow consumer. Rejected promises are swallowed
        // for now — onError-on-listener is a v0.1 polish.
        if (
          ret !== undefined &&
          typeof (ret as Promise<void>).catch === "function"
        ) {
          (ret as Promise<void>).catch(() => {
            /* swallow */
          });
        }
      } catch {
        /* swallow */
      }
    }
  }

  private scheduleRelease(): void {
    if (this.releaseTimer !== null) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      void this.releaseNow();
    }, RELEASE_GRACE_MS);
    // Don't keep the event loop alive on the grace timer — same reasoning as
    // the pool's idle reaper.
    this.releaseTimer.unref?.();
  }

  private cancelRelease(): void {
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  private async releaseNow(): Promise<void> {
    if (this.channels.size > 0) return; // someone re-subscribed during the grace window
    const conn = this.conn;
    this.conn = null;
    if (conn !== null) {
      await conn.end().catch(() => {
        /* best-effort */
      });
    }
  }
}

function validateChannel(channel: string): void {
  if (channel.length === 0) {
    throw new TypeError("listen: channel name cannot be empty");
  }
  if (channel.indexOf("\0") >= 0) {
    throw new TypeError("listen: channel name contains NUL byte");
  }
}

function quoteChannel(channel: string): string {
  return `"${channel.replace(/"/g, '""')}"`;
}
