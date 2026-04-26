// Observability event shapes.
//
// Hooks are configured once at `createClient` (or at `Connection.connect` for
// lower-level callers) and stored on the connection. The dispatch path is
// `if (this.onX !== undefined) { … allocate event …; this.onX(event); }` —
// no EventEmitter, no listener arrays. Hooks set to undefined cost a single
// hidden-class compare per query; hooks set to a function pay the event
// allocation plus the callback dispatch.
//
// Event objects are fresh per fire (not pooled) — the user might hold the
// reference past the synchronous call.

export interface QueryEvent {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly durationMs: number;
  readonly rowCount: number;
  readonly command: string;
  readonly connectionId: number;
}

export interface ErrorEvent {
  readonly error: Error;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly durationMs: number;
  readonly connectionId: number;
}

export interface NoticeEvent {
  readonly severity: string;
  readonly message: string;
  readonly code: string;
  readonly connectionId: number;
}

export type OnQuery = (event: QueryEvent) => void;
export type OnError = (event: ErrorEvent) => void;
export type OnNotice = (event: NoticeEvent) => void;
