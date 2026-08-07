/** The wire v6 hello: codec golden bytes, mismatch errors, both tolerances. */

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import * as wire from "../src/wire.ts";
import {
  EofError,
  FrameStream,
  HelloMode,
  ProtocolError,
} from "../src/wire.ts";
import { connect } from "../src/client.ts";
import { endpoint, Server } from "../src/serve.ts";

const utf8 = new TextEncoder();

function tempSocketDir(): string {
  // UDS paths are length-limited (~104 bytes on macOS); keep it short.
  return Deno.makeTempDirSync({ prefix: "ik-deno-" });
}

/** Capture console.error output while `fn` runs. */
async function withStderr<T>(
  fn: () => Promise<T>,
): Promise<[T, string]> {
  const original = console.error;
  let captured = "";
  console.error = (...args: unknown[]) => {
    captured += args.map(String).join(" ") + "\n";
  };
  try {
    return [await fn(), captured];
  } finally {
    console.error = original;
  }
}

Deno.test("hello golden bytes match the Rust layout", () => {
  // The exact bytes are a PUBLIC contract (ikigai-wire and ikigai-python
  // lock the same vector): magic + u32 BE version + u8 mode.
  assertEquals(
    wire.encodeHello(wire.hello(6, HelloMode.Alias)),
    new Uint8Array([...utf8.encode("IKWH"), 0x00, 0x00, 0x00, 0x06, 0x01]),
  );
  assertEquals(
    wire.encodeHello(wire.hello(6)),
    new Uint8Array([...utf8.encode("IKWH"), 0x00, 0x00, 0x00, 0x06, 0x00]),
  );
});

Deno.test("hello decode is prefix-only and hint-tolerant", () => {
  // Trailing bytes are the extension mechanism; an unknown mode byte is a
  // hint from a NEWER peer and falls back to verbatim instead of failing.
  const extended = new Uint8Array([
    ...wire.encodeHello(wire.hello(9)),
    ...utf8.encode("future"),
  ]);
  assertEquals(wire.decodeHello(extended), wire.hello(9));
  const odd = wire.encodeHello(wire.hello(9));
  odd[8] = 7;
  assertEquals(wire.decodeHello(odd), wire.hello(9, HelloMode.Verbatim));
  // A legacy first frame (a postcard Call) has no magic.
  assertStrictEquals(
    wire.decodeHello(wire.encodeCall({ kind: "entries" })),
    null,
  );
});

Deno.test("the header is big-endian, not little", () => {
  // Guard the byte order explicitly: postcard varints elsewhere are LE, and
  // a LE u32 here would round-trip within one implementation undetected.
  const payload = wire.encodeHello(wire.hello(6));
  assertEquals(payload.slice(4, 8), new Uint8Array([0x00, 0x00, 0x00, 0x06]));
});

Deno.test("a version mismatch names both versions", async () => {
  // A future v9 server: answers the hello with its own version, closes.
  const dir = tempSocketDir();
  const path = `${dir}/hello.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const server = (async () => {
    const conn = await listener.accept();
    const stream = new FrameStream(conn);
    await stream.readFrame();
    await stream.writeFrame(wire.encodeHello(wire.hello(9)));
    conn.close();
  })();
  const err = await assertRejects(() => connect(path), ProtocolError);
  assertMatch(err.message, /v9/);
  assertMatch(err.message, /v6/);
  await server;
  listener.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a new client falls back against a pre-hello server", async () => {
  // A <= v5 RUST server drops an undecodable frame SILENTLY; the client
  // must reconnect without the hello (warning loudly) and still work.
  const dir = tempSocketDir();
  const path = `${dir}/hello.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const server = (async () => {
    // First connection: read the hello, cannot decode it, hang up.
    let conn = await listener.accept();
    let stream = new FrameStream(conn);
    await stream.readFrame();
    conn.close();
    // Second connection: legacy service, straight Calls.
    conn = await listener.accept();
    stream = new FrameStream(conn);
    try {
      while (true) {
        const call = wire.decodeCall(await stream.readFrame());
        const reply: wire.Reply = call.kind === "entries"
          ? { kind: "entries", entries: [] }
          : { kind: "error", message: "endpoint error: not in this test" };
        await stream.writeFrame(wire.encodeReply(reply));
      }
    } catch {
      // client hung up
    } finally {
      conn.close();
    }
  })();
  const [, stderr] = await withStderr(async () => {
    const k = await connect(path);
    assertStrictEquals(
      k.serverVersion,
      null,
      "the fallback marks the server legacy",
    );
    assertEquals(await k.entries(), []);
    k.close();
  });
  assert(stderr.includes("predates wire v6"), stderr);
  await server;
  listener.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a legacy client without a hello is still served", async () => {
  // A <= v5 client's first frame is a Call; the server serves it (warning)
  // under its configured default entries form.
  const hi = endpoint(
    "urn:ts:hi",
    { summary: "hi", args: ["who"] },
    ({ who }) => `hi ${who}`,
  );
  const dir = tempSocketDir();
  const path = `${dir}/hello.sock`;
  const server = new Server([hi], path);
  const serving = server.serve();
  const [, stderr] = await withStderr(async () => {
    const conn = await Deno.connect({ transport: "unix", path });
    const stream = new FrameStream(conn);
    await stream.writeFrame(wire.encodeCall({ kind: "entries" }));
    const reply = wire.decodeReply(await stream.readFrame());
    assert(reply.kind === "entries" && reply.entries !== null);
    assertEquals(reply.entries.map((e) => e.pattern), ["urn:hi"]);
    conn.close();
  });
  assert(stderr.includes("without the version hello"), stderr);
  server.shutdown();
  await serving;
  Deno.removeSync(dir, { recursive: true });
});

// --- FrameStream edges (in-memory) ---

class MemoryStream implements wire.ByteStream {
  #data: Uint8Array;
  #pos = 0;
  written: number[] = [];

  constructor(data: Uint8Array = new Uint8Array(0)) {
    this.#data = data;
  }

  read(p: Uint8Array): Promise<number | null> {
    if (this.#pos >= this.#data.length) return Promise.resolve(null);
    const n = Math.min(p.length, this.#data.length - this.#pos);
    p.set(this.#data.subarray(this.#pos, this.#pos + n));
    this.#pos += n;
    return Promise.resolve(n);
  }

  write(p: Uint8Array): Promise<number> {
    this.written.push(...p);
    return Promise.resolve(p.length);
  }
}

Deno.test("frames round-trip through a stream", async () => {
  const sink = new MemoryStream();
  const out = new FrameStream(sink);
  await out.writeFrame(utf8.encode("payload"));
  await out.writeFrame(new Uint8Array(0));
  const back = new FrameStream(new MemoryStream(new Uint8Array(sink.written)));
  assertEquals(await back.readFrame(), utf8.encode("payload"));
  assertEquals(await back.readFrame(), new Uint8Array(0));
});

Deno.test("a clean close reading a frame is EofError", async () => {
  const stream = new FrameStream(new MemoryStream());
  await assertRejects(() => stream.readFrame(), EofError, "connection closed");
});

Deno.test("a mid-frame close is a distinct EofError", async () => {
  const framed = wire.frame(utf8.encode("payload"));
  const stream = new FrameStream(
    new MemoryStream(framed.slice(0, framed.length - 1)),
  );
  await assertRejects(() => stream.readFrame(), EofError, "mid-frame");
});

Deno.test("an oversized length header is rejected before allocating", async () => {
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, wire.MAX_FRAME + 1, false);
  const stream = new FrameStream(new MemoryStream(header));
  await assertRejects(() => stream.readFrame(), ProtocolError, "exceeds");
});
