/**
 * The ikigai IPC wire protocol: types, postcard codec, framing, the hello,
 * and the typed error taxonomy.
 *
 * Mirrors `ikigai-wire` (Rust) at `PROTOCOL_VERSION` 8. The codec is
 * non-self-describing, so every type here restates a Rust layout
 * field-for-field; the Rust declaration is the normative source
 * (`ikigai-wire/src/lib.rs` and the `ikigai-core` types it serializes), and
 * ikigai-python (`src/ikigai/wire.py`) is the sister implementation this one
 * locks the same golden vectors with.
 *
 * Framing: a `u32` **big-endian** length header, then the postcard payload.
 * Frames above 64 MiB are rejected before allocation, both directions.
 *
 * Since v6 the connection opens with a **hello exchange** (see the Rust
 * `docs/wire-hello-design.md`): the first frame each way is
 * `"IKWH" + u32 BE version + u8 mode`, deliberately NOT postcard (the codec
 * whose version is being negotiated must not be needed to negotiate it), and
 * readers ignore trailing bytes — that is the extension mechanism. A version
 * mismatch is a clean error naming both sides instead of garbled postcard.
 * **Since v7 the hello is REQUIRED**: the v6 one-version tolerances (a client
 * reconnecting without the hello, a server serving a first frame without the
 * magic) are gone. A v6 peer still fails cleanly — the hello exchange itself
 * names both versions; only pre-v6 peers fail without explanation.
 *
 * v7 also adds `Reply::ErrorTyped`: the error TAXONOMY crosses the wire (see
 * {@linkcode WireFailure}), so a remote denial stays a permanent denial and a
 * remote timeout stays transient, instead of every failure flattening to one
 * string.
 *
 * **v8 is the first BACKWARD-COMPATIBLE bump.** It appends one taxonomy
 * variant — `Conflict`, variant 8 (see {@linkcode ConflictError}) — and
 * nothing else, so a flag day would have bought nothing but an outage. A v8
 * peer accepts a hello of {@linkcode MIN_PROTOCOL_VERSION} (7) or 8 and
 * answers with the PEER's version (anything else is refused); each connection
 * remembers it, and a v8 server never sends variant 8 to a v7 peer — it
 * downgrades `Conflict(msg)` to `Endpoint("conflict: {msg}")`, byte-identical
 * to what a v7 server sends for the same core error (see
 * {@linkcode replyForPeer}). A v7 SERVER answers a v8 hello with 7 and hangs
 * up (unequal versions close, under v7's rules), so a v8 client that hears 7
 * redials once, saying 7.
 *
 * @module
 */

import { DecodeError, Reader, Writer } from "./postcard.ts";
import { isAbsoluteIri } from "./iri.ts";

/**
 * Bumped in lockstep with the Rust `ikigai_wire::PROTOCOL_VERSION`. v5 era:
 * core 0.1.48 `TraceEvent.notes` changed the postcard layout of traced
 * replies. v6 adds the hello exchange (version + mount mode at open). v7 adds
 * `Reply::ErrorTyped` (the error taxonomy crosses, not a flat string) and
 * removes the v6 tolerances: the hello is required on both sides. v8 appends
 * `WireError::Conflict` (variant 8) and is backward compatible with v7 — see
 * {@linkcode MIN_PROTOCOL_VERSION}.
 */
export const PROTOCOL_VERSION = 8;

/**
 * The oldest peer version this side still speaks. A hello from here up to
 * {@linkcode PROTOCOL_VERSION} is served at the PEER's version; any other
 * hello (older, or newer than this side) is refused — answered with
 * {@linkcode PROTOCOL_VERSION}, so the peer can name both versions, then
 * closed.
 */
export const MIN_PROTOCOL_VERSION = 7;

/**
 * The version a connection runs at, given the peer's hello: the PEER's own
 * version when it lies in {@linkcode MIN_PROTOCOL_VERSION} ..=
 * {@linkcode PROTOCOL_VERSION}, else `null` — refused. The accepted answer
 * must echo the peer's version exactly, because a v7 client refuses any
 * answer but 7. A NEWER peer (9) is refused too, as the Rust and Python
 * halves refuse it: accepting upward is the newer side's job, which it does
 * by redialing at our version, the way this client redials a v7 server.
 *
 * ```ts
 * import { negotiateVersion } from "./wire.ts";
 * negotiateVersion(8); // 8
 * negotiateVersion(7); // 7 — a v7 peer is served at v7
 * negotiateVersion(6); // null — refused
 * negotiateVersion(9); // null — refused
 * ```
 */
export function negotiateVersion(peerVersion: number): number | null {
  if (
    peerVersion < MIN_PROTOCOL_VERSION || peerVersion > PROTOCOL_VERSION
  ) {
    return null;
  }
  return peerVersion;
}

/** The first wire version that carries `WireError::Conflict` (variant 8). */
export const CONFLICT_SINCE_VERSION = 8;

/**
 * The magic prefix of a hello payload; a first frame without it is a legacy
 * (<= v5) Call.
 */
export const HELLO_MAGIC: Uint8Array = new Uint8Array(
  [0x49, 0x4b, 0x57, 0x48], // "IKWH"
);

/** The largest framed message accepted (matches the Rust MAX_FRAME). */
export const MAX_FRAME = 64 * 1024 * 1024;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Base for everything this package throws on purpose. */
export class WireError extends Error {
  /**
   * `name` is set to the concrete subclass's own name, so a thrown error
   * prints as `DeniedError: …`, not `Error: …`.
   */
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A frame or message that violates the wire protocol — including a peer
 * speaking a different version whose messages do not decode (the hello
 * usually catches that first and names both versions).
 */
export class ProtocolError extends WireError {}

/**
 * A server-reported resolution failure. Since wire v7 the taxonomy crosses
 * the wire (`Reply::ErrorTyped`), so most failures arrive as one of the
 * subclasses below; a bare `EndpointError` is the `Endpoint` variant (a
 * handler failure), an unknown-future variant, or a legacy flat
 * `Reply::Error` string.
 *
 * `transient` mirrors `ikigai_core::Error::is_transient()`: `true` only for
 * {@linkcode TimeoutError} and {@linkcode UnavailableError} — re-issuing
 * might succeed. Permanent failures (denied, not found, bad arguments, a
 * state conflict) stay `false`: retrying will not conjure the resource or
 * the grant, nor change the state that refused.
 */
export class EndpointError extends WireError {
  /**
   * Whether re-issuing the same request might succeed — `false` here and on
   * every permanent subclass; only {@linkcode TimeoutError} and
   * {@linkcode UnavailableError} override it to `true`.
   */
  readonly transient: boolean = false;

  /**
   * The error as the Rust kernel's `Display` prints it (`impl fmt::Display
   * for ikigai_core::Error`): the variant's prefix, then the message. Each
   * subclass renders its own variant; this base is `Endpoint` (and an
   * unknown-future variant or a legacy flat string, which Rust also reads as
   * `Endpoint`).
   *
   * `message` stays the bare text the wire carries, so
   * {@linkcode toWireFailure} never sends the prefix twice. Use `display()`
   * where a person reads the error the way a Rust face would show it.
   *
   * ```ts
   * import { DeniedError, EndpointError, UnresolvedError } from "./wire.ts";
   * new EndpointError("boom").display(); // "endpoint error: boom"
   * new DeniedError("needs urn:cap:x").display(); // "denied: needs urn:cap:x"
   * new DeniedError("needs urn:cap:x").message; // "needs urn:cap:x"
   * new UnresolvedError("urn:x:y").display(); // "no endpoint resolved for urn:x:y"
   * ```
   */
  display(): string {
    return `endpoint error: ${this.message}`;
  }
}

/**
 * The kernel found no binding for the target IRI (`WireFailure` /
 * `ikigai_core::Error::Unresolved`). Distinct from {@linkcode NotFoundError}:
 * this is the KERNEL having nothing bound there, not a bound endpoint
 * reporting the fronted thing absent.
 */
export class UnresolvedError extends EndpointError {
  /** The target IRI nothing was bound to — what crosses the wire. */
  readonly iri: string;

  /**
   * The message is Rust's rendering, `no endpoint resolved for {iri}`; only
   * `iri` crosses the wire, and the receiver rebuilds the text from it.
   */
  constructor(iri: string) {
    super(`no endpoint resolved for ${iri}`);
    this.iri = iri;
  }

  /** Rust's Display for this variant is the message itself. */
  override display(): string {
    return this.message;
  }
}

/** A required argument was absent (`Error::MissingArgument`). */
export class MissingArgumentError extends EndpointError {
  /** The name of the absent argument — what crosses the wire. */
  readonly argument: string;

  /**
   * The message is Rust's rendering, ``missing required argument `{name}` ``;
   * only the name crosses the wire, and the receiver rebuilds the text.
   */
  constructor(argument: string) {
    super(`missing required argument \`${argument}\``);
    this.argument = argument;
  }

  /** Rust's Display for this variant is the message itself. */
  override display(): string {
    return this.message;
  }
}

/** An argument was present but unusable (`Error::InvalidArgument`). */
export class InvalidArgumentError extends EndpointError {
  /** The name of the argument that was refused. */
  readonly argument: string;
  /** Why it was refused, in the endpoint's words. */
  readonly detail: string;

  /**
   * The message is Rust's rendering,
   * ``invalid argument `{name}`: {detail}``; the name and the detail cross
   * the wire as two fields, and the receiver rebuilds the text.
   */
  constructor(argument: string, detail: string) {
    super(`invalid argument \`${argument}\`: ${detail}`);
    this.argument = argument;
    this.detail = detail;
  }

  /** Rust's Display for this variant is the message itself. */
  override display(): string {
    return this.message;
  }
}

/**
 * The capability did not authorize the operation (`Error::Denied`) — a
 * **permanent** denial. A failover must not paper over it with a weaker
 * local answer; an HTTP face says 403.
 */
export class DeniedError extends EndpointError {
  /** Rust's Display: `denied: {msg}`. */
  override display(): string {
    return `denied: ${this.message}`;
  }
}

/**
 * A bound endpoint reports the fronted thing absent (`Error::NotFound`) —
 * **permanent**; an HTTP face says 404.
 */
export class NotFoundError extends EndpointError {
  /** Rust's Display: `not found: {msg}`. */
  override display(): string {
    return `not found: ${this.message}`;
  }
}

/**
 * The request is well-formed and authorized and its target exists, but the
 * target's CURRENT STATE refuses it (`Error::Conflict`, core 0.1.80; wire
 * variant 8 since v8) — a move on an occupied square, a write that lost a
 * race. **Permanent**: re-issuing the same request against the same state
 * fails the same way, so a retry overlay must not retry it. An HTTP face
 * says 409. (A precondition the CALLER stated — `If-Match` — failing is 412,
 * not this.)
 *
 * The message is carried verbatim, like {@linkcode DeniedError}'s: the class
 * is the taxonomy. Only the downgrade to a v7 peer bakes a `conflict: `
 * prefix into text, because there the text is all that survives.
 */
export class ConflictError extends EndpointError {
  /** Rust's Display: `conflict: {msg}`. */
  override display(): string {
    return `conflict: ${this.message}`;
  }
}

/**
 * The remote operation exceeded its time budget (`Error::Timeout`) —
 * **transient**; retry/failover overlays may act. (This is the SERVER's
 * endpoint timing out; the client's own read deadline is `ConnectionLost`.)
 */
export class TimeoutError extends EndpointError {
  /** Always `true`: a timeout is the transient case a retry may cure. */
  override readonly transient: boolean = true;

  /** Rust's Display: `timeout: {msg}`. */
  override display(): string {
    return `timeout: ${this.message}`;
  }
}

/**
 * A dependency or transport behind the server is unavailable
 * (`Error::Unavailable`) — **transient**, like {@linkcode TimeoutError}.
 */
export class UnavailableError extends EndpointError {
  /** Always `true`: an unavailable dependency may come back. */
  override readonly transient: boolean = true;

  /** Rust's Display: `unavailable: {msg}`. */
  override display(): string {
    return `unavailable: ${this.message}`;
  }
}

/** A clean or mid-frame connection close while reading a frame. */
export class EofError extends WireError {}

// ---------------------------------------------------------------------------
// Core types (mirroring ikigai-core)
// ---------------------------------------------------------------------------

/**
 * Request verbs. Values are the **postcard variant indexes** (0-based
 * declaration order), not the `#[repr(u8)]` codes 1-5 — those exist only for
 * Rust-side identity hashing and never cross the wire.
 */
export enum Verb {
  Source = 0,
  Sink = 1,
  Exists = 2,
  Delete = 3,
  Meta = 4,
}

/** The serde name (used in JSON faces): `Source`, `Sink`, ... */
export function verbName(verb: Verb): string {
  return Verb[verb];
}

/** `ArgRef::Reference` — an argument by IRI. */
export interface Reference {
  /** The discriminant: postcard variant 0 of `ArgRef`. */
  readonly kind: "reference";
  /** The IRI the receiving kernel resolves to get the value. */
  readonly iri: string;
}

/** `ArgRef::Inline` — a small literal value carried inline. */
export interface Inline {
  /** The discriminant: postcard variant 1 of `ArgRef`. */
  readonly kind: "inline";
  /** The value's bytes, as sent (text travels UTF-8 encoded). */
  readonly data: Uint8Array;
}

/**
 * `ArgRef::Content` — a content-store id. On the wire this is the STRING
 * form `b3:<hex>` (Rust's `ContentId` serializes via
 * `#[serde(into = "String")]`), not the raw 32-byte digest.
 */
export interface Content {
  /** The discriminant: postcard variant 2 of `ArgRef`. */
  readonly kind: "content";
  /** The id in its string form, `b3:<hex>`. */
  readonly contentId: string;
}

/**
 * `ikigai_core::ArgRef`: how one named argument travels — by IRI, inline
 * bytes, or a content-store id. Build one with {@linkcode reference},
 * {@linkcode inline} or {@linkcode content}.
 */
export type ArgRef = Reference | Inline | Content;

/** An argument passed by IRI; the receiving kernel resolves it. */
export function reference(iri: string): Reference {
  return { kind: "reference", iri };
}

/**
 * An argument carried inline. A string is UTF-8 encoded; bytes are kept as
 * given (not copied).
 *
 * ```ts
 * import { assertEquals } from "@std/assert";
 * import { inline } from "./wire.ts";
 *
 * assertEquals(inline("hi"), {
 *   kind: "inline",
 *   data: new Uint8Array([0x68, 0x69]),
 * });
 * ```
 */
export function inline(data: Uint8Array | string): Inline {
  return {
    kind: "inline",
    data: typeof data === "string" ? utf8Encoder.encode(data) : data,
  };
}

/**
 * An argument by content-store id. Pass the STRING form, `b3:<hex>`: that
 * string is what crosses the wire, not the raw digest.
 */
export function content(contentId: string): Content {
  return { kind: "content", contentId };
}

/**
 * `ikigai_core::Request`: a verb, a target IRI, named arguments.
 *
 * Encoded as: verb enum, target (a plain string — `Iri` is a newtype), then
 * the args as a map sorted by key (UTF-8 byte order, matching Rust's
 * `BTreeMap<String, _>`).
 */
export interface Request {
  /** Which of the five verbs to apply. */
  readonly verb: Verb;
  /** The IRI to resolve. */
  readonly target: string;
  /**
   * Named arguments. Key order here does not matter: the encoder sorts them
   * by UTF-8 bytes, as Rust's `BTreeMap` does.
   */
  readonly args: Record<string, ArgRef>;
}

/**
 * `ikigai_core::Capability`: root, or a set of `urn:cap:` scopes.
 *
 * Layout: the struct holds one private enum `Kind` — variant 0 `Root`
 * (unit), variant 1 `Scoped(BTreeSet<String>)` (sorted strings).
 * `scopes === null` means root.
 */
export class Capability {
  /**
   * The granted `urn:cap:` scopes, or `null` for root. Set order is
   * irrelevant: the encoder sorts the scopes, as Rust's `BTreeSet` does.
   */
  readonly scopes: ReadonlySet<string> | null;

  private constructor(scopes: ReadonlySet<string> | null) {
    this.scopes = scopes;
  }

  /** Full authority (`Kind::Root`). */
  static root(): Capability {
    return new Capability(null);
  }

  /**
   * Authority limited to `scopes` (`Kind::Scoped`); duplicates collapse. An
   * empty set is a real capability that grants nothing, not root.
   */
  static scoped(scopes: Iterable<string>): Capability {
    return new Capability(new Set(scopes));
  }

  /** Whether this is the root capability (`scopes === null`). */
  get isRoot(): boolean {
    return this.scopes === null;
  }

  /**
   * Whether this capability grants `scope`, matched EXACTLY
   * (`Capability::allows` in core). Root grants everything. A scoped
   * capability grants a scope it holds, except that an exclusion
   * ({@linkcode isDenyScope}) is never granted, held or not, and a principal
   * scope (`urn:cap:principal:<iri>`) is granted only as the ONE principal the
   * capability carries: held beside another principal, neither is granted.
   *
   * This is the primitive, not the floor's predicate: a declared family scope
   * (`urn:cap:net:*`) wants {@linkcode Capability.satisfies}, and this method
   * answers `false` for every wildcard a scoped capability does not hold
   * literally.
   *
   * ```ts
   * import { assert } from "@std/assert";
   * import { Capability } from "./wire.ts";
   *
   * const cap = Capability.scoped(["urn:cap:fs:read:/root", "urn:cap:fs:read:-/root/secret"]);
   * assert(cap.allows("urn:cap:fs:read:/root"));
   * assert(!cap.allows("urn:cap:fs:read:-/root/secret")); // held, but an exclusion
   * assert(!cap.allows("urn:cap:fs:read:*")); // exact: the family form is `satisfies`
   * assert(Capability.root().allows("urn:cap:anything"));
   * ```
   */
  allows(scope: string): boolean {
    const held = this.scopes;
    if (held === null) return true;
    if (!held.has(scope) || isDenyScope(scope)) return false;
    const principal = principalIn(scope);
    return principal === null || singlePrincipal(held) === principal;
  }

  /**
   * Whether this capability satisfies one DECLARED scope, the way core's
   * kernel decides it at its capability floor (`Capability::satisfies`,
   * `select::cap_satisfies`): the predicate this peer's own floor uses.
   *
   * - A plain scope is {@linkcode Capability.allows}: exact.
   * - A scope ending in `*` is the family form, a PRESENCE test: "holds ANY
   *   scope under this prefix" (`urn:cap:net:*` is satisfied by a held
   *   `urn:cap:net:example.com`; a held exclusion under the prefix counts
   *   too, and the module's own rule then says which). A bare `*` is
   *   satisfied by any held scope at all. Root satisfies every one; the
   *   empty capability none.
   *
   * ```ts
   * import { assert } from "@std/assert";
   * import { Capability } from "./wire.ts";
   *
   * const perRoot = Capability.scoped(["urn:cap:browse:read:ikigai-core"]);
   * assert(perRoot.satisfies("urn:cap:browse:read:*"));
   * assert(!perRoot.allows("urn:cap:browse:read:*"));
   * assert(perRoot.satisfies("urn:cap:browse:read:ikigai-core"));
   * assert(!perRoot.satisfies("urn:cap:browse:read:ikigai-gonk"));
   * assert(!perRoot.satisfies("urn:cap:browse:write:*"));
   * assert(Capability.root().satisfies("urn:cap:net:*"));
   * assert(!Capability.scoped([]).satisfies("urn:cap:net:*"));
   * ```
   */
  satisfies(scope: string): boolean {
    if (!scope.endsWith("*")) return this.allows(scope);
    const held = this.scopes;
    if (held === null) return true;
    const prefix = scope.slice(0, -1);
    for (const s of held) if (s.startsWith(prefix)) return true;
    return false;
  }
}

/**
 * Whether `scope` is DENY-SHAPED: an exclusion (core's `is_deny_scope`). A
 * leading `-` on the rule, in exactly one of two positions:
 * `urn:cap:<family>:-<rule>` or `urn:cap:<family>:<qualifier>:-<rule>`, where
 * `<family>` and `<qualifier>` are words (`[a-z0-9][a-z0-9_-]*`). Nothing
 * deeper counts. {@linkcode Capability.allows} never grants an exclusion.
 *
 * ```ts
 * import { assert } from "@std/assert";
 * import { isDenyScope } from "./wire.ts";
 *
 * assert(isDenyScope("urn:cap:fs:read:-/root/secret"));
 * assert(isDenyScope("urn:cap:net:-example.com"));
 * assert(!isDenyScope("urn:cap:fs:read:notes:-x"));
 * assert(!isDenyScope("urn:cap:net:*"));
 * ```
 */
export function isDenyScope(scope: string): boolean {
  if (!scope.startsWith("urn:cap:")) return false;
  const rest = scope.slice("urn:cap:".length);
  // Rust's `splitn(3, ':')`: family, second, and the remainder.
  const first = rest.indexOf(":");
  const family = first < 0 ? rest : rest.slice(0, first);
  if (!isCapWord(family)) return false;
  if (first < 0) return false;
  const afterFamily = rest.slice(first + 1);
  const second = afterFamily.indexOf(":");
  const qualifier = second < 0 ? afterFamily : afterFamily.slice(0, second);
  if (qualifier.startsWith("-")) return true;
  if (!isCapWord(qualifier) || second < 0) return false;
  return afterFamily.slice(second + 1).startsWith("-");
}

/** A family or qualifier segment: `[a-z0-9][a-z0-9_-]*` (core's `is_word`). */
function isCapWord(segment: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(segment);
}

/** The prefix of a principal scope (core's `PRINCIPAL_SCOPE_PREFIX`). */
const PRINCIPAL_SCOPE_PREFIX = "urn:cap:principal:";

/** The longest principal IRI carried, in UTF-8 bytes (`MAX_PRINCIPAL_LEN`). */
const MAX_PRINCIPAL_LEN = 512;

/**
 * The principal `scope` carries if it is a well-formed principal scope (core's
 * `principal_in` over `check_principal`), else `null`.
 */
function principalIn(scope: string): string | null {
  if (!scope.startsWith(PRINCIPAL_SCOPE_PREFIX)) return null;
  const iri = scope.slice(PRINCIPAL_SCOPE_PREFIX.length);
  if (new TextEncoder().encode(iri).length > MAX_PRINCIPAL_LEN) return null;
  if (!isAbsoluteIri(iri) || iri.includes("*") || isDenyScope(scope)) {
    return null;
  }
  return iri;
}

/** The one principal `held` carries: `null` for none and for several. */
function singlePrincipal(held: ReadonlySet<string>): string | null {
  let found: string | null = null;
  for (const scope of held) {
    const principal = principalIn(scope);
    if (principal === null) continue;
    if (found !== null) return null;
    found = principal;
  }
  return found;
}

/**
 * `ikigai_core::Expiry`: Always (variant 0) | At(Time) (1) | Never (2).
 * `Time` is a newtype over u64 milliseconds since the Unix epoch.
 */
export type Expiry =
  | { readonly kind: "always" }
  | { readonly kind: "at"; readonly atMillis: number }
  | { readonly kind: "never" };

/**
 * Constructors for {@linkcode Expiry}: `always()` (expired as soon as made,
 * so never served from a cache), `at(ms)` (valid until that instant), and
 * `never()` (valid until a golden thread cuts it). `at` takes WHOLE
 * milliseconds since the Unix epoch: Rust's `Time` is a `u64`.
 *
 * ```ts
 * import { assertEquals } from "@std/assert";
 * import { Expiry } from "./wire.ts";
 *
 * assertEquals(Expiry.always(), { kind: "always" });
 * assertEquals(Expiry.at(1_700_000_000_000), {
 *   kind: "at",
 *   atMillis: 1_700_000_000_000,
 * });
 * assertEquals(Expiry.never(), { kind: "never" });
 * ```
 */
export const Expiry: {
  always(): Expiry;
  at(atMillis: number): Expiry;
  never(): Expiry;
} = {
  always(): Expiry {
    return { kind: "always" };
  },
  at(atMillis: number): Expiry {
    return { kind: "at", atMillis };
  },
  never(): Expiry {
    return { kind: "never" };
  },
};

/** `ikigai_resolve::CacheStatus` (variant indexes). */
export enum CacheStatus {
  Hit = 0,
  Miss = 1,
  Uncacheable = 2,
}

/**
 * `ikigai_core::Representation`: typed bytes plus cache validity.
 *
 * Wire layout: `ReprType { media_type: String, params: BTreeMap }`, then the
 * bytes, then the `Expiry`. The Rust `threads` field is `#[serde(skip)]` —
 * golden threads are kernel-local and never cross the wire.
 */
export class Representation {
  /**
   * Backed by a plain `ArrayBuffer` (a `SharedArrayBuffer`-backed input is
   * copied at construction), so it feeds `BodyInit` consumers directly:
   * `new Response(rep.data)` type-checks under TS 6.
   */
  readonly data: Uint8Array<ArrayBuffer>;
  /** The media type without parameters, e.g. `text/plain`. */
  readonly baseMediaType: string;
  /**
   * The media type's parameters (`charset=utf-8` is `{ charset: "utf-8" }`).
   * Sent sorted by key, whatever the insertion order.
   */
  readonly params: Record<string, string>;
  /** How long a cache may keep this; `Expiry.always()` unless given. */
  readonly expiry: Expiry;
  /**
   * How the server's cache answered (stamped by the client on receipt; not
   * part of the representation itself).
   */
  cacheStatus: CacheStatus | null = null;

  /**
   * `data` may be text (UTF-8 encoded here) or bytes. `mediaType` may carry
   * parameters (`text/plain;charset=utf-8`): they are split off into
   * {@linkcode Representation.params}, and `options.params` overrides any of
   * the same name. Defaults: `text/plain`, `Expiry.always()`.
   *
   * ```ts
   * import { assertEquals } from "@std/assert";
   * import { Representation } from "./wire.ts";
   *
   * const rep = new Representation("hi", "text/plain; charset=utf-8", {
   *   params: { a: "1" },
   * });
   * assertEquals(rep.baseMediaType, "text/plain");
   * assertEquals(rep.params, { charset: "utf-8", a: "1" });
   * assertEquals(rep.mediaType, "text/plain;a=1;charset=utf-8"); // sorted
   * assertEquals(rep.text, "hi");
   * assertEquals(rep.expiry, { kind: "always" });
   * ```
   */
  constructor(
    data: Uint8Array | string,
    mediaType = "text/plain",
    options: { params?: Record<string, string>; expiry?: Expiry } = {},
  ) {
    const [base, ...rest] = mediaType.split(";");
    const parsed: Record<string, string> = {};
    for (const piece of rest) {
      const eq = piece.indexOf("=");
      if (eq < 0) {
        parsed[piece.trim()] = "";
      } else {
        parsed[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
      }
    }
    Object.assign(parsed, options.params ?? {});
    this.data = typeof data === "string"
      ? utf8Encoder.encode(data)
      : data.buffer instanceof ArrayBuffer
      ? (data as Uint8Array<ArrayBuffer>)
      : new Uint8Array(data); // copy off a SharedArrayBuffer
    this.baseMediaType = base.trim();
    this.params = parsed;
    this.expiry = options.expiry ?? Expiry.always();
  }

  /** The canonical form `media/type;k=v;...` with sorted params. */
  get mediaType(): string {
    let out = this.baseMediaType;
    for (const key of sortedUtf8(Object.keys(this.params))) {
      out += `;${key}=${this.params[key]}`;
    }
    return out;
  }

  /**
   * The bytes decoded as UTF-8, whatever the declared charset. Not strict:
   * an invalid sequence becomes U+FFFD rather than an error.
   */
  get text(): string {
    return utf8Decoder.decode(this.data);
  }

  /**
   * The cache verdict as the conventional header/page token: `HIT` / `MISS` /
   * `UNCACHEABLE`, or `NONE` before any server stamped one.
   */
  get cacheStatusName(): "HIT" | "MISS" | "UNCACHEABLE" | "NONE" {
    return this.cacheStatus === null
      ? "NONE"
      : CacheStatus[this.cacheStatus].toUpperCase() as
        | "HIT"
        | "MISS"
        | "UNCACHEABLE";
  }
}

/**
 * `ikigai_core::SpaceEntry`: one catalog binding. `origin` is `null` for a
 * kernel's own bindings; a mount label for bindings surfaced from a mounted
 * remote.
 */
export interface SpaceEntry {
  /** The bound pattern: an exact IRI, or a URI template like `urn:x:{id}`. */
  readonly pattern: string;
  /** The name (id) of the endpoint the pattern resolves to. */
  readonly endpoint: string;
  /** `null` for a local binding, else the mount label it came through. */
  readonly origin: string | null;
}

/** A {@linkcode SpaceEntry}; `origin` defaults to `null` (a local binding). */
export function spaceEntry(
  pattern: string,
  endpoint: string,
  origin: string | null = null,
): SpaceEntry {
  return { pattern, endpoint, origin };
}

/** `ikigai_wire::TraceContext`: trace id + optional parent span. */
export interface TraceContext {
  /** Identifies the overall trace this call belongs to. */
  readonly traceId: number;
  /**
   * The caller's span to parent the returned subtree under, or `null` for a
   * whole-session trace (the remote root is the trace root).
   */
  readonly parentSpan: number | null;
}

/** `ikigai_core::TraceEvent` (the v5 layout, including `notes`). */
export interface TraceEvent {
  /** The resolved request's target IRI. */
  readonly target: string;
  /**
   * The worker the invocation ran on (a scheduler thread name or thread id);
   * a Deno server reports `deno-main`.
   */
  readonly thread: string;
  /**
   * When the invocation started, in milliseconds since the Unix epoch;
   * `null` when the kernel has no clock, and on a capability denial, which
   * never ran.
   */
  readonly started: number | null; // Time, millis since epoch
  /** When it finished; `null` in the same cases as `started`. */
  readonly ended: number | null;
  /** Whether the representation cache served it, rather than computing it. */
  readonly cacheHit: boolean;
  /** This invocation's span id, unique within one traced resolution. */
  readonly span: number;
  /**
   * The span that issued this one, `null` for the root; the `(span, parent)`
   * edges rebuild the execution tree.
   */
  readonly parent: number | null;
  /**
   * The authority the invocation ran under: `null` for root, else the scope
   * set, SORTED — so an attenuation down the call chain shows node by node.
   */
  readonly capability: readonly string[] | null; // null = root authority
  /**
   * `(key, value)` facts the endpoint attached to its own span (e.g. which
   * model an LLM facade picked); empty unless it annotated. A capability
   * denial is noted under the key `denied` (core's `DENIED_NOTE`), with the
   * scope the caller lacked as the value.
   */
  readonly notes: readonly (readonly [string, string])[];
}

// ---------------------------------------------------------------------------
// Calls and replies (mirroring ikigai-wire)
// ---------------------------------------------------------------------------

/**
 * `ikigai_wire::Call`: one client → server message, mirroring the Rust
 * `Resolver` methods. `kind` order is the postcard variant order — issue=0,
 * isCached=1, entries=2, issueAs=3, issueTraced=4 — and is append-only.
 * `issueAs` resolves under an explicit capability (a server clamps it to the
 * principal the channel authenticated); `issueTraced` also records the
 * resolution and is answered with a `resolvedTraced` {@linkcode Reply}.
 */
export type Call =
  | { readonly kind: "issue"; readonly request: Request }
  | { readonly kind: "isCached"; readonly request: Request }
  | { readonly kind: "entries" }
  | {
    readonly kind: "issueAs";
    readonly request: Request;
    readonly capability: Capability;
  }
  | {
    readonly kind: "issueTraced";
    readonly request: Request;
    readonly capability: Capability;
    readonly context: TraceContext;
  };

/**
 * The error taxonomy on the wire — a field-for-field mirror of the Rust
 * `ikigai_wire::WireError` enum (named `WireFailure` here because
 * `WireError` is already this package's base error class). Wire-local on
 * purpose: this codec is a public ABI with independent implementations, so a
 * taxonomy addition is a WIRE VERSION event, not a silent core cascade.
 * Variant order is the postcard contract — append only:
 * unresolved=0, missingArgument=1, invalidArgument=2, endpoint=3, denied=4,
 * notFound=5, timeout=6, unavailable=7, conflict=8 (v8).
 */
export type WireFailure =
  | { readonly kind: "unresolved"; readonly iri: string }
  | { readonly kind: "missingArgument"; readonly name: string }
  | {
    readonly kind: "invalidArgument";
    readonly name: string;
    readonly detail: string;
  }
  | { readonly kind: "endpoint"; readonly message: string }
  | { readonly kind: "denied"; readonly message: string }
  | { readonly kind: "notFound"; readonly message: string }
  | { readonly kind: "timeout"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

/**
 * Rebuild the typed error a {@linkcode WireFailure} carries — the client's
 * side of `impl From<WireError> for ikigai_core::Error`. The variant (and so
 * `transient`) survives the wire. `message` is what the wire carried: for
 * `unresolved`, `missingArgument` and `invalidArgument` that is already
 * Rust's rendering, and for every other variant it is the bare message,
 * WITHOUT the variant's `denied: ` / `not found: ` / … prefix. The error's
 * `display()` is the text the Rust kernel's `Display` prints, for every
 * variant.
 *
 * ```ts
 * import { typedError } from "./wire.ts";
 * const e = typedError({ kind: "notFound", message: "no such row" });
 * e.message; // "no such row"
 * e.display(); // "not found: no such row"
 * ```
 */
export function typedError(failure: WireFailure): EndpointError {
  switch (failure.kind) {
    case "unresolved":
      return new UnresolvedError(failure.iri);
    case "missingArgument":
      return new MissingArgumentError(failure.name);
    case "invalidArgument":
      return new InvalidArgumentError(failure.name, failure.detail);
    case "endpoint":
      return new EndpointError(failure.message);
    case "denied":
      return new DeniedError(failure.message);
    case "notFound":
      return new NotFoundError(failure.message);
    case "timeout":
      return new TimeoutError(failure.message);
    case "unavailable":
      return new UnavailableError(failure.message);
    case "conflict":
      return new ConflictError(failure.message);
  }
}

/**
 * The server's side of `impl From<&ikigai_core::Error> for WireError`: what
 * a thrown error crosses the wire as. The typed subclasses map to their own
 * variants (so a Deno handler can throw `NotFoundError` and the host sees a
 * real NotFound); anything else degrades to the `endpoint` variant with its
 * message preserved — exactly the Rust fallback for unknown variants.
 */
export function toWireFailure(error: unknown): WireFailure {
  if (error instanceof UnresolvedError) {
    return { kind: "unresolved", iri: error.iri };
  }
  if (error instanceof MissingArgumentError) {
    return { kind: "missingArgument", name: error.argument };
  }
  if (error instanceof InvalidArgumentError) {
    return {
      kind: "invalidArgument",
      name: error.argument,
      detail: error.detail,
    };
  }
  if (error instanceof DeniedError) {
    return { kind: "denied", message: error.message };
  }
  if (error instanceof NotFoundError) {
    return { kind: "notFound", message: error.message };
  }
  if (error instanceof TimeoutError) {
    return { kind: "timeout", message: error.message };
  }
  if (error instanceof UnavailableError) {
    return { kind: "unavailable", message: error.message };
  }
  if (error instanceof ConflictError) {
    return { kind: "conflict", message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "endpoint", message };
}

/**
 * The reply as a peer that negotiated `peerVersion` may receive it — the
 * per-connection downgrade that makes v8 backward compatible. Below
 * {@linkcode CONFLICT_SINCE_VERSION}, a `conflict` failure becomes
 * `endpoint` with the message `conflict: {msg}`: exactly the bytes a v7
 * server sends for the same core error, since a v7 kernel has no Conflict
 * variant and falls back to the error's Display (`conflict: {msg}`). Every
 * other reply passes through unchanged (the same object).
 *
 * ```ts
 * import { replyForPeer } from "./wire.ts";
 * const reply = {
 *   kind: "errorTyped",
 *   failure: { kind: "conflict", message: "square taken" },
 * } as const;
 * replyForPeer(reply, 7); // { kind: "errorTyped", failure: { kind: "endpoint", message: "conflict: square taken" } }
 * replyForPeer(reply, 8) === reply; // true
 * ```
 */
export function replyForPeer(reply: Reply, peerVersion: number): Reply {
  if (
    peerVersion < CONFLICT_SINCE_VERSION && reply.kind === "errorTyped" &&
    reply.failure.kind === "conflict"
  ) {
    return {
      kind: "errorTyped",
      failure: {
        kind: "endpoint",
        message: `conflict: ${reply.failure.message}`,
      },
    };
  }
  return reply;
}

/**
 * `ikigai_wire::Reply`: one server → client message. `kind` order is the
 * postcard variant order — resolved=0, cached=1, entries=2, error=3,
 * resolvedTraced=4, errorTyped=5 — and is append-only. A v7+ server answers
 * every failure as `errorTyped`; pass a reply through
 * {@linkcode replyForPeer} before encoding it for a peer older than this
 * side.
 */
export type Reply =
  | {
    readonly kind: "resolved";
    readonly representation: Representation;
    readonly cacheStatus: CacheStatus;
  }
  | { readonly kind: "cached"; readonly cached: boolean }
  | {
    /** `entries === null` = the space does not support enumeration. */
    readonly kind: "entries";
    readonly entries: readonly SpaceEntry[] | null;
  }
  | {
    /**
     * The flat pre-v7 error string. Still decodable (discriminants are
     * append-only) but a v7 server never sends it.
     */
    readonly kind: "error";
    readonly message: string;
  }
  | {
    readonly kind: "resolvedTraced";
    readonly representation: Representation;
    readonly cacheStatus: CacheStatus;
    readonly events: readonly TraceEvent[];
  }
  | {
    /**
     * A failure with its taxonomy intact (v7) — how a v7+ server answers
     * failures. The client rebuilds the same variant the server saw via
     * {@linkcode typedError}.
     */
    readonly kind: "errorTyped";
    readonly failure: WireFailure;
  };

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Rust `BTreeMap<String, _>` order: lexicographic over UTF-8 bytes. */
export function sortedUtf8(keys: readonly string[]): string[] {
  const encoded = keys.map((key) => [key, utf8Encoder.encode(key)] as const);
  encoded.sort(([, a], [, b]) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  });
  return encoded.map(([key]) => key);
}

function putArgRef(out: Writer, arg: ArgRef): void {
  switch (arg.kind) {
    case "reference":
      out.varint(0);
      out.string(arg.iri);
      break;
    case "inline":
      out.varint(1);
      out.byteString(arg.data);
      break;
    case "content":
      out.varint(2);
      out.string(arg.contentId);
      break;
  }
}

function putRequest(out: Writer, request: Request): void {
  out.varint(request.verb);
  out.string(request.target);
  const names = sortedUtf8(Object.keys(request.args));
  out.varint(names.length);
  for (const name of names) {
    out.string(name);
    putArgRef(out, request.args[name]);
  }
}

function putCapability(out: Writer, capability: Capability): void {
  if (capability.scopes === null) {
    out.varint(0); // Kind::Root
  } else {
    out.varint(1); // Kind::Scoped(BTreeSet<String>)
    const scopes = sortedUtf8([...capability.scopes]);
    out.varint(scopes.length);
    for (const scope of scopes) out.string(scope);
  }
}

function putExpiry(out: Writer, expiry: Expiry): void {
  switch (expiry.kind) {
    case "always":
      out.varint(0);
      break;
    case "at":
      out.varint(1);
      out.varint(expiry.atMillis);
      break;
    case "never":
      out.varint(2);
      break;
  }
}

function putRepresentation(out: Writer, representation: Representation): void {
  out.string(representation.baseMediaType);
  const keys = sortedUtf8(Object.keys(representation.params));
  out.varint(keys.length);
  for (const key of keys) {
    out.string(key);
    out.string(representation.params[key]);
  }
  out.byteString(representation.data);
  putExpiry(out, representation.expiry);
}

function putSpaceEntry(out: Writer, entry: SpaceEntry): void {
  out.string(entry.pattern);
  out.string(entry.endpoint);
  if (entry.origin === null) {
    out.byte(0);
  } else {
    out.byte(1);
    out.string(entry.origin);
  }
}

function putWireFailure(out: Writer, failure: WireFailure): void {
  switch (failure.kind) {
    case "unresolved":
      out.varint(0);
      out.string(failure.iri);
      break;
    case "missingArgument":
      out.varint(1);
      out.string(failure.name);
      break;
    case "invalidArgument":
      out.varint(2);
      out.string(failure.name);
      out.string(failure.detail);
      break;
    case "endpoint":
      out.varint(3);
      out.string(failure.message);
      break;
    case "denied":
      out.varint(4);
      out.string(failure.message);
      break;
    case "notFound":
      out.varint(5);
      out.string(failure.message);
      break;
    case "timeout":
      out.varint(6);
      out.string(failure.message);
      break;
    case "unavailable":
      out.varint(7);
      out.string(failure.message);
      break;
    case "conflict":
      out.varint(8);
      out.string(failure.message);
      break;
  }
}

function putTraceEvent(out: Writer, event: TraceEvent): void {
  out.string(event.target);
  out.string(event.thread);
  out.optionVarint(event.started);
  out.optionVarint(event.ended);
  out.bool(event.cacheHit);
  out.varint(event.span);
  out.optionVarint(event.parent);
  if (event.capability === null) {
    out.byte(0);
  } else {
    out.byte(1);
    out.varint(event.capability.length);
    for (const scope of event.capability) out.string(scope);
  }
  out.varint(event.notes.length);
  for (const [key, value] of event.notes) {
    out.string(key);
    out.string(value);
  }
}

/**
 * A {@linkcode Call} as its postcard payload, UNFRAMED: wrap it with
 * {@linkcode frame} (or {@linkcode FrameStream.writeFrame}) to send it. The
 * bytes are the Rust encoding exactly: the variant index, then the fields in
 * declaration order, strings and bytes as a varint length plus the raw
 * bytes, maps and sets sorted by key.
 *
 * ```ts
 * import { assertEquals } from "@std/assert";
 * import { encodeCall, inline, Verb } from "./wire.ts";
 *
 * assertEquals(encodeCall({ kind: "entries" }), new Uint8Array([2]));
 * const issue = encodeCall({
 *   kind: "issue",
 *   request: { verb: Verb.Source, target: "urn:x", args: { a: inline("hi") } },
 * });
 * assertEquals(
 *   issue,
 *   new Uint8Array([
 *     0, // Call::Issue
 *     0, // Verb::Source
 *     5, 0x75, 0x72, 0x6e, 0x3a, 0x78, // "urn:x"
 *     1, // one argument
 *     1, 0x61, // "a"
 *     1, // ArgRef::Inline
 *     2, 0x68, 0x69, // b"hi"
 *   ]),
 * );
 * ```
 */
export function encodeCall(call: Call): Uint8Array {
  const out = new Writer();
  switch (call.kind) {
    case "issue":
      out.varint(0);
      putRequest(out, call.request);
      break;
    case "isCached":
      out.varint(1);
      putRequest(out, call.request);
      break;
    case "entries":
      out.varint(2);
      break;
    case "issueAs":
      out.varint(3);
      putRequest(out, call.request);
      putCapability(out, call.capability);
      break;
    case "issueTraced":
      out.varint(4);
      putRequest(out, call.request);
      putCapability(out, call.capability);
      out.varint(call.context.traceId);
      out.optionVarint(call.context.parentSpan);
      break;
  }
  return out.finish();
}

/**
 * A {@linkcode Reply} as its postcard payload, UNFRAMED, in the Rust
 * encoding. It encodes what it is given: a server answering an older peer
 * passes the reply through {@linkcode replyForPeer} first.
 *
 * ```ts
 * import { assertEquals } from "@std/assert";
 * import { encodeReply } from "./wire.ts";
 *
 * assertEquals(
 *   encodeReply({ kind: "cached", cached: true }),
 *   new Uint8Array([1, 1]),
 * );
 * assertEquals(
 *   encodeReply({
 *     kind: "errorTyped",
 *     failure: { kind: "notFound", message: "x" },
 *   }),
 *   new Uint8Array([5, 5, 1, 0x78]), // ErrorTyped, NotFound, "x"
 * );
 * ```
 */
export function encodeReply(reply: Reply): Uint8Array {
  const out = new Writer();
  switch (reply.kind) {
    case "resolved":
      out.varint(0);
      putRepresentation(out, reply.representation);
      out.varint(reply.cacheStatus);
      break;
    case "cached":
      out.varint(1);
      out.bool(reply.cached);
      break;
    case "entries":
      out.varint(2);
      if (reply.entries === null) {
        out.byte(0);
      } else {
        out.byte(1);
        out.varint(reply.entries.length);
        for (const entry of reply.entries) putSpaceEntry(out, entry);
      }
      break;
    case "error":
      out.varint(3);
      out.string(reply.message);
      break;
    case "resolvedTraced":
      out.varint(4);
      putRepresentation(out, reply.representation);
      out.varint(reply.cacheStatus);
      out.varint(reply.events.length);
      for (const event of reply.events) putTraceEvent(out, event);
      break;
    case "errorTyped":
      out.varint(5);
      putWireFailure(out, reply.failure);
      break;
  }
  return out.finish();
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function versionMismatch(what: string, discriminant: number): ProtocolError {
  return new ProtocolError(
    `unknown ${what} variant ${discriminant}: this side speaks ikigai wire ` +
      `protocol v${PROTOCOL_VERSION}; the peer is probably a different ` +
      `version whose messages do not decode`,
  );
}

function getArgRef(r: Reader): ArgRef {
  const variant = r.varint(32);
  if (variant === 0) return reference(r.string());
  if (variant === 1) return inline(r.byteString());
  if (variant === 2) return content(r.string());
  throw versionMismatch("ArgRef", variant);
}

function getRequest(r: Reader): Request {
  const verb = r.varint(32);
  if (!(verb in Verb)) throw versionMismatch("Verb", verb);
  const target = r.string();
  const args: Record<string, ArgRef> = {};
  const count = r.varint();
  for (let i = 0; i < count; i++) {
    const name = r.string();
    args[name] = getArgRef(r);
  }
  return { verb, target, args };
}

function getCapability(r: Reader): Capability {
  const variant = r.varint(32);
  if (variant === 0) return Capability.root();
  if (variant === 1) {
    const count = r.varint();
    const scopes: string[] = [];
    for (let i = 0; i < count; i++) scopes.push(r.string());
    return Capability.scoped(scopes);
  }
  throw versionMismatch("Capability", variant);
}

function getExpiry(r: Reader): Expiry {
  const variant = r.varint(32);
  if (variant === 0) return Expiry.always();
  if (variant === 1) return Expiry.at(r.varint());
  if (variant === 2) return Expiry.never();
  throw versionMismatch("Expiry", variant);
}

function getRepresentation(r: Reader): Representation {
  const mediaType = r.string();
  const params: Record<string, string> = {};
  const count = r.varint();
  for (let i = 0; i < count; i++) {
    const key = r.string();
    params[key] = r.string();
  }
  const data = r.byteString();
  const expiry = getExpiry(r);
  return new Representation(data, mediaType, { params, expiry });
}

function getCacheStatus(r: Reader): CacheStatus {
  const variant = r.varint(32);
  if (!(variant in CacheStatus)) throw versionMismatch("CacheStatus", variant);
  return variant;
}

function getSpaceEntry(r: Reader): SpaceEntry {
  const pattern = r.string();
  const endpoint = r.string();
  const origin = r.option() ? r.string() : null;
  return { pattern, endpoint, origin };
}

function getWireFailure(r: Reader): WireFailure {
  const variant = r.varint(32);
  switch (variant) {
    case 0:
      return { kind: "unresolved", iri: r.string() };
    case 1:
      return { kind: "missingArgument", name: r.string() };
    case 2:
      return { kind: "invalidArgument", name: r.string(), detail: r.string() };
    case 3:
      return { kind: "endpoint", message: r.string() };
    case 4:
      return { kind: "denied", message: r.string() };
    case 5:
      return { kind: "notFound", message: r.string() };
    case 6:
      return { kind: "timeout", message: r.string() };
    case 7:
      return { kind: "unavailable", message: r.string() };
    case 8:
      return { kind: "conflict", message: r.string() };
    default:
      // The taxonomy is append-only, and every existing variant carries its
      // message as a leading string; read it so an unknown FUTURE variant
      // degrades to a named base error instead of an opaque decode failure.
      // (A future variant with a different payload shape still fails loud as
      // a ProtocolError — the hello makes that unreachable in practice.)
      return {
        kind: "endpoint",
        message: `wire error variant ${variant} (newer than protocol ` +
          `v${PROTOCOL_VERSION}): ${r.string()}`,
      };
  }
}

function getTraceEvent(r: Reader): TraceEvent {
  const target = r.string();
  const thread = r.string();
  const started = r.option() ? r.varint() : null;
  const ended = r.option() ? r.varint() : null;
  const cacheHit = r.bool();
  const span = r.varint();
  const parent = r.option() ? r.varint() : null;
  let capability: string[] | null = null;
  if (r.option()) {
    capability = [];
    const count = r.varint();
    for (let i = 0; i < count; i++) capability.push(r.string());
  }
  const notes: [string, string][] = [];
  const noteCount = r.varint();
  for (let i = 0; i < noteCount; i++) notes.push([r.string(), r.string()]);
  return {
    target,
    thread,
    started,
    ended,
    cacheHit,
    span,
    parent,
    capability,
    notes,
  };
}

/**
 * Decode one unframed Call payload — the inverse of {@linkcode encodeCall}.
 * The payload must be consumed EXACTLY: trailing bytes, a truncated
 * message, or an unknown variant all throw {@linkcode ProtocolError} naming
 * this side's protocol version.
 *
 * ```ts
 * import { assertEquals, assertThrows } from "@std/assert";
 * import { decodeCall, ProtocolError } from "./wire.ts";
 *
 * assertEquals(decodeCall(new Uint8Array([2])), { kind: "entries" });
 * assertThrows(() => decodeCall(new Uint8Array([2, 0])), ProtocolError);
 * assertThrows(() => decodeCall(new Uint8Array([9])), ProtocolError);
 * ```
 */
export function decodeCall(payload: Uint8Array): Call {
  try {
    const r = new Reader(payload);
    const variant = r.varint(32);
    let call: Call;
    if (variant === 0) {
      call = { kind: "issue", request: getRequest(r) };
    } else if (variant === 1) {
      call = { kind: "isCached", request: getRequest(r) };
    } else if (variant === 2) {
      call = { kind: "entries" };
    } else if (variant === 3) {
      call = {
        kind: "issueAs",
        request: getRequest(r),
        capability: getCapability(r),
      };
    } else if (variant === 4) {
      const request = getRequest(r);
      const capability = getCapability(r);
      const traceId = r.varint();
      const parentSpan = r.option() ? r.varint() : null;
      call = {
        kind: "issueTraced",
        request,
        capability,
        context: { traceId, parentSpan },
      };
    } else {
      throw versionMismatch("Call", variant);
    }
    r.finish();
    return call;
  } catch (e) {
    if (e instanceof DecodeError) {
      throw new ProtocolError(
        `undecodable Call (wire protocol v${PROTOCOL_VERSION}): ${e.message}`,
      );
    }
    throw e;
  }
}

/**
 * Decode one unframed Reply payload — the inverse of
 * {@linkcode encodeReply}, refusing the same way {@linkcode decodeCall}
 * does. One exception is deliberate: an `errorTyped` failure variant NEWER
 * than this side degrades to an `endpoint` failure that keeps its message,
 * since the taxonomy is append-only and every variant so far leads with a
 * string.
 *
 * ```ts
 * import { assertEquals } from "@std/assert";
 * import { decodeReply, PROTOCOL_VERSION } from "./wire.ts";
 *
 * assertEquals(decodeReply(new Uint8Array([1, 1])), {
 *   kind: "cached",
 *   cached: true,
 * });
 * // Failure variant 9, which no version has defined yet, carrying "x".
 * assertEquals(decodeReply(new Uint8Array([5, 9, 1, 0x78])), {
 *   kind: "errorTyped",
 *   failure: {
 *     kind: "endpoint",
 *     message:
 *       `wire error variant 9 (newer than protocol v${PROTOCOL_VERSION}): x`,
 *   },
 * });
 * ```
 */
export function decodeReply(payload: Uint8Array): Reply {
  try {
    const r = new Reader(payload);
    const variant = r.varint(32);
    let reply: Reply;
    if (variant === 0) {
      reply = {
        kind: "resolved",
        representation: getRepresentation(r),
        cacheStatus: getCacheStatus(r),
      };
    } else if (variant === 1) {
      reply = { kind: "cached", cached: r.bool() };
    } else if (variant === 2) {
      if (r.option()) {
        const entries: SpaceEntry[] = [];
        const count = r.varint();
        for (let i = 0; i < count; i++) entries.push(getSpaceEntry(r));
        reply = { kind: "entries", entries };
      } else {
        reply = { kind: "entries", entries: null };
      }
    } else if (variant === 3) {
      reply = { kind: "error", message: r.string() };
    } else if (variant === 4) {
      const representation = getRepresentation(r);
      const cacheStatus = getCacheStatus(r);
      const events: TraceEvent[] = [];
      const count = r.varint();
      for (let i = 0; i < count; i++) events.push(getTraceEvent(r));
      reply = { kind: "resolvedTraced", representation, cacheStatus, events };
    } else if (variant === 5) {
      reply = { kind: "errorTyped", failure: getWireFailure(r) };
    } else {
      throw versionMismatch("Reply", variant);
    }
    r.finish();
    return reply;
  } catch (e) {
    if (e instanceof DecodeError) {
      throw new ProtocolError(
        `undecodable Reply (wire protocol v${PROTOCOL_VERSION}): ${e.message}`,
      );
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The hello (wire v6)
// ---------------------------------------------------------------------------

/**
 * How the dialing side will address the connection — a hint for peers whose
 * canonical IRIs carry a namespace prefix (this package's servers), which
 * otherwise cannot know what form `Entries` should list.
 */
export enum HelloMode {
  /** A plain client / `--connect` / `--override` / `--prefer`. */
  Verbatim = 0,
  /** An alias `--mount`: IRIs arrive prefix-stripped. */
  Alias = 1,
}

/** One side's hello: `HELLO_MAGIC + u32 BE version + u8 mode`. */
export interface Hello {
  /** The sender's wire protocol version (a client's, or a server's answer). */
  readonly version: number;
  /** How the dialing side addresses the connection; servers send verbatim. */
  readonly mode: HelloMode;
}

/** A {@linkcode Hello}; `mode` defaults to {@linkcode HelloMode.Verbatim}. */
export function hello(version: number, mode = HelloMode.Verbatim): Hello {
  return { version, mode };
}

/**
 * A hello as its 9-byte payload: {@linkcode HELLO_MAGIC}, the version as a
 * `u32` BIG-endian, then the mode byte. Not postcard (the codec being
 * negotiated must not be needed to negotiate it), and unframed: send it with
 * {@linkcode frame} like any other payload.
 *
 * ```ts
 * import { assertEquals } from "@std/assert";
 * import { encodeHello, hello, HelloMode } from "./wire.ts";
 *
 * assertEquals(
 *   encodeHello(hello(8, HelloMode.Alias)),
 *   new Uint8Array([0x49, 0x4b, 0x57, 0x48, 0, 0, 0, 8, 1]), // "IKWH", 8, alias
 * );
 * ```
 */
export function encodeHello(h: Hello): Uint8Array {
  const out = new Uint8Array(9);
  out.set(HELLO_MAGIC, 0);
  new DataView(out.buffer).setUint32(4, h.version, false); // big-endian
  out[8] = h.mode;
  return out;
}

/**
 * `null` if the magic is absent (a legacy first frame). A missing mode byte
 * defaults to verbatim; an UNKNOWN mode value also falls back to verbatim
 * rather than failing — the mode is a hint, and a newer peer's new mode must
 * not break an older reader. Trailing bytes are ignored: that is the
 * extension mechanism.
 */
export function decodeHello(payload: Uint8Array): Hello | null {
  if (payload.length < 8) return null;
  for (let i = 0; i < 4; i++) {
    if (payload[i] !== HELLO_MAGIC[i]) return null;
  }
  const version = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(4, false);
  const mode = payload.length > 8 && payload[8] === 1
    ? HelloMode.Alias
    : HelloMode.Verbatim;
  return { version, mode };
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * A wire frame: u32 big-endian length + payload. A payload above
 * {@linkcode MAX_FRAME} throws {@linkcode ProtocolError} instead.
 *
 * ```ts
 * import { assertEquals } from "@std/assert";
 * import { frame } from "./wire.ts";
 *
 * assertEquals(
 *   frame(new Uint8Array([2])),
 *   new Uint8Array([0, 0, 0, 1, 2]),
 * );
 * ```
 */
export function frame(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME) {
    throw new ProtocolError(
      `message of ${payload.length} bytes exceeds the ${MAX_FRAME}-byte limit`,
    );
  }
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

/** The minimal duplex-byte-stream shape (structurally, a `Deno.Conn`). */
export interface ByteStream {
  /**
   * Read up to `p.length` bytes into `p`: the count read, or `null` at end of
   * stream.
   */
  read(p: Uint8Array): Promise<number | null>;
  /** Write some prefix of `p`, resolving to how many bytes were written. */
  write(p: Uint8Array): Promise<number>;
}

/**
 * Length-prefixed frames over a byte stream. Reads buffer internally, so one
 * `FrameStream` must own the connection's read side.
 */
export class FrameStream {
  #conn: ByteStream;
  #pending: Uint8Array = new Uint8Array(0);

  /** Frame over `conn`; from here on, read it only through this stream. */
  constructor(conn: ByteStream) {
    this.#conn = conn;
  }

  async #readExact(n: number): Promise<Uint8Array> {
    while (this.#pending.length < n) {
      const chunk = new Uint8Array(Math.max(n - this.#pending.length, 4096));
      const read = await this.#conn.read(chunk);
      if (read === null) {
        if (this.#pending.length === 0) throw new EofError("connection closed");
        throw new EofError(
          `connection closed mid-frame (${this.#pending.length}/${n} bytes)`,
        );
      }
      const merged = new Uint8Array(this.#pending.length + read);
      merged.set(this.#pending, 0);
      merged.set(chunk.subarray(0, read), this.#pending.length);
      this.#pending = merged;
    }
    const out = this.#pending.slice(0, n);
    this.#pending = this.#pending.slice(n);
    return out;
  }

  /**
   * Read one length-prefixed frame. Throws `EofError` on a clean or
   * mid-frame close, `ProtocolError` on an oversized length header (checked
   * before allocating).
   */
  async readFrame(): Promise<Uint8Array> {
    const header = await this.#readExact(4);
    const length = new DataView(header.buffer).getUint32(0, false);
    if (length > MAX_FRAME) {
      throw new ProtocolError(
        `framed message of ${length} bytes exceeds the ${MAX_FRAME}-byte limit`,
      );
    }
    return await this.#readExact(length);
  }

  /** Frame `payload` and write it fully. */
  async writeFrame(payload: Uint8Array): Promise<void> {
    let data = frame(payload);
    while (data.length > 0) {
      const written = await this.#conn.write(data);
      data = data.subarray(written);
    }
  }
}

/**
 * Strip the `endpoint error: ` prefix the server's Display rendering adds,
 * the way the Rust wire clients do — the remainder is the endpoint's own
 * message.
 */
export function decodeErrorMessage(message: string): string {
  const prefix = "endpoint error: ";
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
