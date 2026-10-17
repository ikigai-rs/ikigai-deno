/**
 * `src/html.ts` pinned by the shared HTML vectors (ledger #1813).
 *
 * `html_vectors.json` is a VERBATIM copy of ikigai-fn's
 * `tests/vectors/html_vectors.json` at ikigai-fn commit 53d50c5 (PR 18); do
 * not edit or reformat it here (`deno.json` keeps it out of `deno fmt`, and
 * `.gitattributes` keeps it LF): to pick up new vectors, copy the file again.
 * Every case runs; an unknown section or a changed case fails.
 */

import { assertEquals } from "@std/assert";
import { attr, htmlText, jsonAttr, safeHref, urlSegment } from "../src/html.ts";

type Case = { in: unknown; out: unknown };
const vectors = JSON.parse(
  await Deno.readTextFile(new URL("./html_vectors.json", import.meta.url)),
) as Record<string, Case[] | string>;

function cases(section: string): Case[] {
  const c = vectors[section];
  if (!Array.isArray(c) || c.length === 0) {
    throw new Error(`section ${section} missing or empty`);
  }
  return c;
}

Deno.test("html vectors: no unknown sections", () => {
  assertEquals(Object.keys(vectors).sort(), [
    "about",
    "escape",
    "json_attr",
    "safe_href",
    "url_segment",
  ]);
});

Deno.test("html vectors: escape (htmlText and attr)", () => {
  for (const c of cases("escape")) {
    assertEquals(htmlText(c.in as string), c.out, JSON.stringify(c));
    assertEquals(attr(c.in as string), c.out, JSON.stringify(c));
  }
});

Deno.test("html vectors: url_segment", () => {
  for (const c of cases("url_segment")) {
    assertEquals(urlSegment(c.in as string), c.out, JSON.stringify(c));
  }
});

Deno.test("html vectors: safe_href", () => {
  for (const c of cases("safe_href")) {
    assertEquals(safeHref(c.in as string), c.out, JSON.stringify(c));
  }
});

Deno.test("html vectors: json_attr", () => {
  for (const c of cases("json_attr")) {
    assertEquals(
      jsonAttr(c.in as [string, string][]),
      c.out,
      JSON.stringify(c),
    );
  }
});
