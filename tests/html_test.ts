/**
 * `src/html.ts` pinned by the shared HTML vectors (ledger #1813).
 *
 * `html_vectors.json` is a VERBATIM copy of ikigai-fn's
 * `tests/vectors/html_vectors.json` at ikigai-fn main (commit aebf30a, PR 35); do
 * not edit or reformat it here (`deno.json` keeps it out of `deno fmt`, and
 * `.gitattributes` keeps it LF): to pick up new vectors, copy the file again.
 * Every case runs; an unknown section or a changed case fails.
 */

import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import {
  attr,
  formPairs,
  FormPairsError,
  htmlText,
  jsonAttr,
  percentDecode,
  percentDecodeBytes,
  PercentDecodeError,
  safeHref,
  urlSegment,
} from "../src/html.ts";

type Case = {
  in: unknown;
  out?: unknown;
  plus_is_space?: boolean;
  bytes?: number[];
  error?: string;
  offset?: number;
};
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
    "form_pairs",
    "json_attr",
    "percent_decode",
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

Deno.test("html vectors: url_segment, and its decode round trip", () => {
  const utf8 = new TextEncoder();
  for (const c of cases("url_segment")) {
    const encoded = urlSegment(c.in as string);
    assertEquals(encoded, c.out, JSON.stringify(c));
    for (const plus of [false, true]) {
      assertEquals(percentDecode(encoded, plus), c.in, JSON.stringify(c));
      assertEquals(
        percentDecodeBytes(utf8.encode(encoded), plus),
        utf8.encode(c.in as string),
        JSON.stringify(c),
      );
    }
  }
});

Deno.test("html vectors: percent_decode (text and bytes)", () => {
  for (const c of cases("percent_decode")) {
    const where = JSON.stringify(c);
    const input = c.in as string;
    const plus = c.plus_is_space;
    if (typeof plus !== "boolean") {
      throw new Error(`no plus_is_space: ${where}`);
    }
    const inputBytes = new TextEncoder().encode(input);
    switch (c.error) {
      case "malformed_escape": {
        for (
          const run of [
            () => percentDecode(input, plus),
            () => percentDecodeBytes(inputBytes, plus),
          ]
        ) {
          const e = assertThrows(run, PercentDecodeError, undefined, where);
          assertEquals(e.kind, "malformed_escape", where);
          assertEquals(e.offset, c.offset, where);
        }
        break;
      }
      case "invalid_utf8": {
        assertEquals(
          percentDecodeBytes(inputBytes, plus),
          new Uint8Array(c.bytes!),
          where,
        );
        const e = assertThrows(
          () => percentDecode(input, plus),
          PercentDecodeError,
          undefined,
          where,
        );
        assertEquals(e.kind, "invalid_utf8", where);
        assertEquals(e.offset, undefined, where);
        break;
      }
      case undefined:
        assertEquals(
          percentDecodeBytes(inputBytes, plus),
          new Uint8Array(c.bytes!),
          where,
        );
        assertEquals(percentDecode(input, plus), c.out, where);
        break;
      default:
        throw new Error(`unknown decoder error in ${where}`);
    }
  }
});

Deno.test("percentDecodeBytes passes arbitrary bytes through", () => {
  assertEquals(
    percentDecodeBytes(new Uint8Array([0xFF, 0x25, 0x32, 0x62, 0x2B]), true),
    new Uint8Array([0xFF, 0x2B, 0x20]),
  );
  assertEquals(
    percentDecodeBytes(new Uint8Array([0xFF]), false),
    new Uint8Array([0xFF]),
  );
});

// TextDecoder drops a leading byte order mark unless told not to; Rust's
// String::from_utf8 keeps it, so the port must too.
Deno.test("percentDecode keeps a leading byte order mark", () => {
  assertEquals(percentDecode("%EF%BB%BFa", false), "﻿a");
  assertEquals(percentDecode("﻿a", false), "﻿a");
});

Deno.test("PercentDecodeError is an Error with a stable message", () => {
  const e = assertThrows(
    () => percentDecode("ab%G1", false),
    PercentDecodeError,
  );
  assertInstanceOf(e, Error);
  assertEquals(e.name, "PercentDecodeError");
  assertEquals(
    e.message,
    "percent_decode: malformed percent-escape at byte 2",
  );
  const u = assertThrows(() => percentDecode("%FF", false), PercentDecodeError);
  assertEquals(u.message, "percent_decode: decoded bytes are not UTF-8");
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

Deno.test("html vectors: form_pairs", () => {
  for (const c of cases("form_pairs")) {
    const where = JSON.stringify(c);
    if (c.error === undefined) {
      assertEquals(formPairs(c.in as string), c.out, where);
    } else {
      const e = assertThrows(
        () => formPairs(c.in as string),
        FormPairsError,
        undefined,
        where,
      );
      assertEquals(e.kind, c.error, where);
      assertEquals(e.offset, c.offset, where);
      assertInstanceOf(e.source, PercentDecodeError, where);
      assertEquals(e.source.kind, c.error, where);
      assertEquals(e.cause, e.source, where);
    }
  }
});

Deno.test("FormPairsError preserves messages and component decoding causes", () => {
  for (
    const [input, kind, offset, relative, reason] of [
      ["日=ok&x=%41%", "malformed_escape", 12, 3, "malformed percent-escape"],
      ["x=%FF", "invalid_utf8", 2, undefined, "decoded bytes are not UTF-8"],
    ] as const
  ) {
    const e = assertThrows(() => formPairs(input), FormPairsError);
    assertInstanceOf(e, Error);
    assertEquals(e.name, "FormPairsError");
    assertEquals(e.message, `form_pairs: ${reason} at byte ${offset}`);
    assertEquals(e.kind, kind);
    assertEquals(e.source.offset, relative);
    assertEquals(e.cause, e.source);
  }
});

Deno.test("formPairs maps UTF-8 failures after valid multibyte sequences", () => {
  const prefixes = ["é日😀", "%C3%A9%E6%97%A5%F0%9F%98%80", "%EF%BB%BF+"];
  const invalid = [
    "%80",
    "%C1%BF",
    "%F5%80%80%80",
    "%E0%9F%BF",
    "%F0%8F%BF%BF",
    "%E2%82%41",
    "%F0%90%80%41",
    "%F0%90%80",
    "%C3日",
  ];
  for (const prefix of prefixes) {
    for (const suffix of invalid) {
      const input = `日=ok&x=${prefix}${suffix}`;
      const e = assertThrows(() => formPairs(input), FormPairsError);
      assertEquals(e.kind, "invalid_utf8", input);
      assertEquals(
        e.offset,
        new TextEncoder().encode(`日=ok&x=${prefix}`).length,
        input,
      );
    }
  }
});
