/**
 * Where a {@linkcode Server} puts its socket, and how (ledger #3631).
 *
 * The socket is bound in a fresh private directory (`0700`, ours) inside the
 * final path's parent, narrowed to its mode there, then renamed to the final
 * path, so the final path never holds a socket with the umask's mode and a
 * leftover is replaced atomically. Before that the parent and every directory
 * above it are checked, and a leftover at the final path must be our own
 * socket; anything else is refused by name.
 *
 * What the mode gates: Linux requires write permission on the socket file to
 * `connect` (measured: the owner's own `0000` and `0400` sockets refuse it
 * with `EACCES`). macOS is not measured yet (`tests/runtime_test.ts` prints
 * it); where a socket's mode is not enforced the `0700` directory is the
 * whole gate, which is why the directory check refuses a directory another
 * account can write. Windows reports no owners (`uid()` is `null`), so there
 * the directory and owner checks are skipped and only the private bind and
 * rename run; Deno's Unix sockets on Windows are untested here.
 *
 * @module
 */

import type { Runtime, RuntimeListener, RuntimeStat } from "./runtime.ts";

/**
 * A server refused its socket path: the directory it would serve in, or one
 * above it, is not safely ours, or something other than our own socket is
 * already at the path. The message names the path, what is wrong with it,
 * and the fix.
 */
export class SocketPathRefused extends Error {
  /** The path that was refused: a directory, or the socket path itself. */
  readonly path: string;

  /** A refusal of `path`, explained by `message`. */
  constructor(path: string, message: string) {
    super(message);
    this.name = "SocketPathRefused";
    this.path = path;
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : slash === 0 ? "/" : ".";
}

function octal(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

function describe(st: RuntimeStat): string {
  return st.kind === "file" ? "a regular file" : `a ${st.kind}`;
}

/**
 * Create the missing directories down to `dir`, outermost first, each
 * `0700`, and return `dir` with its symlinks resolved.
 */
function ensureDir(runtime: Runtime, dir: string): string {
  const missing: string[] = [];
  for (let d = dir; runtime.lstatSync(d) === null;) {
    missing.unshift(d);
    const up = parentOf(d);
    if (up === d) break;
    d = up;
  }
  for (const d of missing) {
    try {
      runtime.mkdirSync(d, 0o700);
    } catch (e) {
      // Lost a race to another creator: the check judges what is there.
      if (runtime.lstatSync(d) === null) throw e;
    }
  }
  return runtime.realPathSync(dir);
}

/**
 * Refuse unless `dir` (symlinks resolved) is a directory we own that group
 * and others cannot write, and every directory above it is owned by us or
 * root and not writable by group or others, unless it is sticky (`/tmp`):
 * whoever can write a directory on the path can rename what is below it.
 */
function checkDirs(runtime: Runtime, dir: string, me: number): void {
  for (let d = dir, first = true;; d = parentOf(d), first = false) {
    const st = runtime.lstatSync(d);
    const where = first ? `serve in ${d}` : `serve under ${d}`;
    if (st === null || st.kind !== "directory") {
      throw new SocketPathRefused(
        d,
        `ikigai-ts: refused to ${where}: it is ` +
          `${st === null ? "missing" : describe(st)}, not a directory.`,
      );
    }
    const mode = st.mode ?? 0;
    if (st.uid !== me && (first || st.uid !== 0)) {
      // A root-owned directory (`/tmp`) is no one's mistake: point at one of
      // our own inside it, which the server makes 0700 if missing.
      const fix = st.uid === 0
        ? "Serve in a directory of your own, such as " +
          `${d === "/" ? "" : d}/ikigai-${me}.`
        : `Remove ${d}, or serve in a directory of your own.`;
      throw new SocketPathRefused(
        d,
        `ikigai-ts: refused to ${where}: it is owned by uid ${st.uid}, ` +
          `not by this process's uid ${me}, so that account could replace ` +
          `or remove the socket. ${fix}`,
      );
    }
    if ((mode & 0o022) !== 0 && (first || (mode & 0o1000) === 0)) {
      throw new SocketPathRefused(
        d,
        `ikigai-ts: refused to ${where}: its mode is ${octal(mode)}, ` +
          "writable by group or others, who could replace or remove the " +
          `socket. Run \`chmod 700 ${d}\`, or remove it.`,
      );
    }
    if (d === "/" || parentOf(d) === d) return;
  }
}

/** Refuse anything at `path` but a socket we own. */
function checkLeftover(runtime: Runtime, path: string, me: number | null) {
  const st = runtime.lstatSync(path);
  if (st === null) return;
  if (st.kind !== "socket") {
    throw new SocketPathRefused(
      path,
      `ikigai-ts: refused to replace ${path}: it is ${describe(st)}, ` +
        "not a socket. Remove it, or serve on another path.",
    );
  }
  if (me !== null && st.uid !== me) {
    throw new SocketPathRefused(
      path,
      `ikigai-ts: refused to replace ${path}: it is a socket owned by ` +
        `uid ${st.uid}, not by this process's uid ${me}. Remove it, or ` +
        "serve on another path.",
    );
  }
}

/**
 * A socket bound privately and moved to its final path; {@linkcode close}
 * removes that path only while it is still this socket.
 */
export class PlacedSocket {
  /** The listener, bound at the private path. */
  readonly listener: RuntimeListener;
  #runtime: Runtime;
  #final: string;
  #private: string;
  #bound: string;
  #id: { dev: number; ino: number | null } | null = null;

  /**
   * Check `path`'s directories and leftover, bind in a private directory
   * beside it, narrow the socket to `mode` and rename it into place. Throws
   * {@linkcode SocketPathRefused} before binding anything.
   */
  constructor(runtime: Runtime, path: string, mode: number) {
    this.#runtime = runtime;
    const me = runtime.uid();
    const dir = ensureDir(runtime, parentOf(path));
    if (me !== null) checkDirs(runtime, dir, me);
    this.#final = `${dir}/${path.slice(path.lastIndexOf("/") + 1)}`;
    checkLeftover(runtime, this.#final, me);
    this.#private = runtime.makeTempDirSync(dir, ".ik-");
    this.#bound = `${this.#private}/s`;
    const st = runtime.lstatSync(this.#private);
    if (
      me !== null &&
      (st?.kind !== "directory" || st.uid !== me ||
        ((st.mode ?? 0) & 0o077) !== 0)
    ) {
      this.#cleanup();
      throw new SocketPathRefused(
        this.#private,
        `ikigai-ts: refused to bind in ${this.#private}: the new private ` +
          "directory is not a 0700 directory owned by this process.",
      );
    }
    let listener: RuntimeListener;
    try {
      listener = runtime.listenUnix(this.#bound, mode, () => {
        runtime.renameSync(this.#bound, this.#final);
        const placed = runtime.lstatSync(this.#final);
        if (placed !== null) this.#id = { dev: placed.dev, ino: placed.ino };
        runtime.removeSync(this.#private);
      });
    } catch (e) {
      this.#cleanup();
      throw e;
    }
    listener.ready.catch(() => this.#cleanup());
    this.listener = listener;
  }

  /**
   * Close the listener and remove the final path if it is still the socket
   * placed there: the runtimes' own close unlinks only the private path.
   */
  close(): void {
    try {
      this.listener.close();
    } catch {
      // already closed
    }
    this.#cleanup();
    const id = this.#id;
    if (id === null) return;
    this.#id = null;
    const st = this.#runtime.lstatSync(this.#final);
    if (st?.kind === "socket" && st.dev === id.dev && st.ino === id.ino) {
      try {
        this.#runtime.removeSync(this.#final);
      } catch {
        // already gone
      }
    }
  }

  #cleanup(): void {
    for (const p of [this.#bound, this.#private]) {
      try {
        this.#runtime.removeSync(p);
      } catch {
        // absent: moved, or never made
      }
    }
  }
}
