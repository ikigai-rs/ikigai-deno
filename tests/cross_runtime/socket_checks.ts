/**
 * Socket checks any {@linkcode Runtime} adapter must pass, written against
 * `node:fs` and `node:os` only so they run under Deno, Node and Bun alike.
 * `tests/runtime_test.ts` runs them under `deno test` with both adapters;
 * `socket_smoke.ts` runs them under Node and Bun (spike, ledger #3627).
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  connect,
  ConnectionLost,
  defaultSocketPath,
} from "../../src/client.ts";
import { endpoint, Server } from "../../src/serve.ts";
import type { Runtime, RuntimeStat } from "../../src/runtime.ts";

const ENDPOINTS = [
  endpoint("urn:ts:hello", {
    summary: "Greet someone",
    args: [{ name: "who", required: true }],
  }, ({ who }) => `Hello, ${who}!`),
  endpoint("urn:ts:echo", {
    summary: "Echo the input",
    args: [{ name: "in", required: true }],
  }, (args) => String(args["in"])),
];

async function inTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/ik-runtime-`);
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A served `Server` on `path` through `server`'s adapter, for `fn`. */
async function withServer(
  runtime: Runtime,
  path: string,
  fn: (server: Server) => Promise<void>,
): Promise<void> {
  const server = new Server(ENDPOINTS, path, { runtime });
  await server.ready;
  const serving = server.serve();
  try {
    await fn(server);
  } finally {
    server.shutdown();
    await serving;
  }
}

/**
 * `runtime` with what `lstatSync` reports for `path` changed: how a check
 * fakes another account's directory or socket without a second account.
 */
function faking(
  runtime: Runtime,
  path: string,
  change: Partial<RuntimeStat>,
): Runtime {
  return {
    ...runtime,
    lstatSync(p) {
      const st = runtime.lstatSync(p);
      return p === path && st !== null ? { ...st, ...change } : st;
    },
  };
}

/**
 * Serving on `path` is refused, before anything is bound, with a
 * `SocketPathRefused` that names `named` and says `words`. (Matched by name,
 * not class, so the check also runs, and fails, against a server without
 * the class.)
 */
async function assertRefused(
  runtime: Runtime,
  path: string,
  named: string,
  words: string,
): Promise<void> {
  let server: Server | undefined;
  try {
    server = new Server(ENDPOINTS, path, { runtime });
    await server.ready;
  } catch (e) {
    assert(e instanceof Error, String(e));
    assertEquals(e.name, "SocketPathRefused", e.message);
    assertEquals((e as Error & { path: string }).path, named);
    assertStringIncludes(e.message, named);
    assertStringIncludes(e.message, words);
    return;
  } finally {
    server?.shutdown();
  }
  throw new Error(`served on ${path}; expected a refusal naming ${named}`);
}

/** A live socket of `runtime`'s at `path`, bound elsewhere and moved there. */
async function foreignSocket(
  runtime: Runtime,
  dir: string,
  path: string,
): Promise<{ close(): void }> {
  const listener = runtime.listenUnix(`${dir}/elsewhere.sock`, 0o600);
  await listener.ready;
  fs.renameSync(`${dir}/elsewhere.sock`, path);
  return listener;
}

/** One named check: `server` listens, `client` dials. */
export type Check = {
  name: string;
  fn: (server: Runtime, client: Runtime) => Promise<void>;
};

/** The checks, in the order they run. */
export const CHECKS: Check[] = [
  {
    name: "a call round-trips",
    fn: (server, client) =>
      inTempDir((dir) =>
        withServer(server, `${dir}/peer.sock`, async () => {
          await using k = await connect(`${dir}/peer.sock`, {
            runtime: client,
          });
          assertEquals(
            (await k.source("urn:ts:hello", { who: "Ada" })).text,
            "Hello, Ada!",
          );
        })
      ),
  },
  {
    name: "the socket is 0600 in a fresh 0700 directory",
    fn: (server) =>
      inTempDir((dir) =>
        withServer(server, `${dir}/sub/peer.sock`, () => {
          assertEquals(fs.statSync(`${dir}/sub`).mode & 0o777, 0o700);
          const st = fs.statSync(`${dir}/sub/peer.sock`);
          assert(st.isSocket(), "a socket file");
          assertEquals(st.mode & 0o777, 0o600);
          assertEquals(fs.readdirSync(`${dir}/sub`), ["peer.sock"]);
          return Promise.resolve();
        })
      ),
  },
  {
    name: "a leftover socket of ours at the path is replaced",
    fn: (server, client) =>
      inTempDir(async (dir) => {
        const leftover = await foreignSocket(server, dir, `${dir}/peer.sock`);
        leftover.close();
        await withServer(server, `${dir}/peer.sock`, async () => {
          await using k = await connect(`${dir}/peer.sock`, {
            runtime: client,
          });
          assertEquals((await k.source("urn:ts:echo", { in: "x" })).text, "x");
        });
      }),
  },
  {
    name: "a leftover regular file at the path is refused by name and kept",
    fn: (server) =>
      inTempDir(async (dir) => {
        const real = fs.realpathSync(dir);
        fs.writeFileSync(`${dir}/peer.sock`, "stale");
        await assertRefused(
          server,
          `${dir}/peer.sock`,
          `${real}/peer.sock`,
          "a regular file, not a socket",
        );
        assertEquals(fs.readFileSync(`${dir}/peer.sock`, "utf8"), "stale");
      }),
  },
  {
    name: "another account's leftover socket is refused by name and kept",
    fn: (server) =>
      inTempDir(async (dir) => {
        const real = fs.realpathSync(dir);
        const other = await foreignSocket(server, dir, `${dir}/peer.sock`);
        try {
          const uid = server.uid()! + 1;
          await assertRefused(
            faking(server, `${real}/peer.sock`, { uid }),
            `${dir}/peer.sock`,
            `${real}/peer.sock`,
            `owned by uid ${uid}`,
          );
          assert(fs.statSync(`${dir}/peer.sock`).isSocket(), "kept");
        } finally {
          other.close();
        }
      }),
  },
  {
    name: "a parent directory of mode 0777 is refused by name",
    fn: (server) =>
      inTempDir(async (dir) => {
        const real = fs.realpathSync(dir);
        fs.mkdirSync(`${dir}/open`);
        fs.chmodSync(`${dir}/open`, 0o777);
        await assertRefused(
          server,
          `${dir}/open/peer.sock`,
          `${real}/open`,
          `mode is 0777, writable by group or others, who could replace or ` +
            `remove the socket. Run \`chmod 700 ${real}/open\``,
        );
        assert(!fs.existsSync(`${dir}/open/peer.sock`), "nothing bound");
        assertEquals(fs.readdirSync(`${dir}/open`), []);
      }),
  },
  {
    name: "a parent directory another account owns is refused by name",
    fn: (server) =>
      inTempDir(async (dir) => {
        const real = fs.realpathSync(dir);
        fs.mkdirSync(`${dir}/theirs`, { mode: 0o700 });
        const uid = server.uid()! + 1;
        await assertRefused(
          faking(server, `${real}/theirs`, { uid }),
          `${dir}/theirs/peer.sock`,
          `${real}/theirs`,
          `owned by uid ${uid}, not by this process's uid ${server.uid()}`,
        );
        assertEquals(fs.readdirSync(`${dir}/theirs`), []);
      }),
  },
  {
    // The default path's shape: `$TMPDIR/ikigai-<uid>` made first by another
    // account, then `ikigai/kernel.sock` below it. The fresh `ikigai` is
    // ours, but whoever owns the directory above can rename it away.
    name: "a directory above, owned by another account, is refused by name",
    fn: (server) =>
      inTempDir(async (dir) => {
        const real = fs.realpathSync(dir);
        fs.mkdirSync(`${dir}/ikigai-u`, { mode: 0o755 });
        const uid = server.uid()! + 1;
        await assertRefused(
          faking(server, `${real}/ikigai-u`, { uid }),
          `${dir}/ikigai-u/ikigai/kernel.sock`,
          `${real}/ikigai-u`,
          `owned by uid ${uid}`,
        );
      }),
  },
  {
    // Claim 1: the socket is bound away from its final path and reaches it
    // only after it is 0600. A Node bind runs before its listen callback, so
    // the final path is also looked at as soon as the constructor returns.
    name: "the socket reaches its path only once it is 0600",
    fn: (server) =>
      inTempDir(async (dir) => {
        const path = `${dir}/peer.sock`;
        const bound: string[] = [];
        const recording: Runtime = {
          ...server,
          listenUnix(p, mode, onBound) {
            bound.push(p);
            assert(!fs.existsSync(path), "the final path is empty at bind");
            return server.listenUnix(p, mode, () => {
              assertEquals(fs.statSync(p).mode & 0o777, 0o600);
              assert(!fs.existsSync(path), "the final path is still empty");
              const st = fs.statSync(p.slice(0, p.lastIndexOf("/")));
              assertEquals(st.mode & 0o777, 0o700);
              assertEquals(st.uid, server.uid());
              onBound?.();
            });
          },
        };
        const s = new Server(ENDPOINTS, path, { runtime: recording });
        try {
          if (fs.existsSync(path)) {
            assertEquals(fs.statSync(path).mode & 0o777, 0o600);
          }
          await s.ready;
          assertEquals(bound.length, 1);
          assertNotEquals(bound[0], path);
          assertEquals(fs.statSync(path).mode & 0o777, 0o600);
          assert(!fs.existsSync(bound[0]), "moved, not copied");
          assertEquals(fs.readdirSync(dir), ["peer.sock"]);
        } finally {
          s.shutdown();
        }
      }),
  },
  {
    name: "a 1 MiB payload crosses both ways intact",
    fn: (server, client) =>
      inTempDir((dir) =>
        withServer(server, `${dir}/peer.sock`, async () => {
          await using k = await connect(`${dir}/peer.sock`, {
            runtime: client,
          });
          const big = "abcdefghij".repeat(104_858);
          assertEquals((await k.source("urn:ts:echo", { in: big })).text, big);
        })
      ),
  },
  {
    name: "concurrent calls on one client are serialized",
    fn: (server, client) =>
      inTempDir((dir) =>
        withServer(server, `${dir}/peer.sock`, async () => {
          await using k = await connect(`${dir}/peer.sock`, {
            runtime: client,
          });
          const names = ["a", "b", "c", "d", "e"];
          const reps = await Promise.all(
            names.map((who) => k.source("urn:ts:hello", { who })),
          );
          assertEquals(
            reps.map((r) => r.text),
            names.map((n) => `Hello, ${n}!`),
          );
        })
      ),
  },
  {
    name: "a restarted server is redialed",
    fn: (server, client) =>
      inTempDir(async (dir) => {
        const path = `${dir}/peer.sock`;
        let k: Awaited<ReturnType<typeof connect>> | undefined;
        try {
          await withServer(server, path, async () => {
            k = await connect(path, { runtime: client });
            assertEquals(
              (await k.source("urn:ts:echo", { in: "1" })).text,
              "1",
            );
          });
          await withServer(server, path, async () => {
            assertEquals(
              (await k!.source("urn:ts:echo", { in: "2" })).text,
              "2",
            );
          });
        } finally {
          k?.close();
        }
      }),
  },
  {
    name: "shutdown removes the socket file",
    fn: (server) =>
      inTempDir(async (dir) => {
        await withServer(server, `${dir}/peer.sock`, () => Promise.resolve());
        // Some runtimes unlink on close asynchronously; give it a turn.
        for (let i = 0; i < 50 && fs.existsSync(`${dir}/peer.sock`); i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        assert(!fs.existsSync(`${dir}/peer.sock`), "socket file removed");
      }),
  },
  {
    name: "shutdown leaves a socket that is not ours alone",
    fn: (server) =>
      inTempDir(async (dir) => {
        const path = `${dir}/peer.sock`;
        let other: { close(): void } | undefined;
        try {
          await withServer(server, path, async () => {
            other = await foreignSocket(server, dir, path);
          });
          const st = fs.statSync(path);
          assert(st.isSocket(), "the other socket is still there");
          // Give an asynchronous unlink a turn, then look again.
          await new Promise((r) => setTimeout(r, 50));
          assertEquals(fs.statSync(path).ino, st.ino);
        } finally {
          other?.close();
        }
      }),
  },
  {
    name: "a silent server times the hello out as ConnectionLost",
    fn: (server, client) =>
      inTempDir(async (dir) => {
        const path = `${dir}/mute.sock`;
        const listener = server.listenUnix(path, 0o600);
        await listener.ready;
        const held: { close(): void }[] = [];
        const accepting = (async () => {
          try {
            while (true) held.push(await listener.accept());
          } catch {
            // closed
          }
        })();
        try {
          await assertRejects(
            () => connect(path, { runtime: client, timeoutMs: 200 }),
            ConnectionLost,
            "within the deadline",
          );
        } finally {
          listener.close();
          for (const c of held) c.close();
          await accepting;
        }
      }),
  },
  {
    name: "an absent server is ConnectionLost",
    fn: (_server, client) =>
      inTempDir(async (dir) => {
        await assertRejects(
          () => connect(`${dir}/none.sock`, { runtime: client }),
          ConnectionLost,
          "cannot reach a kernel server",
        );
      }),
  },
  {
    name: "the default socket path follows XDG_RUNTIME_DIR",
    fn: (_server, client) => {
      const xdg = client.env("XDG_RUNTIME_DIR");
      const path = defaultSocketPath(client);
      if (xdg) assertEquals(path, `${xdg}/ikigai/kernel.sock`);
      else assert(path.endsWith(`-${client.uid()}/ikigai/kernel.sock`), path);
      return Promise.resolve();
    },
  },
];
