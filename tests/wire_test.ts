import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import * as wire from "../src/wire.ts";
import {
  CacheStatus,
  Capability,
  content,
  DeniedError,
  EndpointError,
  Expiry,
  inline,
  InvalidArgumentError,
  MissingArgumentError,
  NotFoundError,
  ProtocolError,
  reference,
  Representation,
  TimeoutError,
  toWireFailure,
  typedError,
  UnavailableError,
  UnresolvedError,
  Verb,
} from "../src/wire.ts";

const utf8 = new TextEncoder();

/** Build a byte vector from strings (utf-8) and raw byte values. */
function b(...pieces: (string | number[])[]): Uint8Array {
  const parts = pieces.map((p) =>
    typeof p === "string" ? utf8.encode(p) : new Uint8Array(p)
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function upperRequest(): wire.Request {
  return {
    verb: Verb.Source,
    target: "urn:fn:toUpper",
    args: { in: inline("hi") },
  };
}

// --- byte-exact fixtures (the same vectors the Rust and Python suites lock) ---

Deno.test("an Entries call is one byte", () => {
  assertEquals(wire.encodeCall({ kind: "entries" }), b([0x02]));
});

Deno.test("Issue call golden bytes", () => {
  const expected = b(
    [0x00], // Call::Issue
    [0x00], // Verb::Source (variant index 0, NOT the repr(u8) value 1)
    [0x0e],
    "urn:fn:toUpper", // Iri newtype = string
    [0x01], // args: 1 entry
    [0x02],
    "in", // key
    [0x01], // ArgRef::Inline
    [0x02],
    "hi", // value bytes
  );
  assertEquals(
    wire.encodeCall({ kind: "issue", request: upperRequest() }),
    expected,
  );
});

Deno.test("Resolved reply golden bytes", () => {
  const reply: wire.Reply = {
    kind: "resolved",
    representation: new Representation("HI", "text/plain"),
    cacheStatus: CacheStatus.Miss,
  };
  const expected = b(
    [0x00], // Reply::Resolved
    [0x0a],
    "text/plain", // ReprType.media_type
    [0x00], // ReprType.params: empty map
    [0x02],
    "HI", // bytes
    [0x00], // Expiry::Always
    [0x01], // CacheStatus::Miss
  );
  assertEquals(wire.encodeReply(reply), expected);
});

Deno.test("framing is u32 BE length prefixed", () => {
  assertEquals(wire.frame(b([0x02])), b([0x00, 0x00, 0x00, 0x01, 0x02]));
});

// --- round trips over every variant ---

const CALLS: wire.Call[] = [
  { kind: "issue", request: upperRequest() },
  { kind: "isCached", request: upperRequest() },
  { kind: "entries" },
  { kind: "issueAs", request: upperRequest(), capability: Capability.root() },
  {
    kind: "issueAs",
    request: {
      verb: Verb.Sink,
      target: "urn:file:notes.txt",
      args: {
        ref: reference("urn:x"),
        cid: content("b3:" + "ab".repeat(32)),
        value: inline(new Uint8Array([0x00, 0xff])),
      },
    },
    capability: Capability.scoped(["urn:cap:fs:write", "urn:cap:demo"]),
  },
  {
    kind: "issueTraced",
    request: upperRequest(),
    capability: Capability.root(),
    context: { traceId: 7, parentSpan: null },
  },
  {
    kind: "issueTraced",
    request: upperRequest(),
    capability: Capability.scoped([]),
    context: { traceId: 2 ** 40, parentSpan: 3 },
  },
];

const REPLIES: wire.Reply[] = [
  {
    kind: "resolved",
    representation: new Representation("HI", "text/plain"),
    cacheStatus: CacheStatus.Miss,
  },
  {
    kind: "resolved",
    representation: new Representation("{}", "application/json", {
      params: { charset: "utf-8" },
      expiry: Expiry.never(),
    }),
    cacheStatus: CacheStatus.Hit,
  },
  {
    kind: "resolved",
    representation: new Representation("x", "text/plain", {
      expiry: Expiry.at(1_722_000_000_000),
    }),
    cacheStatus: CacheStatus.Uncacheable,
  },
  { kind: "cached", cached: true },
  { kind: "cached", cached: false },
  { kind: "entries", entries: null },
  { kind: "entries", entries: [] },
  {
    kind: "entries",
    entries: [
      wire.spaceEntry("urn:fn:toUpper", "toUpper"),
      wire.spaceEntry("urn:ts:hello", "hello", "/tmp/ts.sock"),
    ],
  },
  { kind: "error", message: "endpoint error: boom" },
  { kind: "errorTyped", failure: { kind: "unresolved", iri: "urn:x:y" } },
  { kind: "errorTyped", failure: { kind: "missingArgument", name: "in" } },
  {
    kind: "errorTyped",
    failure: { kind: "invalidArgument", name: "n", detail: "not a number" },
  },
  { kind: "errorTyped", failure: { kind: "endpoint", message: "boom" } },
  {
    kind: "errorTyped",
    failure: { kind: "denied", message: "needs urn:cap:x" },
  },
  {
    kind: "errorTyped",
    failure: { kind: "notFound", message: "no such row" },
  },
  { kind: "errorTyped", failure: { kind: "timeout", message: "5s elapsed" } },
  {
    kind: "errorTyped",
    failure: { kind: "unavailable", message: "connection refused" },
  },
  {
    kind: "resolvedTraced",
    representation: new Representation("HI", "text/plain"),
    cacheStatus: CacheStatus.Miss,
    events: [
      {
        target: "urn:fn:toUpper",
        thread: "ikigai-sched-0",
        started: null,
        ended: null,
        cacheHit: false,
        span: 0,
        parent: null,
        capability: ["urn:cap:demo"],
        notes: [["model", "llama3.2:3b"]],
      },
      {
        target: "urn:child",
        thread: "t",
        started: 1000,
        ended: 2000,
        cacheHit: true,
        span: 1,
        parent: 0,
        capability: null,
        notes: [],
      },
    ],
  },
];

Deno.test("every Call variant round-trips", () => {
  for (const call of CALLS) {
    assertEquals(wire.decodeCall(wire.encodeCall(call)), call);
  }
});

Deno.test("every Reply variant round-trips", () => {
  for (const reply of REPLIES) {
    assertEquals(wire.decodeReply(wire.encodeReply(reply)), reply);
  }
});

Deno.test("args encode in BTreeMap key order regardless of insertion", () => {
  const first: wire.Request = {
    verb: Verb.Source,
    target: "urn:x",
    args: { b: inline("2"), a: inline("1") },
  };
  const second: wire.Request = {
    verb: Verb.Source,
    target: "urn:x",
    args: { a: inline("1"), b: inline("2") },
  };
  assertEquals(
    wire.encodeCall({ kind: "issue", request: first }),
    wire.encodeCall({ kind: "issue", request: second }),
  );
});

Deno.test("BTreeMap order is UTF-8 byte order, not UTF-16 code units", () => {
  // U+FF01 ( efbc81 in utf-8) sorts before U+10000 (f0908080 in utf-8), but
  // AFTER it by UTF-16 code units (ff01 > d800). The wire wants byte order.
  assertEquals(wire.sortedUtf8(["\u{10000}", "！"]), [
    "！",
    "\u{10000}",
  ]);
});

// --- the typed error taxonomy (wire v7) ---

Deno.test("ErrorTyped wire discriminant is five (the Rust-locked vector)", () => {
  // Mirrors ikigai-wire's `error_typed_wire_discriminant_is_five`: the
  // discriminants are the public ABI.
  const endpoint = wire.encodeReply({
    kind: "errorTyped",
    failure: { kind: "endpoint", message: "x" },
  });
  assertStrictEquals(endpoint[0], 5, "Reply::ErrorTyped is variant 5");
  const denied = wire.encodeReply({
    kind: "errorTyped",
    failure: { kind: "denied", message: "x" },
  });
  assertStrictEquals(denied[1], 4, "WireError::Denied is variant 4");
});

Deno.test("ErrorTyped(InvalidArgument) golden bytes", () => {
  // The one struct-shaped variant: name then detail, declaration order.
  const expected = b(
    [0x05], // Reply::ErrorTyped
    [0x02], // WireError::InvalidArgument
    [0x01],
    "n", // name
    [0x0c],
    "not a number", // detail
  );
  assertEquals(
    wire.encodeReply({
      kind: "errorTyped",
      failure: { kind: "invalidArgument", name: "n", detail: "not a number" },
    }),
    expected,
  );
});

Deno.test("every taxonomy variant crosses with kind and transience intact", () => {
  // The property the reliability overlays and the HTTP faces depend on:
  // the same variant comes back, and transient survives the wire.
  const cases: [wire.WireFailure, unknown, boolean][] = [
    [{ kind: "unresolved", iri: "urn:x:y" }, UnresolvedError, false],
    [{ kind: "missingArgument", name: "in" }, MissingArgumentError, false],
    [
      { kind: "invalidArgument", name: "n", detail: "not a number" },
      InvalidArgumentError,
      false,
    ],
    [{ kind: "endpoint", message: "boom" }, EndpointError, false],
    [{ kind: "denied", message: "needs urn:cap:x" }, DeniedError, false],
    [{ kind: "notFound", message: "no such row" }, NotFoundError, false],
    [{ kind: "timeout", message: "5s elapsed" }, TimeoutError, true],
    [
      { kind: "unavailable", message: "connection refused" },
      UnavailableError,
      true,
    ],
  ];
  for (const [failure, cls, transient] of cases) {
    const decoded = wire.decodeReply(
      wire.encodeReply({ kind: "errorTyped", failure }),
    );
    assert(decoded.kind === "errorTyped");
    assertEquals(decoded.failure, failure);
    const error = typedError(decoded.failure);
    // deno-lint-ignore no-explicit-any
    assertInstanceOf(error, cls as any);
    assertStrictEquals(
      error.transient,
      transient,
      `transience must survive the wire: ${failure.kind}`,
    );
    // And the round trip back: a thrown typed error re-crosses as itself.
    assertEquals(toWireFailure(error), failure);
  }
});

Deno.test("typed errors render the Rust kernel's message texts", () => {
  assertStrictEquals(
    typedError({ kind: "unresolved", iri: "urn:x:y" }).message,
    "no endpoint resolved for urn:x:y",
  );
  assertStrictEquals(
    typedError({ kind: "missingArgument", name: "in" }).message,
    "missing required argument `in`",
  );
  assertStrictEquals(
    typedError({ kind: "invalidArgument", name: "n", detail: "not a number" })
      .message,
    "invalid argument `n`: not a number",
  );
  // The message-bearing variants carry the message verbatim; the CLASS is
  // the taxonomy (no "denied: " prefix baked into the text).
  assertStrictEquals(
    typedError({ kind: "denied", message: "needs urn:cap:x" }).message,
    "needs urn:cap:x",
  );
});

Deno.test("a plain thrown error degrades to the endpoint variant", () => {
  // The server-side fallback mirrors Rust's unknown-variant degrade:
  // message preserved, taxonomy honest (it IS an endpoint failure).
  assertEquals(toWireFailure(new Error("boom")), {
    kind: "endpoint",
    message: "boom",
  });
  assertEquals(toWireFailure("stringly"), {
    kind: "endpoint",
    message: "stringly",
  });
});

Deno.test("an unknown FUTURE taxonomy variant degrades to a named base error", () => {
  // Append-only means variant 8+ belongs to a newer wire revision. Every
  // existing variant leads with its message string, so a same-shaped future
  // variant decodes to a base EndpointError that NAMES the unknown variant.
  const payload = b([0x05], [0x08], [0x04], "next");
  const decoded = wire.decodeReply(payload);
  assert(decoded.kind === "errorTyped");
  const error = typedError(decoded.failure);
  assertStrictEquals(error.constructor, EndpointError);
  assert(error.message.includes("variant 8"), error.message);
  assert(error.message.includes("next"), error.message);
});

// --- failure modes ---

Deno.test("an unknown Call variant names the protocol version", () => {
  assertThrows(() => wire.decodeCall(b([0x09])), ProtocolError, "v7");
});

Deno.test("an unknown Reply variant names the protocol version", () => {
  assertThrows(() => wire.decodeReply(b([0x2a])), ProtocolError, "protocol v7");
});

Deno.test("a truncated payload is a protocol error", () => {
  const encoded = wire.encodeCall({ kind: "issue", request: upperRequest() });
  assertThrows(
    () => wire.decodeCall(encoded.slice(0, -1)),
    ProtocolError,
    "truncated",
  );
});

Deno.test("trailing garbage is rejected", () => {
  const encoded = b([0x02, 0x00]); // Entries + one stray byte
  assertThrows(() => wire.decodeCall(encoded), ProtocolError, "trailing");
});

Deno.test("an oversized frame is refused", () => {
  const huge = { length: wire.MAX_FRAME + 1 } as unknown as Uint8Array;
  assertThrows(() => wire.frame(huge), ProtocolError, "exceeds");
});

Deno.test("the endpoint-error prefix strips, other messages pass through", () => {
  assertStrictEquals(wire.decodeErrorMessage("endpoint error: boom"), "boom");
  assertStrictEquals(
    wire.decodeErrorMessage("no endpoint resolved for urn:x"),
    "no endpoint resolved for urn:x",
  );
});

Deno.test("a representation's media type is canonical", () => {
  const rep = new Representation("", "text/plain;charset=utf-8");
  assertStrictEquals(rep.baseMediaType, "text/plain");
  assertStrictEquals(rep.mediaType, "text/plain;charset=utf-8");
  const both = new Representation("", "text/plain", {
    params: { charset: "utf-8", boundary: "x" },
  });
  assertStrictEquals(both.mediaType, "text/plain;boundary=x;charset=utf-8");
});

Deno.test("cacheStatusName renders the header/page token", () => {
  const rep = new Representation("x");
  assertStrictEquals(rep.cacheStatusName, "NONE"); // no server stamped one
  rep.cacheStatus = CacheStatus.Hit;
  assertStrictEquals(rep.cacheStatusName, "HIT");
  rep.cacheStatus = CacheStatus.Miss;
  assertStrictEquals(rep.cacheStatusName, "MISS");
  rep.cacheStatus = CacheStatus.Uncacheable;
  assertStrictEquals(rep.cacheStatusName, "UNCACHEABLE");
});

Deno.test("a representation's data feeds BodyInit directly", () => {
  // The load-bearing TYPE-level assertion: `Representation.data` is
  // `Uint8Array<ArrayBuffer>`, so `deno check` accepts it as a Response
  // body with no copy and no cast (the TS 6 BodyInit tightening).
  const body: BodyInit = new Representation("payload").data;
  assertStrictEquals(new TextDecoder().decode(body as Uint8Array), "payload");
});
