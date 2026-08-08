/**
 * The reconnecting client: a restarted peer stops meaning 503-forever.
 *
 * The semantics under test (documented on `src/client.ts`):
 * - after a `ConnectionLost`, the next call redials once (fresh hello, same
 *   mode) before failing;
 * - within one call, only a failure to SEND is retried — a call that was
 *   sent and lost its reply is NEVER replayed (it may have executed).
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
  DeniedError,
  FrameStream,
  HelloMode,
  Verb,
} from "../src/wire.ts";
import { connect, ConnectionLost } from "../src/client.ts";
import { endpoint, Server } from "../src/serve.ts";

function makeEndpoints() {
  return [
    endpoint("urn:ts:hello", {
      summary: "Greet someone",
      args: [{ name: "who", required: true }],
    }, ({ who }) => `Hello, ${who}!`),
  ];
}

Deno.test("a restarted server is redialed transparently", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-reconnect-" });
  const path = `${dir}/peer.sock`;
  const first = new Server(makeEndpoints(), path);
  const firstServing = first.serve();
  const k = await connect(path);
  try {
    assertStrictEquals(
      (await k.source("urn:ts:hello", { who: "one" })).text,
      "Hello, one!",
    );
    // Kill the peer (severs the live connection too), restart on the SAME
    // socket path — the next call's send fails, which is the safe-to-redial
    // case: the frame never left, so nothing can have executed.
    first.shutdown();
    await firstServing;
    const second = new Server(makeEndpoints(), path);
    const secondServing = second.serve();
    try {
      const rep = await k.source("urn:ts:hello", { who: "two" });
      assertStrictEquals(rep.text, "Hello, two!");
      assertStrictEquals(k.serverVersion, 7, "the redial re-ran the hello");
    } finally {
      second.shutdown();
      await secondServing;
    }
  } finally {
    k.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("the redial replays the hello mode", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-reconnect-" });
  const path = `${dir}/peer.sock`;
  const first = new Server(makeEndpoints(), path);
  const firstServing = first.serve();
  const k = await connect(path, { mode: HelloMode.Alias });
  try {
    assert((await k.entries()).some((e) => e.pattern === "urn:hello"));
    first.shutdown();
    await firstServing;
    const second = new Server(makeEndpoints(), path);
    const secondServing = second.serve();
    try {
      // The fresh connection still identifies as an alias mount: the
      // entries form survives the redial without re-configuration.
      const entries = await k.entries();
      assert(entries.some((e) => e.pattern === "urn:hello"));
      assert(!entries.some((e) => e.pattern === "urn:ts:hello"));
    } finally {
      second.shutdown();
      await secondServing;
    }
  } finally {
    k.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a call cut mid-reply fails without replay; the NEXT call redials", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-reconnect-" });
  const path = `${dir}/cut.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  let callsReceived = 0;
  const server = (async () => {
    // Connection 1: hello, then read the call and hang up WITHOUT a reply —
    // the request was sent (and may have executed); the client must not
    // resend it anywhere.
    {
      const conn = await listener.accept();
      const stream = new FrameStream(conn);
      await stream.readFrame(); // client hello
      await stream.writeFrame(
        wire.encodeHello(wire.hello(wire.PROTOCOL_VERSION)),
      );
      await stream.readFrame(); // the call…
      callsReceived += 1;
      conn.close(); // …cut before any reply
    }
    // Connection 2: the next call's redial; serve it properly.
    {
      const conn = await listener.accept();
      const stream = new FrameStream(conn);
      await stream.readFrame(); // client hello
      await stream.writeFrame(
        wire.encodeHello(wire.hello(wire.PROTOCOL_VERSION)),
      );
      const call = wire.decodeCall(await stream.readFrame());
      callsReceived += 1;
      assert(call.kind === "issue");
      assertStrictEquals(call.request.verb, Verb.Source);
      assertStrictEquals(call.request.target, "urn:ts:second");
      await stream.writeFrame(wire.encodeReply({
        kind: "resolved",
        representation: new wire.Representation("answered"),
        cacheStatus: CacheStatus.Uncacheable,
      }));
      conn.close();
    }
  })();
  const k = await connect(path);
  try {
    // The cut call fails — it is NOT retried on a fresh connection.
    await assertRejects(
      () => k.source("urn:ts:first"),
      ConnectionLost,
    );
    // The next call redials once and succeeds.
    const rep = await k.source("urn:ts:second");
    assertStrictEquals(rep.text, "answered");
    await server;
    // One call frame per source(): the cut one was never replayed.
    assertStrictEquals(callsReceived, 2);
  } finally {
    k.close();
    listener.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a redialed v7 server's typed errors cross typed", async () => {
  // The redial replays the full v7 handshake; the fresh connection then
  // answers with ErrorTyped, and the taxonomy still crosses — a restarted
  // peer's denial is a real DeniedError, not a flattened string.
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-reconnect-" });
  const path = `${dir}/typed.sock`;
  const first = new Server(makeEndpoints(), path);
  const firstServing = first.serve();
  const k = await connect(path);
  try {
    assertStrictEquals(
      (await k.source("urn:ts:hello", { who: "one" })).text,
      "Hello, one!",
    );
    first.shutdown();
    await firstServing;
    const gated = endpoint("urn:ts:hello", { summary: "now gated" }, () => {
      throw new DeniedError("needs urn:cap:x");
    });
    const second = new Server([gated], path);
    const secondServing = second.serve();
    try {
      const err = await assertRejects(
        () => k.source("urn:ts:hello", { who: "two" }), // redials first
        DeniedError,
        "needs urn:cap:x",
      );
      assertStrictEquals(err.transient, false);
      assertStrictEquals(k.serverVersion, 7, "the redial re-ran the hello");
    } finally {
      second.shutdown();
      await secondServing;
    }
  } finally {
    k.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a dead-and-gone peer still fails cleanly after one redial attempt", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-reconnect-" });
  const path = `${dir}/gone.sock`;
  const server = new Server(makeEndpoints(), path);
  const serving = server.serve();
  const k = await connect(path);
  try {
    assertStrictEquals(
      (await k.source("urn:ts:hello", { who: "x" })).text,
      "Hello, x!",
    );
    server.shutdown(); // removes the socket file too
    await serving;
    // Send fails, the one redial fails (nothing listens), the call fails.
    await assertRejects(
      () => k.source("urn:ts:hello", { who: "y" }),
      ConnectionLost,
    );
    // And so does the next one — no listener ever comes back.
    await assertRejects(
      () => k.source("urn:ts:hello", { who: "z" }),
      ConnectionLost,
    );
  } finally {
    k.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("a closed client does not redial", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-reconnect-" });
  const path = `${dir}/closed.sock`;
  const server = new Server(makeEndpoints(), path);
  const serving = server.serve();
  try {
    const k = await connect(path);
    k.close();
    // The server is alive, but close() is final: no silent resurrection.
    await assertRejects(
      () => k.source("urn:ts:hello", { who: "x" }),
      ConnectionLost,
      "closed",
    );
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("entries answers an empty array when the space cannot enumerate", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-reconnect-" });
  const path = `${dir}/noenum.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const server = (async () => {
    const conn = await listener.accept();
    const stream = new FrameStream(conn);
    await stream.readFrame(); // client hello
    await stream.writeFrame(
      wire.encodeHello(wire.hello(wire.PROTOCOL_VERSION)),
    );
    await stream.readFrame(); // the entries call
    // The wire's "this space does not support enumeration" answer.
    await stream.writeFrame(
      wire.encodeReply({ kind: "entries", entries: null }),
    );
    conn.close();
  })();
  const k = await connect(path);
  try {
    assertEquals(await k.entries(), []);
    await server;
  } finally {
    k.close();
    listener.close();
    Deno.removeSync(dir, { recursive: true });
  }
});
