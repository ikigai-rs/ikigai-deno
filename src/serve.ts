/**
 * Serve TypeScript functions as ikigai resources over a Unix socket.
 *
 * The peer-module seed: a Rust host mounts this server
 * (`ikigai --mount urn:ts:=<socket>`) and the functions join its resolution
 * space — listed in the catalog with their origin, named-arg routed via
 * their declared ArgSpecs, invoked over the wire:
 *
 * ```ts
 * import { endpoint, serve } from "@ikigai/wire/serve";
 *
 * const hello = endpoint("urn:ts:hello", {
 *   summary: "Greet someone",
 *   args: [{ name: "who", required: true,
 *            class: "http://www.w3.org/2001/XMLSchema#string" }],
 * }, ({ who }) => `Hello, ${who}!`);
 *
 * await serve([hello], "/tmp/ts.sock"); // blocks
 * ```
 *
 * **Families and verbs.** A door may be a URI TEMPLATE
 * (`urn:ts:stored:{x}:{y}` — see {@linkcode UriTemplate} for the matching
 * rule, which is core's) answering every IRI it matches, with each
 * variable handed to the handler by name; and it may answer several verbs,
 * each with its own contract ({@linkcode family}):
 *
 * ```ts
 * import { family } from "@ikigai/wire/serve";
 *
 * const marks = new Map<string, string>();
 * const cell = family("urn:ts:stored:{x}:{y}", { id: "stored" })
 *   .source({ cacheable: true }, ({ x, y }) => marks.get(`${x},${y}`) ?? "-")
 *   .sink({}, ({ x, y, content }) => (marks.set(`${x},${y}`, `${content}`), "ok"))
 *   .delete({}, ({ x, y }) => (marks.delete(`${x},${y}`), "ok"));
 * ```
 *
 * **Alias mounts strip the prefix.** `--mount urn:ts:=<socket>` rewrites
 * `urn:ts:hello` to `urn:hello` before forwarding, and re-prefixes catalog
 * patterns coming back. This server therefore answers BOTH the declared IRI
 * and its alias-stripped form — for a template, both the declared template
 * and its stripped form. Every door's declared form is tried before any
 * door's stripped form (reversed on an alias-mode connection), so a stripped
 * form never swallows a declared name — see {@linkcode Space}. Since wire v6 the client's hello says which form
 * its `entries` wants, per connection — and since v7 the hello is REQUIRED
 * (a first frame without it is refused), so every served connection's form
 * is known, never guessed.
 *
 * **Failures cross typed** (wire v7): an unknown IRI is a real `Unresolved`,
 * a missing required argument a `MissingArgument`, a zod validation failure
 * an `InvalidArgument` naming the field, a handler throw an `Endpoint` — and
 * a handler may throw the typed classes (`NotFoundError`, `DeniedError`,
 * `TimeoutError`, `UnavailableError`, `ConflictError`, …) to cross as that
 * variant, so a Deno peer can answer a real 404-equivalent the host
 * recognizes without message sniffing. A `ConflictError` (wire v8) reaches a
 * v7 host as the `Endpoint` text `conflict: {msg}` — what a v7 kernel sends
 * for the same error — because that host cannot decode variant 8.
 *
 * **Security posture**: the socket is `0600` in a `0700` directory. Deno
 * exposes no SO_PEERCRED / LOCAL_PEERCRED equivalent, so unlike the Rust and
 * Python servers this one CANNOT verify the connecting peer's UID — the
 * socket file's `0600` mode is the whole gate (the kernel enforces it on
 * `connect`, on both Linux and macOS). That is a real, honest difference; do
 * not serve on a path whose parent directory other users can traverse.
 *
 * **The capability floor is enforced here, on every call** (core's
 * declared-capability floor, ported): a capability carried on
 * `IssueAs`/`IssueTraced` must satisfy every scope the door declares for the
 * verb (`requires`, per verb when declared per verb, flat otherwise), or the
 * call is refused as a typed `Denied` before the handler runs — so a host
 * that forwards a caller's capability can rely on this peer running its own
 * floor. A plain `Issue` carries no capability and resolves under root, as
 * the Rust IPC door does for its owner. See {@linkcode Space.dispatch}.
 *
 * @module
 */

import * as wire from "./wire.ts";
import {
  CacheStatus,
  Expiry,
  type FailureClass,
  FrameStream,
  InvalidArgumentError,
  type Reply,
  Representation,
  type Request,
  type SpaceEntry,
  spaceEntry,
  toWireFailure,
  type TraceEvent,
  Verb,
  verbName,
} from "./wire.ts";
import { UriTemplate } from "./template.ts";
import {
  contractIri,
  escapeIriFragment,
  groupSegment,
  nameFragment,
} from "./contract.ts";
import { isAbsoluteIri } from "./iri.ts";

export { TemplateError, UriTemplate } from "./template.ts";
export { checkAction, GIVEN_TWICE } from "./check.ts";
export type { ProposedArgs, Violation, ViolationKind } from "./check.ts";

/** The `ik:` vocabulary namespace the Turtle Meta face writes against. */
export const VOCAB_NS = "https://ikigai-rs.dev/ns#";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Where an input's value comes from (`ikigai_core::InputSource`): a by-value
 * argument sent with the request, or a variable captured from the IRI by
 * the door's template.
 */
export type InputSource = "argument" | "binding";

/** The spec-object form an argument declaration may take. */
export interface ArgSpecInput {
  /** The argument's name: the `key` a caller writes as `key=value`. */
  name: string;
  /** One line on what the argument is for. */
  summary?: string;
  /**
   * Defaults to `true`, but is forced to `false` whenever `default` is set
   * (as in Rust): an argument with a default is never required.
   */
  required?: boolean;
  /** rdfs:Class IRI for entities, XSD datatype IRI for scalars. */
  class?: string;
  /** The value the handler receives when the caller sends none. */
  default?: string;
  /**
   * The allowed values, when the argument is an enumeration. An EMPTY list is
   * meaningful: the input accepts no value (core's `"one_of": []`); leave
   * `oneOf` out for an open-valued input.
   */
  oneOf?: string[];
  /** `"argument"` (the default) or `"binding"`. */
  source?: InputSource;
  /** Example values, each one the contract itself accepts. */
  examples?: string[];
  /** The inputs that must be given whenever this one is. */
  needs?: string[];
  /** The separator of a list-valued argument (one value, many items). */
  list?: ListSeparator;
  /** What particular `oneOf` values mean, keyed by value. */
  values?: Record<string, ValueNoteInput>;
}

/** How a list-valued argument's items are separated in its one value. */
export type ListSeparator =
  | "comma"
  | "whitespace"
  | "comma-or-whitespace"
  | "newline";

/** What one `oneOf` value means (`ikigai_core::ValueNote`), as declared. */
export interface ValueNoteInput {
  /** What the value means. */
  summary?: string;
  /** Producer-owned tags. */
  tags?: string[];
  /** Inputs that must be given when this value is. */
  needs?: string[];
}

/** What one `oneOf` value means (`ikigai_core::ValueNote`). */
export interface ValueNote {
  /** What the value means; `""` when none was given. */
  readonly summary: string;
  /** Producer-owned tags. */
  readonly tags: readonly string[];
  /** Inputs that must be given when this value is. */
  readonly needs: readonly string[];
}

/** How an input group relates its members (`ikigai_core::GroupKind`). */
export type GroupKind = "exactly-one" | "at-least-one" | "at-most-one";

/** A relation between an action's inputs (`ikigai_core::InputGroup`). */
export interface InputGroup {
  /** How the members relate. */
  readonly kind: GroupKind;
  /** The member input names, a set. */
  readonly members: readonly string[];
  /** The member a pipe fills when none is named. */
  readonly pipe?: string;
}

/**
 * The names an action takes beyond its declared inputs
 * (`ikigai_core::Arguments`); absent means closed. The serde shape:
 * `{ open: "what the others mean" }` or `{ envelope: "carrier" }`.
 */
export type ArgumentSet = { readonly open: string } | {
  readonly envelope: string;
};

/**
 * Where an action's output type comes from when it is a pass-through
 * (`ikigai_core::OutputFrom`): `{ input: name }` or `"origin"`.
 */
export type OutputFrom = { readonly input: string } | "origin";

/**
 * One named input, mirroring `ikigai_core::ArgSpec`. The describe face built
 * from these is what the host engine routes named arguments by — the names
 * and required/optional flags are load-bearing, not decoration.
 */
export class ArgSpec {
  /** The argument's name. */
  readonly name: string;
  /** Its one-line summary; `""` when none was given. */
  readonly summary: string;
  /** Whether a call must send it; always `false` when it has a default. */
  readonly required: boolean;
  /** Its `class` IRI, or `null`; serialized as `class`. */
  readonly cls: string | null;
  /** Its default value, or `null` for none. */
  readonly default: string | null;
  /** Its allowed values; empty when it is not an enumeration. */
  readonly oneOf: readonly string[];
  /** Whether the value is sent as an argument or bound from the IRI. */
  readonly source: InputSource;
  /**
   * Whether it declares an enumeration at all, so an empty `oneOf` means
   * "accepts no value" rather than "open-valued".
   */
  readonly enumerated: boolean;
  /** Example values the contract accepts. */
  readonly examples: readonly string[];
  /** The inputs that must be given whenever this one is. */
  readonly needs: readonly string[];
  /** Its list separator, or `null` for a single-valued input. */
  readonly list: ListSeparator | null;
  /** What particular `oneOf` values mean, in value (UTF-8 byte) order. */
  readonly values: ReadonlyMap<string, ValueNote>;

  /**
   * From a bare name (a required `argument` with no summary), a spec object,
   * or another `ArgSpec` (copied as is). A spec object with a `default` is
   * optional even when it says `required: true`.
   */
  constructor(spec: string | ArgSpecInput | ArgSpec) {
    if (spec instanceof ArgSpec) {
      this.name = spec.name;
      this.summary = spec.summary;
      this.required = spec.required;
      this.cls = spec.cls;
      this.default = spec.default;
      this.oneOf = spec.oneOf;
      this.source = spec.source;
      this.enumerated = spec.enumerated;
      this.examples = spec.examples;
      this.needs = spec.needs;
      this.list = spec.list;
      this.values = spec.values;
      return;
    }
    const input: ArgSpecInput = typeof spec === "string"
      ? { name: spec }
      : spec;
    this.name = input.name;
    this.summary = input.summary ?? "";
    // A declared default implies the argument is optional (as in Rust).
    this.required = input.default === undefined
      ? (input.required ?? true)
      : false;
    this.cls = input.class ?? null;
    this.default = input.default ?? null;
    this.oneOf = [...(input.oneOf ?? [])];
    this.enumerated = input.oneOf !== undefined || this.oneOf.length > 0;
    this.source = input.source ?? "argument";
    this.examples = [...(input.examples ?? [])];
    this.needs = [...(input.needs ?? [])];
    this.list = input.list ?? null;
    const notes = input.values ?? {};
    this.values = new Map(
      wire.sortedUtf8(Object.keys(notes)).map((value) => [value, {
        summary: notes[value].summary ?? "",
        tags: [...(notes[value].tags ?? [])],
        needs: [...(notes[value].needs ?? [])],
      }]),
    );
  }

  /**
   * The serde shape of `ikigai_core::ArgSpec` (fields with
   * `skip_serializing_if` omitted when unset, like the Rust side).
   */
  toJson(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      summary: this.summary,
      required: this.required,
      source: this.source,
    };
    if (this.cls !== null) out["class"] = this.cls;
    if (this.default !== null) out["default"] = this.default;
    if (this.enumerated) out["one_of"] = [...this.oneOf];
    if (this.examples.length > 0) out["examples"] = [...this.examples];
    if (this.needs.length > 0) out["needs"] = [...this.needs];
    if (this.list !== null) out["list"] = this.list;
    if (this.values.size > 0) {
      const values: Record<string, unknown> = {};
      for (const [value, note] of this.values) {
        const json: Record<string, unknown> = {};
        if (note.summary) json["summary"] = note.summary;
        if (note.tags.length > 0) json["tags"] = [...note.tags];
        if (note.needs.length > 0) json["needs"] = [...note.needs];
        values[value] = json;
      }
      out["values"] = values;
    }
    return out;
  }
}

/**
 * How a template variable is described: its summary and class. The
 * variable itself is always a REQUIRED `binding` input — its value is part
 * of the IRI, so it is never absent and has no default.
 */
export interface BindingSpecInput {
  /** One line on what the variable names. */
  summary?: string;
  /** rdfs:Class IRI for entities, XSD datatype IRI for scalars. */
  class?: string;
}

/** What a handler may return (optionally wrapped in a Promise). */
export type HandlerResult =
  | string
  | Uint8Array
  | [string | Uint8Array, string]
  | Representation;

/**
 * Arguments arrive utf-8 decoded (bytes when not valid utf-8); template
 * variables arrive as the captured strings, under their own names.
 */
export type HandlerArgs = Record<string, string | Uint8Array>;

/**
 * What the caller's run carries to a handler (wire v9 `IssueWith`), the way
 * the Rust `Invocation` exposes it. A peer that sends none gets
 * {@linkcode NO_RUN}: no budget, no deadline.
 */
export interface RunContext {
  /** The retry budget remaining (the pool), or `null` when none was sent. */
  readonly retriesLeft: number | null;
  /**
   * The run's deadline as an instant on THIS process's clock (ms since the
   * Unix epoch): the server's own now when the call arrived plus the time
   * left the peer sent. `null` when none was sent.
   */
  readonly deadline: number | null;
  /** Milliseconds left until {@linkcode RunContext.deadline}, floored at 0. */
  timeLeftMs(): number | null;
}

/** Build the run context of a call that arrived at `now` (ms since epoch). */
export function runContext(
  retries: number | null,
  timeLeftMs: number | null,
  now: number = Date.now(),
): RunContext {
  const deadline = timeLeftMs === null ? null : now + timeLeftMs;
  return {
    retriesLeft: retries,
    deadline,
    timeLeftMs: () =>
      deadline === null ? null : Math.max(0, deadline - Date.now()),
  };
}

/** The run context of a call that carried none. */
export const NO_RUN: RunContext = runContext(null, null);

/**
 * The function behind a verb. A thrown typed error (`NotFoundError`,
 * `DeniedError`, …) crosses the wire as that variant; anything else thrown
 * crosses as an `Endpoint` failure with its message. A string or bytes
 * result is sent with the declared output media type, a
 * `[value, mediaType]` pair with its own, and a `Representation` as built,
 * except that a Sink or Delete answer is always made uncacheable.
 */
export type Handler = (
  args: HandlerArgs,
  run: RunContext,
) => HandlerResult | Promise<HandlerResult>;

/** An explicit Exists answers yes or no. */
export type ExistsHandler = (
  args: HandlerArgs,
  run: RunContext,
) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// The description model and its three faces
// ---------------------------------------------------------------------------

/** `ikigai_core::ActionSpec`: one verb's contract. */
export interface ActionSpecModel {
  /** The verb this contract is for (never Meta). */
  readonly verb: Verb;
  /** What the verb does here; `""` when undeclared. */
  readonly summary: string;
  /**
   * ALL of this verb's inputs: an explicit action inherits nothing from the
   * flat fields, so the template's bindings are listed here too.
   */
  readonly inputs: readonly ArgSpec[];
  /** The media types the verb answers with. */
  readonly outputs: readonly string[];
  /**
   * The capability scopes the verb requires. Declared here, they REPLACE
   * the flat `requires` for this verb rather than adding to it.
   */
  readonly requires: readonly string[];
  /** Relations between this verb's inputs; none when absent. */
  readonly groups?: readonly InputGroup[];
  /** The names it takes beyond its inputs; closed when absent. */
  readonly arguments?: ArgumentSet;
  /** Where its output type comes from, when it is a pass-through. */
  readonly outputFrom?: OutputFrom;
  /**
   * The failure classes it states it may answer with, in declaration order
   * (core 0.1.108). Absent says nothing; `[]` says "only the implied
   * classes", which is stated and so moves the contract's digest.
   */
  readonly failures?: readonly FailureClass[];
  /** Whether this contract hides resource existence on refusal; false when absent. */
  readonly existenceSensitive?: boolean;
}

/** `ikigai_core::Description`, the fields this peer emits. */
export interface DescriptionModel {
  /** The endpoint's id: the name its catalog entries point at. */
  readonly id: string;
  /** A short human title; `""` when none was given. */
  readonly title: string;
  /** One line on what the endpoint does; `""` when none was given. */
  readonly summary: string;
  /** The verbs it answers, Meta included. */
  readonly verbs: readonly Verb[];
  /**
   * The flat inputs, which apply to every verb with no explicit action;
   * empty for a {@linkcode Family}, whose inputs live on its actions.
   */
  readonly inputs: readonly ArgSpec[];
  /** The flat output media types; empty for a {@linkcode Family}. */
  readonly outputs: readonly string[];
  /** The flat required capability scopes; empty for a {@linkcode Family}. */
  readonly requires: readonly string[];
  /** Explicit per-verb contracts; empty for the flat single-verb form. */
  readonly actions: readonly ActionSpecModel[];
  /** Relations between the flat inputs; none when absent. */
  readonly groups?: readonly InputGroup[];
  /** The names the flat form takes beyond its inputs; closed when absent. */
  readonly arguments?: ArgumentSet;
  /** Where the flat form's output type comes from. */
  readonly outputFrom?: OutputFrom;
  /** The failure classes the flat form states; see {@linkcode ActionSpecModel.failures}. */
  readonly failures?: readonly FailureClass[];
  /** Whether this contract hides resource existence on refusal; false when absent. */
  readonly existenceSensitive?: boolean;
}

/**
 * `Description::action_specs`: one spec per non-Meta verb — the explicit
 * one when declared, else synthesized from the flat fields.
 */
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
      existenceSensitive: d.existenceSensitive,
    }
  );
}

/**
 * The scopes a request with `verb` must hold to pass the capability floor
 * (core's `Floor::requirements`, `Description::required_scopes`), row for
 * row:
 *
 * | the request's verb | the door declares | the floor |
 * |---|---|---|
 * | declared (flat, or by its own action) | — | exactly that verb's `requires` |
 * | `Exists`, undeclared | `Source` | `Source`'s `requires` |
 * | `Exists`, undeclared | no `Source` | every `requires` it declares |
 * | `Source`, `Sink`, `Delete`, undeclared | — | every `requires` it declares |
 * | `Meta` | — | none |
 *
 * A verb's own action REPLACES the flat `requires` for that verb (the two
 * forms are exclusive per verb, as in core). "Every `requires` it declares"
 * is the union over {@linkcode actionSpecs}, deduplicated in declaration
 * order; when that is empty (a description that declares no verb but Meta)
 * it is the flat `requires` plus any actions' `requires`.
 */
function requiredScopes(d: DescriptionModel, verb: Verb): string[] {
  const declared = actionSpecs(d);
  const own = declared.find((a) => a.verb === verb);
  if (own !== undefined) return [...own.requires];
  if (verb === Verb.Meta) return [];
  if (verb === Verb.Exists) {
    const source = declared.find((a) => a.verb === Verb.Source);
    if (source !== undefined) return [...source.requires];
  }
  const every: string[] = [];
  const add = (scope: string) => {
    if (!every.includes(scope)) every.push(scope);
  };
  for (const a of declared) a.requires.forEach(add);
  if (declared.length === 0) {
    d.requires.forEach(add);
    for (const a of d.actions) a.requires.forEach(add);
  }
  return every;
}

/**
 * Core's `denial_message` for an unmet floor (without an alias hop, which a
 * peer never sees): byte for byte, because other repos' tests match it.
 */
function denialMessage(scope: string, target: string): string {
  if (!scope.endsWith("*")) {
    return `capability does not grant \`${scope}\` (declared by \`${target}\`)`;
  }
  const prefix = scope.slice(0, -1);
  if (prefix === "") {
    return `capability does not grant \`${scope}\` (declared by \`${target}\`; ` +
      "any grant at all satisfies it)";
  }
  return `capability does not grant \`${scope}\` (declared by \`${target}\`; ` +
    `any grant under \`${prefix}\` satisfies it)`;
}

/**
 * A failure class as `ik:mayFail`'s object, the vocabulary individual
 * (`ikigai_vocab::failure_class_iri`): `retry-after` is `ik:RetryAfterFailure`.
 */
function failureClassTerm(failure: FailureClass): string {
  const name = failure.split("-").map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  return `ik:${name}Failure`;
}

/** The groups, argument set and `output_from` a contract carries, as serde writes them. */
function constructsJson(
  c: Pick<
    ActionSpecModel,
    "groups" | "arguments" | "outputFrom" | "failures" | "existenceSensitive"
  >,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.failures !== undefined) out["failures"] = [...c.failures];
  if (c.existenceSensitive) out["existence_sensitive"] = true;
  if (c.groups !== undefined && c.groups.length > 0) {
    out["groups"] = c.groups.map((g) => {
      const group: Record<string, unknown> = {
        kind: g.kind,
        members: [...g.members],
      };
      if (g.pipe !== undefined) group["pipe"] = g.pipe;
      return group;
    });
  }
  if (c.arguments !== undefined) out["arguments"] = { ...c.arguments };
  if (c.outputFrom !== undefined) {
    out["output_from"] = c.outputFrom === "origin"
      ? "origin"
      : { ...c.outputFrom };
  }
  return out;
}

/** The serde shape of `ikigai_core::Description` (the JSON Meta face). */
function descriptionJson(d: DescriptionModel): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: d.id,
    title: d.title,
    summary: d.summary,
    verbs: d.verbs.map(verbName),
    inputs: d.inputs.map((a) => a.toJson()),
    outputs: [...d.outputs],
  };
  if (d.requires.length > 0) out["requires"] = [...d.requires];
  Object.assign(out, constructsJson(d));
  if (d.actions.length > 0) {
    out["actions"] = d.actions.map((a) => {
      const action: Record<string, unknown> = { verb: verbName(a.verb) };
      if (a.summary) action["summary"] = a.summary;
      if (a.inputs.length > 0) {
        action["inputs"] = a.inputs.map((i) => i.toJson());
      }
      if (a.outputs.length > 0) action["outputs"] = [...a.outputs];
      if (a.requires.length > 0) action["requires"] = [...a.requires];
      Object.assign(action, constructsJson(a));
      return action;
    });
  }
  return out;
}

/**
 * The human face — mirrors `ikigai_vocab::to_text`, which prints the FLAT
 * inputs only (so a door whose inputs live on its per-verb actions lists
 * none here; the Turtle and JSON faces carry them).
 */
function descriptionText(d: DescriptionModel): string {
  let s = `${d.id} — ${d.title}\n`;
  if (d.summary) s += `${d.summary}\n`;
  if (d.verbs.length > 0) s += `verbs: ${d.verbs.map(verbName).join(", ")}\n`;
  for (const arg of d.inputs) {
    const opt = arg.required ? "" : " (optional)";
    s += `  input ${arg.name} [${arg.source}]${opt}: ${arg.summary}\n`;
  }
  if (d.outputs.length > 0) s += `outputs: ${d.outputs.join(", ")}\n`;
  return s;
}

/**
 * The graph face — mirrors `ikigai_vocab::to_turtle`: skolemized node IRIs,
 * no blank nodes, the shared `ik:` vocabulary, one `ik:Action` per non-Meta
 * verb. Each action node is CONTENT-ADDRESSED ({@linkcode contractIri},
 * `urn:ikigai:contract:{id}:{verb}:b3:{hex}`) and owns its inputs at
 * `{contract}:input:{name}`, synthesized or explicit alike; the flat inputs
 * stay on the endpoint node too, as core writes them.
 */
function descriptionTurtle(d: DescriptionModel): string {
  // Core's `escape_literal`: a short Turtle string cannot carry a raw line
  // break, so `\n` and `\r` (and `\t`, as core does) are escaped too.
  const lit = (s: string): string =>
    '"' +
    s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r").replaceAll("\t", "\\t") +
    '"';
  // Core's `iri_term`: an authored value MEANT to be an IRI (a `class`, a
  // capability scope) is percent-encoded so it cannot close the `<…>` early,
  // and emitted as a resource only when the encoded form parses as an IRI
  // (`Iri::parse`, oxiri); anything else degrades to a literal of the author's
  // text. Encoding alone is not enough: `http://ok> . <urn:z` encodes to a
  // legal IRIREF whose port (`z`) is not a number, which would fail the whole
  // document. `%` is left alone here, unlike in a name (`nameFragment`): an
  // authored IRI may carry real escapes, and a malformed one (`100%`) fails
  // the parse and degrades to a literal.
  const iriTerm = (s: string): string => {
    const escaped = escapeIriFragment(s);
    return isAbsoluteIri(escaped) ? `<${escaped}>` : lit(s);
  };
  // Core's `cap_term`: a scope that looks like an IRI goes through `iriTerm`
  // (the prefix only rules a value OUT of IRI-hood, never in); any other is a
  // legacy descriptive label.
  const capTerm = (scope: string): string =>
    scope.startsWith("urn:") || scope.startsWith("http://") ||
      scope.startsWith("https://")
      ? iriTerm(scope)
      : lit(scope);
  const inputPredicates = (owner: string, arg: ArgSpec): string => {
    let node = `ik:inputName ${lit(arg.name)} ;\n` +
      `    ik:source ${lit(arg.source)} ;\n` +
      `    ik:required ${arg.required ? "true" : "false"}`;
    if (arg.summary) node += ` ;\n    ik:summary ${lit(arg.summary)}`;
    if (arg.cls !== null) node += ` ;\n    ik:class ${iriTerm(arg.cls)}`;
    if (arg.default !== null) node += ` ;\n    ik:default ${lit(arg.default)}`;
    for (const value of arg.oneOf) node += ` ;\n    ik:oneOf ${lit(value)}`;
    if (arg.enumerated && arg.oneOf.length === 0) {
      node += " ;\n    ik:enumerated true";
    }
    for (const example of arg.examples) {
      node += ` ;\n    ik:example ${lit(example)}`;
    }
    if (arg.list !== null) node += ` ;\n    ik:listSeparator ${lit(arg.list)}`;
    for (const needed of arg.needs) {
      node += ` ;\n    ik:needs <${owner}:input:${nameFragment(needed)}>`;
    }
    for (const value of arg.values.keys()) {
      node += ` ;\n    ik:valueNote <${valueNodeIri(owner, arg.name, value)}>`;
    }
    return node;
  };
  const valueNodeIri = (owner: string, input: string, value: string): string =>
    `${owner}:input:${nameFragment(input)}:value:${nameFragment(value)}`;
  // Core's `value_nodes`: one SKOS concept per value note.
  const valueNodes = (owner: string, arg: ArgSpec): string[] => {
    const skos = "http://www.w3.org/2004/02/skos/core#";
    return [...arg.values].map(([value, note]) => {
      const preds = [`a <${skos}Concept>`, `<${skos}notation> ${lit(value)}`];
      if (note.summary) preds.push(`<${skos}definition> ${lit(note.summary)}`);
      for (const tag of note.tags) preds.push(`ik:tag ${lit(tag)}`);
      for (const needed of note.needs) {
        preds.push(`ik:needs <${owner}:input:${nameFragment(needed)}>`);
      }
      return `<${valueNodeIri(owner, arg.name, value)}> ` +
        preds.join(" ;\n    ") + " .";
    });
  };
  // The argument set, `output_from` and groups a contract carries, hung off
  // `owner` (the endpoint's node or the contract's): the predicates for it,
  // and the group nodes.
  const constructs = (
    owner: string,
    c: Pick<ActionSpecModel, "groups" | "arguments" | "outputFrom">,
  ): { preds: string[]; groupPreds: string[]; nodes: string[] } => {
    const preds: string[] = [];
    if (c.arguments !== undefined) {
      preds.push(
        "open" in c.arguments
          ? `ik:openArguments ${lit(c.arguments.open)}`
          : `ik:envelope <${owner}:input:${
            nameFragment(c.arguments.envelope)
          }>`,
      );
    }
    if (c.outputFrom !== undefined) {
      preds.push(
        c.outputFrom === "origin"
          ? "ik:outputFrom ik:Origin"
          : `ik:outputFrom <${owner}:input:${
            nameFragment(c.outputFrom.input)
          }>`,
      );
    }
    const groupPreds: string[] = [];
    const nodes: string[] = [];
    for (const group of c.groups ?? []) {
      const iri = `${owner}:${groupSegment(group)}`;
      groupPreds.push(`ik:group <${iri}>`);
      const gp = ["a ik:InputGroup", `ik:groupKind ${lit(group.kind)}`];
      for (const member of group.members) {
        gp.push(`ik:member <${owner}:input:${nameFragment(member)}>`);
      }
      if (group.pipe !== undefined) {
        gp.push(`ik:pipe <${owner}:input:${nameFragment(group.pipe)}>`);
      }
      nodes.push(`<${iri}> ${gp.join(" ;\n    ")} .`);
    }
    return { preds, groupPreds, nodes };
  };

  const endpointIri = `urn:ikigai:endpoint:${nameFragment(d.id)}`;
  const preds: string[] = ["a ik:Endpoint", `ik:id ${lit(d.id)}`];
  if (d.title) preds.push(`ik:title ${lit(d.title)}`);
  if (d.summary) preds.push(`ik:summary ${lit(d.summary)}`);
  if (d.verbs.length > 0) {
    preds.push(`ik:verb ${d.verbs.map((v) => lit(verbName(v))).join(", ")}`);
  }
  if (d.outputs.length > 0) {
    preds.push(`ik:output ${d.outputs.map(lit).join(", ")}`);
  }
  if (d.requires.length > 0) {
    preds.push(`ik:requires ${d.requires.map(capTerm).join(", ")}`);
  }
  if (d.existenceSensitive) preds.push("ik:existenceSensitive true");
  if (d.failures !== undefined && d.failures.length > 0) {
    preds.push(`ik:mayFail ${d.failures.map(failureClassTerm).join(", ")}`);
  }

  const extraNodes: string[] = [];
  for (const arg of d.inputs) {
    const nodeIri = `${endpointIri}:input:${nameFragment(arg.name)}`;
    preds.push(`ik:input <${nodeIri}>`);
    extraNodes.push(`<${nodeIri}> ${inputPredicates(endpointIri, arg)} .`);
    extraNodes.push(...valueNodes(endpointIri, arg));
  }
  const flat = constructs(endpointIri, d);
  preds.push(...flat.preds, ...flat.groupPreds);
  extraNodes.push(...flat.nodes);

  for (const action of actionSpecs(d)) {
    const verb = verbName(action.verb);
    const actionIri = contractIri(d.id, action);
    preds.push(`ik:action <${actionIri}>`);
    const actionPreds = ["a ik:Action", `ik:verb ${lit(verb)}`];
    if (action.summary) actionPreds.push(`ik:summary ${lit(action.summary)}`);
    for (const output of action.outputs) {
      actionPreds.push(`ik:output ${lit(output)}`);
    }
    for (const cap of action.requires) {
      actionPreds.push(`ik:requires ${capTerm(cap)}`);
    }
    for (const failure of action.failures ?? []) {
      actionPreds.push(`ik:mayFail ${failureClassTerm(failure)}`);
    }
    if (action.existenceSensitive) {
      actionPreds.push("ik:existenceSensitive true");
    }
    for (const arg of action.inputs) {
      const nodeIri = `${actionIri}:input:${nameFragment(arg.name)}`;
      extraNodes.push(`<${nodeIri}> ${inputPredicates(actionIri, arg)} .`);
      extraNodes.push(...valueNodes(actionIri, arg));
      actionPreds.push(`ik:input <${nodeIri}>`);
    }
    const own = constructs(actionIri, action);
    actionPreds.push(...own.preds, ...own.groupPreds);
    extraNodes.push(...own.nodes);
    extraNodes.push(`<${actionIri}> ` + actionPreds.join(" ;\n    ") + " .");
  }

  let ttl = `@prefix ik: <${VOCAB_NS}> .\n\n<${endpointIri}> ` +
    preds.join(" ;\n    ") + " .\n";
  for (const node of extraNodes) ttl += `\n${node}\n`;
  return ttl;
}

// ---------------------------------------------------------------------------
// Served doors: the shared part
// ---------------------------------------------------------------------------

/**
 * The alias-stripped form an alias mount forwards: `urn:ts:hello` arrives
 * as `urn:hello` after `--mount urn:ts:=…` strips its prefix. `null` when
 * there is no namespace segment to strip — or when that segment is (part
 * of) a template variable, which no mount prefix could name.
 */
function aliasOf(pattern: string): string | null {
  const first = pattern.indexOf(":");
  const second = pattern.indexOf(":", first + 1);
  if (second < 0) return null;
  if (pattern.slice(0, second).includes("{")) return null;
  return `urn:${pattern.slice(second + 1)}`;
}

/**
 * The default id: the pattern's last `:`-segment that is plain text — so
 * `urn:ts:hello` is `hello` and `urn:ts:stored:{x}:{y}` is `stored`.
 */
function defaultId(pattern: string): string {
  const segments = pattern.split(":").filter((s) => !s.includes("{"));
  return segments.at(-1) ?? pattern;
}

/** Build the binding ArgSpecs for a template's variables. */
function bindingSpecs(
  pattern: string,
  template: UriTemplate,
  specs: Readonly<Record<string, BindingSpecInput>>,
): ArgSpec[] {
  const variables = template.variables;
  for (const name of Object.keys(specs)) {
    if (!variables.includes(name)) {
      throw new Error(
        `${pattern}: a binding is described for {${name}}, ` +
          `which the template does not have`,
      );
    }
  }
  const seen = new Set<string>();
  const out: ArgSpec[] = [];
  for (const name of variables) {
    if (seen.has(name)) continue; // `{a}…{a}`: one input, as core has one binding
    seen.add(name);
    const spec = specs[name] ?? {};
    out.push(
      new ArgSpec({
        name,
        summary: spec.summary,
        class: spec.class,
        required: true,
        source: "binding",
      }),
    );
  }
  return out;
}

/** Refuse an argument that shadows a template variable, at declaration. */
function assertNoCollision(
  pattern: string,
  what: string,
  bindings: readonly ArgSpec[],
  args: readonly ArgSpec[],
): void {
  for (const arg of args) {
    if (bindings.some((b) => b.name === arg.name)) {
      throw new Error(
        `${pattern}: ${what} declares an argument \`${arg.name}\`, which is ` +
          `also a template variable {${arg.name}} — a name has one source`,
      );
    }
    if (arg.source === "binding") {
      throw new Error(
        `${pattern}: ${what} declares \`${arg.name}\` as a binding, but ` +
          `bindings come from the template's variables, not from args`,
      );
    }
  }
}

function decodeArg(name: string, arg: wire.ArgRef): string | Uint8Array {
  if (arg.kind === "inline") {
    try {
      return utf8Decoder.decode(arg.data);
    } catch {
      return arg.data;
    }
  }
  // A peer has no back-channel to the host to dereference a Reference or
  // fetch a Content id — fail loud rather than hand the handler an IRI
  // pretending to be a value.
  throw new InvalidArgumentError(
    name,
    "arrived by reference; this peer only takes inline values",
  );
}

/** The handler's arguments: bindings, then declared args by name. */
function routeArgs(
  bindings: Readonly<Record<string, string>>,
  args: readonly ArgSpec[],
  request: Request,
): { args: HandlerArgs } | { refused: Reply } {
  const out: HandlerArgs = { ...bindings };
  for (const arg of args) {
    if (arg.name in request.args) {
      try {
        out[arg.name] = decodeArg(arg.name, request.args[arg.name]);
      } catch (e) {
        return {
          refused: { kind: "errorTyped", failure: toWireFailure(e) },
        };
      }
    } else if (arg.default !== null) {
      out[arg.name] = arg.default;
    } else if (arg.required) {
      return {
        refused: {
          kind: "errorTyped",
          failure: { kind: "missingArgument", name: arg.name },
        },
      };
    }
  }
  return { args: out };
}

/**
 * A handler's result as a Reply. `cacheable` marks a plain result
 * `Expiry::Never`; `mutating` (Sink/Delete) forces `Expiry::Always` even
 * on a Representation the handler built itself — a write's answer is never
 * something to serve again.
 */
function representationReply(
  result: HandlerResult,
  defaultMediaType: string,
  cacheable: boolean,
  mutating: boolean,
): Reply {
  let mediaType = defaultMediaType;
  let value: string | Uint8Array | Representation = result as
    | string
    | Uint8Array
    | Representation;
  if (Array.isArray(result)) {
    [value, mediaType] = result;
  }
  let rep: Representation;
  if (value instanceof Representation) {
    rep = mutating && value.expiry.kind !== "always"
      ? new Representation(value.data, value.mediaType, {
        expiry: Expiry.always(),
      })
      : value;
  } else {
    const expiry = cacheable && !mutating ? Expiry.never() : Expiry.always();
    rep = new Representation(value, mediaType, { expiry });
  }
  // No cache here: cacheable results report Miss ("computed now, cacheable
  // downstream" — the HOST kernel caches by the expiry), everything else
  // Uncacheable.
  const status = rep.expiry.kind !== "always"
    ? CacheStatus.Miss
    : CacheStatus.Uncacheable;
  return { kind: "resolved", representation: rep, cacheStatus: status };
}

async function runHandler(
  handler: Handler,
  args: HandlerArgs,
  output: string,
  cacheable: boolean,
  mutating: boolean,
  run: RunContext,
): Promise<Reply> {
  let result: HandlerResult;
  try {
    result = await handler(args, run);
  } catch (e) {
    // A handler failure crosses typed, never as a hang: the typed classes
    // map to their own taxonomy variants (a thrown NotFoundError IS a
    // NotFound on the host); anything else is an Endpoint error.
    return { kind: "errorTyped", failure: toWireFailure(e) };
  }
  return representationReply(result, output, cacheable, mutating);
}

function booleanReply(value: boolean, cacheable: boolean): Reply {
  return {
    kind: "resolved",
    representation: new Representation(
      value ? "true" : "false",
      "text/plain;charset=utf-8",
      { expiry: cacheable ? Expiry.never() : Expiry.always() },
    ),
    cacheStatus: cacheable ? CacheStatus.Miss : CacheStatus.Uncacheable,
  };
}

/** The shared shape of everything a {@linkcode Space} serves. */
export abstract class ServedDef {
  /** The declared pattern — an exact IRI, or a URI template. */
  readonly iri: string;
  /** {@linkcode ServedDef.iri} parsed; an exact IRI is a template too. */
  readonly template: UriTemplate;
  /**
   * The endpoint id the catalog lists. Defaults to the pattern's last plain
   * `:`-segment (`urn:ts:stored:{x}:{y}` is `stored`); a flat endpoint
   * prefers its handler's function name when it has one.
   */
  readonly id: string;
  /** A short human title; `""` when none was given. */
  readonly title: string;
  /** One line on what the door does; `""` when none was given. */
  readonly summary: string;
  /** One required `binding` input per template variable (empty if exact). */
  readonly bindings: readonly ArgSpec[];
  readonly #aliasTemplate: UriTemplate | null;

  /**
   * Validates the declaration, so a bad one fails where it is written: `iri`
   * must be a `urn:` and a valid {@linkcode UriTemplate}, and `bindings` may
   * describe only variables the template has. `fallbackId` is the id used
   * when `options.id` is absent.
   */
  protected constructor(
    iri: string,
    options: {
      id?: string;
      title?: string;
      summary?: string;
      bindings?: Readonly<Record<string, BindingSpecInput>>;
    },
    fallbackId: string,
  ) {
    if (!iri.startsWith("urn:")) {
      throw new Error(`endpoint IRI must be a urn: (${iri})`);
    }
    this.iri = iri;
    this.template = UriTemplate.parse(iri);
    this.id = options.id ?? fallbackId;
    this.title = options.title ?? "";
    this.summary = options.summary ?? "";
    this.bindings = bindingSpecs(iri, this.template, options.bindings ?? {});
    const alias = aliasOf(iri);
    this.#aliasTemplate = alias === null ? null : UriTemplate.parse(alias);
  }

  /**
   * The alias-stripped form an alias mount forwards: `urn:ts:hello` arrives
   * as `urn:hello` after `--mount urn:ts:=…` strips its prefix (for a
   * template, the stripped TEMPLATE). `null` when the IRI has no namespace
   * segment to strip.
   */
  get aliasIri(): string | null {
    return this.#aliasTemplate?.source ?? null;
  }

  /** {@linkcode aliasIri} as a parsed template (`null` when there is none). */
  get aliasTemplate(): UriTemplate | null {
    return this.#aliasTemplate;
  }

  /**
   * The bindings if `target` is this door's IRI (either form, declared
   * first), else null. This is ONE door's view; a {@linkcode Space} does
   * not route by it, because across doors every declared form must be
   * tried before any stripped one (see {@linkcode Space.lookup}).
   */
  match(target: string): Record<string, string> | null {
    return this.template.match(target) ??
      this.#aliasTemplate?.match(target) ?? null;
  }

  /** The `ikigai_core::Description` this door answers Meta with. */
  abstract description(): DescriptionModel;

  /** Answer a non-Meta verb at a matched IRI. */
  abstract answer(
    request: Request,
    bindings: Readonly<Record<string, string>>,
    run?: RunContext,
  ): Promise<Reply>;

  /** The verbs this door answers, for a refusal that names them. */
  protected abstract answeredVerbs(): Verb[];

  /**
   * The typed `Endpoint` refusal for a verb this door does not answer; its
   * message names the verbs it does.
   */
  protected refuse(verb: Verb): Reply {
    return {
      kind: "errorTyped",
      failure: {
        kind: "endpoint",
        message: `verb ${verbName(verb)} is not supported by \`${this.id}\` ` +
          `(it answers ${this.answeredVerbs().map(verbName).join(", ")})`,
      },
    };
  }

  /**
   * The serde shape of `ikigai_core::Description` — the face the host's
   * engine parses to route named arguments over a mount.
   */
  descriptionJson(): Record<string, unknown> {
    return descriptionJson(this.description());
  }

  /**
   * The capability scopes a request with `verb` must hold before this door
   * is entered: its declared floor, read from {@linkcode description} by
   * core's rule (`Description::required_scopes`). The verb's own `requires`
   * when it declares the verb (a per-verb action's REPLACES the flat list);
   * for an undeclared Exists, what Source requires (or, with no Source,
   * everything declared); for any other undeclared verb, every scope
   * declared anywhere; for Meta, nothing.
   *
   * ```ts
   * import { assertEquals } from "@std/assert";
   * import { family } from "./serve.ts";
   * import { Verb } from "./wire.ts";
   *
   * const calendar = family("urn:ts:calendar")
   *   .source({ requires: ["urn:cap:cal:read"] }, () => "")
   *   .sink({ requires: ["urn:cap:cal:write"] }, () => "ok");
   * assertEquals(calendar.requiredScopes(Verb.Sink), ["urn:cap:cal:write"]);
   * assertEquals(calendar.requiredScopes(Verb.Exists), ["urn:cap:cal:read"]);
   * assertEquals(calendar.requiredScopes(Verb.Meta), []);
   * assertEquals(calendar.requiredScopes(Verb.Delete).length, 2);
   * ```
   */
  requiredScopes(verb: Verb): string[] {
    return requiredScopes(this.description(), verb);
  }

  /**
   * The scopes in {@linkcode requiredScopes} that `capability` does not
   * satisfy ({@linkcode Capability.satisfies}): empty exactly when this
   * peer's floor admits the request.
   */
  unsatisfiedScopes(verb: Verb, capability: wire.Capability): string[] {
    return this.requiredScopes(verb).filter((s) => !capability.satisfies(s));
  }

  /** The human face (mirrors `ikigai_vocab::to_text`). */
  descriptionText(): string {
    return descriptionText(this.description());
  }

  /** The graph face (mirrors `ikigai_vocab::to_turtle`). */
  descriptionTurtle(): string {
    return descriptionTurtle(this.description());
  }
}

// ---------------------------------------------------------------------------
// The flat form: one verb, one function
// ---------------------------------------------------------------------------

/** How {@linkcode endpoint} declares a single-verb Source door. */
export interface EndpointOptions {
  /**
   * The catalog id. Default: the handler's function name, else the IRI's
   * last plain `:`-segment.
   */
  id?: string;
  /** A short human title. */
  title?: string;
  /** One line on what the endpoint does. */
  summary?: string;
  /**
   * The by-value arguments, as names, spec objects or `ArgSpec`s. None may
   * reuse a template variable's name, or declare `source: "binding"`: both
   * are refused at declaration.
   */
  args?: (string | ArgSpecInput | ArgSpec)[];
  /** Descriptions of the template's variables, when the IRI is a template. */
  bindings?: Record<string, BindingSpecInput>;
  /** The media type a plain result is sent as; `text/plain;charset=utf-8`. */
  output?: string;
  /**
   * Marks the result a pure function of its inputs (`Expiry::Never`) — the
   * HOST kernel then caches it.
   */
  cacheable?: boolean;
  /**
   * The capability scopes the endpoint requires. Declared = enforced: a call
   * whose carried capability does not satisfy every one is refused as a
   * typed `Denied` before the handler runs (see {@linkcode Space.dispatch}).
   */
  requires?: string[];
}

/** A served single-verb Source endpoint: a handler plus its self-description. */
export class EndpointDef extends ServedDef {
  /** The function that answers Source. */
  readonly handler: Handler;
  /** The declared by-value arguments (the template's bindings are separate). */
  readonly args: readonly ArgSpec[];
  /** The media type a plain result is sent as. */
  readonly output: string;
  /** Whether a result is marked `Expiry::Never` for the host to cache. */
  readonly cacheable: boolean;
  /** The declared capability scopes, enforced at dispatch. */
  readonly requires: readonly string[];

  /**
   * Prefer {@linkcode endpoint}, which takes the same values in reading
   * order. Throws when the declaration is invalid (see
   * {@linkcode EndpointOptions.args}).
   */
  constructor(handler: Handler, iri: string, options: EndpointOptions = {}) {
    // TS erases names more readily than Python (an inline arrow has none),
    // so the default id is the IRI's last plain segment, not the function
    // name.
    super(iri, options, handler.name || defaultId(iri));
    this.handler = handler;
    this.args = (options.args ?? []).map((a) => new ArgSpec(a));
    assertNoCollision(iri, "the endpoint", this.bindings, this.args);
    this.output = options.output ?? "text/plain;charset=utf-8";
    this.cacheable = options.cacheable ?? false;
    this.requires = [...(options.requires ?? [])];
  }

  /**
   * The flat single-verb form: verbs Source and Meta, the bindings then the
   * args as inputs, and no explicit actions.
   */
  description(): DescriptionModel {
    return {
      id: this.id,
      title: this.title,
      summary: this.summary,
      verbs: [Verb.Source, Verb.Meta],
      inputs: [...this.bindings, ...this.args],
      outputs: [this.output],
      requires: this.requires,
      actions: [],
    };
  }

  /** Source, Exists and Meta: Exists is answered though not described. */
  protected answeredVerbs(): Verb[] {
    return [Verb.Source, Verb.Exists, Verb.Meta];
  }

  /**
   * Source runs the handler. Exists is always `true` (the name is bound)
   * and never runs the handler. Sink and Delete get a typed refusal.
   */
  async answer(
    request: Request,
    bindings: Readonly<Record<string, string>>,
    run: RunContext = NO_RUN,
  ): Promise<Reply> {
    if (request.verb === Verb.Exists) {
      // The flat form's Exists is "the name is bound" — unchanged since L0,
      // and it never runs the handler (a function of its arguments has no
      // absent case to find).
      return booleanReply(true, false);
    }
    if (request.verb !== Verb.Source) return this.refuse(request.verb);
    const routed = routeArgs(bindings, this.args, request);
    if ("refused" in routed) return routed.refused;
    return await runHandler(
      this.handler,
      routed.args,
      this.output,
      this.cacheable,
      false,
      run,
    );
  }
}

/**
 * Declare a function as a single-verb Source endpoint. The ArgSpecs are
 * explicit spec data in L0 (TS types are erased at runtime; a schema-derived
 * layer is a later ergonomic rung) but they are REAL: the host engine routes
 * `key=value` arguments by this declaration.
 *
 * `iri` may be a URI template (`urn:ts:echo:{msg}`): the endpoint then
 * answers every IRI it matches, and the handler receives each variable by
 * name beside its arguments. Describe the variables with `bindings`.
 */
export function endpoint(
  iri: string,
  options: EndpointOptions,
  handler: Handler,
): EndpointDef {
  return new EndpointDef(handler, iri, options);
}

// ---------------------------------------------------------------------------
// The multi-verb form: a family of doors, one contract per verb
// ---------------------------------------------------------------------------

/** One verb's contract, as a {@linkcode Family} declares it. */
export interface ActionOptions {
  /** One line on what this verb does here. */
  summary?: string;
  /** By-value arguments (the template's variables are added for you). */
  args?: (string | ArgSpecInput | ArgSpec)[];
  /** The media type a plain result is sent as; `text/plain;charset=utf-8`. */
  output?: string;
  /**
   * Capability scopes this verb requires, enforced at dispatch. Declared per
   * verb, as in core: a verb this door does not declare needs every scope
   * the door declares (an undeclared Exists, what Source needs).
   */
  requires?: string[];
}

/** A Source may mark its answer a pure function of the door's state. */
export interface SourceOptions extends ActionOptions {
  /**
   * `Expiry::Never`: the HOST kernel caches the read, and cuts it when a
   * Sink or Delete to the same IRI goes through that kernel.
   */
  cacheable?: boolean;
}

/** An explicit Exists answers yes/no; its output is always text/plain. */
export interface ExistsOptions extends Omit<ActionOptions, "output"> {
  /** Mark the yes/no answer `Expiry::Never`, for the host to cache. */
  cacheable?: boolean;
}

/** How {@linkcode family} declares a multi-verb door. */
export interface FamilyOptions {
  /** The catalog id; default: the pattern's last plain `:`-segment. */
  id?: string;
  /** A short human title. */
  title?: string;
  /** One line on what the door does. */
  summary?: string;
  /** Descriptions of the template's variables. */
  bindings?: Record<string, BindingSpecInput>;
}

interface ActionDef {
  readonly verb: Verb;
  readonly summary: string;
  readonly args: readonly ArgSpec[];
  readonly output: string;
  readonly requires: readonly string[];
  readonly cacheable: boolean;
  readonly handler: Handler | null;
  readonly exists: ExistsHandler | null;
}

/** The order verbs are listed in a family's description. */
const VERB_ORDER = [Verb.Source, Verb.Sink, Verb.Exists, Verb.Delete];

/**
 * A multi-verb door, usually over a URI template: each verb is declared
 * with its own contract — the per-verb `ActionSpec` form of core, where an
 * explicit action carries ALL its inputs (the template's variables are
 * added to every verb for you, as `binding` inputs, ahead of its args).
 *
 * - **Sink** receives the body as `content` (the ecosystem's pipeline rule);
 *   a Sink that does not declare `content` gets it declared, required.
 * - **Exists**, when not declared, answers "would Source succeed": the
 *   Source handler runs, a success is `true`, a {@linkcode NotFoundError} is
 *   `false`, and any other failure crosses as itself. A family with neither
 *   refuses Exists.
 * - **Cacheability** is per verb: a Source (or Exists) may be `cacheable`;
 *   a Sink or Delete answer is never cacheable, whatever the handler built.
 * - Any verb not declared is a typed refusal naming the ones that are.
 *
 * ```ts
 * import { family } from "@ikigai/wire/serve";
 *
 * // Stand-ins for your own storage.
 * declare function read(...cell: unknown[]): string;
 * declare function write(...cell: unknown[]): string;
 * declare function clear(...cell: unknown[]): string;
 *
 * const cell = family("urn:ts:stored:{x}:{y}", { id: "stored" })
 *   .source({ cacheable: true }, ({ x, y }) => read(x, y))
 *   .sink({}, ({ x, y, content }) => write(x, y, content))
 *   .delete({}, ({ x, y }) => clear(x, y));
 * ```
 */
export class Family extends ServedDef {
  readonly #actions = new Map<Verb, ActionDef>();

  /**
   * Prefer {@linkcode family}, which is the same call. Until a verb is
   * declared, the door answers Meta and refuses everything else.
   */
  constructor(pattern: string, options: FamilyOptions = {}) {
    super(pattern, options, defaultId(pattern));
  }

  /** Declare the Source verb. */
  source(handler: Handler): this;
  /**
   * Declare the Source verb with its contract. Each verb may be declared
   * once; a second declaration throws.
   */
  source(options: SourceOptions, handler: Handler): this;
  source(a: SourceOptions | Handler, b?: Handler): this {
    const [options, handler] = typeof a === "function" ? [{}, a] : [a, b!];
    return this.#declare(Verb.Source, options, handler, options.cacheable);
  }

  /** Declare the Sink verb; the body arrives as `content`. */
  sink(handler: Handler): this;
  /**
   * Declare the Sink verb with its contract. `content` is added to `args`,
   * required, unless already declared there; the answer is never cacheable.
   */
  sink(options: ActionOptions, handler: Handler): this;
  sink(a: ActionOptions | Handler, b?: Handler): this {
    const [options, handler] = typeof a === "function" ? [{}, a] : [a, b!];
    const args = (options.args ?? []).map((x) => new ArgSpec(x));
    if (!args.some((x) => x.name === "content")) {
      args.push(new ArgSpec({ name: "content", summary: "the body to write" }));
    }
    return this.#declare(Verb.Sink, { ...options, args }, handler, false);
  }

  /** Declare the Delete verb. */
  delete(handler: Handler): this;
  /** Declare the Delete verb with its contract; never cacheable. */
  delete(options: ActionOptions, handler: Handler): this;
  delete(a: ActionOptions | Handler, b?: Handler): this {
    const [options, handler] = typeof a === "function" ? [{}, a] : [a, b!];
    return this.#declare(Verb.Delete, options, handler, false);
  }

  /** Declare an explicit Exists (else it is derived from Source). */
  exists(handler: ExistsHandler): this;
  /**
   * Declare an explicit Exists with its contract; its answer is always
   * `text/plain;charset=utf-8` `true` or `false`.
   */
  exists(options: ExistsOptions, handler: ExistsHandler): this;
  exists(a: ExistsOptions | ExistsHandler, b?: ExistsHandler): this {
    const [options, handler] = typeof a === "function" ? [{}, a] : [a, b!];
    this.#declare(
      Verb.Exists,
      { ...options, output: "text/plain;charset=utf-8" },
      null,
      options.cacheable,
    );
    const held = this.#actions.get(Verb.Exists)!;
    this.#actions.set(Verb.Exists, { ...held, exists: handler });
    return this;
  }

  #declare(
    verb: Verb,
    options: ActionOptions,
    handler: Handler | null,
    cacheable: boolean | undefined,
  ): this {
    if (this.#actions.has(verb)) {
      throw new Error(`${this.iri}: ${verbName(verb)} is declared twice`);
    }
    const args = (options.args ?? []).map((x) => new ArgSpec(x));
    assertNoCollision(this.iri, `its ${verbName(verb)}`, this.bindings, args);
    this.#actions.set(verb, {
      verb,
      summary: options.summary ?? "",
      args,
      output: options.output ?? "text/plain;charset=utf-8",
      requires: [...(options.requires ?? [])],
      cacheable: cacheable ?? false,
      handler,
      exists: null,
    });
    return this;
  }

  /** The declared verbs, in the order a description lists them. */
  get verbs(): Verb[] {
    return VERB_ORDER.filter((v) => this.#actions.has(v));
  }

  /**
   * The explicit per-verb form: one action per declared verb, each carrying
   * the bindings then its own args, and empty flat fields. A derived Exists
   * is answered but not listed.
   */
  description(): DescriptionModel {
    const verbs = this.verbs;
    return {
      id: this.id,
      title: this.title,
      summary: this.summary,
      verbs: [...verbs, Verb.Meta],
      // Like core's explicit form (and the Rust `ttt-stored`): every input
      // lives on its action, because an explicit action inherits nothing.
      inputs: [],
      outputs: [],
      requires: [],
      actions: verbs.map((verb) => {
        const a = this.#actions.get(verb)!;
        return {
          verb,
          summary: a.summary,
          inputs: [...this.bindings, ...a.args],
          outputs: [a.output],
          requires: a.requires,
        };
      }),
    };
  }

  /** The declared verbs, plus Exists when it derives from Source, plus Meta. */
  protected answeredVerbs(): Verb[] {
    const verbs = this.verbs;
    if (!verbs.includes(Verb.Exists) && verbs.includes(Verb.Source)) {
      verbs.push(Verb.Exists);
    }
    return [...VERB_ORDER.filter((v) => verbs.includes(v)), Verb.Meta];
  }

  /**
   * Run the declared verb's handler, or derive Exists from Source as the
   * class doc describes; an undeclared verb gets a typed refusal.
   */
  async answer(
    request: Request,
    bindings: Readonly<Record<string, string>>,
    run: RunContext = NO_RUN,
  ): Promise<Reply> {
    const action = this.#actions.get(request.verb);
    if (request.verb === Verb.Exists) {
      if (action !== undefined) {
        return await this.#explicitExists(action, request, bindings, run);
      }
      const source = this.#actions.get(Verb.Source);
      if (source === undefined) return this.refuse(request.verb);
      const reply = await this.#run(source, request, bindings, run);
      if (reply.kind === "resolved") {
        return booleanReply(true, source.cacheable);
      }
      if (reply.kind === "errorTyped" && reply.failure.kind === "notFound") {
        return booleanReply(false, source.cacheable);
      }
      return reply;
    }
    if (action === undefined) return this.refuse(request.verb);
    return await this.#run(action, request, bindings, run);
  }

  async #run(
    action: ActionDef,
    request: Request,
    bindings: Readonly<Record<string, string>>,
    run: RunContext,
  ): Promise<Reply> {
    const routed = routeArgs(bindings, action.args, request);
    if ("refused" in routed) return routed.refused;
    const mutating = action.verb === Verb.Sink || action.verb === Verb.Delete;
    return await runHandler(
      action.handler!,
      routed.args,
      action.output,
      action.cacheable,
      mutating,
      run,
    );
  }

  async #explicitExists(
    action: ActionDef,
    request: Request,
    bindings: Readonly<Record<string, string>>,
    run: RunContext,
  ): Promise<Reply> {
    const routed = routeArgs(bindings, action.args, request);
    if ("refused" in routed) return routed.refused;
    try {
      return booleanReply(
        await action.exists!(routed.args, run),
        action.cacheable,
      );
    } catch (e) {
      return { kind: "errorTyped", failure: toWireFailure(e) };
    }
  }
}

/**
 * Declare a multi-verb door — a FAMILY when `pattern` is a URI template,
 * one exact IRI otherwise. Chain `.source` / `.sink` / `.delete` /
 * `.exists` to give each verb its contract; see {@linkcode Family}.
 */
export function family(pattern: string, options: FamilyOptions = {}): Family {
  return new Family(pattern, options);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** One form of one door, as a {@linkcode Space} routes it. */
interface Route {
  readonly template: UriTemplate;
  readonly def: ServedDef;
}

/**
 * Add `def`'s `template` to one form's routes, refusing the same pattern
 * text from a second door WITHIN that form.
 */
function route(routes: Route[], template: UriTemplate, def: ServedDef): void {
  const held = routes.find((r) =>
    r.def !== def && r.template.source === template.source
  );
  if (held !== undefined) {
    throw new Error(
      `two endpoints answer ${template.source}: ${held.def.id} and ${def.id}`,
    );
  }
  routes.push({ template, def });
}

/**
 * The served resolution space: door lookup + call dispatch.
 *
 * **Routing mirrors core `EndpointSpace`: the first declared door whose
 * pattern matches wins** — declare a specific door before a general template
 * that would also match it; a later door it shadows is left unreachable,
 * exactly as in a Rust kernel.
 *
 * Each door is matched in two forms, its declared pattern and its
 * alias-stripped one, in two SEPARATE passes — every declared form (in
 * declaration order), then every stripped form (in declaration order) — so
 * a stripped form can never shadow another door's declared name: with
 * `urn:a:{x}` declared before `urn:b:c`, a verbatim `urn:b:c` reaches the
 * second door rather than the first's stripped `urn:{x}`. A connection
 * whose hello declared an ALIAS mount is forwarding stripped names, so for
 * it the passes reverse: stripped forms first, then declared.
 *
 * The same pattern text twice WITHIN one form (two declared, or two
 * stripped) is refused at construction. A declared pattern equal to another
 * door's stripped pattern is not: the passes keep them apart — the declared
 * door answers a verbatim caller, the stripped one an alias-mode connection.
 */
export class Space {
  /**
   * The entries form for a caller that states none (`entries(null)`):
   * `true`, the default, lists alias-stripped patterns. A served
   * connection always states its own form.
   */
  readonly stripAlias: boolean;
  #defs: readonly ServedDef[];
  #declared: readonly Route[];
  #aliased: readonly Route[];

  /**
   * Routes `endpoints` in the order given, which is the order they win in.
   * Throws when two doors share a pattern within one form.
   */
  constructor(
    endpoints: readonly ServedDef[],
    options: { stripAlias?: boolean } = {},
  ) {
    this.stripAlias = options.stripAlias ?? true;
    const declared: Route[] = [];
    const aliased: Route[] = [];
    for (const d of endpoints) route(declared, d.template, d);
    for (const d of endpoints) {
      const alias = d.aliasTemplate;
      if (alias !== null) route(aliased, alias, d);
    }
    this.#defs = [...endpoints];
    this.#declared = declared;
    this.#aliased = aliased;
  }

  /**
   * `stripAlias === null` uses the space's configured default (direct
   * programmatic use); a served connection always passes its hello mode —
   * since v7 the hello is required, so the form is KNOWN per connection,
   * never guessed. A family's entry is its TEMPLATE, so the host's catalog
   * lists the family, not the members it has been asked about.
   */
  entries(stripAlias: boolean | null = null): SpaceEntry[] {
    const strip = stripAlias === null ? this.stripAlias : stripAlias;
    return this.#defs.map((d) =>
      spaceEntry((strip ? d.aliasIri : null) ?? d.iri, d.id)
    );
  }

  /**
   * Answer one decoded Call. Failures come back as typed replies: an
   * unmatched target is `unresolved`, a handler's throw is its taxonomy
   * variant. Meta answers for any matched IRI before a handler sees it.
   * `isCached` is always `false` (this peer keeps no cache); a resolved
   * `issueTraced` carries one span for the whole resolution.
   * `stripAlias` is the connection's hello mode, `null` for a direct call.
   *
   * **The capability floor runs here, on every call, before the door is
   * entered** — core's declared-capability floor: every scope the door
   * declares for the request's verb ({@linkcode ServedDef.requiredScopes})
   * must be satisfied ({@linkcode wire.Capability.satisfies}), or the call is
   * refused as a typed `Denied` with core's message text. `issueAs` and
   * `issueTraced` are floored under the capability they carry. A plain
   * `issue` carries none and resolves under ROOT, as the Rust IPC door
   * resolves a plain `Issue` from its owner: the socket is reachable only by
   * its owner (mode `0600`), so the owner's authority is root and a carried
   * capability needs no clamp (root's clamp of `c` is `c`). Meta is never
   * floored: self-description stays readable.
   */
  async dispatch(
    call: wire.Call,
    stripAlias: boolean | null = null,
  ): Promise<Reply> {
    if (call.kind === "entries") {
      return { kind: "entries", entries: this.entries(stripAlias) };
    }
    if (call.kind === "isCached") {
      return { kind: "cached", cached: false }; // this peer keeps no cache
    }
    // Only a connection that DECLARED an alias mount tries stripped forms
    // first; a direct programmatic call (`null`) is a verbatim caller.
    const aliasFirst = stripAlias === true;
    if (call.kind === "issue") {
      return await this.#resolve(
        call.request,
        aliasFirst,
        wire.Capability.root(),
      );
    }
    if (call.kind === "issueAs") {
      return await this.#resolve(call.request, aliasFirst, call.capability);
    }
    // issueTraced, or issueWith: the run context is built at THIS side's now
    // (the peer sent time LEFT, never an instant), and a trace is recorded
    // only when the call carries one.
    const run = call.kind === "issueWith"
      ? runContext(call.with.retries, call.with.timeLeftMs)
      : NO_RUN;
    if (call.kind === "issueWith" && call.with.trace === null) {
      return await this.#resolve(
        call.request,
        aliasFirst,
        call.capability,
        run,
      );
    }
    const started = Date.now();
    const reply = await this.#resolve(
      call.request,
      aliasFirst,
      call.capability,
      run,
    );
    const ended = Date.now();
    if (reply.kind !== "resolved") return reply;
    const capability = call.capability;
    const event: TraceEvent = {
      target: call.request.target,
      thread: "deno-main",
      started,
      ended,
      cacheHit: false,
      span: 0,
      parent: null,
      capability: capability.isRoot
        ? null
        : wire.sortedUtf8([...(capability.scopes ?? [])]),
      notes: [],
    };
    return {
      kind: "resolvedTraced",
      representation: reply.representation,
      cacheStatus: reply.cacheStatus,
      events: [event],
    };
  }

  /**
   * The first door matching `target`, if any: every declared form, then
   * every stripped form, each pass in declaration order — reversed when
   * `aliasFirst` (a connection whose hello declared an alias mount).
   */
  lookup(
    target: string,
    aliasFirst = false,
  ): { def: ServedDef; bindings: Record<string, string> } | null {
    const passes = aliasFirst
      ? [this.#aliased, this.#declared]
      : [this.#declared, this.#aliased];
    for (const routes of passes) {
      for (const { template, def } of routes) {
        const bindings = template.match(target);
        if (bindings !== null) return { def, bindings };
      }
    }
    return null;
  }

  async #resolve(
    request: Request,
    aliasFirst: boolean,
    capability: wire.Capability,
    run: RunContext = NO_RUN,
  ): Promise<Reply> {
    const hit = this.lookup(request.target, aliasFirst);
    if (hit === null) {
      // A real Unresolved (v7): the host-side client rebuilds the same
      // variant — and the same rendering — the Rust kernel would produce.
      return {
        kind: "errorTyped",
        failure: { kind: "unresolved", iri: request.target },
      };
    }
    // Meta answers for ANY matched IRI, before a binding is looked at: the
    // host describes a template row by Meta on a PROBE expansion
    // (`{x}` -> `probe`, core `select::describe_entry`), which no handler
    // would accept as a value.
    if (request.verb === Verb.Meta) return this.#meta(hit.def, request);
    // The floor: declared = enforced, before the door is entered (and before
    // a verb it does not answer is refused, as in core, where an undeclared
    // verb needs every scope the door declares).
    const lacking = hit.def.unsatisfiedScopes(request.verb, capability)[0];
    if (lacking !== undefined) {
      return {
        kind: "errorTyped",
        failure: {
          kind: "denied",
          message: denialMessage(lacking, request.target),
        },
      };
    }
    return await hit.def.answer(request, hit.bindings, run);
  }

  #meta(d: ServedDef, request: Request): Reply {
    let target = "text/turtle"; // the kernel's default Meta face
    const asArg = request.args["as"];
    if (asArg !== undefined && asArg.kind === "inline") {
      try {
        target = utf8Decoder.decode(asArg.data);
      } catch {
        // keep the default
      }
    }
    let rep: Representation;
    if (target === "text/turtle" || target === "*/*" || target === "") {
      rep = new Representation(d.descriptionTurtle(), "text/turtle");
    } else if (target === "text/plain") {
      rep = new Representation(
        d.descriptionText(),
        "text/plain;charset=utf-8",
      );
    } else if (target === "application/json") {
      rep = new Representation(
        JSON.stringify(d.descriptionJson()),
        "application/json",
      );
    } else {
      return {
        kind: "errorTyped",
        failure: {
          kind: "endpoint",
          message: `meta renderer does not support target \`${target}\``,
        },
      };
    }
    return {
      kind: "resolved",
      representation: rep,
      cacheStatus: CacheStatus.Uncacheable,
    };
  }
}

// ---------------------------------------------------------------------------
// The socket server
// ---------------------------------------------------------------------------

/**
 * A wire server for a set of endpoints. `serve()` blocks until
 * {@linkcode Server.shutdown} is called (from another task, or via
 * `await using`).
 */
export class Server {
  /** The routing space built from the endpoints. */
  readonly space: Space;
  /** The Unix socket path the server listens on. */
  readonly path: string;
  #listener: Deno.UnixListener;
  #conns = new Set<Deno.UnixConn>();
  #closing = false;

  /**
   * Bind now, before {@linkcode Server.serve}: creates the parent directory
   * (`0700`) if missing, REMOVES any file already at `path`, listens, and
   * narrows the socket to `0600`, which is this server's whole access gate.
   */
  constructor(endpoints: readonly ServedDef[], path: string) {
    this.space = new Space(endpoints);
    this.path = path;
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      Deno.mkdirSync(path.slice(0, slash), { recursive: true, mode: 0o700 });
    }
    try {
      Deno.removeSync(path); // a leftover socket would fail the bind
    } catch {
      // absent is fine
    }
    this.#listener = Deno.listen({ transport: "unix", path });
    // Deno binds the socket with the process umask; narrow it. (No
    // SO_PEERCRED equivalent in Deno, so this mode IS the access gate.)
    Deno.chmodSync(path, 0o600);
  }

  /** Accept and serve connections until {@linkcode shutdown}. */
  async serve(): Promise<void> {
    const handlers: Promise<void>[] = [];
    try {
      while (true) {
        const conn = await this.#listener.accept();
        if (this.#closing) {
          conn.close();
          break;
        }
        this.#conns.add(conn);
        handlers.push(
          this.#handle(conn).finally(() => {
            this.#conns.delete(conn);
            try {
              conn.close();
            } catch {
              // already closed
            }
          }),
        );
      }
    } catch (e) {
      if (!this.#closing) throw e;
    }
    await Promise.all(handlers);
  }

  async #handle(conn: Deno.UnixConn): Promise<void> {
    const stream = new FrameStream(conn);
    // The FIRST frame must be the hello (wire v7): a v7 or v8 client is
    // answered with ITS OWN version and served at it (v8), and its mode
    // picks this connection's entries form; any other version (6, 9) gets
    // OUR version (so it names both in its error) and a close. The answer
    // must echo the client, not say 8: a v7 client refuses any hello
    // answer but 7. A frame WITHOUT the
    // magic is a pre-v6 client; it is REFUSED (the v6 serve-it-anyway
    // tolerance is over).
    let first: Uint8Array;
    try {
      first = await stream.readFrame();
    } catch {
      return;
    }
    const hello = wire.decodeHello(first);
    if (hello === null) {
      console.error(
        "ikigai-deno: refused a client that connected without the version " +
          `hello (wire <= v5; v${wire.PROTOCOL_VERSION} requires it). ` +
          "Update the client.",
      );
      return;
    }
    const version = wire.negotiateVersion(hello.version);
    try {
      await stream.writeFrame(
        wire.encodeHello(wire.hello(version ?? wire.PROTOCOL_VERSION)),
      );
    } catch {
      return;
    }
    if (version === null) {
      return; // the client renders the mismatch
    }
    const stripAlias = hello.mode === wire.HelloMode.Alias;
    while (true) {
      let frame: Uint8Array;
      try {
        frame = await stream.readFrame();
      } catch {
        return; // peer hung up
      }
      if (!(await this.#serveOneFrame(stream, frame, stripAlias, version))) {
        return;
      }
    }
  }

  /**
   * Decode and answer one Call frame; `false` ends the connection. Every
   * reply passes through {@linkcode wire.replyForPeer} at the connection's
   * negotiated `version`, so a v7 peer never sees a variant it cannot decode.
   */
  async #serveOneFrame(
    stream: FrameStream,
    frame: Uint8Array,
    stripAlias: boolean,
    version: number,
  ): Promise<boolean> {
    let call: wire.Call;
    try {
      call = wire.decodeCall(frame);
    } catch (e) {
      // An undecodable frame. Answer once, loudly, then drop the
      // connection — framing after a bad frame is unreliable.
      const message = e instanceof Error ? e.message : String(e);
      try {
        await stream.writeFrame(
          wire.encodeReply({
            kind: "errorTyped",
            failure: { kind: "endpoint", message },
          }),
        );
      } catch {
        // best effort
      }
      return false;
    }
    try {
      const reply = await this.space.dispatch(call, stripAlias);
      await stream.writeFrame(
        wire.encodeReply(wire.replyForPeer(reply, version)),
      );
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Stop listening and close every open connection, which ends
   * {@linkcode Server.serve}. Idempotent.
   */
  shutdown(): void {
    if (this.#closing) return;
    this.#closing = true;
    // Closing the listener wakes the accept loop (BadResource) and removes
    // the socket file; open connections are closed so their read loops end.
    try {
      this.#listener.close();
    } catch {
      // already closed
    }
    for (const conn of this.#conns) {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  }

  /** {@linkcode Server.shutdown}, for `using`. */
  [Symbol.dispose](): void {
    this.shutdown();
  }
}

/**
 * Serve `endpoints` (from {@linkcode endpoint}) on the Unix socket at
 * `path`. Blocks until the returned promise is settled by
 * {@linkcode Server.shutdown} (e.g. from a signal handler).
 */
export async function serve(
  endpoints: readonly ServedDef[],
  path: string,
): Promise<void> {
  const server = new Server(endpoints, path);
  try {
    await server.serve();
  } finally {
    server.shutdown();
  }
}
