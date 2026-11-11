/**
 * The failure classes of core 0.1.108 (ledger #1546), pinned against
 * `failure_class_vectors.json`, a VERBATIM copy of ikigai-vocab's
 * `tests/vectors/failure_class_vectors.json` (do not reformat it; `deno.json`
 * keeps it out of `deno fmt`). Per case this face must hold the error's
 * `kind`, `class`, `transient`, `display`, wire tag (decoded from real bytes)
 * and the edge status with its `Retry-After` header.
 *
 * The payload layouts of tags 9-14 are not in the vectors (ikigai-wire owns
 * them); this test builds them in serde field order, the way postcard writes
 * the variants: `DepthExceeded { depth, target }`, `RetryAfter { delay_ms:
 * Option<u64>, detail }`, `OverBudget { detail }`, `Refused(msg)`,
 * `Unsupported { verb: Option<Verb>, detail }`,
 * `GaveUp { attempts: u32, elapsed_ms: u64, detail }`.
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { Writer } from "../src/postcard.ts";
import {
  decodeReply,
  DepthExceededError,
  encodeReply,
  EndpointError,
  FAILURE_CLASSES,
  type FailureClass,
  GaveUpError,
  OverBudgetError,
  RefusedError,
  replyForPeer,
  RetryAfterError,
  toWireFailure,
  typedError,
  UnsupportedError,
  Verb,
  type WireFailure,
} from "../src/wire.ts";
import { httpStatus, retryAfterHeader } from "../examples/http_status.ts";
import type { Json } from "./vector_door.ts";

interface Case {
  name: string;
  error: Json;
  kind: string;
  class: FailureClass;
  transient: boolean;
  display: string;
  retry_after_ms: number | null;
  attempts: number | null;
  elapsed_ms: number | null;
  json: Json;
  wire_tag: number;
  http: { status: number; retry_after: number | null };
}

const VECTORS: { cases: Case[]; classes: { word: string; iri: string }[] } =
  JSON.parse(
    await Deno.readTextFile(
      new URL("./failure_class_vectors.json", import.meta.url),
    ),
  );

const REPLY_ERROR_TYPED = 5;

/** The wire failure a case's `error` stands for, and the bytes of its reply. */
function failureOf(c: Case): { failure: WireFailure; payload: Uint8Array } {
  const e = c.error;
  const str = (k: string) => e[k] as string;
  const out = new Writer();
  out.varint(REPLY_ERROR_TYPED);
  out.varint(c.wire_tag);
  let failure: WireFailure;
  switch (c.wire_tag) {
    case 0:
      failure = { kind: "unresolved", iri: str("iri") };
      out.string(str("iri"));
      break;
    case 1:
      failure = { kind: "missingArgument", name: str("name") };
      out.string(str("name"));
      break;
    case 2:
      failure = {
        kind: "invalidArgument",
        name: str("name"),
        detail: str("detail"),
      };
      out.string(str("name"));
      out.string(str("detail"));
      break;
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8: {
      const kind = (
        { 3: "endpoint", 4: "denied", 5: "notFound", 6: "timeout" } as Record<
          number,
          string
        >
      )[c.wire_tag] ?? (c.wire_tag === 7 ? "unavailable" : "conflict");
      failure = { kind, message: str("message") } as WireFailure;
      out.string(str("message"));
      break;
    }
    case 9:
      failure = {
        kind: "depthExceeded",
        depth: e["depth"] as number,
        target: str("target"),
      };
      out.varint(e["depth"] as number);
      out.string(str("target"));
      break;
    case 10:
      failure = {
        kind: "retryAfter",
        delayMs: c.retry_after_ms,
        detail: str("detail"),
      };
      out.optionVarint(c.retry_after_ms);
      out.string(str("detail"));
      break;
    case 11:
      failure = { kind: "overBudget", detail: str("detail") };
      out.string(str("detail"));
      break;
    case 12:
      failure = { kind: "refused", message: str("message") };
      out.string(str("message"));
      break;
    case 13: {
      const verb = "verb" in e ? Verb[str("verb") as keyof typeof Verb] : null;
      failure = { kind: "unsupported", verb, detail: str("detail") };
      out.optionVarint(verb);
      out.string(str("detail"));
      break;
    }
    case 14:
      // The case is in microseconds; the wire and JSON faces floor elapsed ms.
      failure = {
        kind: "gaveUp",
        attempts: e["attempts"] as number,
        elapsedMs: Math.floor((e["elapsed_us"] as number) / 1000),
        detail: str("detail"),
      };
      out.varint(failure.attempts);
      out.varint(failure.elapsedMs);
      out.string(failure.detail);
      break;
    default:
      throw new Error(`unexpected wire tag ${c.wire_tag}`);
  }
  return { failure, payload: out.finish() };
}

Deno.test("failure vectors: every class word and vocabulary individual", () => {
  assertEquals(VECTORS.classes.map((c) => c.word), [...FAILURE_CLASSES]);
  assert(VECTORS.cases.length >= 19);
});

for (const c of VECTORS.cases) {
  Deno.test(`failure vectors: ${c.name}`, () => {
    const { failure, payload } = failureOf(c);
    // The wire tag, from real bytes: decode them, and the typed error comes out.
    const reply = decodeReply(payload);
    assertEquals(reply, { kind: "errorTyped", failure });
    const error = typedError(failure);
    assertEquals(error.kind(), c.kind);
    assertEquals(error.class(), c.class);
    assertStrictEquals(error.transient, c.transient);
    assertStrictEquals(error.class() === "transient", error.transient);
    assertEquals(error.display(), c.display);
    assertStrictEquals(httpStatus(error), c.http.status);
    assertStrictEquals(retryAfterHeader(error), c.http.retry_after);
    if (error instanceof RetryAfterError) {
      assertStrictEquals(error.delayMs, c.retry_after_ms);
    }
    if (error instanceof GaveUpError) {
      assertStrictEquals(error.attempts, c.attempts);
      assertStrictEquals(error.elapsedMs, c.elapsed_ms);
      assertEquals(error.toJson(), c.json);
      assertEquals(GaveUpError.fromJson(c.json).toJson(), c.json);
      assertEquals(
        encodeReply({ kind: "errorTyped", failure: toWireFailure(error) }),
        payload,
      );
      assertEquals(replyForPeer(reply, 9), reply);
      assertEquals(replyForPeer(reply, 8), {
        kind: "errorTyped",
        failure: { kind: "endpoint", message: c.display },
      });
    }
    // Tags 0-8 are what this side also SENDS: they re-encode to the same bytes.
    if (c.wire_tag <= 8) {
      assertEquals(
        encodeReply({ kind: "errorTyped", failure: toWireFailure(error) }),
        payload,
      );
    }
  });
}

Deno.test("RetryAfter is not transient; a blind retry is the wrong answer", () => {
  const e = new RetryAfterError(30_000, "rate-limited");
  assertStrictEquals(e.transient, false);
  assertEquals(e.class(), "retry-after");
  assertEquals(e.message, "rate-limited");
  assertEquals(new RetryAfterError(null, "not now").retryAfterSeconds(), null);
  assertEquals(new RetryAfterError(0, "now").retryAfterSeconds(), 1);
  assertEquals(new RetryAfterError(1001, "x").retryAfterSeconds(), 2);
});

Deno.test("the other classes: Endpoint is unknown, Unsupported is permanent", () => {
  assertEquals(new EndpointError("x").class(), "unknown");
  assertEquals(new EndpointError("x").kind(), "endpoint");
  assertEquals(new UnsupportedError("x", Verb.Sink).class(), "permanent");
  assertEquals(new OverBudgetError("x").class(), "over-budget");
  assertEquals(new RefusedError("x").class(), "refused");
  assertEquals(new DepthExceededError(65, "urn:x:y").class(), "permanent");
});

Deno.test("an unknown tag still decodes as Endpoint(display)", () => {
  const out = new Writer();
  out.varint(REPLY_ERROR_TYPED);
  out.varint(15);
  out.string("from the future");
  const reply = decodeReply(out.finish());
  assertEquals(reply.kind, "errorTyped");
  assert(reply.kind === "errorTyped" && reply.failure.kind === "endpoint");
  assertInstanceOf(typedError(reply.failure), EndpointError);
  assert(reply.failure.message.endsWith("from the future"));
});

Deno.test("a new class thrown from a handler crosses typed to a v9 peer, as Endpoint(display) to a v8 one", () => {
  const retry = toWireFailure(new RetryAfterError(1500, "busy"));
  assertEquals(retry, { kind: "retryAfter", delayMs: 1500, detail: "busy" });
  const unsupported = toWireFailure(new UnsupportedError("no", Verb.Sink));
  assertEquals(unsupported, {
    kind: "unsupported",
    verb: Verb.Sink,
    detail: "no",
  });
  const reply = (failure: WireFailure) =>
    ({ kind: "errorTyped", failure }) as const;
  assertEquals(
    replyForPeer(reply(retry), 8),
    reply({
      kind: "endpoint",
      message: "retry after 1500 ms: busy",
    }),
  );
  assertEquals(
    replyForPeer(reply(unsupported), 7),
    reply({
      kind: "endpoint",
      message: "unsupported: no",
    }),
  );
  assertEquals(replyForPeer(reply(retry), 9), reply(retry));
});

Deno.test("an unsupported verb index this side does not know is refused", () => {
  const out = new Writer();
  out.varint(REPLY_ERROR_TYPED);
  out.varint(13);
  out.optionVarint(99);
  out.string("x");
  assertThrows(() => decodeReply(out.finish()));
});

Deno.test("gave-up Turtle matches core and escapes the failure message", () => {
  const error = new GaveUpError(9, 120000, "unavailable: down");
  assertStrictEquals(
    error.toTurtle(),
    "@prefix ik: <https://ikigai-rs.dev/ns#> .\n" +
      "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n" +
      '[] a ik:Failure ;\n    ik:failureKind "gave-up" ;\n    ' +
      "ik:failureClass ik:TransientFailure ;\n    " +
      'ik:failureMessage "gave up after 9 attempts over 120000 ms: unavailable: down" ;\n    ' +
      'ik:attempts "9"^^xsd:nonNegativeInteger ;\n    ' +
      'ik:elapsedMillis "120000"^^xsd:nonNegativeInteger .\n',
  );
  assert(
    new GaveUpError(1, 0, '"\\\n\r\t').toTurtle().includes(
      'ms: \\"\\\\\\n\\r\\t"',
    ),
  );
});

Deno.test("gave-up JSON refuses missing, fractional, negative, and out-of-range counts", () => {
  const valid = {
    kind: "gave-up",
    attempts: 1,
    elapsed_ms: 250,
    detail: "down",
  };
  for (
    const json of [
      null,
      {},
      { ...valid, attempts: "one" },
      { ...valid, attempts: -1 },
      { ...valid, attempts: 1.5 },
      { ...valid, attempts: 0x100000000 },
      { ...valid, elapsed_ms: -1 },
      { ...valid, elapsed_ms: 1.9 },
      { ...valid, elapsed_ms: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, detail: null },
    ]
  ) {
    assertThrows(() => GaveUpError.fromJson(json), TypeError);
  }
});
