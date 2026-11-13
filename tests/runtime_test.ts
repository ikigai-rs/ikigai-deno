/**
 * The runtime adapters (ledger #3627): the socket checks pass with the Deno
 * adapter, with the Node adapter under Deno's `node:` compatibility, and with
 * each one serving the other. Node and Bun themselves run the same checks
 * through `tests/cross_runtime/run.ts`.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { defaultRuntime, denoRuntime } from "../src/runtime.ts";
import { nodeRuntime } from "../src/runtime_node.ts";
import { CHECKS } from "./cross_runtime/socket_checks.ts";

const PAIRS = [
  ["deno", denoRuntime, denoRuntime],
  ["node", nodeRuntime, nodeRuntime],
  ["node server, deno client", nodeRuntime, denoRuntime],
  ["deno server, node client", denoRuntime, nodeRuntime],
] as const;

for (const [label, server, client] of PAIRS) {
  for (const check of CHECKS) {
    Deno.test(`runtime (${label}): ${check.name}`, () =>
      check.fn(server, client));
  }
}

Deno.test("runtime: the default under Deno is the Deno adapter", () => {
  if (defaultRuntime() !== denoRuntime) throw new Error("not denoRuntime");
});

Deno.test("runtime: no Deno global names the missing adapter", () => {
  const deno = Object.getOwnPropertyDescriptor(globalThis, "Deno")!;
  // deno-lint-ignore no-explicit-any
  delete (globalThis as any).Deno;
  try {
    assertThrows(() => defaultRuntime(), Error, "no runtime adapter");
  } finally {
    Object.defineProperty(globalThis, "Deno", deno);
  }
});

/**
 * What a socket file's mode gates on `connect`, measured on this OS (ledger
 * #3631): a socket owned by this uid is narrowed to each mode and dialed.
 * Linux requires write permission, and is pinned; elsewhere (macOS) the
 * answer is printed, to be recorded in the README's "Security posture" and
 * pinned here. Root bypasses the check, and Windows is out of scope, so
 * neither is measured.
 */
Deno.test("runtime: what a socket's mode gates on connect, by OS", async () => {
  if (Deno.build.os === "windows" || Deno.uid() === 0) return;
  const dir = Deno.makeTempDirSync({ prefix: "ik-mode-" });
  const path = `${dir}/m.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const accepting = (async () => {
    try {
      for await (const c of listener) c.close();
    } catch {
      // closed
    }
  })();
  const dials: Record<string, boolean> = {};
  try {
    for (const mode of [0o000, 0o400, 0o200, 0o600]) {
      Deno.chmodSync(path, mode);
      try {
        (await Deno.connect({ transport: "unix", path })).close();
        dials[`0${mode.toString(8).padStart(3, "0")}`] = true;
      } catch (e) {
        if (!(e instanceof Deno.errors.PermissionDenied)) throw e;
        dials[`0${mode.toString(8).padStart(3, "0")}`] = false;
      }
    }
  } finally {
    listener.close();
    await accepting;
    Deno.removeSync(dir, { recursive: true });
  }
  console.log(`${Deno.build.os}: connect accepted? ${JSON.stringify(dials)}`);
  if (Deno.build.os === "linux") {
    assertEquals(dials, {
      "0000": false,
      "0400": false,
      "0200": true,
      "0600": true,
    });
  }
});
