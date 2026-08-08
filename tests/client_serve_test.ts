/**
 * The client and server halves against each other, in-process — both sides
 * of the v6 hello, all verbs, the meta faces, error rendering, timeouts.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import * as wire from "../src/wire.ts";
import {
  CacheStatus,
  Capability,
  EndpointError,
  HelloMode,
  reference,
  Representation,
} from "../src/wire.ts";
import { connect, ConnectionLost } from "../src/client.ts";
import { endpoint, Server, Space } from "../src/serve.ts";

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

function makeEndpoints() {
  return [
    endpoint("urn:ts:hello", {
      summary: "Greet someone",
      args: [{ name: "who", required: true, class: XSD_STRING }],
    }, ({ who }) => `Hello, ${who}!`),
    endpoint("urn:ts:shout", {
      summary: "Uppercase a string",
      args: [{ name: "in", required: true }],
      cacheable: true,
    }, (args) => `${String(args["in"]).toUpperCase()}!`),
    endpoint("urn:ts:slow", {
      summary: "An async handler",
      args: [{ name: "in", required: true }],
    }, async (args) => {
      await new Promise((r) => setTimeout(r, 10));
      return `slowly ${args["in"]}`;
    }),
    endpoint("urn:ts:boom", { summary: "Always fails" }, () => {
      throw new Error("boom");
    }),
    endpoint(
      "urn:ts:bytes",
      { summary: "Raw bytes in and out", args: ["in"] },
      (
        args,
      ) => (args["in"] instanceof Uint8Array
        ? args["in"]
        : new TextEncoder().encode(String(args["in"]))),
    ),
    endpoint("urn:ts:greet", {
      summary: "Greeting with a default",
      args: [{ name: "who", default: "world" }],
    }, ({ who }) => `hi ${who}`),
  ];
}

async function withServer(
  fn: (path: string) => Promise<void>,
  options: { stripAlias?: boolean } = {},
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-" });
  const path = `${dir}/ts.sock`;
  const server = new Server(makeEndpoints(), path, options);
  const serving = server.serve();
  try {
    await fn(path);
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("source round-trips with the v6 hello on both sides", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    assertStrictEquals(k.serverVersion, 6);
    const rep = await k.source("urn:ts:hello", { who: "Ada" });
    assertStrictEquals(rep.text, "Hello, Ada!");
    assertStrictEquals(rep.mediaType, "text/plain;charset=utf-8");
    assertStrictEquals(rep.cacheStatus, CacheStatus.Uncacheable);
  });
});

Deno.test("the hello mode picks the entries form per connection", async () => {
  await withServer(async (path) => {
    // A verbatim client (plain --connect / --prefer) sees declared IRIs…
    await using verbatim = await connect(path);
    const verbatimEntries = await verbatim.entries();
    assert(verbatimEntries.some((e) => e.pattern === "urn:ts:hello"));
    // …while an alias-mode client (an alias --mount) sees stripped ones,
    // on the SAME server, with no server-side configuration. This is what
    // the v6 mode hint retires the guessing for.
    await using alias = await connect(path, { mode: HelloMode.Alias });
    const aliasEntries = await alias.entries();
    assert(aliasEntries.some((e) => e.pattern === "urn:hello"));
    assert(!aliasEntries.some((e) => e.pattern === "urn:ts:hello"));
  });
});

Deno.test("both the declared IRI and the alias-stripped form resolve", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    assertStrictEquals(
      (await k.source("urn:ts:hello", { who: "x" })).text,
      "Hello, x!",
    );
    assertStrictEquals(
      (await k.source("urn:hello", { who: "x" })).text,
      "Hello, x!",
    );
  });
});

Deno.test("a cacheable result crosses with Expiry::Never and reports Miss", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    const rep = await k.source("urn:ts:shout", { in: "hi" });
    assertStrictEquals(rep.text, "HI!");
    assertEquals(rep.expiry, wire.Expiry.never());
    assertStrictEquals(rep.cacheStatus, CacheStatus.Miss);
    // This peer keeps no representation cache of its own.
    assertStrictEquals(await k.isCached("urn:ts:shout", { in: "hi" }), false);
  });
});

Deno.test("meta faces: turtle default, text, json (the routing face)", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    const turtle = await k.meta("urn:ts:hello");
    assertStrictEquals(turtle.baseMediaType, "text/turtle");
    assert(turtle.text.includes("<urn:ikigai:endpoint:hello>"));
    assert(turtle.text.includes('ik:inputName "who"'));
    assert(turtle.text.includes("ik:class <" + XSD_STRING + ">"));
    const text = await k.meta("urn:ts:hello", "text/plain");
    assert(text.text.includes("input who [argument]"));
    const description = await k.describe("urn:ts:hello");
    assert(description !== null);
    assertStrictEquals(description["id"], "hello");
    const inputs = description["inputs"] as Record<string, unknown>[];
    assertStrictEquals(inputs[0]["name"], "who");
    assertStrictEquals(inputs[0]["required"], true);
    assertStrictEquals(inputs[0]["class"], XSD_STRING);
  });
});

Deno.test("an unknown meta face is a clean endpoint error", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    await assertRejects(
      () => k.meta("urn:ts:hello", "application/pdf"),
      EndpointError,
      "meta renderer does not support target",
    );
  });
});

Deno.test("exists answers true; unsupported verbs are named", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    assertStrictEquals((await k.exists("urn:ts:hello")).text, "true");
    await assertRejects(
      () => k.delete("urn:ts:hello"),
      EndpointError,
      "verb Delete is not supported by `hello` (a single-verb Source endpoint)",
    );
  });
});

Deno.test("the error strings match the Rust kernel's renderings", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    // Unresolved: exactly Error::Unresolved, no `endpoint error: ` prefix.
    await assertRejects(
      () => k.source("urn:ts:nope"),
      EndpointError,
      "no endpoint resolved for urn:ts:nope",
    );
    // Missing arg: exactly the Rust engine's text.
    await assertRejects(
      () => k.source("urn:ts:hello"),
      EndpointError,
      "missing required argument `who`",
    );
    // A handler throw crosses (prefix stripped by the client).
    const err = await assertRejects(
      () => k.source("urn:ts:boom"),
      EndpointError,
    );
    assertStrictEquals(err.message, "boom");
  });
});

Deno.test("a by-reference argument is refused loudly", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    await assertRejects(
      () => k.source("urn:ts:hello", { who: reference("urn:x") }),
      EndpointError,
      "arrived by reference; this peer only takes inline values",
    );
  });
});

Deno.test("async handlers, defaults, and byte passthrough work", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    assertStrictEquals(
      (await k.source("urn:ts:slow", { in: "does it" })).text,
      "slowly does it",
    );
    assertStrictEquals((await k.source("urn:ts:greet")).text, "hi world");
    assertStrictEquals(
      (await k.source("urn:ts:greet", { who: "Ada" })).text,
      "hi Ada",
    );
    const raw = new Uint8Array([0x00, 0xff, 0x01]); // not valid utf-8
    const rep = await k.source("urn:ts:bytes", { in: raw });
    assertEquals(rep.data, raw);
  });
});

Deno.test("sourceTraced returns the peer's span", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    const [rep, events] = await k.sourceTraced("urn:ts:hello", { who: "T" });
    assertStrictEquals(rep.text, "Hello, T!");
    assertStrictEquals(events.length, 1);
    assertStrictEquals(events[0].target, "urn:ts:hello");
    assert(events[0].started !== null && events[0].ended !== null);
    assertStrictEquals(events[0].capability, null); // root authority
  });
});

Deno.test("a scoped capability crosses and lands in the trace span", async () => {
  await withServer(async (path) => {
    await using k = await connect(path, {
      capability: Capability.scoped(["urn:cap:demo"]),
    });
    const [, events] = await k.sourceTraced("urn:ts:hello", { who: "T" });
    assertEquals(events[0].capability, ["urn:cap:demo"]);
    // IssueAs also round-trips (accepted, not enforced per-scope at L0).
    assertStrictEquals(
      (await k.source("urn:ts:hello", { who: "c" })).text,
      "Hello, c!",
    );
  });
});

Deno.test("concurrent calls serialize instead of interleaving frames", async () => {
  await withServer(async (path) => {
    await using k = await connect(path);
    const results = await Promise.all([
      k.source("urn:ts:hello", { who: "one" }),
      k.source("urn:ts:slow", { in: "two" }),
      k.source("urn:ts:hello", { who: "three" }),
    ]);
    assertEquals(results.map((r) => r.text), [
      "Hello, one!",
      "slowly two",
      "Hello, three!",
    ]);
  });
});

Deno.test("a hung server trips the read deadline as ConnectionLost", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-" });
  const path = `${dir}/hang.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const server = (async () => {
    const conn = await listener.accept();
    const stream = new wire.FrameStream(conn);
    try {
      await stream.readFrame(); // the client hello
      await stream.writeFrame(wire.encodeHello(wire.hello(6)));
      await stream.readFrame(); // the call — never answered
      await stream.readFrame(); // blocks until the client's timeout closes
    } catch {
      // the client's timeout closed the connection
    } finally {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  })();
  const k = await connect(path, { timeoutMs: 250 });
  await assertRejects(
    () => k.source("urn:ts:hello", { who: "x" }),
    ConnectionLost,
    "no response",
  );
  k.close();
  listener.close();
  await server;
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("connecting to nothing is ConnectionLost with guidance", async () => {
  await assertRejects(
    () => connect("/tmp/ik-deno-definitely-absent.sock"),
    ConnectionLost,
    "is `ikigai serve`",
  );
});

Deno.test("the socket file is created 0600", async () => {
  await withServer(async (path) => {
    const mode = Deno.statSync(path).mode! & 0o777;
    assertStrictEquals(mode, 0o600);
    await Promise.resolve();
  });
});

Deno.test("a handler can return a full Representation or a tuple", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-" });
  const path = `${dir}/faces.sock`;
  const json = endpoint(
    "urn:ts:json",
    { summary: "structured" },
    () => [JSON.stringify({ ok: true }), "application/json"],
  );
  const rich = endpoint(
    "urn:ts:rich",
    { summary: "full control" },
    () =>
      new Representation("<x/>", "application/xml", {
        expiry: wire.Expiry.at(1_722_000_000_000),
      }),
  );
  const server = new Server([json, rich], path);
  const serving = server.serve();
  try {
    await using k = await connect(path);
    const j = await k.source("urn:ts:json");
    assertStrictEquals(j.baseMediaType, "application/json");
    assertStrictEquals(JSON.parse(j.text)["ok"], true);
    const r = await k.source("urn:ts:rich");
    assertStrictEquals(r.baseMediaType, "application/xml");
    assertEquals(r.expiry, wire.Expiry.at(1_722_000_000_000));
    assertStrictEquals(r.cacheStatus, CacheStatus.Miss);
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("two endpoints colliding on a target are refused at build time", () => {
  const a = endpoint("urn:ts:x", { summary: "a" }, () => "a");
  const b = endpoint("urn:other:x", { summary: "b" }, () => "b"); // alias urn:x collides
  let threw = false;
  try {
    new Space([a, b]);
  } catch (e) {
    threw = true;
    assert(String(e).includes("two endpoints answer urn:x"));
  }
  assert(threw);
});
