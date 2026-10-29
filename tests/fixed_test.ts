/**
 * Inputs a named request fixes (core's `ArgSpec::fixed`, ledger #2512,
 * #2557): read from the JSON contract's `"fixed"`, written back there, said as
 * `ik:fixed` on the input node, and fed to the v2 contract digest as core's
 * `contract_id_v2` tail, the byte `4` and the set of `name` NUL `value`
 * strings, only when an input is fixed.
 *
 * Pinned against `fixed_vectors.json`, which a Rust build of ikigai-core and
 * ikigai-vocab 0.2.7 produced (its `about` says how). Core's shared
 * `contract_vectors.json` has no fixed case yet; when it gains one, the
 * shared-vector tests in `contract_test.ts` carry it too.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { ArgSpec } from "../src/serve.ts";
import { contractIri } from "../src/contract.ts";
import { actionSpec, type Json, VectorDoor } from "./vector_door.ts";

const read = async (file: string) =>
  JSON.parse(await Deno.readTextFile(new URL(file, import.meta.url)));

const FIXED: {
  contracts: { name: string; id: string; action: Json; contract: string }[];
  door: { description: Json; turtle: string };
} = await read("./fixed_vectors.json");

const SHARED: {
  contracts: { name: string; id: string; action: Json; contract: string }[];
} = await read("./contract_vectors.json");

const contract = (name: string) => {
  const c = FIXED.contracts.find((c) => c.name === name);
  assert(c !== undefined, name);
  return c;
};

Deno.test("fixed: contractIri is core's for one and for two fixed inputs", () => {
  for (const c of FIXED.contracts) {
    assertStrictEquals(
      contractIri(c.id, actionSpec(c.action)),
      c.contract,
      c.name,
    );
  }
});

Deno.test("fixed: the tail is a set, so declaration order never moves it", () => {
  assertStrictEquals(
    contract("fixed/two").contract,
    contract("fixed/two-in-another-order").contract,
  );
  // But which input holds which value does.
  assert(
    contract("fixed/two").contract !==
      contract("fixed/two-values-swapped").contract,
  );
});

Deno.test("fixed: a contract that fixes nothing keeps its digest", () => {
  // The same contract without the fix: v1, and core's digest for it.
  assert(contract("fixed/one").contract !== contract("fixed/none").contract);
  // An existing shared v2 vector, which fixes nothing, is unchanged.
  const needs = SHARED.contracts.find((c) => c.name === "v2/needs");
  assert(needs !== undefined);
  assertStrictEquals(
    contractIri(needs.id, actionSpec(needs.action)),
    needs.contract,
  );
  assertStrictEquals(
    needs.contract,
    "urn:ikigai:contract:kernel-validate:source:b3:" +
      "7e6f08c66d8afec7af0565b16db5f228680712c4474eef647b1898a0ecad6bfc",
  );
});

Deno.test("fixed: the JSON Meta face round-trips `fixed`, absent when unfixed", () => {
  const door = new VectorDoor(FIXED.door.description);
  assertEquals(door.descriptionJson(), FIXED.door.description);
  const json = new ArgSpec({ name: "graph", fixed: "urn:g" }).toJson();
  assertStrictEquals(json["fixed"], "urn:g");
  assertStrictEquals(json["required"], false);
  assert(!("fixed" in new ArgSpec("graph").toJson()));
});

Deno.test("fixed: the Turtle Meta face says ik:fixed as core's to_turtle does", () => {
  const ttl = new VectorDoor(FIXED.door.description).descriptionTurtle();
  assertStrictEquals(ttl, FIXED.door.turtle);
  assertStrictEquals(ttl.split("ik:fixed ").length - 1, 4);
});
