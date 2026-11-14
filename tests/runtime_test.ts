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
    assertThrows(
      () => defaultRuntime(),
      Error,
      "ikigai-ts: no runtime adapter",
    );
  } finally {
    Object.defineProperty(globalThis, "Deno", deno);
  }
});

/**
 * What a socket file's mode gates on `connect`, measured on this OS (ledger
 * #3631, #3666): a socket owned by this uid is narrowed to each mode and
 * dialed, and each dial's outcome is recorded (`accepted`, or the error's
 * code), never thrown. Linux and macOS both require write permission, and are
 * pinned; elsewhere the answer is printed. Root bypasses the check, and Windows
 * is out of scope, so neither is measured.
 *
 * The server holds each accepted connection open until the probe ends. Closing
 * it at once raced the dial on macOS: `Deno.connect` reads the new socket's
 * peer address after `connect` succeeds, and macOS answers `getpeername` with
 * `EINVAL` once the peer has closed (Linux does not), so an accepted dial was
 * reported as `EINVAL` (#3666).
 */
Deno.test("runtime: what a socket's mode gates on connect, by OS", async () => {
  if (Deno.build.os === "windows" || Deno.uid() === 0) return;
  const dir = Deno.makeTempDirSync({ prefix: "ik-mode-" });
  const path = `${dir}/m.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const held: Deno.Conn[] = [];
  const accepting = (async () => {
    try {
      for await (const c of listener) held.push(c);
    } catch {
      // closed
    }
  })();
  const dials: Record<string, string> = {};
  try {
    for (const mode of [0o000, 0o400, 0o200, 0o600]) {
      Deno.chmodSync(path, mode);
      const key = `0${mode.toString(8).padStart(3, "0")}`;
      try {
        (await Deno.connect({ transport: "unix", path })).close();
        dials[key] = "accepted";
      } catch (e) {
        dials[key] = (e as { code?: string }).code ?? String(e);
      }
    }
  } finally {
    listener.close();
    await accepting;
    for (const c of held) c.close();
    Deno.removeSync(dir, { recursive: true });
  }
  console.log(
    `${Deno.build.os}: connect outcome by mode ${JSON.stringify(dials)}`,
  );
  if (Deno.build.os === "linux" || Deno.build.os === "darwin") {
    assertEquals(dials, {
      "0000": "EACCES",
      "0400": "EACCES",
      "0200": "accepted",
      "0600": "accepted",
    });
  }
});
