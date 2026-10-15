/**
 * The capability floor (ledger #1580), pinned with ikigai-core's own vectors
 * (ledger #1583).
 *
 * Every coverage, floor and denial expectation in the first half comes from
 * `capability_vectors.json`, a VERBATIM copy of ikigai-core's
 * `crates/ikigai-vocab/tests/vectors/capability_vectors.json`. Core's own test
 * recomputes that file (its denials by issuing through a kernel) and fails if
 * it differs by a byte, and devtools' `vector-drift` compares this copy with
 * core's, so do not edit or reformat it here (`deno.json` keeps it out of
 * `deno fmt`): to pick up new vectors, copy the file again. Its sections, and
 * what each asks of a face, are in core's `tests/vectors/README.md`.
 *
 * The second half is face-local: the public builders declare what core's table
 * expects, and the floor at dispatch refuses an under-capable `issueAs` typed
 * before the handler runs, runs a covering one, and resolves a plain `issue`
 * under root.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type Call,
  Capability,
  inline,
  isDenyScope,
  type Reply,
  Verb,
} from "../src/wire.ts";
import { endpoint, family, Space } from "../src/serve.ts";
import { type Json, VectorDoor, verbOf } from "./vector_door.ts";

// ---------------------------------------------------------------------------
// Core's shared capability vectors
// ---------------------------------------------------------------------------

/** A vector's capability: `"root"` or the list of scopes it holds. */
type Held = "root" | string[];

const VECTORS: {
  form: string;
  deny_scopes: { scope: string; is_deny_scope: boolean }[];
  coverage: {
    capability: Held;
    scope: string;
    allows: boolean;
    satisfies: boolean;
  }[];
  principals: { capability: Held; principal: string | null }[];
  floors: {
    name: string;
    description: Json;
    verbs: { verb: string; required_scopes: string[] }[];
  }[];
  denials: {
    name: string;
    target: string;
    description: Json;
    verb: string;
    capability: Held;
    denied: string | null;
  }[];
} = JSON.parse(
  await Deno.readTextFile(
    new URL("./capability_vectors.json", import.meta.url),
  ),
);

const capability = (held: Held): Capability =>
  held === "root" ? Capability.root() : Capability.scoped(held);

const PRINCIPAL = "urn:cap:principal:";

Deno.test("the capability vectors are core's file, in the shape this test reads", () => {
  assertStrictEquals(VECTORS.form, "ikigai:capability:v1");
  for (
    const key of [
      "deny_scopes",
      "coverage",
      "principals",
      "floors",
      "denials",
    ] as const
  ) {
    assert(VECTORS[key].length > 0, `no ${key}`);
  }
});

Deno.test("deny_scopes: isDenyScope is core's is_deny_scope", () => {
  for (const row of VECTORS.deny_scopes) {
    assertStrictEquals(isDenyScope(row.scope), row.is_deny_scope, row.scope);
  }
});

Deno.test("coverage: allows is exact and satisfies is the floor's predicate, as in core", () => {
  for (const row of VECTORS.coverage) {
    const cap = capability(row.capability);
    const what = `${JSON.stringify(row.capability)} / ${row.scope}`;
    assertStrictEquals(cap.allows(row.scope), row.allows, `allows ${what}`);
    assertStrictEquals(
      cap.satisfies(row.scope),
      row.satisfies,
      `satisfies ${what}`,
    );
  }
});

Deno.test("principals: the one principal a capability carries is granted", () => {
  // This package has no public `principal()`: the principal is read only
  // through `allows`, so what is checkable here is that the principal core
  // names is granted. The refusals (several, a wildcard, an uncarriable IRI)
  // are pinned through `coverage`'s principal-scope rows.
  for (const row of VECTORS.principals) {
    if (row.principal === null) continue;
    assert(
      capability(row.capability).allows(PRINCIPAL + row.principal),
      JSON.stringify(row.capability).slice(0, 120),
    );
  }
});

Deno.test("floors: requiredScopes is core's Description::required_scopes", () => {
  for (const floor of VECTORS.floors) {
    const door = new VectorDoor(floor.description);
    for (const row of floor.verbs) {
      assertEquals(
        door.requiredScopes(verbOf(row.verb)),
        row.required_scopes,
        `${floor.name} ${row.verb}`,
      );
    }
  }
});

Deno.test("denials: the floor at dispatch refuses with the kernel's text", async () => {
  for (const row of VECTORS.denials) {
    const space = new Space([new VectorDoor(row.description, row.target)], {
      stripAlias: false,
    });
    const call: Call = {
      kind: "issueAs",
      request: { verb: verbOf(row.verb), target: row.target, args: {} },
      capability: capability(row.capability),
    };
    let refused: string | null = null;
    try {
      const reply = await space.dispatch(call);
      if (reply.kind === "errorTyped" && reply.failure.kind === "denied") {
        refused = reply.failure.message;
      }
    } catch {
      // A vector door answers Meta only, so an admitted Source, Sink, Exists or
      // Delete reaches it and throws: the floor let the request through.
    }
    assertStrictEquals(refused, row.denied, row.name);
  }
});

// ---------------------------------------------------------------------------
// Face-local: the public builders declare what core's table expects
// ---------------------------------------------------------------------------

const noop = () => "ok";

Deno.test("a per-verb requires replaces the flat one; undeclared verbs follow core's table", () => {
  const calendar = family("urn:ts:calendar")
    .source({ requires: ["urn:cap:cal:read"] }, noop)
    .sink({ requires: ["urn:cap:cal:write"] }, noop);
  assertEquals(calendar.requiredScopes(Verb.Source), ["urn:cap:cal:read"]);
  assertEquals(calendar.requiredScopes(Verb.Sink), ["urn:cap:cal:write"]);
  // An undeclared Exists asks what a reader holds; Meta is never gated.
  assertEquals(calendar.requiredScopes(Verb.Exists), ["urn:cap:cal:read"]);
  assertEquals(calendar.requiredScopes(Verb.Meta), []);
  // An undeclared mutating verb needs everything the door declares.
  assertEquals(calendar.requiredScopes(Verb.Delete), [
    "urn:cap:cal:read",
    "urn:cap:cal:write",
  ]);

  // No Source: an undeclared Exists needs every declared scope, deduplicated.
  const writeOnly = family("urn:ts:drop")
    .sink({ requires: ["urn:cap:a", "urn:cap:b"] }, noop)
    .delete({ requires: ["urn:cap:b", "urn:cap:c"] }, noop);
  assertEquals(writeOnly.requiredScopes(Verb.Exists), [
    "urn:cap:a",
    "urn:cap:b",
    "urn:cap:c",
  ]);

  // The flat form: Source declares; undeclared verbs need the same.
  const flat = endpoint("urn:ts:flat", { requires: ["urn:cap:f"] }, noop);
  for (const verb of [Verb.Source, Verb.Exists, Verb.Sink, Verb.Delete]) {
    assertEquals(flat.requiredScopes(verb), ["urn:cap:f"], `verb ${verb}`);
  }
  assertEquals(flat.requiredScopes(Verb.Meta), []);

  // Declaring nothing is public on every verb.
  const open = endpoint("urn:ts:open", {}, noop);
  assertEquals(open.requiredScopes(Verb.Source), []);
});

// ---------------------------------------------------------------------------
// The floor at dispatch
// ---------------------------------------------------------------------------

function request(
  verb: Verb,
  target: string,
  args: Record<string, string> = {},
) {
  return {
    verb,
    target,
    args: Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, inline(v)]),
    ),
  };
}

function issueAs(
  verb: Verb,
  target: string,
  scopes: string[],
  args: Record<string, string> = {},
): Call {
  return {
    kind: "issueAs",
    request: request(verb, target, args),
    capability: Capability.scoped(scopes),
  };
}

function denied(reply: Reply): string {
  assertStrictEquals(reply.kind, "errorTyped", JSON.stringify(reply));
  if (reply.kind !== "errorTyped") throw new Error("unreachable");
  assertStrictEquals(reply.failure.kind, "denied");
  if (reply.failure.kind !== "denied") throw new Error("unreachable");
  return reply.failure.message;
}

function text(reply: Reply): string {
  assertStrictEquals(reply.kind, "resolved", JSON.stringify(reply));
  if (reply.kind !== "resolved") throw new Error("unreachable");
  return new TextDecoder().decode(reply.representation.data);
}

/** A space whose handlers count their entries, so a refusal can be shown to run none. */
function gatedSpace() {
  const entered: string[] = [];
  const space = new Space([
    endpoint("urn:ts:secret", {
      requires: ["urn:cap:ts:secret:read"],
    }, () => (entered.push("secret"), "the secret")),
    endpoint("urn:ts:fetch", {
      requires: ["urn:cap:net:*"],
    }, () => (entered.push("fetch"), "fetched")),
    endpoint("urn:ts:script", {
      requires: ["urn:cap:script:run:open-*"],
    }, () => (entered.push("script"), "ran")),
    family("urn:ts:notes:{name}", { id: "notes" })
      .source({ requires: ["urn:cap:notes:read"] }, ({ name }) => {
        entered.push(`read ${name}`);
        return `note ${name}`;
      })
      .sink({ requires: ["urn:cap:notes:write"] }, ({ name }) => {
        entered.push(`write ${name}`);
        return "ok";
      }),
    endpoint("urn:ts:open", {}, () => (entered.push("open"), "public")),
  ], { stripAlias: false });
  return { space, entered };
}

Deno.test("an under-capable issueAs is refused typed, before the handler runs", async () => {
  const { space, entered } = gatedSpace();
  const message = denied(
    await space.dispatch(
      issueAs(Verb.Source, "urn:ts:secret", ["urn:cap:nothing"]),
    ),
  );
  // Core's exact-requirement text, byte for byte.
  assertStrictEquals(
    message,
    "capability does not grant `urn:cap:ts:secret:read` (declared by `urn:ts:secret`)",
  );
  // The empty capability grants nothing either.
  denied(await space.dispatch(issueAs(Verb.Source, "urn:ts:secret", [])));
  assertEquals(entered, []);
});

Deno.test("a covering issueAs runs; root and a plain issue run", async () => {
  const { space, entered } = gatedSpace();
  assertStrictEquals(
    text(
      await space.dispatch(
        issueAs(Verb.Source, "urn:ts:secret", ["urn:cap:ts:secret:read"]),
      ),
    ),
    "the secret",
  );
  assertStrictEquals(
    text(
      await space.dispatch({
        kind: "issueAs",
        request: request(Verb.Source, "urn:ts:secret"),
        capability: Capability.root(),
      }),
    ),
    "the secret",
  );
  // A plain Issue carries no capability: the owner's root, as the Rust IPC
  // door resolves it.
  assertStrictEquals(
    text(
      await space.dispatch({
        kind: "issue",
        request: request(Verb.Source, "urn:ts:secret"),
      }),
    ),
    "the secret",
  );
  assertEquals(entered, ["secret", "secret", "secret"]);
});

Deno.test("a declared family scope is satisfied by any grant under its prefix", async () => {
  const { space } = gatedSpace();
  assertStrictEquals(
    text(
      await space.dispatch(
        issueAs(Verb.Source, "urn:ts:fetch", ["urn:cap:net:example.com"]),
      ),
    ),
    "fetched",
  );
  assertStrictEquals(
    denied(
      await space.dispatch(
        issueAs(Verb.Source, "urn:ts:fetch", ["urn:cap:fs:read:/x"]),
      ),
    ),
    "capability does not grant `urn:cap:net:*` (declared by `urn:ts:fetch`; " +
      "any grant under `urn:cap:net:` satisfies it)",
  );
  // Core's a_family_floor_refusal_names_what_satisfies_it, ported.
  assertStrictEquals(
    denied(
      await space.dispatch(
        issueAs(Verb.Source, "urn:ts:script", [
          "urn:cap:script:run:close-door",
        ]),
      ),
    ),
    "capability does not grant `urn:cap:script:run:open-*` (declared by " +
      "`urn:ts:script`; any grant under `urn:cap:script:run:open-` satisfies it)",
  );
  text(
    await space.dispatch(
      issueAs(Verb.Source, "urn:ts:script", ["urn:cap:script:run:open-door"]),
    ),
  );
});

Deno.test("the floor is per verb: a reader cannot write, and Exists needs what Source needs", async () => {
  const { space, entered } = gatedSpace();
  const reader = ["urn:cap:notes:read"];
  assertStrictEquals(
    text(await space.dispatch(issueAs(Verb.Source, "urn:ts:notes:a", reader))),
    "note a",
  );
  assertStrictEquals(
    denied(
      await space.dispatch(
        issueAs(Verb.Sink, "urn:ts:notes:a", reader, { content: "x" }),
      ),
    ),
    "capability does not grant `urn:cap:notes:write` (declared by `urn:ts:notes:a`)",
  );
  // The writer's own scope is the Sink floor, not the reader's: per-verb
  // requires REPLACE, they do not add up.
  assertStrictEquals(
    text(
      await space.dispatch(
        issueAs(Verb.Sink, "urn:ts:notes:a", ["urn:cap:notes:write"], {
          content: "x",
        }),
      ),
    ),
    "ok",
  );
  // A derived Exists is floored on Source's requires.
  denied(
    await space.dispatch(
      issueAs(Verb.Exists, "urn:ts:notes:a", ["urn:cap:notes:write"]),
    ),
  );
  assertStrictEquals(
    text(await space.dispatch(issueAs(Verb.Exists, "urn:ts:notes:a", reader))),
    "true",
  );
  // An undeclared Delete needs every declared scope, so a reader+writer is
  // let through to the verb refusal and a reader alone is Denied first.
  denied(await space.dispatch(issueAs(Verb.Delete, "urn:ts:notes:a", reader)));
  const both = await space.dispatch(
    issueAs(Verb.Delete, "urn:ts:notes:a", [
      "urn:cap:notes:read",
      "urn:cap:notes:write",
    ]),
  );
  assert(
    both.kind === "errorTyped" && both.failure.kind === "endpoint",
    JSON.stringify(both),
  );
  assertEquals(entered, ["read a", "write a", "read a"]);
});

Deno.test("Meta is never floored, and an undeclared door stays public", async () => {
  const { space } = gatedSpace();
  const meta = await space.dispatch(
    issueAs(Verb.Meta, "urn:ts:secret", [], { as: "application/json" }),
  );
  assert(text(meta).includes("urn:cap:ts:secret:read"));
  assertStrictEquals(
    text(await space.dispatch(issueAs(Verb.Source, "urn:ts:open", []))),
    "public",
  );
});

Deno.test("issueTraced is floored under the capability it carries", async () => {
  const { space, entered } = gatedSpace();
  const call = (scopes: string[]): Call => ({
    kind: "issueTraced",
    request: request(Verb.Source, "urn:ts:secret"),
    capability: Capability.scoped(scopes),
    context: { traceId: 1, parentSpan: null },
  });
  denied(await space.dispatch(call(["urn:cap:other"])));
  const ok = await space.dispatch(call(["urn:cap:ts:secret:read"]));
  assertStrictEquals(ok.kind, "resolvedTraced");
  assertEquals(entered, ["secret"]);
});
