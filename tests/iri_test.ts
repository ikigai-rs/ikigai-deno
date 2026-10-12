/**
 * `isAbsoluteIri` is a port of `oxiri` 0.2.11's `Iri::parse`, which decides
 * whether core's Turtle Meta face writes a `class` or `requires` value as an
 * IRI or as a literal (ledger #1113). The contract vectors pin the cases the
 * hostile door exercises; these pin the parser more widely, from oxiri's own
 * test tables (`tests/lib.rs`: `test_parsing` and
 * `test_wrong_relative_parsing`, every one of which is also refused as an
 * absolute IRI).
 */

import { assert } from "@std/assert";
import { isAbsoluteIri } from "../src/iri.ts";
import { escapeIriFragment } from "../src/contract.ts";

const VALID = [
  "file://foo",
  "ftp://ftp.is.co.za/rfc/rfc1808.txt",
  "http://www.ietf.org/rfc/rfc2396.txt",
  "ldap://[2001:db8::7]/c=GB?objectClass?one",
  "mailto:John.Doe@example.com",
  "news:comp.infosystems.www.servers.unix",
  "tel:+1-816-555-1212",
  "telnet://192.0.2.16:80/",
  "urn:oasis:names:specification:docbook:dtd:xml:4.1.2",
  "http://example.com",
  "http://example.com/",
  "http://example.com/foo",
  "http://example.com/foo/bar",
  "http://example.com/foo/bar/",
  "http://example.com/foo/bar?q=1&r=2",
  "http://example.com/foo/bar/?q=1&r=2",
  "http://example.com#toto",
  "http://example.com/#toto",
  "http://example.com/foo#toto",
  "http://example.com/foo/bar#toto",
  "http://example.com/foo/bar/#toto",
  "http://example.com/foo/bar?q=1&r=2#toto",
  "http://example.com/foo/bar/?q=1&r=2#toto",
  "http://example.com/foo/bar/.././baz",
  "http://a.example/AZazÀÖØöø˿ͰͽͿ῿‌‍⁰↏Ⰰ⿯、퟿﨎﷏ﷰ￯\u{10000}\u{EFFFD}",
  "http://a.example/?AZaz\u{F0000}\u{FFFFD}\u{100000}\u{10FFFD}ÀÖØöø˿ͰͽͿ῿‌‍⁰↏Ⰰ⿯、퟿﨎﷏ﷰ￯\u{10000}\u{EFFFD}",
  "http://[va.12z]",
  "http://[vff.B]",
  "http://[V0.a]",
  // ours: the shapes the ecosystem actually declares, and the encoded hostile class
  "urn:cap:core:read",
  "http://www.w3.org/2001/XMLSchema#string",
  "https://schema.org/Person",
  "urn:cls:a%3E%20b",
  "urn:cap:x%3E%20.%20%3Curn:everything",
  "http://[::1]:8080/",
  "http://[::ffff:192.0.2.1]/",
  "http://user:pw@host:1/p",
];

const INVALID = [
  "beepbeep\x07\x07",
  "\n",
  "http://www yahoo.com",
  "http://www.yahoo.com/hello world/",
  'http://www.yahoo.com/yelp.html#"',
  "[2010:836B:4179::836B:4179]",
  " ",
  "%",
  "A%Z",
  "%ZZ",
  "%AZ",
  "A C",
  "A`C",
  "A<C",
  "A>C",
  "A^C",
  "A\\C",
  "A{C",
  "A|C",
  "A}C",
  "A[C",
  "A]C",
  "A[**]C",
  "http://[xyz]/",
  "http://]/",
  "http://example.org/[2010:836B:4179::836B:4179]",
  "http://example.org/abc#[2010:836B:4179::836B:4179]",
  "http://example.org/xxx/[qwerty]#a[b]",
  "http://w3c.org:80path1/path2",
  ":a/b",
  "http://example.com/",
  "",
  "http://example.com/#",
  "#",
  "//￿",
  "?￿",
  "/\u0000",
  "?\u0000",
  "#\u0000",
  "/",
  "/",
  "/\u{F0000}",
  "/\u{FFFFD}",
  "/\u{100000}",
  "/\u{10FFFD}",
  "?﷯",
  "/﷯",
  "/￿",
  "/\u{1FFFF}",
  "/\u{2FFFF}",
  "/\u{3FFFF}",
  "/\u{4FFFF}",
  "/\u{5FFFF}",
  "/\u{6FFFF}",
  "/\u{7FFFF}",
  "/\u{8FFFF}",
  "/\u{9FFFF}",
  "/\u{AFFFF}",
  "/\u{BFFFF}",
  "/\u{CFFFF}",
  "/\u{DFFFF}",
  "/\u{EFFFF}",
  "/\u{FFFFF}",
  "http://[/",
  "http://[::1]a/",
  "//͏@[]",
  "//@@",
  "$:",
  "-:",
  ":",
  "http://[]",
  "http://[a]",
  "http://[vz]",
  "http://[v11]",
  "http://[v1.]",
  "http://[v.a]",
  "http://[v1.@]",
  "http://[v1.%01]",
  "//[v1.ւ]",
  // ours: relative references, and the hostile door's fallbacks once encoded
  "",
  "not a class",
  "foo/bar",
  "http://ok%3E%20.%20%3Curn:z%3E%20a%20%3Curn:w",
  "https://cap%3E%20.%20%3Curn:z",
  "urn:ikigai:endpoint:ev%3Eil%20100%%20naïve",
  "http://[::1::2]/",
  "http://[1:2:3:4:5:6:7:8:9]/",
  "http://[::01.2.3.4]/",
  "http://[::256.2.3.4]/",
  "http://[fe80::1%25en0]/",
];

Deno.test("isAbsoluteIri accepts what oxiri accepts", () => {
  for (const iri of VALID) assert(isAbsoluteIri(iri), JSON.stringify(iri));
});

Deno.test("isAbsoluteIri refuses what oxiri refuses, relative references included", () => {
  for (const iri of INVALID) assert(!isAbsoluteIri(iri), JSON.stringify(iri));
});

Deno.test("an encoded value never carries a character that could close the IRI", () => {
  // The other half of core's `iri_term`: whatever `isAbsoluteIri` admits after
  // `escapeIriFragment` is safe between angle brackets.
  for (const s of [...VALID, ...INVALID]) {
    const escaped = escapeIriFragment(s);
    if (isAbsoluteIri(escaped)) {
      const closes = Array.from(escaped).some((ch) =>
        ch.codePointAt(0)! <= 0x20 || '<>"{}|^`\\'.includes(ch)
      );
      assert(!closes, escaped);
    }
  }
});
