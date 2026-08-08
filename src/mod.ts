/**
 * ikigai-deno: a zero-dependency TypeScript (Deno-first) client and servable
 * peer for the ikigai wire protocol over Unix domain sockets.
 *
 * L0 of the polyglot ladder — no Rust, no core changes. A Deno process can
 * *drive* a running ikigai kernel:
 *
 * ```ts
 * import { connect } from "@ikigai/wire";
 *
 * await using k = await connect();
 * const rep = await k.source("urn:fn:toUpper", { in: "hi" });
 * rep.text; // "HI"
 * ```
 *
 * …and a Deno process can *be* resources that a Rust host mounts:
 *
 * ```ts
 * import { endpoint, serve } from "@ikigai/wire";
 *
 * const hello = endpoint("urn:ts:hello", {
 *   summary: "Greet someone",
 *   args: [{ name: "who", required: true,
 *            class: "http://www.w3.org/2001/XMLSchema#string" }],
 * }, ({ who }) => `Hello, ${who}!`);
 *
 * await serve([hello], "/tmp/ts.sock");
 * ```
 *
 * A binding = client + servable peer space; the module mechanism IS
 * mount-over-wire.
 */

export {
  CacheStatus,
  Capability,
  content,
  decodeErrorMessage,
  DeniedError,
  EndpointError,
  EofError,
  Expiry,
  HelloMode,
  inline,
  InvalidArgumentError,
  MAX_FRAME,
  MissingArgumentError,
  NotFoundError,
  PROTOCOL_VERSION,
  ProtocolError,
  reference,
  Representation,
  TimeoutError,
  toWireFailure,
  typedError,
  UnavailableError,
  UnresolvedError,
  Verb,
  WireError,
} from "./wire.ts";
export type {
  ArgRef,
  Call,
  Content,
  Hello,
  Inline,
  Reference,
  Reply,
  Request,
  SpaceEntry,
  TraceContext,
  TraceEvent,
  WireFailure,
} from "./wire.ts";

export {
  Client,
  coerceArg,
  connect,
  ConnectionLost,
  DEFAULT_TIMEOUT_MS,
  defaultSocketPath,
} from "./client.ts";
export type { Args, ArgValue, ConnectOptions } from "./client.ts";

export {
  ArgSpec,
  endpoint,
  EndpointDef,
  serve,
  Server,
  Space,
} from "./serve.ts";
export type {
  ArgSpecInput,
  EndpointOptions,
  Handler,
  HandlerArgs,
  HandlerResult,
} from "./serve.ts";
