/// <reference types="node" />

// Node TCP / TLS adapter — the only file in v0 that imports `node:net` / `node:tls`.
//
// Two-phase lifecycle:
//   1. `connectTcp(host, port)` returns a NodeTransport with TCP_NODELAY set.
//   2. The connection layer drives the SSLRequest / negotiation-byte exchange,
//      then optionally calls `upgradeTls()` which wraps the existing socket in
//      a TLSSocket and rebinds event handlers.
//
// Keeping the SSL handshake protocol bytes in the connection layer (rather than
// the transport) keeps the transport interface free of pg-protocol knowledge,
// so a future WebSocket transport can implement the same interface without
// having to special-case Postgres.

import * as net from "node:net";
import * as tls from "node:tls";

import type { TlsUpgradeOptions, Transport } from "./transport.js";

type DataHandler = (chunk: Uint8Array) => void;
type ErrorHandler = (error: Error) => void;
type CloseHandler = () => void;

export class NodeTransport implements Transport {
  private socket: net.Socket;
  private dataHandler: DataHandler | null = null;
  private errorHandler: ErrorHandler | null = null;
  private closeHandler: CloseHandler | null = null;
  // Ensures `onClose` fires exactly once even if the socket emits both 'end' and 'close'.
  private closed = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Transport implementation

  onData(handler: DataHandler): void {
    this.dataHandler = handler;
  }
  onError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }
  onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(bytes, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  end(): void {
    this.socket.end();
  }

  destroy(error?: Error): void {
    this.socket.destroy(error);
  }

  async upgradeTls(options: TlsUpgradeOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // Detach handlers from the TCP socket; the TLS socket will deliver bytes from now on.
      this.detach(this.socket);

      const connectOptions: tls.ConnectionOptions = {
        socket: this.socket,
        rejectUnauthorized: options.rejectUnauthorized ?? true,
      };
      if (options.servername !== undefined)
        connectOptions.servername = options.servername;
      if (options.ca !== undefined) {
        // tls accepts string | Buffer | Array<string | Buffer>; Uint8Array is structurally compatible.
        connectOptions.ca = options.ca as tls.ConnectionOptions["ca"];
      }
      if (options.cert !== undefined)
        connectOptions.cert = options.cert as tls.ConnectionOptions["cert"];
      if (options.key !== undefined)
        connectOptions.key = options.key as tls.ConnectionOptions["key"];
      const tlsSocket = tls.connect(connectOptions);

      const onSecureConnect = (): void => {
        tlsSocket.removeListener("error", onError);
        this.socket = tlsSocket;
        this.attach(tlsSocket);
        resolve();
      };
      const onError = (err: Error): void => {
        tlsSocket.removeListener("secureConnect", onSecureConnect);
        reject(err);
      };

      tlsSocket.once("secureConnect", onSecureConnect);
      tlsSocket.once("error", onError);
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals

  private attach(socket: net.Socket): void {
    socket.on("data", (chunk: Buffer) => {
      this.dataHandler?.(chunk);
    });
    socket.on("error", (err: Error) => {
      this.errorHandler?.(err);
    });
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.closeHandler?.();
    });
  }

  private detach(socket: net.Socket): void {
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
  }
}

/**
 * Open a TCP connection with `TCP_NODELAY` set. The Nagle-disable matters for
 * pipelined batches: without it, the kernel coalesces multiple write() calls
 * into one TCP segment, which works fine over plain TCP but produces multiple
 * TLS records once we upgrade. We coalesce in userspace via MessageWriter.
 */
export function connectTcp(host: string, port: number): Promise<NodeTransport> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);

    const onConnect = (): void => {
      socket.removeListener("error", onError);
      resolve(new NodeTransport(socket));
    };
    const onError = (err: Error): void => {
      socket.removeListener("connect", onConnect);
      socket.destroy();
      reject(err);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}
