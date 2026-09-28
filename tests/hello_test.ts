/**
 * The wire hello: codec golden bytes, mismatch errors, and the v7 postures —
 * pre-hello peers are REFUSED with a diagnosis (the v6 tolerances are gone),
 * and a silent server is reported as hung, never misdiagnosed as ancient.
 *
 * And the v8 posture, which is the opposite of v7's: backward compatible. A
 * v7 hello is served at v7 with Conflict downgraded, a v6 hello is refused,
 * and this client falls back to a v7 server's version by redialing.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import * as wire from "../src/wire.ts";
import {
  ConflictError,
  EndpointError,
  EofError,
  FrameStream,
  HelloMode,
  ProtocolError,
  Verb,
} from "../src/wire.ts";
import { connect, ConnectionLost } from "../src/client.ts";
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
  assertMatch(err.message, /v8/);
  await server;
  listener.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a pre-hello server is diagnosed, not tolerated", async () => {
  // v7: a <= v5 Rust server drops the undecodable hello frame silently —
  // that hang-UP is the pre-v6 signature, and the client refuses with the
  // diagnosis instead of the v6 legacy reconnect.
  const dir = tempSocketDir();
  const path = `${dir}/hello.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const server = (async () => {
    const conn = await listener.accept();
    const stream = new FrameStream(conn);
    await stream.readFrame(); // cannot decode it as a Call…
    conn.close(); // …hang up silently, the <= v5 way
  })();
  const err = await assertRejects(() => connect(path), ProtocolError);
  assert(err.message.includes("predates wire v6"), err.message);
  assert(err.message.includes("v8"), err.message);
  await server;
  listener.close();
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a silent server is reported as hung, not ancient", async () => {
  // The misdiagnosis the Rust hung-server tests caught: silence on the
  // hello is a HANG (overload), not proof of age. Bounded by the timeout.
  const dir = tempSocketDir();
  const path = `${dir}/hello.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const server = (async () => {
    const conn = await listener.accept();
    const stream = new FrameStream(conn);
    try {
      await stream.readFrame(); // the hello…
      await stream.readFrame(); // …hold the line, answer NOTHING
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
  const err = await assertRejects(
    () => connect(path, { timeoutMs: 250 }),
    ConnectionLost,
  );
  assert(err.message.includes("hung or overloaded"), err.message);
  assert(!err.message.includes("predates"), err.message);
  listener.close();
  await server;
  Deno.removeSync(dir, { recursive: true });
});

Deno.test("a pre-hello client is refused", async () => {
  // v7: a <= v5 client's first frame is a Call; the server hangs up with a
  // stderr diagnosis instead of serving it (the v6 tolerance is over).
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
    // The server must close without answering.
    await assertRejects(() => stream.readFrame(), EofError);
    conn.close();
  });
  assert(stderr.includes("refused"), stderr);
  assert(stderr.includes("without the version hello"), stderr);
  server.shutdown();
  await serving;
  Deno.removeSync(dir, { recursive: true });
});

// --- wire v8: backward compatible with v7 ---

/** A Deno server with one endpoint that refuses with a Conflict. */
function conflictServer(path: string): Server {
  const clash = endpoint(
    "urn:ts:clash",
    { summary: "always in conflict" },
    () => {
      throw new ConflictError("square taken");
    },
  );
  return new Server([clash], path);
}

const CLASH_CALL = wire.encodeCall({
  kind: "issue",
  request: { verb: Verb.Source, target: "urn:ts:clash", args: {} },
});

Deno.test("v8 server: a pinned v7 hello is answered 7 and served, Conflict downgraded", async () => {
  // Exactly what an installed v7 host sends. The answer MUST be 7, not our
  // 8: a v7 client refuses any hello answer but its own version.
  const dir = tempSocketDir();
  const path = `${dir}/v7.sock`;
  const server = conflictServer(path);
  const serving = server.serve();
  try {
    const conn = await Deno.connect({ transport: "unix", path });
    const stream = new FrameStream(conn);
    await stream.writeFrame(
      new Uint8Array([...utf8.encode("IKWH"), 0x00, 0x00, 0x00, 0x07, 0x00]),
    );
    assertEquals(
      await stream.readFrame(),
      new Uint8Array([...utf8.encode("IKWH"), 0x00, 0x00, 0x00, 0x07, 0x00]),
    );
    await stream.writeFrame(CLASH_CALL);
    // The v7 bytes for core's Error::Conflict: Endpoint("conflict: {msg}").
    assertEquals(
      await stream.readFrame(),
      new Uint8Array([
        0x05, // Reply::ErrorTyped
        0x03, // WireError::Endpoint — NOT 8, which a v7 peer cannot decode
        0x16,
        ...utf8.encode("conflict: square taken"),
      ]),
    );
    conn.close();
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("v8 server: a v8 peer receives the typed Conflict", async () => {
  const dir = tempSocketDir();
  const path = `${dir}/v8.sock`;
  const server = conflictServer(path);
  const serving = server.serve();
  try {
    await using k = await connect(path);
    assertStrictEquals(k.serverVersion, 8);
    const err = await assertRejects(
      () => k.source("urn:ts:clash"),
      ConflictError,
    );
    assertStrictEquals(err.message, "square taken");
    assertStrictEquals(err.transient, false);
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("v8 server: hellos of 6 and 9 are answered 8 and refused", async () => {
  // Outside 7..=8 in EITHER direction: our version, so the peer can name
  // both, then a close — the rule the Rust and Python halves share.
  for (const offered of [6, 9]) {
    const dir = tempSocketDir();
    const path = `${dir}/out.sock`;
    const server = conflictServer(path);
    const serving = server.serve();
    try {
      const conn = await Deno.connect({ transport: "unix", path });
      const stream = new FrameStream(conn);
      await stream.writeFrame(wire.encodeHello(wire.hello(offered)));
      assertEquals(
        wire.decodeHello(await stream.readFrame()),
        wire.hello(8),
        `offered v${offered}`,
      );
      await assertRejects(() => stream.readFrame(), EofError);
      conn.close();
    } finally {
      server.shutdown();
      await serving;
      Deno.removeSync(dir, { recursive: true });
    }
  }
});

/**
 * A stand-in for an installed v7 server, with v7's hello rule: answer with
 * 7, and hang up unless the client said 7. Records every hello it heard.
 */
function fakeV7Server(path: string, heard: number[]): {
  listener: Deno.Listener;
  done: Promise<void>;
} {
  const listener = Deno.listen({ transport: "unix", path });
  const done = (async () => {
    for await (const conn of listener) {
      const stream = new FrameStream(conn);
      try {
        const h = wire.decodeHello(await stream.readFrame());
        heard.push(h!.version);
        await stream.writeFrame(wire.encodeHello(wire.hello(7)));
        if (h!.version !== 7) continue;
        const call = wire.decodeCall(await stream.readFrame());
        assertStrictEquals(call.kind, "issue");
        // v7's rendering of core's Error::Conflict.
        await stream.writeFrame(wire.encodeReply({
          kind: "errorTyped",
          failure: { kind: "endpoint", message: "conflict: square taken" },
        }));
        await stream.readFrame(); // until the client hangs up
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

Deno.test("v8 client: a v7 server's answer triggers ONE redial at v7", async () => {
  const dir = tempSocketDir();
  const path = `${dir}/v7srv.sock`;
  const heard: number[] = [];
  const { listener, done } = fakeV7Server(path, heard);
  try {
    await using k = await connect(path);
    assertStrictEquals(k.serverVersion, 7);
    assertEquals(heard, [8, 7], "offered 8, heard 7, redialed saying 7");
    // A v7 server's conflict is untyped text; the client does NOT sniff it
    // back into a ConflictError.
    const err = await assertRejects(
      () => k.source("urn:ts:clash"),
      EndpointError,
    );
    assertStrictEquals(err.constructor, EndpointError);
    assertStrictEquals(err.message, "conflict: square taken");
  } finally {
    listener.close();
    await done;
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("v8 client: a v6 server is refused without a redial", async () => {
  const dir = tempSocketDir();
  const path = `${dir}/v6srv.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  let dials = 0;
  const server = (async () => {
    for await (const conn of listener) {
      dials++;
      const stream = new FrameStream(conn);
      try {
        await stream.readFrame();
        await stream.writeFrame(wire.encodeHello(wire.hello(6)));
      } finally {
        conn.close();
      }
    }
  })();
  try {
    const err = await assertRejects(() => connect(path), ProtocolError);
    assertMatch(err.message, /v6/);
    assertMatch(err.message, /v8/);
    assertStrictEquals(dials, 1);
  } finally {
    listener.close();
    await server;
    Deno.removeSync(dir, { recursive: true });
  }
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
