/**
 * The runtime adapters (ledger #3627): the socket checks pass with the Deno
 * adapter, with the Node adapter under Deno's `node:` compatibility, and with
 * each one serving the other. Node and Bun themselves run the same checks
 * through `tests/cross_runtime/run.ts`.
 */

import { assertThrows } from "@std/assert";
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
