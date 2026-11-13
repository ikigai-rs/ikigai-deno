/**
 * The runtime adapter: every socket, listener, filesystem and environment
 * call the client and the server make, behind one small interface.
 *
 * The wire codec, contracts, html and auth helpers are plain TypeScript; only
 * dialing, listening and the socket file's setup need a runtime.
 * {@linkcode denoRuntime} is the default and makes exactly the `Deno.*` calls
 * this package always made. Another runtime passes its own adapter:
 * `connect(path, { runtime })` and `new Server(endpoints, path, { runtime })`.
 *
 * @module
 */

import type { ByteStream } from "./wire.ts";

/** A connected duplex byte stream (structurally, a `Deno.UnixConn`). */
export interface RuntimeConn extends ByteStream {
  /**
   * Close both directions. A read pending on the connection REJECTS (the
   * client's timeouts rely on it); a second close may throw.
   */
  close(): void;
}

/** A bound, listening Unix socket. */
export interface RuntimeListener {
  /**
   * Resolves once the socket is bound and narrowed to its mode, rejects if
   * the bind failed. Deno binds synchronously, so its listener is ready on
   * return.
   */
  readonly ready: Promise<void>;
  /** The next connection; rejects once the listener is closed. */
  accept(): Promise<RuntimeConn>;
  /** Stop listening and remove the socket file; a pending accept rejects. */
  close(): void;
}

/** The calls the client and the server need from their runtime. */
export interface Runtime {
  /** Dial the Unix socket at `path`. */
  connectUnix(path: string): Promise<RuntimeConn>;
  /**
   * Bind and listen on the Unix socket at `path`, then narrow the socket
   * file to `mode` (the server's access gate).
   */
  listenUnix(path: string, mode: number): RuntimeListener;
  /** `mkdir -p` with `mode` for the directories it creates. */
  mkdirSync(path: string, options: { recursive: true; mode: number }): void;
  /** Remove the file at `path`; throws when it is absent. */
  removeSync(path: string): void;
  /** An environment variable, or `undefined` when unset. */
  env(name: string): string | undefined;
  /** The real user id, or `null` where there is none (Windows). */
  uid(): number | null;
}

/** The Deno adapter: the `Deno.*` calls, unchanged. */
export const denoRuntime: Runtime = {
  connectUnix: (path) => Deno.connect({ transport: "unix", path }),
  listenUnix(path, mode) {
    const listener = Deno.listen({ transport: "unix", path });
    // Deno binds the socket with the process umask; narrow it. (No
    // SO_PEERCRED equivalent in Deno, so this mode IS the access gate.)
    Deno.chmodSync(path, mode);
    return {
      ready: Promise.resolve(),
      accept: () => listener.accept(),
      close: () => listener.close(),
    };
  },
  mkdirSync: (path, options) => Deno.mkdirSync(path, options),
  removeSync: (path) => Deno.removeSync(path),
  env: (name) => Deno.env.get(name),
  uid: () => Deno.uid(),
};

/**
 * The adapter used when none is passed: {@linkcode denoRuntime} under Deno.
 * Elsewhere it throws, naming the fix, rather than failing later on an
 * undefined `Deno`.
 */
export function defaultRuntime(): Runtime {
  if (typeof Deno === "undefined") {
    throw new Error(
      "ikigai-deno: no runtime adapter outside Deno; pass one, e.g. " +
        "`{ runtime: nodeRuntime }` from src/runtime_node.ts",
    );
  }
  return denoRuntime;
}
