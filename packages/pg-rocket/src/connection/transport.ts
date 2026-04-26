// Transport interface — the only Node-specific seam in v0.
//
// Callback-based rather than async-iterator: aligns with Node's socket
// 'data' event, avoids per-chunk Promise allocation in the hot path, and
// keeps the contract small enough that alternate adapters (WebSocket,
// HTTP, edge runtime) can implement it without inheriting Node semantics.

export interface TlsUpgradeOptions {
  /** SNI servername to present in the ClientHello. */
  readonly servername?: string | undefined;
  /** Trusted CA bundle (PEM). */
  readonly ca?:
    | string
    | Uint8Array
    | ReadonlyArray<string | Uint8Array>
    | undefined;
  /** Client cert + key for mTLS. */
  readonly cert?: string | Uint8Array | undefined;
  readonly key?: string | Uint8Array | undefined;
  /** Reject self-signed / untrusted certs. Defaults to true; only set false for local dev. */
  readonly rejectUnauthorized?: boolean | undefined;
}

export interface Transport {
  /** Subscribe to inbound chunks. The buffer is borrowed; copy bytes you need to retain. */
  onData(handler: (chunk: Uint8Array) => void): void;

  /** Subscribe to transport-level errors (socket reset, EPIPE, TLS handshake failure). */
  onError(handler: (error: Error) => void): void;

  /** Subscribe to clean close (FIN from peer or local end()). Fires at most once. */
  onClose(handler: () => void): void;

  /**
   * Send bytes. Resolves once the kernel has accepted the bytes (i.e. once the
   * write callback fires); rejects if the socket erred during the write.
   */
  write(bytes: Uint8Array): Promise<void>;

  /** Send FIN. The remote will close on its side; `onClose` fires after. */
  end(): void;

  /** Hard close. */
  destroy(error?: Error): void;

  /**
   * Wrap the underlying socket in TLS in-place. Must be called only when no
   * pg-protocol bytes are in flight (i.e. immediately after the SSLRequest /
   * negotiation byte exchange). Resolves on `secureConnect`.
   *
   * Optional because alternate transports may not support in-place upgrade.
   */
  upgradeTls?(options: TlsUpgradeOptions): Promise<void>;
}
