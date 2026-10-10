/**
 * Content-addressed contracts (ledger #948, #1034): this peer's Turtle Meta
 * face must name each `ik:Action` exactly as core does, because a Rust host's
 * manifold joins its rows to that node by `ik:contract`. Pinned against
 * `contract_vectors.json`, which a build of the released ikigai-core produced
 * from the doors in `contract_cases.ts` (procedure in `contract_vectors.rs`).
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  type ActionSpecModel,
  ArgSpec,
  type ArgSpecInput,
} from "../src/serve.ts";
import {
  contractId,
  contractIri,
  escapeIriFragment,
  matchIri,
} from "../src/contract.ts";
import { Verb } from "../src/wire.ts";
import { CASES } from "./contract_cases.ts";

interface Vector {
  case: string;
  description: Record<string, unknown>;
  contracts: { verb: string; iri: string }[];
  turtle: string;
}

const VECTORS: {
  core: string;
  cases: Vector[];
  matches: { verb: string; pattern: string; iri: string }[];
} = JSON.parse(
  await Deno.readTextFile(new URL("./contract_vectors.json", import.meta.url)),
);

const verbOf = (name: string): Verb => Verb[name as keyof typeof Verb];

/** A serde `ArgSpec` (the JSON Meta face's shape) as this package's ArgSpec. */
function argSpec(json: Record<string, unknown>): ArgSpec {
  const input: ArgSpecInput = {
    name: json["name"] as string,
    summary: json["summary"] as string,
    required: json["required"] as boolean,
    source: json["source"] as "argument" | "binding",
  };
  if ("class" in json) input.class = json["class"] as string;
  if ("default" in json) input.default = json["default"] as string;
  if ("one_of" in json) input.oneOf = json["one_of"] as string[];
  return new ArgSpec(input);
}

/** `Description::action_specs` over a serde `Description`. */
function actionSpecs(d: Record<string, unknown>): ActionSpecModel[] {
  const list = (key: string, from = d): unknown[] =>
    (from[key] as unknown[] | undefined) ?? [];
  const explicit = list("actions") as Record<string, unknown>[];
  return (d["verbs"] as string[]).filter((v) => v !== "Meta").map((name) => {
    const a = explicit.find((x) => x["verb"] === name);
    const from = a ?? d;
    return {
      verb: verbOf(name),
      summary: a ? (a["summary"] as string | undefined) ?? "" : "",
      inputs: (list("inputs", from) as Record<string, unknown>[]).map(argSpec),
      outputs: list("outputs", from) as string[],
      requires: list("requires", from) as string[],
    };
  });
}

Deno.test("contract vectors cover every case, and every case still builds the door they were made from", () => {
  assertEquals(
    VECTORS.cases.map((v) => v.case).sort(),
    Object.keys(CASES).sort(),
  );
  for (const v of VECTORS.cases) {
    // A changed door would make the vector stale rather than wrong: say so.
    assertEquals(
      CASES[v.case]().descriptionJson(),
      v.description,
      `${v.case}: the door no longer matches its vector; regenerate (contract_vectors.rs)`,
    );
  }
});

Deno.test("the Turtle Meta face is core's to_turtle, byte for byte", () => {
  for (const v of VECTORS.cases) {
    assertStrictEquals(CASES[v.case]().descriptionTurtle(), v.turtle, v.case);
  }
});

Deno.test("contractIri is core's ActionSpec::contract_iri on every vector", () => {
  for (const v of VECTORS.cases) {
    const id = v.description["id"] as string;
    const got = actionSpecs(v.description).map((spec) => ({
      verb: Verb[spec.verb],
      iri: contractIri(id, spec),
    }));
    assertEquals(got, v.contracts, v.case);
    for (const { iri } of got) {
      assertMatch(
        iri,
        /^urn:ikigai:contract:[^<>"{}|^`\\\s]+:b3:[0-9a-f]{64}$/,
      );
    }
  }
});

Deno.test("matchIri is core's match_iri", () => {
  for (const m of VECTORS.matches) {
    assertStrictEquals(matchIri(verbOf(m.verb), m.pattern), m.iri, m.pattern);
  }
});

Deno.test("a contract's identity ignores declaration order and duplicates, never its content", () => {
  const edge = VECTORS.cases.find((v) => v.case === "edge")!;
  const id = edge.description["id"] as string;
  const [source] = actionSpecs(edge.description);
  const shuffled: ActionSpecModel = {
    ...source,
    inputs: [...source.inputs].reverse().concat([source.inputs[0]]),
    requires: [...source.requires].reverse(),
    outputs: [...source.outputs, ...source.outputs],
  };
  assertStrictEquals(contractId(id, shuffled), contractId(id, source));
  assertNotEquals(contractId("other", source), contractId(id, source));
  const variants: ActionSpecModel[] = [
    { ...source, summary: "changed" },
    { ...source, verb: Verb.Sink },
    { ...source, outputs: ["text/plain"] },
    { ...source, requires: [...source.requires, "urn:cap:more"] },
    { ...source, inputs: source.inputs.slice(1) },
    {
      ...source,
      inputs: source.inputs.map((i) =>
        i.name === "zeta" ? new ArgSpec({ name: "zeta", required: false }) : i
      ),
    },
  ];
  for (const v of variants) {
    assertNotEquals(contractId(id, v), contractId(id, source));
  }
});

Deno.test("escapeIriFragment is core's: the IRIREF set only, `%` left alone", () => {
  // core's own doctest vector
  assertStrictEquals(
    escapeIriFragment("evil> ; a <urn:x> . <urn:y"),
    "evil%3E%20;%20a%20%3Curn:x%3E%20.%20%3Curn:y",
  );
  assertStrictEquals(escapeIriFragment("a%3Eb"), "a%3Eb");
  assert(
    contractIri("a%3Eb", {
      verb: Verb.Delete,
      summary: "",
      inputs: [],
      outputs: [],
      requires: [],
    }).startsWith("urn:ikigai:contract:a%253Eb:delete:b3:"),
  );
});
