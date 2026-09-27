/**
 * A constrained RFC 6570 URI template — Level 1 `{var}` only — ported from
 * `ikigai_core::UriTemplate` (`ikigai-core/crates/ikigai-core/src/grammar.rs`,
 * `UriTemplate::parse` and `match_str`) so a family served from Deno
 * matches EXACTLY the IRIs the same pattern would match inside a Rust
 * kernel. Where the two could disagree, core wins and this file is the bug.
 *
 * The rule, as core states and implements it:
 *
 * - **Variable names** are one or more ASCII letters, digits or `_`
 *   (`{x}`, `{repo_id}`); anything else between the braces — including an
 *   empty `{}` — is refused at parse. A `{` with no closing `}` is refused.
 *   (A lone `}` is ordinary literal text, as in core.)
 * - **Literal text matches verbatim**, from the current position.
 * - **A variable followed by a literal captures up to the LEFTMOST next
 *   occurrence of that literal** — lazy, not greedy. `urn:r:{id}:data`
 *   against `urn:r:a:data:data` binds `id = "a"` and then fails, because
 *   `:data` is left over; no backtracking is attempted.
 * - **A final variable captures the whole remainder** — any characters,
 *   `:` and `/` included. `urn:ts:echo:{msg}` binds `msg = "a:b"` from
 *   `urn:ts:echo:a:b`.
 * - **Every capture is non-empty**: an empty run fails the match.
 * - **Adjacent variables** (`{a}{b}`) are refused at parse as ambiguous.
 * - The whole input must be consumed.
 * - Values are captured RAW: no percent-decoding, exactly like core.
 * - A variable named twice (`{a}:{a}`) is accepted, as core accepts it, and
 *   the LAST capture wins (core's `Bindings` is a map; `insert` overwrites).
 *
 * Two templates that could both match an IRI are not an error: the served
 * space tries its endpoints in DECLARATION ORDER and the first that matches
 * answers — `EndpointSpace`'s rule (bindings are tried in the order bound).
 *
 * ```ts
 * import { UriTemplate } from "@ikigai/wire/serve";
 * const t = UriTemplate.parse("urn:iki:tutorial:ttt:stored:{x}:{y}");
 * t.match("urn:iki:tutorial:ttt:stored:1:-2"); // { x: "1", y: "-2" }
 * t.match("urn:iki:tutorial:ttt:stored:1:");   // null (empty capture)
 * ```
 */

/** Refused template text — `ikigai_core::TemplateError`, same wording. */
export class TemplateError extends Error {
  constructor(detail: string) {
    super(`invalid URI template: ${detail}`);
    this.name = "TemplateError";
  }
}

type Part =
  | { readonly kind: "lit"; readonly text: string }
  | { readonly kind: "var"; readonly name: string };

const VAR_NAME = /^[A-Za-z0-9_]+$/;

export class UriTemplate {
  readonly source: string;
  readonly #parts: readonly Part[];

  private constructor(source: string, parts: Part[]) {
    this.source = source;
    this.#parts = parts;
  }

  /** Parse a template, refusing malformed or ambiguous forms. */
  static parse(template: string): UriTemplate {
    const parts: Part[] = [];
    let rest = template;
    let offset = 0;
    while (true) {
      const rel = rest.indexOf("{");
      if (rel < 0) break;
      const open = offset + rel;
      if (rel > 0) parts.push({ kind: "lit", text: rest.slice(0, rel) });
      const closeRel = rest.slice(rel).indexOf("}");
      if (closeRel < 0) {
        throw new TemplateError(`unclosed '{' in \`${template}\``);
      }
      const name = rest.slice(rel + 1, rel + closeRel);
      if (!VAR_NAME.test(name)) {
        throw new TemplateError(
          `invalid variable \`{${name}}\` in \`${template}\``,
        );
      }
      parts.push({ kind: "var", name });
      offset = open + closeRel + 1;
      rest = template.slice(offset);
    }
    if (rest.length > 0) parts.push({ kind: "lit", text: rest });
    for (let i = 0; i + 1 < parts.length; i++) {
      if (parts[i].kind === "var" && parts[i + 1].kind === "var") {
        throw new TemplateError(
          `adjacent variables are ambiguous in \`${template}\``,
        );
      }
    }
    return new UriTemplate(template, parts);
  }

  /** The variable names, in order of appearance. */
  get variables(): string[] {
    return this.#parts.flatMap((p) => p.kind === "var" ? [p.name] : []);
  }

  /** Whether this template has no variables (it matches one exact IRI). */
  get isExact(): boolean {
    return this.#parts.every((p) => p.kind === "lit");
  }

  /** Expand with the given bindings; `null` if a variable is missing. */
  expand(bindings: Readonly<Record<string, string>>): string | null {
    let out = "";
    for (const part of this.#parts) {
      if (part.kind === "lit") {
        out += part.text;
      } else {
        const value = bindings[part.name];
        if (value === undefined) return null;
        out += value;
      }
    }
    return out;
  }

  /** The captured bindings if `iri` matches, else `null`. */
  match(iri: string): Record<string, string> | null {
    const bindings: Record<string, string> = {};
    let pos = 0;
    for (let i = 0; i < this.#parts.length; i++) {
      const part = this.#parts[i];
      if (part.kind === "lit") {
        if (!iri.startsWith(part.text, pos)) return null;
        pos += part.text.length;
        continue;
      }
      const next = this.#parts[i + 1];
      if (next !== undefined && next.kind === "lit") {
        const idx = iri.indexOf(next.text, pos);
        if (idx < 0) return null;
        if (idx === pos) return null; // empty capture
        bindings[part.name] = iri.slice(pos, idx);
        pos = idx;
      } else {
        if (pos === iri.length) return null; // empty capture
        bindings[part.name] = iri.slice(pos);
        pos = iri.length;
      }
    }
    return pos === iri.length ? bindings : null;
  }

  toString(): string {
    return this.source;
  }
}
