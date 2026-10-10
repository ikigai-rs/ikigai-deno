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
 * Both encode their variable segments with an **injective** percent-encoding
 * (`%` itself is encoded), so each IRI parses back to exactly what made it.
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
import type { ActionSpecModel, ArgSpec } from "./serve.ts";

/** The prefix of every match IRI: `urn:ikigai:match:{verb}:{pattern}`. */
export const MATCH_PREFIX = "urn:ikigai:match:";

/**
 * The prefix of every content-addressed contract IRI:
 * `urn:ikigai:contract:{id}:{verb}:b3:{hex}`.
 */
export const CONTRACT_PREFIX = "urn:ikigai:contract:";

/** The domain tag that opens core's canonical form (`ikigai:contract:v1`). */
const CONTRACT_FORM = "ikigai:contract:v1";

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
 * the endpoint and input node IRIs, as `ikigai_vocab::to_turtle` does.
 */
export function escapeIriFragment(s: string): string {
  return percentEncode(s, isIriForbidden);
}

/** Core's injective segment encoding: `%` too, plus the `IRIREF` set. */
function encodeSegment(s: string): string {
  return percentEncode(s, (cp) => cp === 0x25 || isIriForbidden(cp));
}

/** A verb's lower-case name, as the IRIs spell it. */
function verbSegment(verb: Verb): string {
  return verbName(verb).toLowerCase();
}

/**
 * The match IRI of one door and verb: `urn:ikigai:match:{verb}:{pattern}`,
 * the pattern percent-encoded injectively (a template's braces become
 * `%7B`/`%7D`). Mirrors core's `match_iri`.
 */
export function matchIri(verb: Verb, pattern: string): string {
  return `${MATCH_PREFIX}${verbSegment(verb)}:${encodeSegment(pattern)}`;
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

  /** The BLAKE3 digest of everything fed, as lower-case hex. */
  digestHex(): string {
    const total = this.#chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of this.#chunks) {
      all.set(c, at);
      at += c.length;
    }
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
 */
export function contractId(endpointId: string, spec: ActionSpecModel): string {
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

/**
 * One verb's contract IRI, `urn:ikigai:contract:{id}:{verb}:b3:{hex}`, the
 * digest being {@linkcode contractId}. Mirrors core's
 * `ActionSpec::contract_iri`: the node `ikigai_vocab::to_turtle` gives each
 * `ik:Action`, and what a manifold row's `ik:contract` points at.
 */
export function contractIri(endpointId: string, spec: ActionSpecModel): string {
  return `${CONTRACT_PREFIX}${encodeSegment(endpointId)}:` +
    `${verbSegment(spec.verb)}:${contractId(endpointId, spec)}`;
}
