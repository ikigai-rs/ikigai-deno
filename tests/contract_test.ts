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
 *
 * The copy carries core 0.1.101's name encoding (ledger #1361, #1390): a NAME
 * — an endpoint id, an input name, a door pattern — is percent-encoded by
 * `encode_name` for `%`, the `IRIREF` set, `[`, `]`, `#`, `?` and every
 * non-`ucschar` code point. `src/contract.ts`'s {@linkcode nameFragment}
 * mirrors it, and the `core/bracket-names` and `core/hash-query-names` doors
 * pin the rule.
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
  type DescriptionModel,
} from "../src/serve.ts";
import {
  CONTRACT_PREFIX,
  contractId,
  contractIri,
  escapeIriFragment,
  MATCH_PREFIX,
  matchIri,
  nameFragment,
} from "../src/contract.ts";
import { isAbsoluteIri } from "../src/iri.ts";
import { Verb } from "../src/wire.ts";
import { CASES } from "./contract_cases.ts";
import {
  actionSpec,
  descriptionModel,
  type Json,
  VectorDoor,
  verbOf,
} from "./vector_door.ts";

const utf8 = new TextEncoder();

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
  form_v2: string;
  doors: Door[];
  contracts: { name: string; id: string; action: Json; contract: string }[];
  matches: { pattern: string; iris: { verb: string; match: string }[] }[];
  parses: ParseCase[];
} = JSON.parse(
  await Deno.readTextFile(new URL("./contract_vectors.json", import.meta.url)),
);

/** `Description::action_specs`: one per non-Meta verb, explicit or flat. */
function actionSpecs(d: DescriptionModel): ActionSpecModel[] {
  return d.verbs.filter((v) => v !== Verb.Meta).map((verb) =>
    d.actions.find((a) => a.verb === verb) ?? {
      verb,
      summary: "",
      inputs: d.inputs,
      outputs: d.outputs,
      requires: d.requires,
      groups: d.groups,
      arguments: d.arguments,
      outputFrom: d.outputFrom,
      failures: d.failures,
    }
  );
}

/** `{id}` as a contract IRI encodes it: the same injective segment encoding a match IRI uses. */
const contractSegment = (id: string): string =>
  matchIri(Verb.Source, id).slice(`${MATCH_PREFIX}source:`.length);

Deno.test("the vectors are core's file, in the shape this test reads", () => {
  assertStrictEquals(VECTORS.form, "ikigai:contract:v1");
  assertStrictEquals(VECTORS.form_v2, "ikigai:contract:v2");
  for (const key of ["doors", "contracts", "matches", "parses"] as const) {
    assert(VECTORS[key].length > 0, `no ${key}`);
  }
});

Deno.test("each vector description survives this test's adapter unchanged", () => {
  // Otherwise a failure below could be the adapter's rather than the face's.
  for (const door of VECTORS.doors) {
    assertEquals(
      new VectorDoor(door.description).descriptionJson(),
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
      new VectorDoor(door.description).descriptionTurtle(),
      door.turtle,
      door.name,
    );
  }
});

Deno.test("doors: every IRI this face writes in a door's Turtle parses", () => {
  // Core dropped KNOWN_UNPARSEABLE (ikigai-core PR 187, ledger #1345): every
  // door must parse. Checked here on what THIS face emits, with the oxiri
  // mirror, so a name encoding that regresses fails even before a vector moves.
  for (const door of VECTORS.doors) {
    const ttl = new VectorDoor(door.description)
      .descriptionTurtle();
    // String literals first: a hostile literal may hold `<…>` text.
    const bare = ttl.replaceAll(/"(?:[^"\\]|\\.)*"/g, '""');
    const iris = Array.from(bare.matchAll(/<([^>]*)>/g), (m) => m[1]);
    assert(iris.length > 0, door.name);
    for (const iri of iris) {
      assert(isAbsoluteIri(iri), `${door.name}: <${iri}>`);
    }
  }
});

Deno.test("nameFragment is core's encode_name: % as %25, then the IRIREF set", () => {
  assertStrictEquals(nameFragment("100% sure"), "100%25%20sure");
  assertStrictEquals(nameFragment("rate%25"), "rate%2525");
  assertStrictEquals(nameFragment("plain"), "plain");
  // An authored IRI keeps its escapes; a name never does.
  assertStrictEquals(escapeIriFragment("urn:cls:a%20b"), "urn:cls:a%20b");
  assertNotEquals(nameFragment("a%41"), nameFragment("aA"));
});

Deno.test("nameFragment encodes the rest of a NAME: brackets, #, ?, non-ucschar", () => {
  // Core's own `encode_name` doctest, verbatim (ledger #1361, #1390).
  assertStrictEquals(nameFragment("toUpper"), "toUpper");
  assertStrictEquals(nameFragment("naïve"), "naïve");
  assertStrictEquals(nameFragment("50% off"), "50%25%20off");
  // An id that is a full IRI with an IPv6 host: the brackets are encoded in a NAME.
  assertStrictEquals(nameFragment("http://[::1]/x"), "http://%5B::1%5D/x");
  // DEL, NEL, private use, a noncharacter: no IRI carries them raw.
  assertStrictEquals(nameFragment("a\u{7F}b\u{85}c"), "a%7Fb%C2%85c");
  assertStrictEquals(nameFragment("\u{E000}\u{FFFF}"), "%EE%80%80%EF%BF%BF");
  // A name is one path segment: `#` and `?` would start a fragment or a query.
  assertStrictEquals(nameFragment("a#b"), "a%23b");
  assertStrictEquals(nameFragment("a?b"), "a%3Fb");
  // An AUTHORED IRI keeps all of them (core's `escape_iri_fragment`).
  assertStrictEquals(escapeIriFragment("http://[::1]/cap"), "http://[::1]/cap");
  assertStrictEquals(escapeIriFragment("urn:x#y"), "urn:x#y");
  assertStrictEquals(escapeIriFragment("urn:x?y"), "urn:x?y");
});

/** Invert {@linkcode nameFragment} as core's `decode_segment` does. */
function decodeName(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === "%") {
      assertMatch(s.slice(i + 1, i + 3), /^[0-9A-Fa-f]{2}$/, s);
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const cp = s.codePointAt(i)!;
      bytes.push(...utf8.encode(String.fromCodePoint(cp)));
      i += cp > 0xffff ? 2 : 1;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

Deno.test("a NAME round-trips: encode_name is injective and inverts exactly", () => {
  // The item's two cases, plus one of each class a name escaper encodes.
  const names = [
    "http://[::1]/x",
    "a\u{85}b", // U+0085 NEL
    "plain",
    "50% off",
    "a%41",
    "a[0]",
    "del\u{7F} nel\u{85} pua\u{E000} nonchar\u{FDD0}\u{FFFF}",
    "a#b?c#d",
    "urn:ts:naïve 𝄞|x",
  ];
  const seen = new Set<string>();
  for (const name of names) {
    const encoded = nameFragment(name);
    assertStrictEquals(decodeName(encoded), name, name);
    // Injective: no two names share one spelling.
    assert(!seen.has(encoded), `${JSON.stringify(name)} collides`);
    seen.add(encoded);
    // And the encoded name is a path segment an IRI parser accepts.
    assert(
      isAbsoluteIri(`urn:ikigai:endpoint:${encoded}`),
      `urn:ikigai:endpoint:${encoded}`,
    );
  }
  // `%` stays encoded, so an escaped name and its unescaped twin stay apart.
  assertNotEquals(nameFragment("a%41"), nameFragment("aA"));
});

Deno.test("the bracket and NEL names round-trip through match and contract IRIs", () => {
  // A door pattern and an endpoint id are both NAMES: the match and contract
  // IRIs carry the encoded spelling, and core's `parse_match_iri` /
  // `parse_contract_iri` would give the name back (the vectors' `parses`
  // section pins those canonical spellings).
  assertStrictEquals(
    matchIri(Verb.Source, "http://[::1]/x"),
    "urn:ikigai:match:source:http://%5B::1%5D/x",
  );
  assertStrictEquals(
    matchIri(Verb.Source, "a\u{85}b"),
    "urn:ikigai:match:source:a%C2%85b",
  );
  const spec: ActionSpecModel = {
    verb: Verb.Source,
    summary: "",
    inputs: [],
    outputs: [],
    requires: [],
  };
  assert(
    contractIri("http://[::1]/x", spec).startsWith(
      "urn:ikigai:contract:http://%5B::1%5D/x:source:b3:",
    ),
  );
  assert(
    contractIri("a\u{85}b", spec).startsWith(
      "urn:ikigai:contract:a%C2%85b:source:b3:",
    ),
  );
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
