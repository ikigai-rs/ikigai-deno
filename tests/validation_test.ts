/**
 * The pre-flight check against `validation_vectors.json`, a VERBATIM copy of
 * ikigai-core's `crates/ikigai-vocab/tests/vectors/validation_vectors.json`
 * (ledger #1547): what `ActionSpec::check` answers for a contract and a
 * proposed argument set. Do not edit or reformat it; to pick up new vectors,
 * copy the file again.
 */

import { assertEquals } from "@std/assert";
import { checkAction } from "../src/check.ts";
import { actionSpec, type Json } from "./vector_door.ts";

interface Case {
  name: string;
  action: Json;
  args: [string, string][];
  conforms: boolean;
  violations: { kind: string; path: string | null }[];
}

const VECTORS: { cases: Case[] } = JSON.parse(
  await Deno.readTextFile(
    new URL("./validation_vectors.json", import.meta.url),
  ),
);

Deno.test("every validation vector agrees with core's ActionSpec::check", () => {
  for (const c of VECTORS.cases) {
    const found = checkAction(actionSpec(c.action), c.args);
    assertEquals(
      found.map(({ kind, path }) => ({ kind, path })),
      c.violations,
      c.name,
    );
    assertEquals(found.length === 0, c.conforms, c.name);
  }
});
