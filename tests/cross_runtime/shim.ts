/**
 * A stand-in for the two `Deno` calls the shared-vector tests make
 * (`Deno.test` and `Deno.readTextFile`), so their bundles run under Node and
 * Bun unchanged. Spike harness for ledger #3627; see `run.ts`.
 *
 * It is installed only where there is no real `Deno`. Vector files are read
 * from `IKIGAI_VECTORS_DIR` by base name, since a bundle's `import.meta.url`
 * is the bundle's, not the test's.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

type Test = { name: string; fn: () => unknown };
const tests: Test[] = [];

if (typeof (globalThis as { Deno?: unknown }).Deno === "undefined") {
  (globalThis as Record<string, unknown>).Deno = {
    test(name: string, fn: () => unknown) {
      tests.push({ name, fn });
    },
    readTextFile(url: URL | string) {
      const base = String(url).split("/").pop()!;
      return readFile(`${process.env.IKIGAI_VECTORS_DIR}/${base}`, "utf8");
    },
  };
}

/** Run every registered test; print one `CROSS_RUNTIME` JSON line. */
export async function runAll(file: string): Promise<void> {
  const failed: { name: string; error: string }[] = [];
  for (const t of tests) {
    try {
      await t.fn();
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      failed.push({ name: t.name, error: error.split("\n")[0] });
    }
  }
  console.log(
    "CROSS_RUNTIME " +
      JSON.stringify({
        file,
        passed: tests.length - failed.length,
        failed,
      }),
  );
}
