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
 * and its stripped form. Since wire v6 the client's hello says which form
 * its `entries` wants, per connection — and since v7 the hello is REQUIRED
 * (a first frame without it is refused), so every served connection's form
 * is known, never guessed.
 *
 * **Failures cross typed** (wire v7): an unknown IRI is a real `Unresolved`,
 * a missing required argument a `MissingArgument`, a zod validation failure
 * an `InvalidArgument` naming the field, a handler throw an `Endpoint` — and
 * a handler may throw the typed classes (`NotFoundError`, `DeniedError`,
 * `TimeoutError`, `UnavailableError`, …) to cross as that variant, so a Deno
 * peer can answer a real 404-equivalent the host recognizes without message
 * sniffing.
 *
 * **Security posture**: the socket is `0600` in a `0700` directory. Deno
 * exposes no SO_PEERCRED / LOCAL_PEERCRED equivalent, so unlike the Rust and
 * Python servers this one CANNOT verify the connecting peer's UID — the
 * socket file's `0600` mode is the whole gate (the kernel enforces it on
 * `connect`, on both Linux and macOS). That is a real, honest difference; do
 * not serve on a path whose parent directory other users can traverse. A
 * capability carried on `IssueAs`/`IssueTraced` is accepted but not enforced
 * per-scope (capability-on-the-wire for IPC is a known TODO on the Rust side
 * too).
 */

import * as wire from "./wire.ts";
import {
  CacheStatus,
  Expiry,
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

export { TemplateError, UriTemplate } from "./template.ts";

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
  name: string;
  summary?: string;
  required?: boolean;
  /** rdfs:Class IRI for entities, XSD datatype IRI for scalars. */
  class?: string;
  default?: string;
  oneOf?: string[];
  /** `"argument"` (the default) or `"binding"`. */
  source?: InputSource;
}

/**
 * One named input, mirroring `ikigai_core::ArgSpec`. The describe face built
 * from these is what the host engine routes named arguments by — the names
 * and required/optional flags are load-bearing, not decoration.
 */
export class ArgSpec {
  readonly name: string;
  readonly summary: string;
  readonly required: boolean;
  readonly cls: string | null;
  readonly default: string | null;
  readonly oneOf: readonly string[];
  readonly source: InputSource;

  constructor(spec: string | ArgSpecInput | ArgSpec) {
    if (spec instanceof ArgSpec) {
      this.name = spec.name;
      this.summary = spec.summary;
      this.required = spec.required;
      this.cls = spec.cls;
      this.default = spec.default;
      this.oneOf = spec.oneOf;
      this.source = spec.source;
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
    this.source = input.source ?? "argument";
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
    if (this.oneOf.length > 0) out["one_of"] = [...this.oneOf];
    return out;
  }
}

/**
 * How a template variable is described: its summary and class. The
 * variable itself is always a REQUIRED `binding` input — its value is part
 * of the IRI, so it is never absent and has no default.
 */
export interface BindingSpecInput {
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

export type Handler = (
  args: HandlerArgs,
) => HandlerResult | Promise<HandlerResult>;

/** An explicit Exists answers yes or no. */
export type ExistsHandler = (
  args: HandlerArgs,
) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// The description model and its three faces
// ---------------------------------------------------------------------------

/** `ikigai_core::ActionSpec`: one verb's contract. */
export interface ActionSpecModel {
  readonly verb: Verb;
  readonly summary: string;
  readonly inputs: readonly ArgSpec[];
  readonly outputs: readonly string[];
  readonly requires: readonly string[];
}

/** `ikigai_core::Description`, the fields this peer emits. */
export interface DescriptionModel {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly verbs: readonly Verb[];
  readonly inputs: readonly ArgSpec[];
  readonly outputs: readonly string[];
  readonly requires: readonly string[];
  /** Explicit per-verb contracts; empty for the flat single-verb form. */
  readonly actions: readonly ActionSpecModel[];
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
    }
  );
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
  if (d.actions.length > 0) {
    out["actions"] = d.actions.map((a) => {
      const action: Record<string, unknown> = { verb: verbName(a.verb) };
      if (a.summary) action["summary"] = a.summary;
      if (a.inputs.length > 0) {
        action["inputs"] = a.inputs.map((i) => i.toJson());
      }
      if (a.outputs.length > 0) action["outputs"] = [...a.outputs];
      if (a.requires.length > 0) action["requires"] = [...a.requires];
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
 * verb. A synthesized action REFERENCES the flat input nodes; an explicit
 * action gets its own action-scoped input nodes.
 */
function descriptionTurtle(d: DescriptionModel): string {
  const lit = (s: string): string =>
    '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
  const capTerm = (scope: string): string =>
    scope.startsWith("urn:") || scope.startsWith("http://") ||
      scope.startsWith("https://")
      ? `<${scope}>`
      : lit(scope);
  const inputPredicates = (arg: ArgSpec): string => {
    let node = `ik:inputName ${lit(arg.name)} ;\n` +
      `    ik:source ${lit(arg.source)} ;\n` +
      `    ik:required ${arg.required ? "true" : "false"}`;
    if (arg.summary) node += ` ;\n    ik:summary ${lit(arg.summary)}`;
    if (arg.cls !== null) node += ` ;\n    ik:class <${arg.cls}>`;
    if (arg.default !== null) node += ` ;\n    ik:default ${lit(arg.default)}`;
    for (const value of arg.oneOf) node += ` ;\n    ik:oneOf ${lit(value)}`;
    return node;
  };

  const endpointIri = `urn:ikigai:endpoint:${d.id}`;
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

  const extraNodes: string[] = [];
  for (const arg of d.inputs) {
    const nodeIri = `${endpointIri}:input:${arg.name}`;
    preds.push(`ik:input <${nodeIri}>`);
    extraNodes.push(`<${nodeIri}> ${inputPredicates(arg)} .`);
  }

  for (const action of actionSpecs(d)) {
    const verb = verbName(action.verb);
    const actionIri = `${endpointIri}:action:${verb.toLowerCase()}`;
    preds.push(`ik:action <${actionIri}>`);
    const actionPreds = ["a ik:Action", `ik:verb ${lit(verb)}`];
    if (action.summary) actionPreds.push(`ik:summary ${lit(action.summary)}`);
    for (const output of action.outputs) {
      actionPreds.push(`ik:output ${lit(output)}`);
    }
    for (const cap of action.requires) {
      actionPreds.push(`ik:requires ${capTerm(cap)}`);
    }
    const synthesized = !d.actions.some((a) => a.verb === action.verb);
    for (const arg of action.inputs) {
      let nodeIri: string;
      if (synthesized) {
        nodeIri = `${endpointIri}:input:${arg.name}`;
      } else {
        nodeIri = `${actionIri}:input:${arg.name}`;
        extraNodes.push(`<${nodeIri}> ${inputPredicates(arg)} .`);
      }
      actionPreds.push(`ik:input <${nodeIri}>`);
    }
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
): Promise<Reply> {
  let result: HandlerResult;
  try {
    result = await handler(args);
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
  readonly template: UriTemplate;
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** One required `binding` input per template variable (empty if exact). */
  readonly bindings: readonly ArgSpec[];
  readonly #aliasTemplate: UriTemplate | null;

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

  /**
   * The bindings if `target` is this door's IRI (either form), else null.
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
  ): Promise<Reply>;

  /** The verbs this door answers, for a refusal that names them. */
  protected abstract answeredVerbs(): Verb[];

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

export interface EndpointOptions {
  id?: string;
  title?: string;
  summary?: string;
  args?: (string | ArgSpecInput | ArgSpec)[];
  /** Descriptions of the template's variables, when the IRI is a template. */
  bindings?: Record<string, BindingSpecInput>;
  output?: string;
  /**
   * Marks the result a pure function of its inputs (`Expiry::Never`) — the
   * HOST kernel then caches it.
   */
  cacheable?: boolean;
  requires?: string[];
}

/** A served single-verb Source endpoint: a handler plus its self-description. */
export class EndpointDef extends ServedDef {
  readonly handler: Handler;
  readonly args: readonly ArgSpec[];
  readonly output: string;
  readonly cacheable: boolean;
  readonly requires: readonly string[];

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

  protected answeredVerbs(): Verb[] {
    return [Verb.Source, Verb.Exists, Verb.Meta];
  }

  async answer(
    request: Request,
    bindings: Readonly<Record<string, string>>,
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
  summary?: string;
  /** By-value arguments (the template's variables are added for you). */
  args?: (string | ArgSpecInput | ArgSpec)[];
  output?: string;
  /** Capability scopes this verb requires (declared per verb, as in core). */
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
  cacheable?: boolean;
}

export interface FamilyOptions {
  id?: string;
  title?: string;
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
 * const cell = family("urn:ts:stored:{x}:{y}", { id: "stored" })
 *   .source({ cacheable: true }, ({ x, y }) => read(x, y))
 *   .sink({}, ({ x, y, content }) => write(x, y, content))
 *   .delete({}, ({ x, y }) => clear(x, y));
 * ```
 */
export class Family extends ServedDef {
  readonly #actions = new Map<Verb, ActionDef>();

  constructor(pattern: string, options: FamilyOptions = {}) {
    super(pattern, options, defaultId(pattern));
  }

  /** Declare the Source verb. */
  source(handler: Handler): this;
  source(options: SourceOptions, handler: Handler): this;
  source(a: SourceOptions | Handler, b?: Handler): this {
    const [options, handler] = typeof a === "function" ? [{}, a] : [a, b!];
    return this.#declare(Verb.Source, options, handler, options.cacheable);
  }

  /** Declare the Sink verb; the body arrives as `content`. */
  sink(handler: Handler): this;
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
  delete(options: ActionOptions, handler: Handler): this;
  delete(a: ActionOptions | Handler, b?: Handler): this {
    const [options, handler] = typeof a === "function" ? [{}, a] : [a, b!];
    return this.#declare(Verb.Delete, options, handler, false);
  }

  /** Declare an explicit Exists (else it is derived from Source). */
  exists(handler: ExistsHandler): this;
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

  protected answeredVerbs(): Verb[] {
    const verbs = this.verbs;
    if (!verbs.includes(Verb.Exists) && verbs.includes(Verb.Source)) {
      verbs.push(Verb.Exists);
    }
    return [...VERB_ORDER.filter((v) => verbs.includes(v)), Verb.Meta];
  }

  async answer(
    request: Request,
    bindings: Readonly<Record<string, string>>,
  ): Promise<Reply> {
    const action = this.#actions.get(request.verb);
    if (request.verb === Verb.Exists) {
      if (action !== undefined) {
        return await this.#explicitExists(action, request, bindings);
      }
      const source = this.#actions.get(Verb.Source);
      if (source === undefined) return this.refuse(request.verb);
      const reply = await this.#run(source, request, bindings);
      if (reply.kind === "resolved") {
        return booleanReply(true, source.cacheable);
      }
      if (reply.kind === "errorTyped" && reply.failure.kind === "notFound") {
        return booleanReply(false, source.cacheable);
      }
      return reply;
    }
    if (action === undefined) return this.refuse(request.verb);
    return await this.#run(action, request, bindings);
  }

  async #run(
    action: ActionDef,
    request: Request,
    bindings: Readonly<Record<string, string>>,
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
    );
  }

  async #explicitExists(
    action: ActionDef,
    request: Request,
    bindings: Readonly<Record<string, string>>,
  ): Promise<Reply> {
    const routed = routeArgs(bindings, action.args, request);
    if ("refused" in routed) return routed.refused;
    try {
      return booleanReply(await action.exists!(routed.args), action.cacheable);
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

/**
 * The served resolution space: door lookup + call dispatch.
 *
 * Doors are tried in DECLARATION ORDER and the first whose pattern matches
 * the target answers (each door tries its declared form, then its
 * alias-stripped form) — core `EndpointSpace`'s rule, so an exact door
 * declared after a template that also matches it is shadowed, exactly as
 * it would be in a Rust kernel. Two doors declaring the SAME pattern text
 * (in either form) are refused at construction.
 */
export class Space {
  readonly stripAlias: boolean;
  #defs: readonly ServedDef[];

  constructor(
    endpoints: readonly ServedDef[],
    options: { stripAlias?: boolean } = {},
  ) {
    this.stripAlias = options.stripAlias ?? true;
    const byPattern = new Map<string, ServedDef>();
    const bind = (pattern: string, d: ServedDef): void => {
      const held = byPattern.get(pattern);
      if (held !== undefined && held !== d) {
        throw new Error(
          `two endpoints answer ${pattern}: ${held.id} and ${d.id}`,
        );
      }
      byPattern.set(pattern, d);
    };
    for (const d of endpoints) {
      bind(d.iri, d);
      const alias = d.aliasIri;
      if (alias !== null) bind(alias, d);
    }
    this.#defs = [...endpoints];
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
    if (call.kind === "issue" || call.kind === "issueAs") {
      return await this.#resolve(call.request);
    }
    // issueTraced
    const started = Date.now();
    const reply = await this.#resolve(call.request);
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

  /** The first door (in declaration order) matching `target`, if any. */
  lookup(
    target: string,
  ): { def: ServedDef; bindings: Record<string, string> } | null {
    for (const def of this.#defs) {
      const bindings = def.match(target);
      if (bindings !== null) return { def, bindings };
    }
    return null;
  }

  async #resolve(request: Request): Promise<Reply> {
    const hit = this.lookup(request.target);
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
    return await hit.def.answer(request, hit.bindings);
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
  readonly space: Space;
  readonly path: string;
  #listener: Deno.UnixListener;
  #conns = new Set<Deno.UnixConn>();
  #closing = false;

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
    // The FIRST frame must be the hello (wire v7): it is answered with ours
    // — equal versions proceed (and its mode picks this connection's
    // entries form), unequal versions get the answer (so the client names
    // both in its error) and a close. A frame WITHOUT the magic is a
    // pre-v6 client; it is REFUSED (the v6 serve-it-anyway tolerance is
    // over — this fleet updates together).
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
    try {
      await stream.writeFrame(
        wire.encodeHello(wire.hello(wire.PROTOCOL_VERSION)),
      );
    } catch {
      return;
    }
    if (hello.version !== wire.PROTOCOL_VERSION) {
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
      if (!(await this.#serveOneFrame(stream, frame, stripAlias))) return;
    }
  }

  /** Decode and answer one Call frame; `false` ends the connection. */
  async #serveOneFrame(
    stream: FrameStream,
    frame: Uint8Array,
    stripAlias: boolean,
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
      await stream.writeFrame(
        wire.encodeReply(await this.space.dispatch(call, stripAlias)),
      );
    } catch {
      return false;
    }
    return true;
  }

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
