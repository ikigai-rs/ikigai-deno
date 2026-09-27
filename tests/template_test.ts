/**
 * `UriTemplate` against core's own cases (`grammar.rs` tests) and the edges
 * the port has to get right to match EXACTLY what a Rust kernel matches.
 */

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { TemplateError, UriTemplate } from "../src/template.ts";

// --- core's pinned cases, one for one ---------------------------------------

Deno.test("template: an exact pattern matches only itself", () => {
  const g = UriTemplate.parse("urn:test:to-upper");
  assertEquals(g.match("urn:test:to-upper"), {});
  assertStrictEquals(g.match("urn:test:to-lower"), null);
  assertStrictEquals(g.isExact, true);
});

Deno.test("template: captures a trailing variable (core)", () => {
  const t = UriTemplate.parse("urn:test:echo/{message}");
  assertEquals(t.match("urn:test:echo/hello"), { message: "hello" });
  assertStrictEquals(t.match("urn:test:echo/"), null); // empty capture
  assertStrictEquals(t.match("urn:other:echo/hi"), null);
});

Deno.test("template: captures a middle variable (core)", () => {
  const t = UriTemplate.parse("urn:r:{id}/data");
  assertEquals(t.match("urn:r:42/data"), { id: "42" });
  assertStrictEquals(t.match("urn:r:42/other"), null);
});

Deno.test("template: expand is the inverse of match (core)", () => {
  const t = UriTemplate.parse("urn:r:{id}/data");
  const b = t.match("urn:r:7/data")!;
  assertStrictEquals(t.expand(b), "urn:r:7/data");
  assertStrictEquals(t.expand({}), null); // a missing variable
});

Deno.test("template: the pattern is the source text (core)", () => {
  assertStrictEquals(
    UriTemplate.parse("urn:demo:echo/{message}").source,
    "urn:demo:echo/{message}",
  );
});

Deno.test("template: ambiguous and malformed forms are refused (core)", () => {
  assertThrows(
    () => UriTemplate.parse("urn:{a}{b}"),
    TemplateError,
    "invalid URI template: adjacent variables are ambiguous in `urn:{a}{b}`",
  );
  assertThrows(
    () => UriTemplate.parse("urn:{a"),
    TemplateError,
    "invalid URI template: unclosed '{' in `urn:{a`",
  );
  assertThrows(
    () => UriTemplate.parse("urn:{}"),
    TemplateError,
    "invalid URI template: invalid variable `{}` in `urn:{}`",
  );
});

// --- the edges the rule implies --------------------------------------------

Deno.test("template: a variable name is ASCII alphanumerics and _ only", () => {
  UriTemplate.parse("urn:x:{repo_id2}");
  for (const bad of ["urn:x:{a-b}", "urn:x:{a.b}", "urn:x:{+a}", "urn:x:{é}"]) {
    assertThrows(() => UriTemplate.parse(bad), TemplateError, "invalid");
  }
  // `{a{b}` names `a{b`, which is not a name.
  assertThrows(
    () => UriTemplate.parse("urn:{a{b}"),
    TemplateError,
    "invalid variable `{a{b}`",
  );
});

Deno.test("template: a lone } is literal text", () => {
  const t = UriTemplate.parse("urn:x}:{a}");
  assertEquals(t.match("urn:x}:1"), { a: "1" });
});

Deno.test("template: a middle variable is LAZY — leftmost next literal, no backtracking", () => {
  const t = UriTemplate.parse("urn:r:{id}:data");
  assertEquals(t.match("urn:r:a:b:data"), { id: "a:b" });
  // The first `:data` ends the capture; the rest cannot be consumed.
  assertStrictEquals(t.match("urn:r:a:data:data"), null);
});

Deno.test("template: a final variable takes the whole remainder, : included", () => {
  const t = UriTemplate.parse("urn:ts:echo:{msg}");
  assertEquals(t.match("urn:ts:echo:a:b/c"), { msg: "a:b/c" });
});

Deno.test("template: the family shape — two coordinates, any text between the colons", () => {
  const t = UriTemplate.parse("urn:iki:tutorial:ttt:stored:{x}:{y}");
  assertEquals(t.variables, ["x", "y"]);
  assertEquals(t.match("urn:iki:tutorial:ttt:stored:1:-2"), {
    x: "1",
    y: "-2",
  });
  // `x` stops at the FIRST colon, so `y` swallows the rest…
  assertEquals(t.match("urn:iki:tutorial:ttt:stored:1:2:3"), {
    x: "1",
    y: "2:3",
  });
  // …and an empty coordinate is not a match at all.
  assertStrictEquals(t.match("urn:iki:tutorial:ttt:stored::2"), null);
  assertStrictEquals(t.match("urn:iki:tutorial:ttt:stored:1:"), null);
  assertStrictEquals(t.match("urn:iki:tutorial:ttt:stored:1"), null);
  // the probe expansion the host's catalog walk sends for Meta
  assertEquals(t.match("urn:iki:tutorial:ttt:stored:probe:probe"), {
    x: "probe",
    y: "probe",
  });
});

Deno.test("template: captures are raw — no percent-decoding", () => {
  const t = UriTemplate.parse("urn:x:{v}");
  assertEquals(t.match("urn:x:a%3Ab"), { v: "a%3Ab" });
});

Deno.test("template: a repeated variable keeps the LAST capture, as core's map does", () => {
  const t = UriTemplate.parse("urn:x:{a}:{a}");
  assertEquals(t.match("urn:x:1:2"), { a: "2" });
});

Deno.test("template: trailing literal must be consumed exactly", () => {
  const t = UriTemplate.parse("urn:x:{a}/end");
  assertEquals(t.match("urn:x:1/end"), { a: "1" });
  assertStrictEquals(t.match("urn:x:1/ending"), null);
});
