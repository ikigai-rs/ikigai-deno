/**
 * Integration against the installed Rust host, both directions.
 *
 * Skips cleanly when the `ikigai` binary is absent (CI has no Rust host;
 * these run locally against `~/.cargo/bin/ikigai`). The binary's wire
 * version is PROBED first: a v7 binary runs the full suite; an older (v6)
 * binary runs the MISMATCH suite instead — v7 removed the tolerances, so
 * the correct cross-version behavior is a clean error naming both versions,
 * and that is what gets asserted.
 *
 * A SECOND probe covers a second host-version axis: the `urn:iki:fn:`
 * resources named here need `ikigai-cli` 0.1.18 or newer, a floor no
 * manifest in a Deno package can express. Rather than fail obscurely on an
 * older host — `no endpoint resolved for urn:iki:fn:toUpper`, with nothing
 * naming the cause — those tests skip and the banner below says which
 * version is missing.
 *
 * ⚠ Both skips mean a GREEN RUN IS NOT EVIDENCE that the names here are
 * right. CI has no binary at all and skips everything. The only evidence is
 * running this file against a real host of the stated version.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  CacheStatus,
  PROTOCOL_VERSION,
  ProtocolError,
  UnresolvedError,
} from "../src/wire.ts";
import { connect } from "../src/client.ts";
import { endpoint, Server } from "../src/serve.ts";
import { hello, shout } from "../examples/demo.ts";
import {
  findIkigai,
  probeIkiFn,
  probeWireVersion,
  spawnServe,
} from "./rust_host.ts";

const IKIGAI = findIkigai();
const RUST_WIRE_VERSION = await probeWireVersion(IKIGAI);
const HAS_IKI_FN = await probeIkiFn(IKIGAI);
const utf8 = new TextDecoder();

if (IKIGAI !== null) {
  console.error(
    `integration: ${IKIGAI} speaks wire v${RUST_WIRE_VERSION}; ` +
      (RUST_WIRE_VERSION === PROTOCOL_VERSION
        ? "running the full suite"
        : "running the version-mismatch suite"),
  );
  if (!HAS_IKI_FN) {
    console.error(
      "integration: this binary does not resolve urn:iki:fn: — it predates " +
        "ikigai-cli 0.1.18; SKIPPING the urn:iki: tests (install a newer " +
        "host: `cargo install ikigai-cli --locked`)",
    );
  }
}

/** Full integration: needs a binary speaking OUR wire version. */
function integration(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name,
    ignore: IKIGAI === null || RUST_WIRE_VERSION !== PROTOCOL_VERSION,
    // The Rust CLI child and the in-process server cross test boundaries in
    // ways the strict sanitizers dislike; cleanup is explicit instead.
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

/**
 * Full integration that also names `urn:iki:` resources: needs everything
 * {@linkcode integration} needs PLUS a host of ikigai-cli 0.1.18 or newer.
 */
function fnIntegration(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name,
    ignore: IKIGAI === null || RUST_WIRE_VERSION !== PROTOCOL_VERSION ||
      !HAS_IKI_FN,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

/** Mismatch integration: needs an OLDER hello-speaking (v6) binary. */
function mismatchIntegration(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name,
    ignore: IKIGAI === null || RUST_WIRE_VERSION === null ||
      RUST_WIRE_VERSION === PROTOCOL_VERSION,
    sanitizeResources: false,
    sanitizeOps: false,
    fn,
  });
}

async function runRepl(
  commands: string[],
  options: { flag?: "--mount" | "--prefer" | "--override"; target?: string } =
    {},
): Promise<string> {
  const args: string[] = [];
  if (options.target) args.push(options.flag ?? "--mount", options.target);
  for (const command of commands) args.push("-c", command);
  const out = await new Deno.Command(IKIGAI!, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const combined = utf8.decode(out.stdout) + utf8.decode(out.stderr);
  assert(out.success, `ikigai ${args.join(" ")} failed:\n${combined}`);
  // Cache annotations and the batch tally go to stderr; return both streams.
  return combined;
}

/** `runRepl` without the success assertion — for the mismatch suite. */
async function runReplExpectingTrouble(
  commands: string[],
  options: { flag?: "--mount" | "--prefer" | "--override"; target?: string } =
    {},
): Promise<string> {
  const args: string[] = [];
  if (options.target) args.push(options.flag ?? "--mount", options.target);
  for (const command of commands) args.push("-c", command);
  const out = await new Deno.Command(IKIGAI!, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return utf8.decode(out.stdout) + utf8.decode(out.stderr);
}

async function withDenoPeer(
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-" });
  const path = `${dir}/ts.sock`;
  const server = new Server([hello, shout], path);
  const serving = server.serve();
  try {
    await fn(path);
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
}

// -- direction 1: Deno serves, the Rust host mounts ------------------------

integration("the Rust host sources a Deno endpoint (alias mount)", async () => {
  await withDenoPeer(async (path) => {
    const out = await runRepl(["source urn:ts:hello who=Ada"], {
      target: `urn:ts:=${path}`,
    });
    assert(out.includes("Hello, Ada!"), out);
  });
});

integration("the Rust host lists Deno endpoints with origin", async () => {
  await withDenoPeer(async (path) => {
    const out = await runRepl(["list"], { target: `urn:ts:=${path}` });
    assert(out.includes("urn:ts:hello"), out);
    assert(out.includes("hello"), out);
    assert(out.includes(path), out); // the mount origin, shown per binding
  });
});

integration(
  "an --override mount gets verbatim entries from the SAME server",
  async () => {
    // The v6 money shot: no server-side configuration — the hello's mode
    // hint makes both mount styles list correctly. (An --override composes
    // the remote's entries into `list`; --prefer routes identically but the
    // host does not enumerate its entries there.)
    await withDenoPeer(async (path) => {
      const out = await runRepl(["list", "source urn:ts:hello who=Ada"], {
        flag: "--override",
        target: `urn:ts:=${path}`,
      });
      assert(out.includes("urn:ts:hello"), out);
      assert(out.includes("Hello, Ada!"), out);
    });
  },
);

integration("a --prefer mount resolves the Deno peer verbatim", async () => {
  await withDenoPeer(async (path) => {
    const out = await runRepl(["source urn:ts:hello who=Ada"], {
      flag: "--prefer",
      target: `urn:ts:=${path}`,
    });
    assert(out.includes("Hello, Ada!"), out);
  });
});

integration("the Rust host caches a cacheable Deno result", async () => {
  // Expiry::Never crosses the wire; the HOST kernel caches the peer's
  // result.
  await withDenoPeer(async (path) => {
    const out = await runRepl(
      ["source urn:ts:shout in=abc", "source urn:ts:shout in=abc"],
      { target: `urn:ts:=${path}` },
    );
    assert(out.includes("ABC!"), out);
    assert(out.includes("1 cached · 1 computed"), out);
  });
});

integration("the Rust host describes a Deno endpoint", async () => {
  await withDenoPeer(async (path) => {
    const out = await runRepl(["describe urn:ts:hello"], {
      target: `urn:ts:=${path}`,
    });
    assert(out.includes("<urn:ikigai:endpoint:hello>"), out);
    assert(out.includes('ik:inputName "who"'), out);
  });
});

integration("a typed Deno error reaches the Rust user natively", async () => {
  // v7: MissingArgument crosses TYPED, so the Rust host renders its own
  // Error::MissingArgument text — not an "endpoint error:" wrapper.
  await withDenoPeer(async (path) => {
    const out = await runReplExpectingTrouble(
      ["source urn:ts:hello"], // missing required `who`
      { target: `urn:ts:=${path}` },
    );
    assert(out.includes("missing required argument `who`"), out);
    assert(!out.includes("endpoint error"), out);
  });
});

// -- direction 2: the Rust host serves, Deno connects ----------------------

async function withRustServer(
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-" });
  const path = `${dir}/kernel.sock`;
  const child = await spawnServe(IKIGAI!, path);
  try {
    await fn(path);
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await child.status;
    Deno.removeSync(dir, { recursive: true });
  }
}

fnIntegration("the Deno client drives the Rust kernel", async () => {
  await withRustServer(async (path) => {
    await using k = await connect(path);
    assertStrictEquals(k.serverVersion, 7);
    const rep = await k.source("urn:iki:fn:toUpper", { in: "hi" });
    assertStrictEquals(rep.text, "HI");
    assert(rep.mediaType.startsWith("text/plain"), rep.mediaType);
    const entries = await k.entries();
    assert(entries.some((e) => e.endpoint === "toUpper"));
    const description = await k.describe("urn:iki:fn:toUpper");
    assert(description !== null);
    assertStrictEquals(description["id"], "toUpper");
    const inputs = description["inputs"] as Record<string, unknown>[];
    assert(inputs.some((i) => i["name"] === "in"));
  });
});

fnIntegration("the Deno client sees the Rust cache", async () => {
  await withRustServer(async (path) => {
    await using k = await connect(path);
    const first = await k.source("urn:iki:fn:toUpper", { in: "cache me" });
    assertStrictEquals(first.cacheStatus, CacheStatus.Miss);
    const second = await k.source("urn:iki:fn:toUpper", { in: "cache me" });
    assertStrictEquals(second.cacheStatus, CacheStatus.Hit);
    assertStrictEquals(
      await k.isCached("urn:iki:fn:toUpper", { in: "cache me" }),
      true,
    );
  });
});

fnIntegration("the Deno client traces the Rust kernel", async () => {
  await withRustServer(async (path) => {
    await using k = await connect(path);
    const [rep, events] = await k.sourceTraced("urn:iki:fn:toUpper", {
      in: "hi",
    });
    assertStrictEquals(rep.text, "HI");
    assert(events.some((e) => e.target === "urn:iki:fn:toUpper"));
  });
});

fnIntegration("a Rust kernel's typed error crosses to Deno typed", async () => {
  // v7: an unresolved target arrives as UnresolvedError, taxonomy intact.
  await withRustServer(async (path) => {
    await using k = await connect(path);
    let error: unknown = null;
    try {
      await k.source("urn:iki:fn:nope");
    } catch (e) {
      error = e;
    }
    assert(error instanceof UnresolvedError, String(error));
    assertStrictEquals(error.iri, "urn:iki:fn:nope");
    assert(
      error.message.includes("no endpoint resolved for urn:iki:fn:nope"),
      error.message,
    );
  });
});

/**
 * ★ The alias protects INVOCATION, not OBSERVATION — and this is the test
 * with teeth.
 *
 * A 0.1.18 host aliases `prefix urn:fn: urn:iki:fn:`, so the OLD spelling
 * still resolves. But the table CANONICALIZES before the name is ever
 * observed, so every IRI coming back out — an error's `.iri`, a trace
 * event's `target`, catalog patterns — is the NEW spelling regardless of
 * what was sent. A client that sends `urn:fn:` and then matches on what
 * returns is comparing its own string against the host's rewrite of it.
 *
 * That is a distinct failure position from the ones a renaming crate can
 * see: it is invisible to the crate's own suite (which never crosses a
 * process) and to host-side tests (which send the canonical name already).
 * It surfaces only in a polyglot client's integration tests — here. It cost
 * this repo two silent failures that appeared the moment a 0.1.18 host was
 * installed, on code nobody had touched.
 *
 * So: send the old name, assert the canonical one comes back. Both halves
 * matter — resolution SUCCEEDS (the alias works) and the observed IRI has
 * MOVED (the alias canonicalized).
 */
fnIntegration(
  "the alias resolves the old name but returns the new",
  async () => {
    await withRustServer(async (path) => {
      await using k = await connect(path);

      // Invocation: the old spelling still resolves, same answer.
      const rep = await k.source("urn:fn:toUpper", { in: "hi" });
      assertStrictEquals(rep.text, "HI");

      // Observation: what comes back is canonical, NOT what was sent.
      const [, events] = await k.sourceTraced("urn:fn:toUpper", { in: "hi" });
      assert(
        events.some((e) => e.target === "urn:iki:fn:toUpper"),
        `trace targets should be canonical: ${
          JSON.stringify(events.map((e) => e.target))
        }`,
      );
      assert(
        !events.some((e) => e.target === "urn:fn:toUpper"),
        "no trace target should carry the pre-alias spelling",
      );

      // Same rule on the error path: the unresolved IRI is the rewrite.
      let error: unknown = null;
      try {
        await k.source("urn:fn:nope");
      } catch (e) {
        error = e;
      }
      assert(error instanceof UnresolvedError, String(error));
      assertStrictEquals(error.iri, "urn:iki:fn:nope");
    });
  },
);

// -- the version-mismatch suite (an installed v6 binary) -------------------

mismatchIntegration(
  "a v6 Rust server is refused cleanly, naming both versions",
  async () => {
    await withRustServer(async (path) => {
      let error: unknown = null;
      try {
        await connect(path);
      } catch (e) {
        error = e;
      }
      assert(error instanceof ProtocolError, String(error));
      assert(
        error.message.includes(`v${RUST_WIRE_VERSION}`),
        error.message,
      );
      assert(error.message.includes(`v${PROTOCOL_VERSION}`), error.message);
    });
  },
);

mismatchIntegration(
  "a v6 Rust host mounting this v7 peer errors naming both versions",
  async () => {
    await withDenoPeer(async (path) => {
      const out = await runReplExpectingTrouble(
        ["source urn:ts:hello who=Ada"],
        { target: `urn:ts:=${path}` },
      );
      // The v6 client's own rendering of the answered hello mismatch.
      assert(out.includes(`v${PROTOCOL_VERSION}`), out);
      assert(out.includes(`v${RUST_WIRE_VERSION}`), out);
      assert(!out.includes("Hello, Ada!"), out);
    });
  },
);

// A tiny always-on test so this file is never empty on CI.
Deno.test("integration harness locates the binary or skips", () => {
  assertEquals(typeof (IKIGAI ?? ""), "string");
  const echo = endpoint(
    "urn:ts:echo",
    { args: ["in"] },
    (a) => String(a["in"]),
  );
  assertStrictEquals(echo.id, "echo");
});
