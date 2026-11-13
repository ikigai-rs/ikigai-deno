/**
 * The Node adapter (spike, ledger #3627): {@linkcode Runtime} over `node:net`
 * and `node:fs`, for Node and Bun. Not an export of the package yet; import
 * it by path.
 *
 * ```ts ignore
 * import { nodeRuntime } from "./runtime_node.ts";
 * import { connect } from "./client.ts";
 *
 * await using k = await connect(undefined, { runtime: nodeRuntime });
 * ```
 *
 * Node binds asynchronously: a `Server` built with this adapter is listening
 * once its `ready` resolves, and a bind error surfaces there (and at the
 * first accept), not from the constructor as it does under Deno.
 *
 * @module
 */

import * as fs from "node:fs";
import * as net from "node:net";
import process from "node:process";
import type { Runtime, RuntimeConn, RuntimeListener } from "./runtime.ts";

/**
 * A `net.Socket` as a pull-based {@linkcode RuntimeConn}: data is buffered
 * per chunk and the socket paused until it is read, so a slow reader applies
 * backpressure the way a Deno read does.
 */
class NodeConn implements RuntimeConn {
  #socket: net.Socket;
  #chunks: Uint8Array[] = [];
  #ended = false;
  #error: Error | null = null;
  #wake: (() => void) | null = null;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Uint8Array) => {
      this.#chunks.push(chunk);
      socket.pause();
      this.#notify();
    });
    socket.on("end", () => {
      this.#ended = true;
      this.#notify();
    });
    socket.on("error", (e: Error) => {
      this.#error ??= e;
      this.#notify();
    });
    socket.on("close", () => {
      this.#ended = true;
      this.#notify();
    });
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  async read(p: Uint8Array): Promise<number | null> {
    while (true) {
      const head = this.#chunks[0];
      if (head !== undefined) {
        const n = Math.min(p.length, head.length);
        p.set(head.subarray(0, n));
        if (n === head.length) this.#chunks.shift();
        else this.#chunks[0] = head.subarray(n);
        return n;
      }
      if (this.#error !== null) throw this.#error;
      if (this.#ended) return null;
      this.#socket.resume();
      await new Promise<void>((resolve) => this.#wake = resolve);
    }
  }

  write(p: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#socket.write(p, (e) => e ? reject(e) : resolve(p.length));
    });
  }

  close(): void {
    // Like Deno, a read pending on a closed connection rejects.
    this.#error ??= new Error("connection closed locally");
    this.#socket.destroy();
    this.#notify();
  }
}

class NodeListener implements RuntimeListener {
  readonly ready: Promise<void>;
  #server: net.Server;
  #queue: net.Socket[] = [];
  #waiters: {
    resolve: (conn: RuntimeConn) => void;
    reject: (e: Error) => void;
  }[] = [];
  #failure: Error | null = null;

  constructor(path: string, mode: number) {
    this.#server = net.createServer((socket) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(new NodeConn(socket));
      else this.#queue.push(socket);
    });
    this.ready = new Promise((resolve, reject) => {
      this.#server.on("error", (e) => {
        this.#fail(e);
        reject(e);
      });
      this.#server.listen(path, () => {
        try {
          // Node binds with the process umask too; narrow it, the gate.
          fs.chmodSync(path, mode);
          resolve();
        } catch (e) {
          this.close();
          reject(e);
        }
      });
    });
    // `ready` is also awaited through accept; never an unhandled rejection.
    this.ready.catch(() => {});
  }

  #fail(e: Error): void {
    this.#failure ??= e;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#failure);
  }

  async accept(): Promise<RuntimeConn> {
    await this.ready;
    const queued = this.#queue.shift();
    if (queued) return new NodeConn(queued);
    if (this.#failure !== null) throw this.#failure;
    return await new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  close(): void {
    // Closing a Unix-socket server unlinks its file, as Deno's close does.
    this.#server.close();
    for (const socket of this.#queue.splice(0)) socket.destroy();
    this.#fail(new Error("listener closed"));
  }
}

/** The Node (and Bun) adapter. */
export const nodeRuntime: Runtime = {
  connectUnix: (path) =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ path });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(new NodeConn(socket));
      });
    }),
  listenUnix: (path, mode) => new NodeListener(path, mode),
  mkdirSync: (path, options) => {
    fs.mkdirSync(path, options);
  },
  removeSync: (path) => fs.rmSync(path),
  env: (name) => process.env[name],
  uid: () => process.getuid?.() ?? null,
};
