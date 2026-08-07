/**
 * Integration against the installed Rust host, both directions.
 *
 * Skips cleanly when the `ikigai` binary is absent (CI has no Rust host;
 * these run locally against `~/.cargo/bin/ikigai`).
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { CacheStatus, EndpointError } from "../src/wire.ts";
import { connect } from "../src/client.ts";
import { endpoint, Server } from "../src/serve.ts";
import { hello, shout } from "../examples/demo.ts";

function findIkigai(): string | null {
  const home = Deno.env.get("HOME");
  const candidates = home ? [`${home}/.cargo/bin/ikigai`] : [];
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (dir) candidates.push(`${dir}/ikigai`);
  }
  for (const candidate of candidates) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

const IKIGAI = findIkigai();
const utf8 = new TextDecoder();

function integration(
  name: string,
  fn: () => Promise<void>,
): void {
  Deno.test({
    name,
    ignore: IKIGAI === null,
    // The Rust CLI child and the in-process server cross test boundaries in
    // ways the strict sanitizers dislike; cleanup is explicit instead.
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
    // The v6 money shot: no --verbatim flag, no server-side configuration —
    // the hello's mode hint makes both mount styles list correctly. (An
    // --override composes the remote's entries into `list`; --prefer routes
    // identically but the host does not enumerate its entries there.)
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

integration("Deno error text reaches the Rust user", async () => {
  await withDenoPeer(async (path) => {
    const out = await new Deno.Command(IKIGAI!, {
      args: [
        "--mount",
        `urn:ts:=${path}`,
        "-c",
        "source urn:ts:hello", // missing required `who`
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const combined = utf8.decode(out.stdout) + utf8.decode(out.stderr);
    assert(combined.includes("missing required argument `who`"), combined);
  });
});

// -- direction 2: the Rust host serves, Deno connects ----------------------

async function withRustServer(
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-" });
  const path = `${dir}/kernel.sock`;
  const child = new Deno.Command(IKIGAI!, {
    args: ["serve", path],
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        Deno.statSync(path);
        break;
      } catch {
        assert(Date.now() < deadline, "ikigai serve did not come up");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
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

integration("the Deno client drives the Rust kernel", async () => {
  await withRustServer(async (path) => {
    await using k = await connect(path);
    assertStrictEquals(k.serverVersion, 6);
    const rep = await k.source("urn:fn:toUpper", { in: "hi" });
    assertStrictEquals(rep.text, "HI");
    assert(rep.mediaType.startsWith("text/plain"), rep.mediaType);
    const entries = await k.entries();
    assert(entries !== null);
    assert(entries.some((e) => e.endpoint === "toUpper"));
    const description = await k.describe("urn:fn:toUpper");
    assert(description !== null);
    assertStrictEquals(description["id"], "toUpper");
    const inputs = description["inputs"] as Record<string, unknown>[];
    assert(inputs.some((i) => i["name"] === "in"));
  });
});

integration("the Deno client sees the Rust cache", async () => {
  await withRustServer(async (path) => {
    await using k = await connect(path);
    const first = await k.source("urn:fn:toUpper", { in: "cache me" });
    assertStrictEquals(first.cacheStatus, CacheStatus.Miss);
    const second = await k.source("urn:fn:toUpper", { in: "cache me" });
    assertStrictEquals(second.cacheStatus, CacheStatus.Hit);
    assertStrictEquals(
      await k.isCached("urn:fn:toUpper", { in: "cache me" }),
      true,
    );
  });
});

integration("the Deno client traces the Rust kernel", async () => {
  await withRustServer(async (path) => {
    await using k = await connect(path);
    const [rep, events] = await k.sourceTraced("urn:fn:toUpper", { in: "hi" });
    assertStrictEquals(rep.text, "HI");
    assert(events.some((e) => e.target === "urn:fn:toUpper"));
  });
});

integration("a Rust error string crosses to Deno", async () => {
  await withRustServer(async (path) => {
    await using k = await connect(path);
    let message = "";
    try {
      await k.source("urn:fn:nope");
    } catch (e) {
      assert(e instanceof EndpointError);
      message = e.message;
    }
    assert(message.includes("no endpoint resolved for urn:fn:nope"), message);
  });
});

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
