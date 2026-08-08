/**
 * The ikigai IPC wire protocol: types, postcard codec, framing, and the v6
 * hello.
 *
 * Mirrors `ikigai-wire` (Rust) at `PROTOCOL_VERSION` 6. The codec is
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
 * Pre-v6 peers are tolerated for one version: a server hung up on our hello
 * means a <= v5 Rust server (reconnect without the hello, warn), and a first
 * frame without the magic means a <= v5 client (serve it, warn).
 */

import { DecodeError, Reader, Writer } from "./postcard.ts";

/**
 * Bumped in lockstep with the Rust `ikigai_wire::PROTOCOL_VERSION`. v5 era:
 * core 0.1.48 `TraceEvent.notes` changed the postcard layout of traced
 * replies. v6 adds the hello exchange (version + mount mode at open).
 */
export const PROTOCOL_VERSION = 6;

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
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A frame or message that violates wire protocol v6 — including a peer
 * speaking a different version whose messages do not decode (the hello
 * usually catches that first and names both versions).
 */
export class ProtocolError extends WireError {}

/** A server-reported resolution failure (the wire's `Reply::Error`). */
export class EndpointError extends WireError {}

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
  readonly kind: "reference";
  readonly iri: string;
}

/** `ArgRef::Inline` — a small literal value carried inline. */
export interface Inline {
  readonly kind: "inline";
  readonly data: Uint8Array;
}

/**
 * `ArgRef::Content` — a content-store id. On the wire this is the STRING
 * form `b3:<hex>` (Rust's `ContentId` serializes via
 * `#[serde(into = "String")]`), not the raw 32-byte digest.
 */
export interface Content {
  readonly kind: "content";
  readonly contentId: string;
}

export type ArgRef = Reference | Inline | Content;

export function reference(iri: string): Reference {
  return { kind: "reference", iri };
}

export function inline(data: Uint8Array | string): Inline {
  return {
    kind: "inline",
    data: typeof data === "string" ? utf8Encoder.encode(data) : data,
  };
}

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
  readonly verb: Verb;
  readonly target: string;
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
  readonly scopes: ReadonlySet<string> | null;

  private constructor(scopes: ReadonlySet<string> | null) {
    this.scopes = scopes;
  }

  static root(): Capability {
    return new Capability(null);
  }

  static scoped(scopes: Iterable<string>): Capability {
    return new Capability(new Set(scopes));
  }

  get isRoot(): boolean {
    return this.scopes === null;
  }
}

/**
 * `ikigai_core::Expiry`: Always (variant 0) | At(Time) (1) | Never (2).
 * `Time` is a newtype over u64 milliseconds since the Unix epoch.
 */
export type Expiry =
  | { readonly kind: "always" }
  | { readonly kind: "at"; readonly atMillis: number }
  | { readonly kind: "never" };

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
  readonly baseMediaType: string;
  readonly params: Record<string, string>;
  readonly expiry: Expiry;
  /**
   * How the server's cache answered (stamped by the client on receipt; not
   * part of the representation itself).
   */
  cacheStatus: CacheStatus | null = null;

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
  readonly pattern: string;
  readonly endpoint: string;
  readonly origin: string | null;
}

export function spaceEntry(
  pattern: string,
  endpoint: string,
  origin: string | null = null,
): SpaceEntry {
  return { pattern, endpoint, origin };
}

/** `ikigai_wire::TraceContext`: trace id + optional parent span. */
export interface TraceContext {
  readonly traceId: number;
  readonly parentSpan: number | null;
}

/** `ikigai_core::TraceEvent` (the v5 layout, including `notes`). */
export interface TraceEvent {
  readonly target: string;
  readonly thread: string;
  readonly started: number | null; // Time, millis since epoch
  readonly ended: number | null;
  readonly cacheHit: boolean;
  readonly span: number;
  readonly parent: number | null;
  readonly capability: readonly string[] | null; // null = root authority
  readonly notes: readonly (readonly [string, string])[];
}

// ---------------------------------------------------------------------------
// Calls and replies (mirroring ikigai-wire)
// ---------------------------------------------------------------------------

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
  | { readonly kind: "error"; readonly message: string }
  | {
    readonly kind: "resolvedTraced";
    readonly representation: Representation;
    readonly cacheStatus: CacheStatus;
    readonly events: readonly TraceEvent[];
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
  readonly version: number;
  readonly mode: HelloMode;
}

export function hello(version: number, mode = HelloMode.Verbatim): Hello {
  return { version, mode };
}

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

/** A wire frame: u32 big-endian length + payload. */
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
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
}

/**
 * Length-prefixed frames over a byte stream. Reads buffer internally, so one
 * `FrameStream` must own the connection's read side.
 */
export class FrameStream {
  #conn: ByteStream;
  #pending: Uint8Array = new Uint8Array(0);

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
