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
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  connect,
  ConnectionLost,
  defaultSocketPath,
} from "../../src/client.ts";
import { endpoint, Server } from "../../src/serve.ts";
import type { Runtime } from "../../src/runtime.ts";

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
          return Promise.resolve();
        })
      ),
  },
  {
    name: "a leftover file at the path is replaced",
    fn: (server, client) =>
      inTempDir(async (dir) => {
        fs.writeFileSync(`${dir}/peer.sock`, "stale");
        await withServer(server, `${dir}/peer.sock`, async () => {
          await using k = await connect(`${dir}/peer.sock`, {
            runtime: client,
          });
          assertEquals((await k.source("urn:ts:echo", { in: "x" })).text, "x");
        });
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
