/**
 * The client: drive a running ikigai kernel over its Unix domain socket.
 *
 * The front door for scripts and Deno programs:
 *
 * ```ts
 * import { connect } from "@ikigai/wire/client";
 *
 * await using k = await connect();
 * const rep = await k.source("urn:fn:toUpper", { in: "hi" });
 * rep.text; // "HI"
 * ```
 *
 * Errors surface as exceptions carrying the server's error string (with the
 * `endpoint error: ` prefix stripped, the way the Rust wire clients do); the
 * wire does not yet carry a structured error taxonomy, so none is fabricated
 * here.
 */

import * as wire from "./wire.ts";
import {
  type ArgRef,
  type Call,
  Capability,
  EndpointError,
  FrameStream,
  HelloMode,
  ProtocolError,
  type Reply,
  type Representation,
  type Request,
  type SpaceEntry,
  type TraceEvent,
  Verb,
  WireError,
} from "./wire.ts";

/**
 * Mirrors the Rust IPC client's DEFAULT_TIMEOUT: five minutes, because what
 * it bounds is SILENCE from the server, and for a long resolution the
 * silence IS the work (e.g. a large model loading before its first token).
 * A genuinely gone server usually fails fast anyway (connection refused,
 * EOF).
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** The kernel server is unreachable, hung past the timeout, or gone. */
export class ConnectionLost extends WireError {}

/**
 * The per-user socket path the Rust CLI serves on by default:
 * `<runtime-dir>/ikigai/kernel.sock` where `<runtime-dir>` is
 * `$XDG_RUNTIME_DIR` when set, else `$TMPDIR`/`/tmp` plus the uid.
 */
export function defaultSocketPath(): string {
  const runtime = Deno.env.get("XDG_RUNTIME_DIR");
  if (runtime) return `${runtime}/ikigai/kernel.sock`;
  const tmp = (Deno.env.get("TMPDIR") ?? "/tmp").replace(/\/$/, "");
  return `${tmp}/ikigai-${Deno.uid()}/ikigai/kernel.sock`;
}

/** What an argument may be passed as. */
export type ArgValue = string | number | boolean | Uint8Array | ArgRef;

export type Args = Record<string, ArgValue>;

/**
 * An argument value as an `ArgRef`: pass `reference`/`inline`/`content`
 * through; encode strings and bytes inline; render booleans the way the REPL
 * grammar does (`true`/`false`) and numbers via `String`.
 */
export function coerceArg(value: ArgValue): ArgRef {
  if (typeof value === "string") return wire.inline(value);
  if (value instanceof Uint8Array) return wire.inline(value);
  if (typeof value === "boolean") return wire.inline(value ? "true" : "false");
  if (typeof value === "number") return wire.inline(String(value));
  return value;
}

export function buildRequest(verb: Verb, iri: string, args: Args): Request {
  const coerced: Record<string, ArgRef> = {};
  for (const [name, value] of Object.entries(args)) {
    coerced[name] = coerceArg(value);
  }
  return { verb, target: iri, args: coerced };
}

export interface ConnectOptions {
  /**
   * When set, requests go as `Call::IssueAs` under this capability (which
   * the server clamps to its authenticated principal).
   */
  capability?: Capability;
  /**
   * Bounds each round trip's silence; `null` waits forever. Default
   * {@linkcode DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number | null;
  /**
   * The hello's addressing hint — a plain client is verbatim; only an alias
   * mount says otherwise.
   */
  mode?: HelloMode;
}

/**
 * A connected kernel client. The wire is strictly call/reply per connection
 * (like the Rust `IpcResolver`), so concurrent calls are serialized
 * internally — awaiting two sources at once is safe, just sequential.
 */
export class Client {
  #conn: Deno.UnixConn;
  #stream: FrameStream;
  #timeoutMs: number | null;
  #timedOut = false;
  #closed = false;
  #chain: Promise<unknown> = Promise.resolve();
  /**
   * When set, requests go as `Call::IssueAs` under this capability (which
   * the server clamps to its authenticated principal).
   */
  capability: Capability | null;
  /**
   * The version the server declared in its hello, or `null` for a legacy
   * (<= v5) server reached through the fallback.
   */
  readonly serverVersion: number | null;

  constructor(
    conn: Deno.UnixConn,
    stream: FrameStream,
    options: {
      capability?: Capability;
      timeoutMs?: number | null;
      serverVersion?: number | null;
    } = {},
  ) {
    this.#conn = conn;
    this.#stream = stream;
    this.#timeoutMs = options.timeoutMs === undefined
      ? DEFAULT_TIMEOUT_MS
      : options.timeoutMs;
    this.capability = options.capability ?? null;
    this.serverVersion = options.serverVersion === undefined
      ? wire.PROTOCOL_VERSION
      : options.serverVersion;
  }

  // -- transport ---------------------------------------------------------

  async #roundTripNow(call: Call): Promise<Reply> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.#timeoutMs !== null) {
      timer = setTimeout(() => {
        // A Deno read cannot be cancelled directly; closing the connection
        // rejects it, and #timedOut names the reason.
        this.#timedOut = true;
        try {
          this.#conn.close();
        } catch {
          // already closed
        }
      }, this.#timeoutMs);
    }
    try {
      await this.#stream.writeFrame(wire.encodeCall(call));
      return wire.decodeReply(await this.#stream.readFrame());
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      if (this.#timedOut) {
        throw new ConnectionLost(
          "no response from the kernel server (it may be hung or gone)",
        );
      }
      throw new ConnectionLost(`the kernel server is unreachable: ${e}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Serialize round trips: the wire is one call/reply at a time. */
  #roundTrip(call: Call): Promise<Reply> {
    const next = this.#chain.then(
      () => this.#roundTripNow(call),
      () => this.#roundTripNow(call),
    );
    this.#chain = next.catch(() => {});
    return next;
  }

  async #issue(request: Request): Promise<Representation> {
    const call: Call = this.capability === null
      ? { kind: "issue", request }
      : { kind: "issueAs", request, capability: this.capability };
    const reply = await this.#roundTrip(call);
    if (reply.kind === "resolved") {
      reply.representation.cacheStatus = reply.cacheStatus;
      return reply.representation;
    }
    if (reply.kind === "error") {
      throw new EndpointError(wire.decodeErrorMessage(reply.message));
    }
    throw new ProtocolError(`unexpected reply to ${call.kind}: ${reply.kind}`);
  }

  // -- the five verbs ----------------------------------------------------

  /** Read a resource's representation. */
  source(iri: string, args: Args = {}): Promise<Representation> {
    return this.#issue(buildRequest(Verb.Source, iri, args));
  }

  /**
   * Write to a resource. `value` rides as the `content` argument — the wire
   * convention for the piped value (the Rust engine does the same for
   * `… | sink <iri>`).
   */
  sink(
    iri: string,
    value?: string | Uint8Array,
    args: Args = {},
  ): Promise<Representation> {
    const all = value === undefined ? args : { ...args, content: value };
    return this.#issue(buildRequest(Verb.Sink, iri, all));
  }

  /**
   * Test for a resource's existence. The representation is whatever the
   * bound endpoint answers (conventionally `true`/`false` text).
   */
  exists(iri: string, args: Args = {}): Promise<Representation> {
    return this.#issue(buildRequest(Verb.Exists, iri, args));
  }

  /** Remove a resource. */
  delete(iri: string, args: Args = {}): Promise<Representation> {
    return this.#issue(buildRequest(Verb.Delete, iri, args));
  }

  /**
   * Read a resource's self-description, rendered `as` a media type (the
   * server's default face is `text/turtle`).
   */
  meta(iri: string, as?: string, args: Args = {}): Promise<Representation> {
    const all = as === undefined ? args : { ...args, as: as };
    return this.#issue(buildRequest(Verb.Meta, iri, all));
  }

  // -- sugar -------------------------------------------------------------

  /**
   * The structured self-description (Meta rendered as JSON), parsed — the
   * same face the Rust engine uses to route named arguments. `null` when the
   * endpoint has none or the face isn't JSON-renderable.
   */
  async describe(iri: string): Promise<Record<string, unknown> | null> {
    let representation: Representation;
    try {
      representation = await this.meta(iri, "application/json");
    } catch (e) {
      if (e instanceof EndpointError) return null;
      throw e;
    }
    try {
      return JSON.parse(representation.text);
    } catch {
      return null;
    }
  }

  /**
   * The catalog: every binding the server's space enumerates (already
   * capability-scoped by the server). `null` if the space does not support
   * enumeration.
   */
  async entries(): Promise<SpaceEntry[] | null> {
    const reply = await this.#roundTrip({ kind: "entries" });
    if (reply.kind === "entries") {
      return reply.entries === null ? null : [...reply.entries];
    }
    if (reply.kind === "error") {
      throw new EndpointError(wire.decodeErrorMessage(reply.message));
    }
    throw new ProtocolError(`unexpected reply to entries: ${reply.kind}`);
  }

  /**
   * Whether sourcing `iri` with these args would be served from the
   * server's cache. (The probe runs under the server's own authority; the
   * wire does not carry the caller's capability for this call.)
   */
  async isCached(iri: string, args: Args = {}): Promise<boolean> {
    const reply = await this.#roundTrip({
      kind: "isCached",
      request: buildRequest(Verb.Source, iri, args),
    });
    return reply.kind === "cached" && reply.cached;
  }

  /**
   * Source a resource AND record the resolution: returns the representation
   * plus the server's trace spans (the execution tree — `(span, parent)`
   * edges, per-node cache outcome and authority).
   */
  async sourceTraced(
    iri: string,
    args: Args = {},
  ): Promise<[Representation, TraceEvent[]]> {
    const reply = await this.#roundTrip({
      kind: "issueTraced",
      request: buildRequest(Verb.Source, iri, args),
      capability: this.capability ?? Capability.root(),
      context: { traceId: 1, parentSpan: null },
    });
    if (reply.kind === "resolvedTraced") {
      reply.representation.cacheStatus = reply.cacheStatus;
      return [reply.representation, [...reply.events]];
    }
    if (reply.kind === "error") {
      throw new EndpointError(wire.decodeErrorMessage(reply.message));
    }
    throw new ProtocolError(`unexpected reply to issueTraced: ${reply.kind}`);
  }

  // -- lifecycle ---------------------------------------------------------

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // already closed (e.g. by a timeout)
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.close();
    return Promise.resolve();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Connect to a kernel server's Unix socket. `path` defaults to the same
 * per-user location the Rust CLI uses.
 *
 * The version hello (wire v6) is the first frame each way. A <= v5 Rust
 * server cannot answer it — it drops the connection silently — so an EOF
 * here means "legacy server": reconnect WITHOUT the hello and warn (the
 * one-version tolerance the design doc removes at v7). A mismatch from a
 * hello-speaking server errors immediately, naming both versions.
 */
export async function connect(
  path?: string,
  options: ConnectOptions = {},
): Promise<Client> {
  const socketPath = path ?? defaultSocketPath();
  const mode = options.mode ?? HelloMode.Verbatim;
  let conn = await dial(socketPath);
  let stream = new FrameStream(conn);
  let serverVersion: number | null = wire.PROTOCOL_VERSION;
  let answer: wire.Hello | null;
  try {
    await stream.writeFrame(
      wire.encodeHello(wire.hello(wire.PROTOCOL_VERSION, mode)),
    );
    answer = wire.decodeHello(await stream.readFrame());
  } catch (e) {
    if (e instanceof ProtocolError) {
      conn.close();
      throw e;
    }
    conn.close();
    console.error(
      `ikigai: the kernel server at ${socketPath} hung up on the version ` +
        "hello — it likely predates wire v6; reconnected WITHOUT the hello " +
        "(tolerated until v7). Update the server.",
    );
    conn = await dial(socketPath);
    stream = new FrameStream(conn);
    serverVersion = null;
    answer = null;
  }
  if (serverVersion !== null) {
    if (answer === null) {
      conn.close();
      throw new ProtocolError(
        "the kernel server answered the version hello with something else " +
          "entirely",
      );
    }
    if (answer.version !== wire.PROTOCOL_VERSION) {
      conn.close();
      throw new ProtocolError(
        `the kernel server speaks wire v${answer.version}, this client ` +
          `speaks v${wire.PROTOCOL_VERSION} — update the older side`,
      );
    }
  }
  return new Client(conn, stream, {
    capability: options.capability,
    timeoutMs: options.timeoutMs,
    serverVersion,
  });
}

async function dial(path: string): Promise<Deno.UnixConn> {
  try {
    return await Deno.connect({ transport: "unix", path });
  } catch (e) {
    throw new ConnectionLost(
      `cannot reach a kernel server at ${path} (${e}); ` +
        "is `ikigai serve` (or the daemon) running?",
    );
  }
}
