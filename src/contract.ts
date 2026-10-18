/**
 * The two identities an action has (core's `contract` module, ledger #948):
 * the **match**, one per door and verb, and the **contract** it satisfies,
 * content-addressed.
 *
 * - A **match IRI** names one row of a kernel's action manifold, a door and a
 *   verb: `urn:ikigai:match:{verb}:{pattern}`.
 * - A **contract IRI** names one verb's contract by its content:
 *   `urn:ikigai:contract:{id}:{verb}:b3:{hex}`. Identical contracts share a
 *   node and different ones never do. It is the `ik:Action` node of this
 *   peer's Turtle Meta face, and the IRI a Rust host's manifold joins to with
 *   `ik:contract`, so the digest must be core's to the byte: it is BLAKE3
 *   (core's own algorithm, through `jsr:@std/crypto`, which compiles the same
 *   Rust `blake3` crate to Wasm) over core's prefix-free canonical form,
 *   pinned by `tests/contract_test.ts` against vectors a Rust build of core
 *   produced.
 *
 * Both encode their variable segments with core's **name** encoding
 * (`encode_name`): an injective percent-encoding (`%` itself is encoded) of
 * the `IRIREF` set, `[` and `]`, `#` and `?`, and every non-`ucschar` code
 * point, so each IRI parses back to exactly what made it — and parses as an
 * IRI whatever the name holds.
 *
 * ```ts
 * import { contractIri, matchIri, Verb } from "@ikigai/wire";
 *
 * matchIri(Verb.Source, "urn:file:{path}");
 * // "urn:ikigai:match:source:urn:file:%7Bpath%7D"
 * contractIri("toUpper", {
 *   verb: Verb.Source,
 *   summary: "",
 *   inputs: [],
 *   outputs: ["text/plain"],
 *   requires: [],
 * }); // "urn:ikigai:contract:toUpper:source:b3:…" (64 hex digits)
 * ```
 *
 * @module
 */

import { crypto } from "@std/crypto/crypto";
import { type Verb, verbName } from "./wire.ts";
import type { ActionSpecModel, ArgSpec, InputGroup } from "./serve.ts";

/** The prefix of every match IRI: `urn:ikigai:match:{verb}:{pattern}`. */
export const MATCH_PREFIX = "urn:ikigai:match:";

/**
 * The prefix of every content-addressed contract IRI:
 * `urn:ikigai:contract:{id}:{verb}:b3:{hex}`.
 */
export const CONTRACT_PREFIX = "urn:ikigai:contract:";

/** The domain tag that opens core's canonical form (`ikigai:contract:v1`). */
const CONTRACT_FORM = "ikigai:contract:v1";

/** The second form's tag (ledger #1547), chosen by content: see {@linkcode contractId}. */
const CONTRACT_FORM_V2 = "ikigai:contract:v2";

const utf8 = new TextEncoder();

/** A Turtle `IRIREF` cannot carry these (core's `is_iri_forbidden`). */
function isIriForbidden(cp: number): boolean {
  return cp <= 0x20 || '<>"{}|^`\\'.includes(String.fromCodePoint(cp));
}

function percentEncode(s: string, encode: (cp: number) => boolean): string {
  let out = "";
  for (const ch of s) {
    if (encode(ch.codePointAt(0)!)) {
      for (const byte of utf8.encode(ch)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Core's `escape_iri_fragment`: percent-encode exactly what a Turtle
 * `IRIREF` cannot carry, leaving `%` alone (so it is NOT injective). Used for
 * an AUTHORED IRI (a `class`, a capability scope), whose escapes are real, as
 * `ikigai_vocab`'s `iri_term` does; a NAME goes through {@linkcode nameFragment}.
 *
 * `[`, `]`, `#` and `?` stay too (ledger #1361, #1390): they are legal in an
 * authored IRI (an IPv6 host, a fragment, a query) and encoding them would
 * change it. Only a NAME encodes them.
 */
export function escapeIriFragment(s: string): string {
  return percentEncode(s, isIriForbidden);
}

/**
 * Whether `cp` is a code point the IRI grammar (RFC 3987) does not admit in a
 * path segment although a Turtle `IRIREF` carries it: DEL, and every
 * non-ASCII code point that is not a `ucschar` (the C1 controls, private use,
 * the noncharacters, the specials block, and the tags and variation-selector
 * plane E0000 to E0FFF). Core's `is_non_ucschar` (ledger #1351).
 */
function isNonUcschar(cp: number): boolean {
  if (cp < 0x80) return cp === 0x7f;
  // RFC 3987 `ucschar`; a JS string iterated by code point has no surrogate
  // pair to split, so the D800-DFFF gap needs no arm.
  const inBmp = (cp >= 0xa0 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfdcf) ||
    (cp >= 0xfdf0 && cp <= 0xffef);
  // Planes 1 to 14, less each plane's last two code points (noncharacters)
  // and E0000 to E0FFF; planes 15 and 16 are private use.
  const aboveBmp = cp >= 0x10000 && cp <= 0xefffd &&
    (cp & 0xffff) <= 0xfffd &&
    !(cp >= 0xe0000 && cp <= 0xe0fff);
  return !(inBmp || aboveBmp);
}

/**
 * Core's `encode_name`'s `must_encode`: whether a character must be
 * percent-encoded in a NAME. `%` itself (so the encoding is injective),
 * everything a Turtle `IRIREF` cannot carry, `[` and `]` (an IRI admits them
 * only around an IP-literal host, never in the path a name lands in), `#` and
 * `?` (a name is ONE path segment, and either would end the path there and
 * move the rest of the name into a fragment or a query), and every code point
 * the IRI grammar refuses although an `IRIREF` carries it
 * ({@linkcode isNonUcschar}).
 */
function mustEncodeName(cp: number): boolean {
  return cp === 0x25 || cp === 0x23 || cp === 0x3f || cp === 0x5b ||
    cp === 0x5d || isIriForbidden(cp) || isNonUcschar(cp);
}

/**
 * Core's `encode_name` (`ikigai_vocab::name_fragment`): percent-encode a NAME
 * (an endpoint id, an input name, a door pattern) for an IRI position,
 * injectively — `%` as `%25`, the `IRIREF` set, `[` and `]`, `#` and `?`, and
 * every non-`ucschar` code point. A name is not an authored IRI, so a `%` in
 * it is a character, never the start of an escape: left alone, `100% sure`
 * emitted `100%%20sure`, which no parser accepts, and the whole Turtle Meta
 * document was refused (ledger #1345). The brackets and the non-`ucschar` code
 * points are what no IRI can carry (ledger #1361); `#` and `?` would end the
 * one path segment a name is (ledger #1390). The endpoint and input nodes are
 * then spelled as a contract IRI spells the id, and the encoding is
 * injective: `a%41` and `aA` stay apart.
 *
 * Not exported from the package: core's is public, but nothing here takes a
 * name from a caller.
 */
export function nameFragment(s: string): string {
  return percentEncode(s, mustEncodeName);
}

/** A verb's lower-case name, as the IRIs spell it. */
function verbSegment(verb: Verb): string {
  return verbName(verb).toLowerCase();
}

/**
 * The match IRI of one door and verb: `urn:ikigai:match:{verb}:{pattern}`,
 * the pattern percent-encoded as core encodes a NAME (a template's braces
 * become `%7B`/`%7D`, and a `[`, a `#` or a non-`ucschar` code point is
 * encoded too). Mirrors core's `match_iri`.
 */
export function matchIri(verb: Verb, pattern: string): string {
  return `${MATCH_PREFIX}${verbSegment(verb)}:${nameFragment(pattern)}`;
}

/**
 * A group's node segment under its owner's IRI (core's
 * `InputGroup::node_segment`): `group:{kind}:{m1},{m2}`, each member a NAME
 * with `,` encoded too, the members sorted and deduplicated.
 */
export function groupSegment(group: InputGroup): string {
  const members = sortedSet(
    group.members.map((m) => nameFragment(m).replaceAll(",", "%2C")),
  );
  return `group:${group.kind}:${members.join(",")}`;
}

/**
 * Rust's `Ord` for `String`: byte-wise over UTF-8, which is code-point order.
 * JavaScript's `<` compares UTF-16 code units and disagrees above U+FFFF
 * (a surrogate pair sorts below U+E000..U+FFFF), so it cannot be used here.
 */
function compareStr(a: string, b: string): number {
  if (a === b) return 0;
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/** `Option<String>`'s `Ord`: `None` before every `Some`. */
function compareOpt(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    return (a === null ? 0 : 1) - (b === null ? 0 : 1);
  }
  return compareStr(a, b);
}

/** `Vec<String>`'s `Ord`: lexicographic, a prefix before its extensions. */
function compareList(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareStr(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Sorted by Rust's string order, then adjacent duplicates dropped. */
function sortedSet(values: readonly string[]): string[] {
  const sorted = [...values].sort(compareStr);
  return sorted.filter((v, i) => i === 0 || v !== sorted[i - 1]);
}

/** One input in core's canonical form: `one_of` sorted and deduplicated. */
interface CanonicalInput {
  readonly name: string;
  readonly summary: string;
  readonly required: boolean;
  readonly binding: boolean;
  readonly cls: string | null;
  readonly default: string | null;
  readonly oneOf: readonly string[];
}

/** Core's `input_key` order: name, summary, required, source, class, default, one_of. */
function compareInput(a: CanonicalInput, b: CanonicalInput): number {
  return compareStr(a.name, b.name) ||
    compareStr(a.summary, b.summary) ||
    Number(a.required) - Number(b.required) ||
    Number(a.binding) - Number(b.binding) ||
    compareOpt(a.cls, b.cls) ||
    compareOpt(a.default, b.default) ||
    compareList(a.oneOf, b.oneOf);
}

/** Rust's `Ord` for `Vec<u8>`. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Core's `crate::hashing`: every variable-length field length-prefixed. */
class Canonical {
  #chunks: Uint8Array[] = [];

  u8(v: number): void {
    this.#chunks.push(Uint8Array.of(v));
  }

  u64(v: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this.#chunks.push(b);
  }

  str(s: string): void {
    const bytes = utf8.encode(s);
    this.u64(bytes.length);
    this.#chunks.push(bytes);
  }

  opt(v: string | null): void {
    if (v === null) {
      this.u8(0);
    } else {
      this.u8(1);
      this.str(v);
    }
  }

  set(values: readonly string[]): void {
    const sorted = sortedSet(values);
    this.u64(sorted.length);
    for (const v of sorted) this.str(v);
  }

  /** A set of separately encoded items: sorted bytewise, deduplicated, counted, each length-prefixed. */
  items(items: readonly Canonical[]): void {
    const encoded = items.map((i) => i.bytes()).sort(compareBytes)
      .filter((x, i, all) => i === 0 || compareBytes(x, all[i - 1]) !== 0);
    this.u64(encoded.length);
    for (const item of encoded) {
      this.u64(item.length);
      this.#chunks.push(item);
    }
  }

  /** Everything fed, concatenated. */
  bytes(): Uint8Array<ArrayBuffer> {
    const total = this.#chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of this.#chunks) {
      all.set(c, at);
      at += c.length;
    }
    return all;
  }

  /** The BLAKE3 digest of everything fed, as lower-case hex. */
  digestHex(): string {
    const all = this.bytes();
    const digest = new Uint8Array(crypto.subtle.digestSync("BLAKE3", all));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}

function canonicalInput(input: ArgSpec): CanonicalInput {
  return {
    name: input.name,
    summary: input.summary,
    required: input.required,
    binding: input.source === "binding",
    cls: input.cls,
    default: input.default,
    oneOf: sortedSet(input.oneOf),
  };
}

/**
 * One verb's contract, content-addressed: `b3:{hex}`, the digest a contract
 * IRI carries. Mirrors core's `ActionSpec::contract_id` exactly: BLAKE3 over
 * the domain tag `ikigai:contract:v1`, the endpoint id, the verb's lower-case
 * name, the summary, the inputs **sorted** (by name, then every other field)
 * and deduplicated (each with its `one_of` sorted and deduplicated), the
 * outputs and the required scopes, each sorted and deduplicated. So the
 * order a contract was declared in never changes its identity, and the
 * endpoint id is part of it.
 *
 * **Two forms, chosen by content** (ledger #1547). A contract that uses a
 * construct v1 cannot carry (an input's `needs`, `list`, value notes,
 * examples or empty enumeration, a group, an open or envelope argument set,
 * `output_from`) is digested under `ikigai:contract:v2` instead (core's
 * `contract_id_v2`; the byte layout is in core's `tests/vectors/README.md`);
 * every other contract keeps its v1 digest, so no existing IRI moves.
 */
export function contractId(endpointId: string, spec: ActionSpecModel): string {
  if (usesV2(spec)) return contractIdV2(endpointId, spec);
  const h = new Canonical();
  h.str(CONTRACT_FORM);
  h.str(endpointId);
  h.str(verbSegment(spec.verb));
  h.str(spec.summary);
  const inputs = spec.inputs.map(canonicalInput).sort(compareInput)
    .filter((x, i, all) => i === 0 || compareInput(x, all[i - 1]) !== 0);
  h.u64(inputs.length);
  for (const input of inputs) {
    h.str(input.name);
    h.str(input.summary);
    h.u8(input.required ? 1 : 0);
    h.u8(input.binding ? 1 : 0);
    h.opt(input.cls);
    h.opt(input.default);
    h.set(input.oneOf);
  }
  h.set(spec.outputs);
  h.set(spec.requires);
  return `b3:${h.digestHex()}`;
}

/** Whether a contract uses a construct only the v2 form carries (core's `uses_v2`). */
function usesV2(spec: ActionSpecModel): boolean {
  return (spec.groups?.length ?? 0) > 0 || spec.arguments !== undefined ||
    spec.outputFrom !== undefined ||
    spec.inputs.some((i) =>
      i.needs.length > 0 || i.list !== null || i.values.size > 0 ||
      i.examples.length > 0 || (i.enumerated && i.oneOf.length === 0)
    );
}

/** One input in the v2 form: v1's fields, then the input-level additions. */
function inputV2(input: ArgSpec): Canonical {
  const c = new Canonical();
  c.str(input.name);
  c.str(input.summary);
  c.u8(input.required ? 1 : 0);
  c.u8(input.source === "binding" ? 1 : 0);
  c.opt(input.cls);
  c.opt(input.default);
  c.set(input.oneOf);
  c.set(input.needs);
  c.opt(input.list);
  c.u64(input.values.size);
  for (const [value, note] of input.values) {
    c.str(value);
    c.str(note.summary);
    c.set(note.tags);
    c.set(note.needs);
  }
  c.u8(input.enumerated && input.oneOf.length === 0 ? 1 : 0);
  c.set(input.examples);
  return c;
}

/** One group in the v2 form: its kind word, member set and pipe member. */
function groupV2(group: InputGroup): Canonical {
  const c = new Canonical();
  c.str(group.kind);
  c.set(group.members);
  c.opt(group.pipe ?? null);
  return c;
}

/** The v2 canonical form (core's `contract_id_v2`). */
function contractIdV2(endpointId: string, spec: ActionSpecModel): string {
  const h = new Canonical();
  h.str(CONTRACT_FORM_V2);
  h.str(endpointId);
  h.str(verbSegment(spec.verb));
  h.str(spec.summary);
  h.items(spec.inputs.map(inputV2));
  h.set(spec.outputs);
  h.set(spec.requires);
  h.items((spec.groups ?? []).map(groupV2));
  const args = spec.arguments;
  if (args === undefined) {
    h.u8(0);
  } else if ("open" in args) {
    h.u8(1);
    h.str(args.open);
  } else {
    h.u8(2);
    h.str(args.envelope);
  }
  const from = spec.outputFrom;
  if (from === undefined) {
    h.u8(0);
  } else if (from === "origin") {
    h.u8(2);
  } else {
    h.u8(1);
    h.str(from.input);
  }
  return `b3:${h.digestHex()}`;
}

/**
 * One verb's contract IRI, `urn:ikigai:contract:{id}:{verb}:b3:{hex}`, the
 * digest being {@linkcode contractId}. Mirrors core's
 * `ActionSpec::contract_iri`: the node `ikigai_vocab::to_turtle` gives each
 * `ik:Action`, and what a manifold row's `ik:contract` points at.
 */
export function contractIri(endpointId: string, spec: ActionSpecModel): string {
  return `${CONTRACT_PREFIX}${nameFragment(endpointId)}:` +
    `${verbSegment(spec.verb)}:${contractId(endpointId, spec)}`;
}
