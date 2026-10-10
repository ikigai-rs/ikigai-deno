/**
 * Content-addressed contracts (ledger #948, #1034): this peer's Turtle Meta
 * face must name each `ik:Action` exactly as core does, because a Rust host's
 * manifold joins its rows to that node by `ik:contract`.
 *
 * Pinned against `contract_vectors.json`, a VERBATIM copy of ikigai-core's
 * `crates/ikigai-vocab/tests/vectors/contract_vectors.json` (ledger #1096,
 * #1106). Core's own test recomputes that file and fails if it differs by a
 * byte, and devtools' `vector-drift` compares this copy with core's, so do not
 * edit or reformat it here (`deno.json` keeps it out of `deno fmt`): to pick up
 * new vectors, copy the file again. Its sections, and what each asks of a face,
 * are in core's `tests/vectors/README.md`.
 *
 * The `deno/…` doors in it are this package's own, built in
 * `contract_cases.ts`; the face-local test below checks that the public API
 * still builds exactly those descriptions.
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
  type DescriptionModel,
  ServedDef,
} from "../src/serve.ts";
import {
  CONTRACT_PREFIX,
  contractId,
  contractIri,
  escapeIriFragment,
  MATCH_PREFIX,
  matchIri,
} from "../src/contract.ts";
import { type Reply, Verb } from "../src/wire.ts";
import { CASES } from "./contract_cases.ts";

type Json = Record<string, unknown>;

interface Door {
  name: string;
  pattern: string;
  description: Json;
  actions: { verb: string; match: string; contract: string }[];
  turtle: string;
}

interface ParseCase {
  iri: string;
  match: [string, string] | null;
  contract: [string, string, string] | null;
  canonical: string | null;
}

const VECTORS: {
  form: string;
  doors: Door[];
  contracts: { name: string; id: string; action: Json; contract: string }[];
  matches: { pattern: string; iris: { verb: string; match: string }[] }[];
  parses: ParseCase[];
} = JSON.parse(
  await Deno.readTextFile(new URL("./contract_vectors.json", import.meta.url)),
);

const verbOf = (name: string): Verb => {
  const verb = Verb[name as keyof typeof Verb];
  assert(verb !== undefined, `not a verb: ${name}`);
  return verb;
};

const list = <T>(from: Json, key: string): T[] =>
  (from[key] as T[] | undefined) ?? [];

/** A serde `ArgSpec` (the JSON Meta face's shape) as this package's ArgSpec. */
function argSpec(json: Json): ArgSpec {
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

/** A serde `ikigai_core::ActionSpec` as this package's model. */
function actionSpec(json: Json): ActionSpecModel {
  return {
    verb: verbOf(json["verb"] as string),
    summary: (json["summary"] as string | undefined) ?? "",
    inputs: list<Json>(json, "inputs").map(argSpec),
    outputs: list<string>(json, "outputs"),
    requires: list<string>(json, "requires"),
  };
}

/** A serde `ikigai_core::Description` as this package's model. */
function descriptionModel(json: Json): DescriptionModel {
  return {
    id: json["id"] as string,
    title: json["title"] as string,
    summary: json["summary"] as string,
    verbs: list<string>(json, "verbs").map(verbOf),
    inputs: list<Json>(json, "inputs").map(argSpec),
    outputs: list<string>(json, "outputs"),
    requires: list<string>(json, "requires"),
    actions: list<Json>(json, "actions").map(actionSpec),
  };
}

/**
 * A door that answers Meta with a given description and nothing else, so a
 * vector's description (another face's door included) goes through the same
 * renderers this package's own doors use.
 */
class VectorDoor extends ServedDef {
  readonly #model: DescriptionModel;

  constructor(pattern: string, json: Json) {
    super(pattern, {}, json["id"] as string);
    this.#model = descriptionModel(json);
  }

  description(): DescriptionModel {
    return this.#model;
  }

  answer(): Promise<Reply> {
    throw new Error("a vector door answers Meta only");
  }

  protected answeredVerbs(): Verb[] {
    return [];
  }
}

/** `Description::action_specs`: one per non-Meta verb, explicit or flat. */
function actionSpecs(d: DescriptionModel): ActionSpecModel[] {
  return d.verbs.filter((v) => v !== Verb.Meta).map((verb) =>
    d.actions.find((a) => a.verb === verb) ?? {
      verb,
      summary: "",
      inputs: d.inputs,
      outputs: d.outputs,
      requires: d.requires,
    }
  );
}

/** `{id}` as a contract IRI encodes it: the same injective segment encoding a match IRI uses. */
const contractSegment = (id: string): string =>
  matchIri(Verb.Source, id).slice(`${MATCH_PREFIX}source:`.length);

Deno.test("the vectors are core's file, in the shape this test reads", () => {
  assertStrictEquals(VECTORS.form, "ikigai:contract:v1");
  for (const key of ["doors", "contracts", "matches", "parses"] as const) {
    assert(VECTORS[key].length > 0, `no ${key}`);
  }
});

Deno.test("each vector description survives this test's adapter unchanged", () => {
  // Otherwise a failure below could be the adapter's rather than the face's.
  for (const door of VECTORS.doors) {
    assertEquals(
      new VectorDoor(door.pattern, door.description).descriptionJson(),
      door.description,
      door.name,
    );
  }
});

Deno.test("face-local: the public API still builds every deno/ door in the vectors", () => {
  const ours = VECTORS.doors.filter((d) => d.name.startsWith("deno/"));
  assertEquals(
    ours.map((d) => d.name.slice("deno/".length)).sort(),
    Object.keys(CASES).sort(),
  );
  for (const door of ours) {
    const built = CASES[door.name.slice("deno/".length)]();
    assertStrictEquals(built.iri, door.pattern, door.name);
    // A changed door would make the vector stale rather than wrong: say so.
    assertEquals(
      built.descriptionJson(),
      door.description,
      `${door.name}: the door no longer matches its vector; change contract_cases.json in ikigai-core and copy the regenerated file`,
    );
    assertStrictEquals(built.descriptionTurtle(), door.turtle, door.name);
  }
});

Deno.test("doors: the Turtle Meta face is core's to_turtle, byte for byte", () => {
  for (const door of VECTORS.doors) {
    assertStrictEquals(
      new VectorDoor(door.pattern, door.description).descriptionTurtle(),
      door.turtle,
      door.name,
    );
  }
});

Deno.test("doors: matchIri and contractIri are core's on every action", () => {
  for (const door of VECTORS.doors) {
    const id = door.description["id"] as string;
    const got = actionSpecs(descriptionModel(door.description)).map((spec) => ({
      verb: Verb[spec.verb],
      match: matchIri(spec.verb, door.pattern),
      contract: contractIri(id, spec),
    }));
    assertEquals(got, door.actions, door.name);
  }
});

Deno.test("contracts: contractIri is core's ActionSpec::contract_iri", () => {
  for (const c of VECTORS.contracts) {
    const iri = contractIri(c.id, actionSpec(c.action));
    assertStrictEquals(iri, c.contract, c.name);
    assertMatch(
      iri,
      /^urn:ikigai:contract:[^<>"{}|^`\\\s]*:[a-z]+:b3:[0-9a-f]{64}$/,
    );
  }
});

Deno.test("matches: matchIri is core's match_iri for all five verbs", () => {
  for (const m of VECTORS.matches) {
    for (const { verb, match } of m.iris) {
      assertStrictEquals(matchIri(verbOf(verb), m.pattern), match, m.pattern);
    }
  }
});

Deno.test("parses: what this face emits for a parsed IRI is core's canonical spelling", () => {
  // Lenient in, canonical out (ledger #1107): a match or contract IRI is said
  // back as `canonical`, never as typed. This package parses no IRIs (nothing
  // in it takes one from a caller), so it consumes this section through its
  // emitters: written from core's parse, each must give `canonical` to the
  // byte. The refusals (`canonical` null) have no emitter to check.
  let emitted = 0;
  for (const p of VECTORS.parses) {
    if (p.canonical === null) {
      assertStrictEquals(p.match, null, p.iri);
      assertStrictEquals(p.contract, null, p.iri);
      continue;
    }
    assert((p.match === null) !== (p.contract === null), p.iri);
    if (p.match !== null) {
      const [verb, pattern] = p.match;
      assertStrictEquals(matchIri(verbOf(verb), pattern), p.canonical, p.iri);
    } else {
      const [id, verb, digest] = p.contract!;
      assertMatch(digest, /^b3:[0-9a-f]{64}$/);
      assertStrictEquals(
        `${CONTRACT_PREFIX}${
          contractSegment(id)
        }:${verb.toLowerCase()}:${digest}`,
        p.canonical,
        p.iri,
      );
    }
    emitted++;
  }
  assert(emitted > 0, "no parse case has a canonical spelling");
});

Deno.test("a contract's identity ignores declaration order and duplicates, never its content", () => {
  const edge = VECTORS.doors.find((d) => d.name === "deno/edge")!;
  const id = edge.description["id"] as string;
  const [source] = actionSpecs(descriptionModel(edge.description));
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
