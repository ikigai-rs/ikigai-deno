/**
 * The tic-tac-toe store (`examples/tictactoe_store.ts`) against its
 * contract — the Rust original's messages, word for word — and then end to
 * end through a real Rust host: `ikigai serve --override` mounts it, and a
 * Source -> Sink -> Source round trip shows the HOST's cached read cut by
 * the write (the reads counter proves which reads ran here).
 *
 * The host half skips when no `ikigai` binary this package speaks (v7 or v8)
 * is installed (CI has no Rust host).
 */

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  CacheStatus,
  InvalidArgumentError,
  MissingArgumentError,
  NotFoundError,
} from "../src/wire.ts";
import { connect } from "../src/client.ts";
import { Server } from "../src/serve.ts";
import {
  CellStore,
  plainInteger,
  STORED,
  storedCell,
  storedName,
} from "../examples/tictactoe_store.ts";
import {
  findIkigai,
  probeWireVersion,
  spawnServe,
  speaksWireVersion,
} from "./rust_host.ts";

const IKIGAI = findIkigai();
const RUST_WIRE_VERSION = await probeWireVersion(IKIGAI);

async function withStore(
  fn: (path: string, store: CellStore) => Promise<void>,
): Promise<void> {
  // A short path: macOS caps a socket path at 104 bytes.
  const dir = Deno.makeTempDirSync({ prefix: "ttt-" });
  const path = `${dir}/s.sock`;
  const store = new CellStore();
  const server = new Server([storedCell(store)], path);
  const serving = server.serve();
  try {
    await fn(path, store);
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
}

const REFUSAL = "is not an integer in its plain form (e.g. 0, 2, -1)";

Deno.test("ttt: a coordinate has exactly one spelling (Rust's parse + to_string)", () => {
  for (const ok of ["0", "2", "-1", "40", "9223372036854775807"]) {
    assertStrictEquals(plainInteger("x", ok), BigInt(ok));
  }
  assertStrictEquals(
    plainInteger("x", "-9223372036854775808"),
    -(2n ** 63n),
  );
  for (
    const bad of [
      "01",
      "+1",
      "-0",
      "00",
      " 1",
      "1 ",
      "1.0",
      "",
      "-",
      "x",
      "9223372036854775808", // one past i64::MAX: Rust's parse refuses it
      "-9223372036854775809",
    ]
  ) {
    let caught: unknown = null;
    try {
      plainInteger("y", bad);
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof InvalidArgumentError)) {
      throw new Error(`\`${bad}\` was accepted`);
    }
    assertStrictEquals(caught.argument, "y");
    assertStrictEquals(caught.detail, `\`${bad}\` ${REFUSAL}`);
  }
});

Deno.test("ttt: the store keeps the contract, message for message", async () => {
  await withStore(async (path, store) => {
    await using k = await connect(path);
    // Nothing played: a TYPED NotFound, the book's exact text.
    await assertRejects(
      () => k.source(storedName(1, 1)),
      NotFoundError,
      "nothing has been played at 1,1",
    );
    assertStrictEquals(store.reads, 1);
    // A mark, trimmed; any non-empty mark (the atom knows no rules).
    assertStrictEquals((await k.sink(storedName(1, 1), " X\n")).text, "ok");
    assertStrictEquals((await k.source(storedName(1, 1))).text, "X");
    await k.sink(storedName(-3, 40), "R");
    assertStrictEquals((await k.source(storedName(-3, 40))).text, "R");
    // The read is cacheable; the write is not.
    const read = await k.source(storedName(1, 1));
    assertStrictEquals(read.expiry.kind, "never");
    assertStrictEquals(read.mediaType, "text/plain;charset=utf-8");
    const wrote = await k.sink(storedName(1, 1), "O");
    assertStrictEquals(wrote.cacheStatus, CacheStatus.Uncacheable);
    // Empty mark: InvalidArgument on content, the Rust text.
    const empty = await assertRejects(
      () => k.sink(storedName(1, 1), "   "),
      InvalidArgumentError,
      "an empty mark — to clear a cell, delete it",
    );
    assertStrictEquals(empty.argument, "content");
    // No body at all: the declared content is missing.
    await assertRejects(
      () => k.sink(storedName(1, 1)),
      MissingArgumentError,
      "missing required argument `content`",
    );
    // A second spelling of a square is refused, naming the variable.
    const spelled = await assertRejects(
      () => k.source("urn:iki:tutorial:ttt:stored:01:1"),
      InvalidArgumentError,
      `\`01\` ${REFUSAL}`,
    );
    assertStrictEquals(spelled.argument, "x");
    await assertRejects(
      () => k.sink("urn:iki:tutorial:ttt:stored:1:-0", "X"),
      InvalidArgumentError,
      "invalid argument `y`",
    );
    // Delete clears, idempotently.
    assertStrictEquals((await k.delete(storedName(1, 1))).text, "ok");
    assertStrictEquals((await k.delete(storedName(1, 1))).text, "ok");
    await assertRejects(() => k.source(storedName(1, 1)), NotFoundError);
    assertEquals([...store.marks.entries()], [["-3,40", "R"]]);
  });
});

Deno.test("ttt: the family is listed by its template, as ttt-stored", async () => {
  await withStore(async (path) => {
    await using k = await connect(path);
    assertEquals(await k.entries(), [
      { pattern: STORED, endpoint: "ttt-stored", origin: null },
    ]);
    const d = await k.describe(storedName(0, 0));
    assertEquals(d!["verbs"], ["Source", "Sink", "Delete", "Meta"]);
  });
});

Deno.test({
  name: "ttt: through a real Rust host, a Sink cuts the host's cached read",
  ignore: IKIGAI === null || !speaksWireVersion(RUST_WIRE_VERSION),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withStore(async (storePath, store) => {
      const dir = Deno.makeTempDirSync({ prefix: "ttt-k-" });
      const kernelSocket = `${dir}/k.sock`;
      const child = await spawnServe(IKIGAI!, kernelSocket, [
        "--override",
        `urn:iki:tutorial:ttt:stored:=${storePath}`,
      ]);
      try {
        await using k = await connect(kernelSocket);
        const cell = storedName(1, 1);
        // The typed NotFound crosses BOTH hops intact.
        await assertRejects(
          () => k.source(cell),
          NotFoundError,
          "nothing has been played at 1,1",
        );
        await k.sink(cell, "X");
        const first = await k.source(cell);
        assertStrictEquals(first.text, "X");
        assertStrictEquals(first.cacheStatus, CacheStatus.Miss);
        const reads = store.reads;
        const second = await k.source(cell);
        assertStrictEquals(second.text, "X");
        assertStrictEquals(second.cacheStatus, CacheStatus.Hit);
        assertStrictEquals(store.reads, reads, "the host served it cached");
        // The write goes through the host, which cuts the read's thread.
        await k.sink(cell, "O");
        const third = await k.source(cell);
        assertStrictEquals(third.text, "O");
        assertStrictEquals(third.cacheStatus, CacheStatus.Miss);
        assertStrictEquals(store.reads, reads + 1, "recomputed after the cut");
        // …and a Delete cuts it too.
        await k.source(cell); // cached again
        await k.delete(cell);
        await assertRejects(() => k.source(cell), NotFoundError);
        // The host's catalog lists the family by its template.
        const entries = await k.entries();
        assertEquals(
          entries.filter((e) => e.pattern === STORED).map((e) => e.endpoint),
          ["ttt-stored"],
        );
        // The host routes by our per-verb contract (JSON Meta through the
        // mount) and describes the family on the member it was asked about.
        const d = await k.describe(storedName(2, 0));
        assertStrictEquals(d!["id"], "ttt-stored");
      } finally {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        await child.status;
        Deno.removeSync(dir, { recursive: true });
      }
    });
  },
});

Deno.test({
  name:
    "ttt: through a STRIPPING mount (`--mount urn:iki:=`), the alias form answers",
  ignore: IKIGAI === null || !speaksWireVersion(RUST_WIRE_VERSION),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withStore(async (storePath, store) => {
      const dir = Deno.makeTempDirSync({ prefix: "ttt-a-" });
      const kernelSocket = `${dir}/k.sock`;
      // The host rewrites urn:iki:tutorial:… to urn:tutorial:… before
      // forwarding; the family answers its stripped template too.
      const child = await spawnServe(IKIGAI!, kernelSocket, [
        "--mount",
        `urn:iki:=${storePath}`,
      ]);
      try {
        await using k = await connect(kernelSocket);
        const cell = storedName(0, 2);
        await k.sink(cell, "X");
        assertStrictEquals((await k.source(cell)).text, "X");
        assertStrictEquals(store.marks.get("0,2"), "X");
        // …and the catalog, re-prefixed by the host, shows the template.
        const entries = await k.entries();
        assertEquals(
          entries.filter((e) => e.pattern === STORED).map((e) => e.endpoint),
          ["ttt-stored"],
        );
      } finally {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        await child.status;
        Deno.removeSync(dir, { recursive: true });
      }
    });
  },
});
