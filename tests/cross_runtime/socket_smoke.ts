/**
 * {@linkcode CHECKS} through the Node adapter, for Node and Bun (spike,
 * ledger #3627): `run.ts` bundles this and prints its `CROSS_RUNTIME` line.
 *
 * @module
 */

import { nodeRuntime } from "../../src/runtime_node.ts";
import { CHECKS } from "./socket_checks.ts";

const failed: { name: string; error: string }[] = [];
for (const check of CHECKS) {
  try {
    await check.fn(nodeRuntime, nodeRuntime);
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    failed.push({ name: check.name, error: error.split("\n")[0] });
  }
}
console.log(
  "CROSS_RUNTIME " +
    JSON.stringify({
      file: "socket_smoke",
      passed: CHECKS.length - failed.length,
      failed,
    }),
);
