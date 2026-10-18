/**
 * `src/auth.ts` pinned by the shared auth vectors (ledger #1862).
 *
 * `auth_vectors.json` is a VERBATIM copy of ikigai-http's
 * `tests/vectors/auth_vectors.json` at ikigai-http commit ffadc89 (PR 19,
 * 0.2.1); do not edit or reformat it here (`deno.json` keeps it out of
 * `deno fmt`, `.gitattributes` keeps it LF): to pick up new vectors, copy the
 * file again. Every case runs. Assertions never print a credential: a failure
 * names the case, not its input.
 */

import { assert, assertEquals } from "@std/assert";
import {
  AuthError,
  base64Decode,
  base64Encode,
  basicAuthorization,
  bearerAuthorization,
  parseAuthorization,
} from "../src/auth.ts";

// deno-lint-ignore no-explicit-any
type Case = Record<string, any>;
const vectors = JSON.parse(
  await Deno.readTextFile(new URL("./auth_vectors.json", import.meta.url)),
) as Record<string, Case[] | string | number>;

function cases(section: string): Case[] {
  const c = vectors[section];
  if (!Array.isArray(c) || c.length === 0) {
    throw new Error(`section ${section} missing or empty`);
  }
  return c;
}

function refusal(c: Case, f: () => unknown) {
  try {
    f();
  } catch (e) {
    assert(e instanceof AuthError, c.name);
    assertEquals(e.code, c.error, c.name);
    return;
  }
  throw new Error(`${c.name}: not refused`);
}

function fromHex(h: string): Uint8Array {
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
}

Deno.test("auth vectors: no unknown sections", () => {
  assertEquals(Object.keys(vectors).sort(), [
    "about",
    "base64",
    "base64_refusals",
    "basic",
    "basic_refusals",
    "bearer",
    "bearer_refusals",
    "scheme",
    "version",
  ]);
});

Deno.test("auth vectors: basic", () => {
  for (const c of cases("basic")) {
    assert(basicAuthorization(c.user, c.password) === c.expect, c.name);
  }
});

Deno.test("auth vectors: basic refusals", () => {
  for (const c of cases("basic_refusals")) {
    refusal(c, () => basicAuthorization(c.user, c.password));
  }
});

Deno.test("auth vectors: bearer", () => {
  for (const c of cases("bearer")) {
    assert(bearerAuthorization(c.token) === c.expect, c.name);
  }
});

Deno.test("auth vectors: bearer refusals", () => {
  for (const c of cases("bearer_refusals")) {
    refusal(c, () => bearerAuthorization(c.token));
  }
});

Deno.test("auth vectors: scheme", () => {
  for (const c of cases("scheme")) {
    assertEquals(parseAuthorization(c.value), c.expect, c.name);
  }
});

Deno.test("auth vectors: base64 encodes and decodes", () => {
  for (const c of cases("base64")) {
    const bytes = c.hex !== undefined
      ? fromHex(c.hex)
      : new TextEncoder().encode(c.text);
    assertEquals(base64Encode(bytes), c.encoded, c.name);
    assertEquals(base64Decode(c.encoded), bytes, c.name);
  }
});

Deno.test("auth vectors: base64 refusals", () => {
  for (const c of cases("base64_refusals")) {
    refusal(c, () => base64Decode(c.encoded));
  }
});

Deno.test("an AuthError never carries the credential", () => {
  for (
    const f of [
      () => basicAuthorization("us:er", "hunter2-secret"),
      () => basicAuthorization("user", "hunter2\n-secret"),
      () => bearerAuthorization("hunter2 secret"),
      () => base64Decode("hunter2-secret"),
    ]
  ) {
    try {
      f();
    } catch (e) {
      assert(!String(e).includes("hunter2"));
      assert(!JSON.stringify(e).includes("hunter2"));
      continue;
    }
    throw new Error("not refused");
  }
});
