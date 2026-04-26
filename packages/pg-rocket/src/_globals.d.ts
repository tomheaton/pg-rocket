// Minimal ambient declarations for Web Platform globals used by pg-rocket.
//
// The protocol layer is portable: it compiles without `lib.dom`, `lib.webworker`,
// or `@types/node`. We declare just the globals it actually uses here so the
// portability boundary is self-evident from this file rather than implied by
// tsconfig "lib" settings.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
  encodeInto(
    source: string,
    destination: Uint8Array,
  ): { read: number; written: number };
}

declare class TextDecoder {
  constructor(
    label?: string,
    options?: { fatal?: boolean; ignoreBOM?: boolean },
  );
  decode(
    input?: ArrayBuffer | ArrayBufferView,
    options?: { stream?: boolean },
  ): string;
}
