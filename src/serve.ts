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
 * **Alias mounts strip the prefix.** `--mount urn:ts:=<socket>` rewrites
 * `urn:ts:hello` to `urn:hello` before forwarding, and re-prefixes catalog
 * patterns coming back. This server therefore answers BOTH the declared IRI
 * and its alias-stripped form. Since wire v6 the client's hello says which
 * form its `entries` wants, per connection — and since v7 the hello is
 * REQUIRED (a first frame without it is refused), so every served
 * connection's form is known, never guessed.
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

export const VOCAB_NS = "https://ikigai-rs.dev/ns#";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** The spec-object form an argument declaration may take. */
export interface ArgSpecInput {
  name: string;
  summary?: string;
  required?: boolean;
  /** rdfs:Class IRI for entities, XSD datatype IRI for scalars. */
  class?: string;
  default?: string;
  oneOf?: string[];
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

  constructor(spec: string | ArgSpecInput | ArgSpec) {
    if (spec instanceof ArgSpec) {
      this.name = spec.name;
      this.summary = spec.summary;
      this.required = spec.required;
      this.cls = spec.cls;
      this.default = spec.default;
      this.oneOf = spec.oneOf;
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
      source: "argument",
    };
    if (this.cls !== null) out["class"] = this.cls;
    if (this.default !== null) out["default"] = this.default;
    if (this.oneOf.length > 0) out["one_of"] = [...this.oneOf];
    return out;
  }
}

/** What a handler may return (optionally wrapped in a Promise). */
export type HandlerResult =
  | string
  | Uint8Array
  | [string | Uint8Array, string]
  | Representation;

/** Arguments arrive utf-8 decoded (bytes when not valid utf-8). */
export type HandlerArgs = Record<string, string | Uint8Array>;

export type Handler = (
  args: HandlerArgs,
) => HandlerResult | Promise<HandlerResult>;

export interface EndpointOptions {
  id?: string;
  title?: string;
  summary?: string;
  args?: (string | ArgSpecInput | ArgSpec)[];
  output?: string;
  /**
   * Marks the result a pure function of its inputs (`Expiry::Never`) — the
   * HOST kernel then caches it.
   */
  cacheable?: boolean;
  requires?: string[];
}

/** A served endpoint: a handler plus its self-description. */
export class EndpointDef {
  readonly handler: Handler;
  readonly iri: string;
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly args: readonly ArgSpec[];
  readonly output: string;
  readonly cacheable: boolean;
  readonly requires: readonly string[];

  constructor(handler: Handler, iri: string, options: EndpointOptions = {}) {
    if (!iri.startsWith("urn:")) {
      throw new Error(`endpoint IRI must be a urn: (${iri})`);
    }
    this.handler = handler;
    this.iri = iri;
    // TS erases names more readily than Python (an inline arrow has none),
    // so the default id is the IRI's last segment, not the function name.
    this.id = options.id ??
      (handler.name || iri.slice(iri.lastIndexOf(":") + 1));
    this.title = options.title ?? "";
    this.summary = options.summary ?? "";
    this.args = (options.args ?? []).map((a) => new ArgSpec(a));
    this.output = options.output ?? "text/plain;charset=utf-8";
    this.cacheable = options.cacheable ?? false;
    this.requires = [...(options.requires ?? [])];
  }

  /**
   * The alias-stripped form an alias mount forwards: `urn:ts:hello` arrives
   * as `urn:hello` after `--mount urn:ts:=…` strips its prefix. `null` when
   * the IRI has no namespace segment to strip.
   */
  get aliasIri(): string | null {
    const first = this.iri.indexOf(":");
    const second = this.iri.indexOf(":", first + 1);
    if (second < 0) return null;
    return `urn:${this.iri.slice(second + 1)}`;
  }

  // -- the Meta faces ----------------------------------------------------

  /**
   * The serde shape of `ikigai_core::Description` — the face the host's
   * engine parses to route named arguments over a mount.
   */
  descriptionJson(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: this.id,
      title: this.title,
      summary: this.summary,
      verbs: ["Source", "Meta"],
      inputs: this.args.map((a) => a.toJson()),
      outputs: [this.output],
    };
    if (this.requires.length > 0) out["requires"] = [...this.requires];
    return out;
  }

  /** The human face (mirrors `ikigai_vocab::to_text`). */
  descriptionText(): string {
    let s = `${this.id} — ${this.title}\n`;
    if (this.summary) s += `${this.summary}\n`;
    s += "verbs: Source, Meta\n";
    for (const arg of this.args) {
      const opt = arg.required ? "" : " (optional)";
      s += `  input ${arg.name} [argument]${opt}: ${arg.summary}\n`;
    }
    s += `outputs: ${this.output}\n`;
    return s;
  }

  /**
   * The graph face (mirrors `ikigai_vocab::to_turtle`): skolemized node
   * IRIs, no blank nodes, the shared `ik:` vocabulary.
   */
  descriptionTurtle(): string {
    const lit = (s: string): string =>
      '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
    const capTerm = (scope: string): string =>
      scope.startsWith("urn:") || scope.startsWith("http://") ||
        scope.startsWith("https://")
        ? `<${scope}>`
        : lit(scope);

    const endpointIri = `urn:ikigai:endpoint:${this.id}`;
    const preds: string[] = ["a ik:Endpoint", `ik:id ${lit(this.id)}`];
    if (this.title) preds.push(`ik:title ${lit(this.title)}`);
    if (this.summary) preds.push(`ik:summary ${lit(this.summary)}`);
    preds.push('ik:verb "Source", "Meta"');
    preds.push(`ik:output ${lit(this.output)}`);
    if (this.requires.length > 0) {
      preds.push(
        "ik:requires " + this.requires.map((c) => capTerm(c)).join(", "),
      );
    }

    const extraNodes: string[] = [];

    const inputPredicates = (arg: ArgSpec): string => {
      let node = `ik:inputName ${lit(arg.name)} ;\n` +
        `    ik:source "argument" ;\n` +
        `    ik:required ${arg.required ? "true" : "false"}`;
      if (arg.summary) node += ` ;\n    ik:summary ${lit(arg.summary)}`;
      if (arg.cls !== null) node += ` ;\n    ik:class <${arg.cls}>`;
      if (arg.default !== null) {
        node += ` ;\n    ik:default ${lit(arg.default)}`;
      }
      for (const value of arg.oneOf) node += ` ;\n    ik:oneOf ${lit(value)}`;
      return node;
    };

    for (const arg of this.args) {
      const nodeIri = `${endpointIri}:input:${arg.name}`;
      preds.push(`ik:input <${nodeIri}>`);
      extraNodes.push(`<${nodeIri}> ${inputPredicates(arg)} .`);
    }

    // The synthesized Source action (the flat form's per-verb view),
    // referencing the same input nodes.
    const actionIri = `${endpointIri}:action:source`;
    preds.push(`ik:action <${actionIri}>`);
    const actionPreds = ["a ik:Action", 'ik:verb "Source"'];
    actionPreds.push(`ik:output ${lit(this.output)}`);
    for (const cap of this.requires) {
      actionPreds.push(`ik:requires ${capTerm(cap)}`);
    }
    for (const arg of this.args) {
      actionPreds.push(`ik:input <${endpointIri}:input:${arg.name}>`);
    }
    extraNodes.push(`<${actionIri}> ` + actionPreds.join(" ;\n    ") + " .");

    let ttl = `@prefix ik: <${VOCAB_NS}> .\n\n<${endpointIri}> ` +
      preds.join(" ;\n    ") + " .\n";
    for (const node of extraNodes) ttl += `\n${node}\n`;
    return ttl;
  }
}

/**
 * Declare a function as a single-verb Source endpoint. The ArgSpecs are
 * explicit spec data in L0 (TS types are erased at runtime; a schema-derived
 * layer is a later ergonomic rung) but they are REAL: the host engine routes
 * `key=value` arguments by this declaration.
 */
export function endpoint(
  iri: string,
  options: EndpointOptions,
  handler: Handler,
): EndpointDef {
  return new EndpointDef(handler, iri, options);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

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

/** The served resolution space: endpoint lookup + call dispatch. */
export class Space {
  readonly stripAlias: boolean;
  #byTarget = new Map<string, EndpointDef>();
  #defs: readonly EndpointDef[];

  constructor(
    endpoints: readonly EndpointDef[],
    options: { stripAlias?: boolean } = {},
  ) {
    this.stripAlias = options.stripAlias ?? true;
    for (const d of endpoints) {
      this.#bind(d.iri, d);
      const alias = d.aliasIri;
      if (alias !== null) this.#bind(alias, d);
    }
    this.#defs = [...endpoints];
  }

  #bind(target: string, d: EndpointDef): void {
    const held = this.#byTarget.get(target);
    if (held !== undefined && held !== d) {
      throw new Error(`two endpoints answer ${target}: ${held.id} and ${d.id}`);
    }
    this.#byTarget.set(target, d);
  }

  /**
   * `stripAlias === null` uses the space's configured default (direct
   * programmatic use); a served connection always passes its hello mode —
   * since v7 the hello is required, so the form is KNOWN per connection,
   * never guessed.
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

  async #resolve(request: Request): Promise<Reply> {
    const d = this.#byTarget.get(request.target);
    if (d === undefined) {
      // A real Unresolved (v7): the host-side client rebuilds the same
      // variant — and the same rendering — the Rust kernel would produce.
      return {
        kind: "errorTyped",
        failure: { kind: "unresolved", iri: request.target },
      };
    }
    if (request.verb === Verb.Meta) return this.#meta(d, request);
    if (request.verb === Verb.Exists) {
      return {
        kind: "resolved",
        representation: new Representation("true", "text/plain;charset=utf-8"),
        cacheStatus: CacheStatus.Uncacheable,
      };
    }
    if (request.verb !== Verb.Source) {
      return {
        kind: "errorTyped",
        failure: {
          kind: "endpoint",
          message: `verb ${verbName(request.verb)} is not ` +
            `supported by \`${d.id}\` (a single-verb Source endpoint)`,
        },
      };
    }
    return await this.#invoke(d, request);
  }

  async #invoke(d: EndpointDef, request: Request): Promise<Reply> {
    const args: HandlerArgs = {};
    for (const arg of d.args) {
      if (arg.name in request.args) {
        try {
          args[arg.name] = decodeArg(arg.name, request.args[arg.name]);
        } catch (e) {
          return { kind: "errorTyped", failure: toWireFailure(e) };
        }
      } else if (arg.default !== null) {
        args[arg.name] = arg.default;
      } else if (arg.required) {
        return {
          kind: "errorTyped",
          failure: { kind: "missingArgument", name: arg.name },
        };
      }
    }
    let result: HandlerResult;
    try {
      result = await d.handler(args);
    } catch (e) {
      // A handler failure crosses typed, never as a hang: the typed classes
      // map to their own taxonomy variants (a thrown NotFoundError IS a
      // NotFound on the host); anything else is an Endpoint error.
      return { kind: "errorTyped", failure: toWireFailure(e) };
    }
    return this.#representation(d, result);
  }

  #representation(d: EndpointDef, result: HandlerResult): Reply {
    let mediaType = d.output;
    let value: string | Uint8Array | Representation = result as
      | string
      | Uint8Array
      | Representation;
    if (Array.isArray(result)) {
      [value, mediaType] = result;
    }
    let rep: Representation;
    if (value instanceof Representation) {
      rep = value;
    } else {
      const expiry = d.cacheable ? Expiry.never() : Expiry.always();
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

  #meta(d: EndpointDef, request: Request): Reply {
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

  constructor(endpoints: readonly EndpointDef[], path: string) {
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
  endpoints: readonly EndpointDef[],
  path: string,
): Promise<void> {
  const server = new Server(endpoints, path);
  try {
    await server.serve();
  } finally {
    server.shutdown();
  }
}
