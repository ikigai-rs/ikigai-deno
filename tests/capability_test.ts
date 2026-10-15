/**
 * The capability floor (ledger #1580): coverage semantics ported from core's
 * `capability.rs` tests (`is_deny_scope`, `allows`, `satisfies`, principals),
 * the per-verb requirement table from core's `Floor`, and the floor at
 * dispatch — an under-capable `issueAs` is refused typed before the handler
 * runs, a covering one runs, a plain `issue` resolves under root.
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

// ---------------------------------------------------------------------------
// Coverage, from core's own capability tests
// ---------------------------------------------------------------------------

Deno.test("deny shape pins every real form (core deny_shape_pins_every_real_form)", () => {
  const denies = [
    "urn:cap:fs:read:-/root/secret",
    "urn:cap:fs:write:-/root/secret",
    "urn:cap:fs:delete:-/root/secret",
    "urn:cap:fs:list:-/root/secret",
    "urn:cap:fs:read:-secret",
    "urn:cap:fs:read:-/Users/brian/secrets",
    "urn:cap:net:-example.com",
    "urn:cap:net:-example.com:443",
    "urn:cap:net:-example.com/admin",
    "urn:cap:net:-example.com:443/admin",
    "urn:cap:net:-[::1]:8080",
    "urn:cap:net:-",
  ];
  for (const scope of denies) assert(isDenyScope(scope), scope);
  const grants = [
    "urn:cap:fs:read:/root",
    "urn:cap:fs:read:/a-b",
    "urn:cap:fs:read:a-b",
    "urn:cap:fs:read:notes:-x",
    "urn:cap:fs:read:/a:-b",
    "urn:cap:fs:read:*",
    "urn:cap:fs:read",
    "urn:cap:net:example.com",
    "urn:cap:net:example.com:-1",
    "urn:cap:net:[::1]:8080",
    "urn:cap:net:*",
    "urn:cap:store:read:graph:urn:x:-y",
    "urn:cap:ledger:read:my-ledger",
    "urn:cap:dev-server:read",
    "urn:cap:personal:calendar:read:freebusy",
    "urn:cap:Fs:read:-x",
    "urn:cap:-fs:read",
    "urn:cap:",
    "urn:cap",
    "urn:other:fs:read:-x",
    "",
  ];
  for (const scope of grants) assert(!isDenyScope(scope), scope);
});

Deno.test("root allows everything; scoped allows only its scopes", () => {
  const root = Capability.root();
  assert(root.allows("urn:cap:anything:read"));
  assert(root.allows("urn:cap:secret:read:-x"));
  const cap = Capability.scoped(["urn:cap:personal:calendar:read:freebusy"]);
  assert(cap.allows("urn:cap:personal:calendar:read:freebusy"));
  assert(!cap.allows("urn:cap:personal:calendar:read:detail"));
});

Deno.test("an exclusion is never granted by exact match", () => {
  const cap = Capability.scoped([
    "urn:cap:fs:read:/root",
    "urn:cap:secret:read:-x",
  ]);
  assert(cap.allows("urn:cap:fs:read:/root"));
  assert(!cap.allows("urn:cap:secret:read:-x"), "held, but an exclusion");
  assert(!cap.allows("urn:cap:fs:read:-/root"), "not held either");
});

Deno.test("satisfies is the kernel's predicate and allows stays exact", () => {
  const perRoot = Capability.scoped(["urn:cap:browse:read:ikigai-core"]);
  assert(!perRoot.allows("urn:cap:browse:read:*"));
  assert(perRoot.satisfies("urn:cap:browse:read:*"));
  const alice = Capability.scoped([
    "urn:cap:x",
    "urn:cap:principal:urn:example:person:alice",
  ]);
  const cases: [Capability, string][] = [
    [perRoot, "urn:cap:browse:read:ikigai-core"],
    [perRoot, "urn:cap:browse:read:ikigai-gonk"],
    [perRoot, "urn:cap:browse:read"],
    [
      Capability.scoped(["urn:cap:fs:read:-/secret"]),
      "urn:cap:fs:read:-/secret",
    ],
    [alice, "urn:cap:principal:urn:example:person:alice"],
  ];
  for (const [cap, scope] of cases) {
    assertStrictEquals(cap.satisfies(scope), cap.allows(scope), scope);
  }
  // A prefix presence test, not a sibling-family match.
  assert(!perRoot.satisfies("urn:cap:browse:write:*"));
  assert(!perRoot.satisfies("urn:cap:net:*"));
  // An exclusion is present, so it satisfies the family form (ledger #858).
  assert(
    Capability.scoped(["urn:cap:fs:read:-/secret"]).satisfies(
      "urn:cap:fs:read:*",
    ),
  );
  assert(Capability.root().satisfies("urn:cap:net:*"));
  assert(!Capability.scoped([]).satisfies("urn:cap:net:*"));
  assert(perRoot.satisfies("urn:cap:*"));
  // A bare `*` is satisfied by any held scope at all.
  assert(perRoot.satisfies("*"));
  assert(!Capability.scoped([]).satisfies("*"));
});

Deno.test("a principal is granted only as the capability's one principal", () => {
  const p = (iri: string) => `urn:cap:principal:${iri}`;
  const ALICE = "urn:example:person:alice";
  const BOB = "urn:example:person:bob";
  const one = Capability.scoped(["urn:cap:fs:read:/r", p(ALICE)]);
  assert(one.allows(p(ALICE)));
  assert(!one.allows(p(BOB)));
  // Several principals are none; the other grants are untouched.
  const both = Capability.scoped([p(ALICE), p(BOB), "urn:cap:x"]);
  assert(!both.allows(p(ALICE)) && !both.allows(p(BOB)));
  assert(both.allows("urn:cap:x"), "only the names are void");
  // A wildcard is never an identity, and does not make a real one ambiguous.
  for (const wild of ["urn:cap:*", "urn:cap:principal:*", p("urn:*")]) {
    assert(!Capability.scoped([wild]).allows(p(ALICE)), wild);
    assert(Capability.scoped([wild, p(ALICE)]).allows(p(ALICE)), wild);
  }
  // A malformed principal scope is not a principal: held exactly, it is an
  // ordinary grant, and it does not void a real principal beside it.
  const odd = Capability.scoped([p("not an iri"), p(ALICE)]);
  assert(odd.allows(p("not an iri")));
  assert(odd.allows(p(ALICE)));
  // Root holds every principal.
  assert(Capability.root().allows(p(ALICE)));
  // The declared presence test is satisfied by a held wildcard.
  assert(
    Capability.scoped(["urn:cap:principal:*"]).satisfies("urn:cap:principal:*"),
  );
});

// ---------------------------------------------------------------------------
// The per-verb requirement table (core's `Floor`, `required_scopes`)
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
