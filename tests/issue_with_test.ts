/**
 * Wire v9's `IssueWith` (Call variant 5) and the failure classes it travels
 * with: the vectors from ikigai-cli 0.1.66's hand-back in both directions, the
 * server's run context, and the client's choice of bytes by negotiated version.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import * as wire from "../src/wire.ts";
import { Capability, FrameStream, Verb } from "../src/wire.ts";
import { connect } from "../src/client.ts";
import { endpoint, Server } from "../src/serve.ts";
import type { RunContext } from "../src/serve.ts";

const hex = (s: string) =>
  new Uint8Array(s.split(" ").map((h) => parseInt(h, 16)));

Deno.test("IssueWith vectors, both directions", () => {
  const cases: [wire.IssueWith, string][] = [
    [{ trace: null, retries: null, timeLeftMs: null }, "00 00 00"],
    [{ trace: null, retries: 2, timeLeftMs: 1500 }, "00 01 02 01 dc 0b"],
    [
      { trace: { traceId: 7, parentSpan: null }, retries: 2, timeLeftMs: 1500 },
      "01 07 00 01 02 01 dc 0b",
    ],
  ];
  for (const [value, bytes] of cases) {
    assertEquals(wire.encodeIssueWith(value), hex(bytes));
    assertEquals(wire.decodeIssueWith(hex(bytes)), value);
  }
});

Deno.test("Call::IssueWith is variant 5, after request and capability", () => {
  const request: wire.Request = {
    verb: Verb.Source,
    target: "urn:x",
    args: {},
  };
  const call: wire.Call = {
    kind: "issueWith",
    request,
    capability: Capability.root(),
    with: { trace: null, retries: 2, timeLeftMs: 1500 },
  };
  const bytes = wire.encodeCall(call);
  assertStrictEquals(bytes[0], 5);
  assertEquals(
    bytes.slice(-6),
    hex("00 01 02 01 dc 0b"),
  );
  assertEquals(wire.decodeCall(bytes), call);
});

Deno.test("failure class vectors, both directions", () => {
  const cases: [wire.WireFailure, string][] = [
    [
      { kind: "depthExceeded", depth: 65, target: "urn:x" },
      "09 41 05 75 72 6e 3a 78",
    ],
    [
      { kind: "retryAfter", delayMs: 30000, detail: "x" },
      "0a 01 b0 ea 01 01 78",
    ],
    [{ kind: "retryAfter", delayMs: null, detail: "x" }, "0a 00 01 78"],
    [{ kind: "overBudget", detail: "x" }, "0b 01 78"],
    [{ kind: "refused", message: "x" }, "0c 01 78"],
    [{ kind: "unsupported", verb: Verb.Sink, detail: "x" }, "0d 01 01 01 78"],
    [{ kind: "unsupported", verb: null, detail: "x" }, "0d 00 01 78"],
  ];
  for (const [failure, tail] of cases) {
    const bytes = hex("05 " + tail);
    assertEquals(wire.encodeReply({ kind: "errorTyped", failure }), bytes);
    assertEquals(wire.decodeReply(bytes), { kind: "errorTyped", failure });
  }
});

Deno.test("a v7/v8 peer gets the five new tags as Endpoint(display)", () => {
  const failures: wire.WireFailure[] = [
    { kind: "depthExceeded", depth: 65, target: "urn:x" },
    { kind: "retryAfter", delayMs: 30000, detail: "x" },
    { kind: "overBudget", detail: "x" },
    { kind: "refused", message: "x" },
    { kind: "unsupported", verb: Verb.Sink, detail: "x" },
  ];
  for (const failure of failures) {
    const reply: wire.Reply = { kind: "errorTyped", failure };
    const display = wire.typedError(failure).display();
    const expected = wire.encodeReply({
      kind: "errorTyped",
      failure: { kind: "endpoint", message: display },
    });
    for (const v of [7, 8]) {
      assertEquals(wire.encodeReply(wire.replyForPeer(reply, v)), expected);
    }
    assertStrictEquals(wire.replyForPeer(reply, 9), reply);
  }
});

function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "ik-deno-" });
}

Deno.test("a v9 server hands the run context to the handler, from its own now", async () => {
  const dir = tempDir();
  const path = `${dir}/s.sock`;
  const seen: RunContext[] = [];
  const server = new Server([
    endpoint("urn:ts:run", { summary: "records its run" }, (_args, run) => {
      seen.push(run);
      return "ok";
    }),
  ], path);
  const serving = server.serve();
  try {
    const run = { retries: 3, deadline: Date.now() + 5000 };
    await using k = await connect(path, { run });
    await k.source("urn:ts:run");
    assertStrictEquals(seen[0].retriesLeft, 3);
    const left = seen[0].timeLeftMs()!;
    assert(left > 3000 && left <= 5000, `time left ${left}`);
    // The deadline is the server's now + time left, not the client's instant.
    assert(Math.abs(seen[0].deadline! - run.deadline) < 1000);
    // A client with no run sends today's bytes: nothing reaches the handler.
    k.run = null;
    await k.source("urn:ts:run");
    assertStrictEquals(seen[1].retriesLeft, null);
    assertStrictEquals(seen[1].deadline, null);
    assertStrictEquals(seen[1].timeLeftMs(), null);
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
});

/** A fake server at `version` that records the Call bytes it is sent. */
function fakeServer(path: string, version: number, calls: Uint8Array[]) {
  const listener = Deno.listen({ transport: "unix", path });
  const done = (async () => {
    for await (const conn of listener) {
      const stream = new FrameStream(conn);
      try {
        const h = wire.decodeHello(await stream.readFrame())!;
        await stream.writeFrame(wire.encodeHello(wire.hello(version)));
        if (h.version !== version) continue;
        while (true) {
          calls.push(await stream.readFrame());
          await stream.writeFrame(wire.encodeReply({
            kind: "resolved",
            representation: new wire.Representation("ok", "text/plain"),
            cacheStatus: wire.CacheStatus.Uncacheable,
          }));
        }
      } catch {
        // the client hung up
      } finally {
        try {
          conn.close();
        } catch {
          // already closed
        }
      }
    }
  })();
  return { listener, done };
}

for (const version of [7, 8, 9]) {
  Deno.test(
    `a v9 client with a run sends ${
      version === 9 ? "IssueWith" : "IssueAs"
    } to a v${version} server`,
    async () => {
      const dir = tempDir();
      const path = `${dir}/f.sock`;
      const calls: Uint8Array[] = [];
      const { listener, done } = fakeServer(path, version, calls);
      try {
        const capability = Capability.root();
        await using k = await connect(path, {
          capability,
          run: { retries: 2, deadline: Date.now() + 1500 },
        });
        assertStrictEquals(k.serverVersion, version);
        await k.source("urn:x");
        const call = wire.decodeCall(calls[0]);
        if (version === 9) {
          assert(call.kind === "issueWith");
          assertStrictEquals(call.with.retries, 2);
          assertEquals(call.with.trace, null);
          const left = call.with.timeLeftMs!;
          assert(left > 0 && left <= 1500, `time left ${left}`);
        } else {
          assertEquals(call, {
            kind: "issueAs",
            request: { verb: Verb.Source, target: "urn:x", args: {} },
            capability,
          });
        }
        // No run: the pre-v9 bytes, whatever the version.
        k.run = null;
        await k.source("urn:x");
        assertStrictEquals(wire.decodeCall(calls[1]).kind, "issueAs");
      } finally {
        listener.close();
        await done;
        Deno.removeSync(dir, { recursive: true });
      }
    },
  );
}
