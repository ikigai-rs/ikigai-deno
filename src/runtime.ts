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
  /**
   * Stop listening; a pending accept rejects. Deno and Node also unlink the
   * path they BOUND, whatever is there by then, so the server binds in a
   * private directory and removes its final path itself.
   */
  close(): void;
}

/** What {@linkcode Runtime.lstatSync} reports about a path, not following a link. */
export interface RuntimeStat {
  /** What the path is. */
  kind: "file" | "directory" | "symlink" | "socket" | "other";
  /** The owner's user id, or `null` where there is none (Windows). */
  uid: number | null;
  /** The permission and type bits, or `null` where there are none (Windows). */
  mode: number | null;
  /** The device the path lives on. */
  dev: number;
  /** The inode number, or `null` where there is none (Windows). */
  ino: number | null;
}

/** The calls the client and the server need from their runtime. */
export interface Runtime {
  /** Dial the Unix socket at `path`. */
  connectUnix(path: string): Promise<RuntimeConn>;
  /**
   * Bind and listen on the Unix socket at `path`, then narrow the socket
   * file to `mode`, then call `onBound`, in that order and before `ready`
   * resolves. If `onBound` throws, the listener is closed and the error is
   * the bind's: thrown here by an adapter that binds synchronously (Deno),
   * else the rejection of `ready`. The server's `onBound` moves the socket
   * to its final path.
   */
  listenUnix(
    path: string,
    mode: number,
    onBound?: () => void,
  ): RuntimeListener;
  /** Create ONE directory with `mode` (less the umask); throws if it exists. */
  mkdirSync(path: string, mode: number): void;
  /**
   * Create a new directory with a random name starting `prefix` inside
   * `dir`, mode `0700`, and return its path.
   */
  makeTempDirSync(dir: string, prefix: string): string;
  /** What is at `path`, not following a symlink; `null` when nothing is. */
  lstatSync(path: string): RuntimeStat | null;
  /** `path` with every symlink resolved, absolute. */
  realPathSync(path: string): string;
  /** Rename `from` to `to`, atomically replacing a file at `to`. */
  renameSync(from: string, to: string): void;
  /**
   * Remove the file, socket or EMPTY directory at `path`; throws when it is
   * absent.
   */
  removeSync(path: string): void;
  /** An environment variable, or `undefined` when unset. */
  env(name: string): string | undefined;
  /** The real user id, or `null` where there is none (Windows). */
  uid(): number | null;
}

/** The Deno adapter: the `Deno.*` calls, unchanged. */
export const denoRuntime: Runtime = {
  connectUnix: (path) => Deno.connect({ transport: "unix", path }),
  listenUnix(path, mode, onBound) {
    const listener = Deno.listen({ transport: "unix", path });
    try {
      // Deno binds the socket with the process umask; narrow it. (No
      // SO_PEERCRED equivalent in Deno, so this mode is part of the gate.)
      Deno.chmodSync(path, mode);
      onBound?.();
    } catch (e) {
      listener.close();
      throw e;
    }
    return {
      ready: Promise.resolve(),
      accept: () => listener.accept(),
      close: () => listener.close(),
    };
  },
  mkdirSync: (path, mode) => Deno.mkdirSync(path, { mode }),
  makeTempDirSync: (dir, prefix) => Deno.makeTempDirSync({ dir, prefix }),
  lstatSync(path) {
    let st: Deno.FileInfo;
    try {
      st = Deno.lstatSync(path);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
    return {
      kind: st.isSymlink
        ? "symlink"
        : st.isDirectory
        ? "directory"
        : st.isFile
        ? "file"
        : st.isSocket
        ? "socket"
        : "other",
      uid: st.uid,
      mode: st.mode,
      dev: st.dev,
      ino: st.ino,
    };
  },
  realPathSync: (path) => Deno.realPathSync(path),
  renameSync: (from, to) => Deno.renameSync(from, to),
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
