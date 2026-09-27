/**
 * Families (templated doors) and multi-verb doors, over a real socket: the
 * variables reach the handler by name, each verb answers by its own
 * contract, the describe faces carry per-verb actions with `binding`
 * inputs, and every refusal crosses typed.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  CacheStatus,
  EndpointError,
  Expiry,
  HelloMode,
  InvalidArgumentError,
  MissingArgumentError,
  NotFoundError,
  Representation,
  UnresolvedError,
} from "../src/wire.ts";
import { connect } from "../src/client.ts";
import {
  endpoint,
  family,
  type ServedDef,
  Server,
  Space,
  TemplateError,
} from "../src/serve.ts";

const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";

/** A tiny key/value family: the shape of the tic-tac-toe store, generic. */
function kv(store: Map<string, string>) {
  return family("urn:ts:kv:{bucket}:{key}", {
    id: "kv",
    title: "Key/value",
    summary: "A value per bucket and key.",
    bindings: {
      bucket: { summary: "the bucket" },
      key: { summary: "the key", class: XSD_INTEGER },
    },
  })
    .source({ summary: "read it", cacheable: true }, ({ bucket, key }) => {
      const value = store.get(`${bucket}/${key}`);
      if (value === undefined) throw new NotFoundError(`no ${bucket}/${key}`);
      return value;
    })
    .sink({ summary: "write it" }, ({ bucket, key, content }) => {
      store.set(`${bucket}/${key}`, String(content));
      // A handler that tries to mark a WRITE cacheable is overruled.
      return new Representation("ok", "text/plain", {
        expiry: Expiry.never(),
      });
    })
    .delete({ summary: "clear it" }, ({ bucket, key }) => {
      store.delete(`${bucket}/${key}`);
      return "ok";
    });
}

async function withServer(
  defs: ServedDef[],
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-fam-" });
  const path = `${dir}/f.sock`;
  const server = new Server(defs, path);
  const serving = server.serve();
  try {
    await fn(path);
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("family: Source -> Sink -> Source -> Delete round trip, variables by name", async () => {
  const store = new Map<string, string>();
  await withServer([kv(store)], async (path) => {
    await using k = await connect(path);
    await assertRejects(
      () => k.source("urn:ts:kv:a:1"),
      NotFoundError,
      "no a/1",
    );
    const wrote = await k.sink("urn:ts:kv:a:1", "hello");
    assertStrictEquals(wrote.text, "ok");
    // Sink/Delete answers are never cacheable, whatever the handler built.
    assertStrictEquals(wrote.cacheStatus, CacheStatus.Uncacheable);
    assertStrictEquals(wrote.expiry.kind, "always");
    const read = await k.source("urn:ts:kv:a:1");
    assertStrictEquals(read.text, "hello");
    // A cacheable Source crosses Expiry::Never (Miss: computed, cacheable).
    assertStrictEquals(read.cacheStatus, CacheStatus.Miss);
    assertStrictEquals(read.expiry.kind, "never");
    // A different member of the family is different state.
    await assertRejects(() => k.source("urn:ts:kv:b:1"), NotFoundError);
    assertStrictEquals((await k.delete("urn:ts:kv:a:1")).text, "ok");
    // Delete is idempotent here because the handler is.
    assertStrictEquals((await k.delete("urn:ts:kv:a:1")).text, "ok");
    await assertRejects(() => k.source("urn:ts:kv:a:1"), NotFoundError);
  });
});

Deno.test("family: Sink's body is `content`, required, declared for you", async () => {
  await withServer([kv(new Map())], async (path) => {
    await using k = await connect(path);
    const missing = await assertRejects(
      () => k.sink("urn:ts:kv:a:1"),
      MissingArgumentError,
    );
    assertStrictEquals(missing.argument, "content");
    const d = await k.describe("urn:ts:kv:a:1");
    const actions = d!["actions"] as Record<string, unknown>[];
    const sink = actions.find((a) => a["verb"] === "Sink")!;
    const inputs = sink["inputs"] as Record<string, unknown>[];
    assertEquals(inputs.map((i) => [i["name"], i["source"], i["required"]]), [
      ["bucket", "binding", true],
      ["key", "binding", true],
      ["content", "argument", true],
    ]);
  });
});

Deno.test("family: Exists defaults to 'would Source succeed' — NotFound is false", async () => {
  const store = new Map([["a/1", "v"]]);
  await withServer([kv(store)], async (path) => {
    await using k = await connect(path);
    const yes = await k.exists("urn:ts:kv:a:1");
    assertStrictEquals(yes.text, "true");
    // It inherits the Source's cacheability: the same state decides it.
    assertStrictEquals(yes.expiry.kind, "never");
    assertStrictEquals((await k.exists("urn:ts:kv:a:2")).text, "false");
  });
});

Deno.test("family: Exists lets any failure other than NotFound cross as itself", async () => {
  const strict = family("urn:ts:strict:{n}")
    .source(({ n }) => {
      if (!/^[0-9]+$/.test(String(n))) {
        throw new InvalidArgumentError("n", "digits only");
      }
      return String(n);
    });
  await withServer([strict], async (path) => {
    await using k = await connect(path);
    assertStrictEquals((await k.exists("urn:ts:strict:7")).text, "true");
    await assertRejects(
      () => k.exists("urn:ts:strict:x"),
      InvalidArgumentError,
      "digits only",
    );
  });
});

Deno.test("family: an explicit Exists wins, and is described as an action", async () => {
  let ran = 0;
  const door = family("urn:ts:probe:{n}")
    .source(({ n }) => {
      ran += 1;
      return String(n);
    })
    .exists({ summary: "even only" }, ({ n }) => Number(n) % 2 === 0);
  await withServer([door], async (path) => {
    await using k = await connect(path);
    assertStrictEquals((await k.exists("urn:ts:probe:4")).text, "true");
    assertStrictEquals((await k.exists("urn:ts:probe:3")).text, "false");
    assertStrictEquals(ran, 0, "the Source handler never ran");
    const d = await k.describe("urn:ts:probe:1");
    assertEquals(d!["verbs"], ["Source", "Exists", "Meta"]);
  });
});

Deno.test("family: an undeclared verb is a typed refusal naming the ones it answers", async () => {
  const readOnly = family("urn:ts:ro:{n}").source(({ n }) => String(n));
  const writeOnly = family("urn:ts:wo:{n}", { id: "wo" }).sink(() => "ok");
  await withServer([kv(new Map()), readOnly, writeOnly], async (path) => {
    await using k = await connect(path);
    await assertRejects(
      () => k.delete("urn:ts:ro:1"),
      EndpointError,
      "verb Delete is not supported by `ro` (it answers Source, Exists, Meta)",
    );
    // No Source and no explicit Exists: Exists is refused, not guessed.
    await assertRejects(
      () => k.exists("urn:ts:wo:1"),
      EndpointError,
      "verb Exists is not supported by `wo` (it answers Sink, Meta)",
    );
    await assertRejects(
      () => k.source("urn:ts:wo:1"),
      EndpointError,
      "(it answers Sink, Meta)",
    );
  });
});

Deno.test("family: the catalog lists the TEMPLATE, in both forms", async () => {
  await withServer([kv(new Map())], async (path) => {
    await using verbatim = await connect(path);
    assertEquals(await verbatim.entries(), [
      { pattern: "urn:ts:kv:{bucket}:{key}", endpoint: "kv", origin: null },
    ]);
    await using alias = await connect(path, { mode: HelloMode.Alias });
    assertEquals(await alias.entries(), [
      { pattern: "urn:kv:{bucket}:{key}", endpoint: "kv", origin: null },
    ]);
  });
});

Deno.test("family: the alias-stripped form resolves too (a stripping mount sends it)", async () => {
  const store = new Map<string, string>();
  await withServer([kv(store)], async (path) => {
    await using k = await connect(path);
    await k.sink("urn:kv:a:1", "via-alias"); // what `--mount urn:ts:=` forwards
    assertStrictEquals((await k.source("urn:ts:kv:a:1")).text, "via-alias");
    assertStrictEquals(store.get("a/1"), "via-alias");
  });
});

Deno.test("family: Meta answers on ANY member — the host's catalog probes `{v}` -> `probe`", async () => {
  await withServer([kv(new Map())], async (path) => {
    await using k = await connect(path);
    const d = await k.describe("urn:ts:kv:probe:probe");
    assertStrictEquals(d!["id"], "kv");
  });
});

Deno.test("family: the JSON face is core's per-verb Description", async () => {
  await withServer([kv(new Map())], async (path) => {
    await using k = await connect(path);
    const d = await k.describe("urn:ts:kv:a:1");
    assertEquals(d, {
      id: "kv",
      title: "Key/value",
      summary: "A value per bucket and key.",
      verbs: ["Source", "Sink", "Delete", "Meta"],
      // An explicit action inherits nothing, so every input is on its action.
      inputs: [],
      outputs: [],
      actions: [
        {
          verb: "Source",
          summary: "read it",
          inputs: [
            {
              name: "bucket",
              summary: "the bucket",
              required: true,
              source: "binding",
            },
            {
              name: "key",
              summary: "the key",
              required: true,
              source: "binding",
              class: XSD_INTEGER,
            },
          ],
          outputs: ["text/plain;charset=utf-8"],
        },
        {
          verb: "Sink",
          summary: "write it",
          inputs: [
            {
              name: "bucket",
              summary: "the bucket",
              required: true,
              source: "binding",
            },
            {
              name: "key",
              summary: "the key",
              required: true,
              source: "binding",
              class: XSD_INTEGER,
            },
            {
              name: "content",
              summary: "the body to write",
              required: true,
              source: "argument",
            },
          ],
          outputs: ["text/plain;charset=utf-8"],
        },
        {
          verb: "Delete",
          summary: "clear it",
          inputs: [
            {
              name: "bucket",
              summary: "the bucket",
              required: true,
              source: "binding",
            },
            {
              name: "key",
              summary: "the key",
              required: true,
              source: "binding",
              class: XSD_INTEGER,
            },
          ],
          outputs: ["text/plain;charset=utf-8"],
        },
      ],
    });
  });
});

Deno.test("family: the Turtle face has one action per verb with action-scoped inputs", async () => {
  await withServer([kv(new Map())], async (path) => {
    await using k = await connect(path);
    const ttl = (await k.meta("urn:ts:kv:a:1")).text;
    assert(ttl.includes('ik:verb "Source", "Sink", "Delete", "Meta"'), ttl);
    for (const verb of ["source", "sink", "delete"]) {
      assert(
        ttl.includes(
          `<urn:ikigai:endpoint:kv:action:${verb}> a ik:Action`,
        ),
        ttl,
      );
      assert(
        ttl.includes(
          `<urn:ikigai:endpoint:kv:action:${verb}:input:key> ik:inputName "key" ;\n` +
            `    ik:source "binding" ;\n    ik:required true`,
        ),
        ttl,
      );
    }
    assert(
      ttl.includes("<urn:ikigai:endpoint:kv:action:sink:input:content>"),
      ttl,
    );
    // the Delete action does not carry the Sink's content
    assert(!ttl.includes("action:delete:input:content"), ttl);
    assert(!ttl.includes("action:meta"), ttl);
    assert(!ttl.includes("_:"), "no blank nodes");
  });
});

Deno.test("flat endpoint over a template: bindings are flat `binding` inputs (the ttt-cell shape)", async () => {
  const echo = endpoint("urn:ts:echo:{msg}", {
    summary: "Echo the name",
    bindings: { msg: { summary: "what to say" } },
    args: [{ name: "suffix", default: "" }],
    cacheable: true,
  }, ({ msg, suffix }) => `${msg}${suffix}`);
  assertStrictEquals(echo.id, "echo"); // the last PLAIN segment
  await withServer([echo], async (path) => {
    await using k = await connect(path);
    assertStrictEquals((await k.source("urn:ts:echo:a:b")).text, "a:b");
    assertStrictEquals(
      (await k.source("urn:ts:echo:hi", { suffix: "!" })).text,
      "hi!",
    );
    const ttl = (await k.meta("urn:ts:echo:x")).text;
    assert(
      ttl.includes(
        '<urn:ikigai:endpoint:echo:input:msg> ik:inputName "msg" ;\n' +
          '    ik:source "binding" ;\n    ik:required true ;\n' +
          '    ik:summary "what to say" .',
      ),
      ttl,
    );
    // the synthesized Source action references the flat nodes
    assert(
      ttl.includes("ik:input <urn:ikigai:endpoint:echo:input:msg>"),
      ttl,
    );
    const text = (await k.meta("urn:ts:echo:x", "text/plain")).text;
    assert(text.includes("  input msg [binding]: what to say\n"), text);
    assert(text.includes("  input suffix [argument] (optional): \n"), text);
  });
});

Deno.test("family: first declared wins when two patterns match", async () => {
  const special = endpoint("urn:ts:kv:special:1", { id: "special" }, () => "S");
  const store = new Map([["special/1", "from-kv"]]);
  // kv declared FIRST shadows the exact door, as an EndpointSpace would.
  await withServer([kv(store), special], async (path) => {
    await using k = await connect(path);
    assertStrictEquals((await k.source("urn:ts:kv:special:1")).text, "from-kv");
  });
  await withServer([special, kv(store)], async (path) => {
    await using k = await connect(path);
    assertStrictEquals((await k.source("urn:ts:kv:special:1")).text, "S");
    // …and the family still answers every other member.
    await assertRejects(() => k.source("urn:ts:kv:other:1"), NotFoundError);
  });
});

Deno.test("family: an IRI outside every pattern is a real Unresolved", async () => {
  await withServer([kv(new Map())], async (path) => {
    await using k = await connect(path);
    await assertRejects(
      () => k.source("urn:ts:kv:only-one"),
      UnresolvedError,
      "no endpoint resolved for urn:ts:kv:only-one",
    );
  });
});

Deno.test("declaration refusals: bad templates, collisions, doubles", () => {
  assertThrows(() => family("urn:ts:{a}{b}"), TemplateError, "adjacent");
  assertThrows(
    () => endpoint("urn:ts:e:{x}", { args: ["x"] }, () => ""),
    Error,
    "also a template variable {x}",
  );
  assertThrows(
    () => family("urn:ts:f:{x}").sink({ args: ["x"] }, () => "ok"),
    Error,
    "also a template variable {x}",
  );
  assertThrows(
    () => family("urn:ts:f:{x}", { bindings: { y: {} } }),
    Error,
    "a binding is described for {y}",
  );
  assertThrows(
    () => family("urn:ts:f:{x}").source(() => "").source(() => ""),
    Error,
    "Source is declared twice",
  );
  assertThrows(
    () =>
      family("urn:ts:f:{x}").source({
        args: [{ name: "q", source: "binding" }],
      }, () => ""),
    Error,
    "bindings come from the template's variables",
  );
  // the same template text twice is two doors answering one pattern
  assertThrows(
    () =>
      new Space([
        family("urn:ts:f:{x}").source(() => ""),
        family("urn:ts:f:{x}").source(() => ""),
      ]),
    Error,
    "two endpoints answer urn:ts:f:{x}",
  );
});
