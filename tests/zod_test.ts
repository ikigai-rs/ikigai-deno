/**
 * The zod → ArgSpec rung: the derivation table, the loud mismatch check for
 * explicit-args + zod together, and dispatch-time validation (typed handler
 * args, clean field-naming errors, before the handler runs).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { z } from "zod";
import { connect } from "../src/client.ts";
import { EndpointError } from "../src/wire.ts";
import { type ArgSpec, type EndpointDef, Server } from "../src/serve.ts";
import { argSpecsFromZod, endpoint } from "../src/zod.ts";

const XSD = "http://www.w3.org/2001/XMLSchema#";

function specByName(specs: readonly ArgSpec[], name: string): ArgSpec {
  const spec = specs.find((s) => s.name === name);
  assert(spec !== undefined, `no ArgSpec named ${name}`);
  return spec;
}

// ---------------------------------------------------------------------------
// The derivation table
// ---------------------------------------------------------------------------

Deno.test("zod: the derivation table, rule by rule", () => {
  const specs = argSpecsFromZod(z.object({
    who: z.string().describe("the name to greet"),
    greeting: z.string().default("Hello"),
    mode: z.enum(["loud", "soft"]).optional(),
    ratio: z.number(),
    count: z.number().int().default(3),
    verbose: z.boolean().default(true),
    note: z.string().optional(),
  }));

  const who = specByName(specs, "who"); // z.string() + .describe
  assertStrictEquals(who.required, true);
  assertStrictEquals(who.cls, `${XSD}string`);
  assertStrictEquals(who.summary, "the name to greet");
  assertStrictEquals(who.default, null);

  const greeting = specByName(specs, "greeting"); // .default => optional
  assertStrictEquals(greeting.required, false);
  assertStrictEquals(greeting.default, "Hello");

  const mode = specByName(specs, "mode"); // z.enum + .optional
  assertStrictEquals(mode.required, false);
  assertEquals([...mode.oneOf], ["loud", "soft"]);
  assertStrictEquals(mode.cls, `${XSD}string`);

  const ratio = specByName(specs, "ratio"); // z.number
  assertStrictEquals(ratio.cls, `${XSD}double`);
  assertStrictEquals(ratio.required, true);

  const count = specByName(specs, "count"); // .int() + numeric default
  assertStrictEquals(count.cls, `${XSD}integer`);
  assertStrictEquals(count.default, "3"); // the wire text form
  assertStrictEquals(count.required, false);

  const verbose = specByName(specs, "verbose"); // z.boolean + default
  assertStrictEquals(verbose.cls, `${XSD}boolean`);
  assertStrictEquals(verbose.default, "true");

  const note = specByName(specs, "note"); // .optional()
  assertStrictEquals(note.required, false);
  assertStrictEquals(note.default, null);
});

Deno.test("zod: an unsupported schema type throws at declaration, naming the argument", () => {
  const err = assertThrows(
    () =>
      endpoint("urn:ts:bad", {
        input: z.object({ items: z.array(z.string()) }),
      }, () => "never"),
    Error,
  );
  assert(err.message.includes("`items`"), err.message);
  assert(err.message.includes("cannot derive an ArgSpec"), err.message);
});

Deno.test("zod: a non-string enum is refused", () => {
  enum Level {
    Low = 1,
    High = 2,
  }
  const err = assertThrows(
    () => argSpecsFromZod(z.object({ level: z.enum(Level) })),
    Error,
  );
  assert(err.message.includes("only string-valued enums"), err.message);
});

Deno.test("zod: the derived describe face carries class, one_of, default", () => {
  const def = endpoint("urn:ts:styled", {
    summary: "A styled greeting",
    input: z.object({
      who: z.string().describe("the name to greet"),
      mode: z.enum(["loud", "soft"]).default("soft"),
    }),
  }, ({ who }) => `hi ${who}`);
  const json = def.descriptionJson();
  const inputs = json["inputs"] as Record<string, unknown>[];
  const who = inputs.find((i) => i["name"] === "who")!;
  assertStrictEquals(who["required"], true);
  assertStrictEquals(who["class"], `${XSD}string`);
  assertStrictEquals(who["summary"], "the name to greet");
  const mode = inputs.find((i) => i["name"] === "mode")!;
  assertStrictEquals(mode["required"], false);
  assertStrictEquals(mode["default"], "soft");
  assertEquals(mode["one_of"], ["loud", "soft"]);
  // The graph face too — one_of and default are engine-routing facts.
  const ttl = def.descriptionTurtle();
  assert(ttl.includes('ik:oneOf "loud"'), ttl);
  assert(ttl.includes('ik:default "soft"'), ttl);
});

// ---------------------------------------------------------------------------
// Explicit args + zod together
// ---------------------------------------------------------------------------

Deno.test("zod: matching explicit args win the face (their summary is kept)", () => {
  const def = endpoint("urn:ts:both", {
    input: z.object({ who: z.string() }),
    args: [{
      name: "who",
      required: true,
      class: `${XSD}string`,
      summary: "the explicit summary",
    }],
  }, ({ who }) => `hi ${who}`);
  assertStrictEquals(def.args[0].summary, "the explicit summary");
});

Deno.test("zod: explicit args that contradict the schema are refused loudly", () => {
  // A required flip.
  let err = assertThrows(
    () =>
      endpoint("urn:ts:flip", {
        input: z.object({ who: z.string() }),
        args: [{ name: "who", required: false }],
      }, ({ who }) => `hi ${who}`),
    Error,
  );
  assert(err.message.includes("urn:ts:flip"), err.message);
  assert(err.message.includes("required=false"), err.message);

  // An argument the schema does not know.
  err = assertThrows(
    () =>
      endpoint("urn:ts:extra", {
        input: z.object({ who: z.string() }),
        args: ["who", "ghost"],
      }, ({ who }) => `hi ${who}`),
    Error,
  );
  assert(
    err.message.includes("`ghost` is in args but not in the zod input"),
    err.message,
  );

  // A class contradiction.
  err = assertThrows(
    () =>
      endpoint("urn:ts:cls", {
        input: z.object({ n: z.number() }),
        args: [{ name: "n", class: `${XSD}string` }],
      }, ({ n }) => String(n)),
    Error,
  );
  assert(err.message.includes("class"), err.message);
});

// ---------------------------------------------------------------------------
// Dispatch: validate before the handler, hand it typed args
// ---------------------------------------------------------------------------

function makeZodEndpoints(): {
  defs: EndpointDef[];
  invocations: string[];
} {
  const invocations: string[] = [];
  const typed = endpoint("urn:ts:typed", {
    summary: "Proves the handler receives parsed types",
    input: z.object({
      who: z.string(),
      greeting: z.string().default("Hello"),
      mode: z.enum(["loud", "soft"]).optional(),
      ratio: z.number(),
      count: z.number().int().default(2),
      verbose: z.boolean().default(false),
    }),
  }, ({ who, greeting, mode, ratio, count, verbose }) => {
    invocations.push(who);
    // TYPED: numbers are numbers, booleans booleans — no String() anywhere.
    const scaled: number = ratio * count;
    return JSON.stringify({
      text: `${greeting}, ${who}${mode === "loud" ? "!!" : "."}`,
      scaled,
      types: [typeof ratio, typeof count, typeof verbose, typeof mode],
      verbose,
    });
  });
  return { defs: [typed], invocations };
}

async function withZodServer(
  fn: (path: string, invocations: string[]) => Promise<void>,
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-zod-" });
  const path = `${dir}/zod.sock`;
  const { defs, invocations } = makeZodEndpoints();
  const server = new Server(defs, path);
  const serving = server.serve();
  try {
    await fn(path, invocations);
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("zod: wire text arrives typed in the handler; defaults apply", async () => {
  await withZodServer(async (path) => {
    await using k = await connect(path);
    const full = JSON.parse(
      (await k.source("urn:ts:typed", {
        who: "Ada",
        mode: "loud",
        ratio: "2.5",
        count: "4",
        verbose: "true",
      })).text,
    );
    assertStrictEquals(full.text, "Hello, Ada!!"); // greeting defaulted
    assertStrictEquals(full.scaled, 10); // 2.5 * 4, computed numerically
    assertEquals(full.types, ["number", "number", "boolean", "string"]);
    assertStrictEquals(full.verbose, true);

    const bare = JSON.parse(
      (await k.source("urn:ts:typed", { who: "Ada", ratio: "1.5" })).text,
    );
    assertStrictEquals(bare.text, "Hello, Ada."); // mode absent -> undefined
    assertStrictEquals(bare.scaled, 3); // count defaulted to 2
    assertEquals(bare.types, ["number", "number", "boolean", "undefined"]);
    assertStrictEquals(bare.verbose, false); // boolean default applied
  });
});

Deno.test("zod: bad input is a clean endpoint error naming the field, before the handler", async () => {
  await withZodServer(async (path, invocations) => {
    await using k = await connect(path);
    // A value outside the enum.
    let err = await assertRejects(
      () =>
        k.source("urn:ts:typed", { who: "Ada", ratio: "1", mode: "shouty" }),
      EndpointError,
    );
    assert(err.message.includes("invalid argument `mode`"), err.message);
    // Unparseable number: passes through as text, zod names the field.
    err = await assertRejects(
      () => k.source("urn:ts:typed", { who: "Ada", ratio: "fast" }),
      EndpointError,
    );
    assert(err.message.includes("invalid argument `ratio`"), err.message);
    // A non-integer where .int() is declared.
    err = await assertRejects(
      () => k.source("urn:ts:typed", { who: "Ada", ratio: "1", count: "2.5" }),
      EndpointError,
    );
    assert(err.message.includes("invalid argument `count`"), err.message);
    // A boolean that is neither true nor false.
    err = await assertRejects(
      () =>
        k.source("urn:ts:typed", { who: "Ada", ratio: "1", verbose: "yes" }),
      EndpointError,
    );
    assert(err.message.includes("invalid argument `verbose`"), err.message);
    // None of the rejects reached the handler.
    assertEquals(invocations, []);
  });
});

Deno.test("zod: a missing required argument keeps the Rust engine's exact text", async () => {
  await withZodServer(async (path) => {
    await using k = await connect(path);
    // The ArgSpec gate (shared with explicit-args endpoints) answers first,
    // with the same rendering the Rust kernel uses.
    await assertRejects(
      () => k.source("urn:ts:typed", { ratio: "1" }),
      EndpointError,
      "missing required argument `who`",
    );
  });
});

Deno.test("zod: bytes into a text schema are refused naming the field", async () => {
  await withZodServer(async (path) => {
    await using k = await connect(path);
    const err = await assertRejects(
      () =>
        k.source("urn:ts:typed", {
          who: new Uint8Array([0x00, 0xff, 0x01]), // not valid utf-8
          ratio: "1",
        }),
      EndpointError,
    );
    assert(err.message.includes("invalid argument `who`"), err.message);
    assert(err.message.includes("not valid UTF-8"), err.message);
  });
});
