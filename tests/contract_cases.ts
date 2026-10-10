/**
 * This package's own doors in the shared contract vectors, built through the
 * PUBLIC API. `contract_vectors.json` (a verbatim copy of ikigai-core's) carries
 * each as `deno/<name>`, with its JSON Meta face as `description`, and
 * `contract_test.ts` checks that these still build exactly those descriptions.
 *
 * Changing a door here means changing its `description` in core's
 * `crates/ikigai-vocab/tests/vectors/contract_cases.json`, regenerating there,
 * and copying the file back. Run as a script, this prints
 * `[{case, description}]`, the faces to paste.
 *
 * The cases cover every field core's canonical contract form feeds, plus the
 * places a TypeScript port could plausibly diverge: declaration order that
 * differs from core's sort order, duplicate set members, strings outside the
 * Basic Multilingual Plane (JavaScript's `<` orders UTF-16 code units, Rust's
 * orders UTF-8 bytes), multi-byte UTF-8 (length prefixes count bytes), and an
 * id that must be percent-encoded (injectively in the contract IRI, not in the
 * endpoint IRI).
 */

import { endpoint, family, type ServedDef } from "../src/serve.ts";

const XSD = "http://www.w3.org/2001/XMLSchema#";

export const CASES: Readonly<Record<string, () => ServedDef>> = {
  hello: () =>
    endpoint("urn:ts:hello", {
      summary: "Greet someone",
      args: [{ name: "who", required: true, class: `${XSD}string` }],
    }, () => ""),
  echo: () =>
    endpoint("urn:ts:echo:{msg}", {
      summary: "Echo the name",
      bindings: { msg: { summary: "what to say" } },
      args: [{ name: "suffix", default: "" }],
      cacheable: true,
    }, () => ""),
  guarded: () =>
    endpoint("urn:ts:guarded", {
      title: "Guarded",
      args: ["in", { name: "mode", oneOf: ["upper", "lower"] }],
      output: "text/plain",
      requires: ["urn:cap:ts:write", "urn:cap:ts:read", "legacy label"],
    }, () => ""),
  kv: () =>
    family("urn:ts:kv:{bucket}:{key}", {
      id: "kv",
      summary: "a key-value store",
      bindings: {
        bucket: { summary: "the bucket" },
        key: { summary: "the key", class: `${XSD}integer` },
      },
    })
      .source({ summary: "read it", cacheable: true }, () => "")
      .sink({ summary: "write it" }, () => "")
      .delete({ summary: "clear it" }, () => ""),
  edge: () =>
    family("urn:ts:edge:{b}:{a}", {
      id: "ev>il 100% naïve",
      summary: "every field the contract digest covers",
      bindings: { b: { summary: "bee" }, a: { summary: "ay" } },
    })
      .source({
        summary: "naïve — 𝄞 ｡",
        args: [
          { name: "zeta", summary: "last by name" },
          { name: "𝄞x", oneOf: ["｡", "𝄞", "b", "a", "b"] },
          { name: "｡x", default: "d" },
          { name: "Alpha", class: `${XSD}string` },
        ],
        output: "text/turtle",
        requires: ["urn:cap:z", "urn:cap:a", "urn:cap:z"],
      }, () => "")
      .exists({ requires: ["urn:cap:a"] }, () => true),
};

if (import.meta.main) {
  const out = Object.entries(CASES).map(([name, make]) => ({
    case: name,
    description: make().descriptionJson(),
  }));
  console.log(JSON.stringify(out));
}
