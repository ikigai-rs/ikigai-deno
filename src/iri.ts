/**
 * Absolute-IRI validation, as core decides it: a port of `oxiri` 0.2.11's
 * `Iri::parse` (RFC 3987), which `ikigai_core::Iri::parse` calls.
 *
 * It exists for one decision in the Turtle Meta face: whether an authored
 * `class` or `requires` value, once percent-encoded, is an IRI (emitted as
 * `<…>`) or must fall back to a literal (core's `iri_term`). The answer has to
 * be core's to the byte, because the face is pinned against core's vectors,
 * so this mirrors oxiri's parser state by state (scheme, authority, host,
 * port, path, query, fragment) rather than using `URL`, whose WHATWG rules
 * accept and normalize far more than RFC 3987 does.
 *
 * Validation only: nothing is resolved or normalized, and there is no base,
 * so a relative reference is never an IRI.
 *
 * @module
 */

/** oxiri's `is_iunreserved_or_sub_delims`. */
function isIunreservedOrSubDelims(c: number): boolean {
  return isUnreservedOrSubDelims(c) ||
    (c >= 0xa0 && c <= 0xd7ff) ||
    (c >= 0xf900 && c <= 0xfdcf) ||
    (c >= 0xfdf0 && c <= 0xffef) ||
    // U+10000..U+EFFFD in planes, each minus its last two code points, and
    // plane 14 starting at U+E1000.
    (c >= 0x10000 && c <= 0xdfffd && (c & 0xfffe) !== 0xfffe) ||
    (c >= 0xe1000 && c <= 0xefffd);
}

/** oxiri's `is_unreserved_or_sub_delims` (ASCII only). */
function isUnreservedOrSubDelims(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x30 && c <= 0x39) || "!$&'()*+,-.;=_~".includes(chr(c));
}

/** The `iprivate` ranges a query (and only a query) may carry. */
function isIprivate(c: number): boolean {
  return (c >= 0xe000 && c <= 0xf8ff) || (c >= 0xf0000 && c <= 0xffffd) ||
    (c >= 0x100000 && c <= 0x10fffd);
}

const chr = (c: number): string => String.fromCodePoint(c);
const isAsciiAlpha = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isAsciiDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isAsciiHex = (c: number): boolean =>
  isAsciiDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

const COLON = 0x3a;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const HASH = 0x23;
const AT = 0x40;
const PERCENT = 0x25;
const OPEN = 0x5b;
const CLOSE = 0x5d;

/** Thrown inside the parser; caught once at the top. */
class Invalid extends Error {}

/** oxiri's `IriParser` without output: the same states, the same refusals. */
class Parser {
  readonly #cps: number[];
  #pos = 0;
  /** Code-point index just past the scheme's `:`. */
  #schemeEnd = 0;

  constructor(iri: string) {
    this.#cps = Array.from(iri, (ch) => ch.codePointAt(0)!);
  }

  #next(): number | undefined {
    return this.#cps[this.#pos++];
  }

  #front(): number | undefined {
    return this.#cps[this.#pos];
  }

  /** `read_url_codepoint_or_echar`: a valid code point, or a `%XX`. */
  #codepointOrEchar(c: number, valid: (c: number) => boolean): void {
    if (valid(c)) return;
    if (c !== PERCENT) throw new Invalid();
    const c1 = this.#next();
    const c2 = this.#next();
    if (c1 === undefined || !isAsciiHex(c1)) throw new Invalid();
    if (c2 === undefined || !isAsciiHex(c2)) throw new Invalid();
  }

  /** `parse_scheme_start` + `parse_scheme`, absolute only. */
  parse(): void {
    const first = this.#front();
    if (first === undefined || !isAsciiAlpha(first)) {
      throw new Invalid(); // relative (or `:`-first): not an absolute IRI
    }
    for (;;) {
      const c = this.#next();
      if (c === COLON) break;
      if (
        c === undefined ||
        !(isAsciiAlpha(c) || isAsciiDigit(c) || c === 0x2b || c === 0x2d ||
          c === 0x2e)
      ) {
        throw new Invalid(); // oxiri reparses as relative: no scheme
      }
    }
    this.#schemeEnd = this.#pos;
    if (this.#front() === SLASH) {
      this.#next();
      if (this.#front() === SLASH) {
        this.#next();
        this.#authority();
      } else {
        this.#path();
      }
    } else {
      this.#path();
    }
  }

  #authority(): void {
    // `@` is not allowed in an IRI authority, so the first one ends userinfo.
    for (;;) {
      const c = this.#next();
      if (c === AT) return this.#host();
      if (
        c === undefined || c === OPEN || c === SLASH || c === QUESTION ||
        c === HASH
      ) {
        this.#pos = this.#schemeEnd + 2; // no userinfo: reread as the host
        return this.#host();
      }
      this.#codepointOrEchar(
        c,
        (c) => isIunreservedOrSubDelims(c) || c === COLON,
      );
    }
  }

  #host(): void {
    if (this.#front() === OPEN) {
      const start = ++this.#pos;
      for (;;) {
        const c = this.#next();
        if (c === undefined) throw new Invalid(); // unterminated `[`
        if (c !== CLOSE) continue;
        const ip = String.fromCodePoint(
          ...this.#cps.slice(start, this.#pos - 1),
        );
        const valid = ip.startsWith("v") || ip.startsWith("V")
          ? isIpvFuture(ip)
          : isIpv6(ip);
        if (!valid) throw new Invalid();
        const after = this.#next();
        if (after === COLON) return this.#port();
        if (
          after === undefined || after === SLASH || after === QUESTION ||
          after === HASH
        ) {
          return this.#pathStart(after);
        }
        throw new Invalid();
      }
    }
    for (;;) {
      const c = this.#next();
      if (c === COLON) return this.#port();
      if (
        c === undefined || c === SLASH || c === QUESTION || c === HASH
      ) {
        return this.#pathStart(c);
      }
      this.#codepointOrEchar(c, isIunreservedOrSubDelims);
    }
  }

  #port(): void {
    for (;;) {
      const c = this.#next();
      if (
        c === undefined || c === SLASH || c === QUESTION || c === HASH
      ) {
        return this.#pathStart(c);
      }
      if (!isAsciiDigit(c)) throw new Invalid();
    }
  }

  #pathStart(c: number | undefined): void {
    if (c === undefined) return;
    if (c === QUESTION) return this.#query();
    if (c === HASH) return this.#fragment();
    // `/`: the path proper (any other `c` cannot reach here).
    this.#path();
  }

  #path(): void {
    for (;;) {
      const c = this.#next();
      if (c === undefined) return;
      if (c === SLASH) continue;
      if (c === QUESTION) return this.#query();
      if (c === HASH) return this.#fragment();
      this.#codepointOrEchar(
        c,
        (c) => isIunreservedOrSubDelims(c) || c === COLON || c === AT,
      );
    }
  }

  #query(): void {
    for (;;) {
      const c = this.#next();
      if (c === undefined) return;
      if (c === HASH) return this.#fragment();
      this.#codepointOrEchar(
        c,
        (c) =>
          isIunreservedOrSubDelims(c) || c === COLON || c === AT ||
          c === SLASH || c === QUESTION || isIprivate(c),
      );
    }
  }

  #fragment(): void {
    for (;;) {
      const c = this.#next();
      if (c === undefined) return;
      this.#codepointOrEchar(
        c,
        (c) =>
          isIunreservedOrSubDelims(c) || c === COLON || c === AT ||
          c === SLASH || c === QUESTION,
      );
    }
  }
}

/** oxiri's `validate_ip_v_future`: `"v" 1*HEXDIG "." 1*( unreserved / sub-delims / ":" )`. */
function isIpvFuture(ip: string): boolean {
  const m = /^[vV]([0-9A-Fa-f]*)\.(.*)$/su.exec(ip);
  if (m === null || m[1] === "" || m[2] === "") return false;
  for (const ch of m[2]) {
    const c = ch.codePointAt(0)!;
    if (!isUnreservedOrSubDelims(c) && c !== COLON) return false;
  }
  return true;
}

/**
 * Rust's `Ipv6Addr::from_str` (which oxiri calls): eight 1–4 digit hex
 * groups, one `::` standing for at least one zero group, and an embedded
 * dotted IPv4 tail in the last two groups. No zone id, no brackets.
 */
function isIpv6(s: string): boolean {
  let pos = 0;

  // Rust's `read_number(10, Some(3), false)` as an octet: no leading zero.
  const readOctet = (): boolean => {
    const start = pos;
    let value = 0;
    while (
      pos < s.length && pos - start < 3 && isAsciiDigit(s.charCodeAt(pos))
    ) {
      value = value * 10 + (s.charCodeAt(pos) - 0x30);
      pos++;
    }
    const digits = pos - start;
    if (digits === 0) return false;
    if (digits > 1 && s.charCodeAt(start) === 0x30) return false;
    return value <= 255;
  };
  const readIpv4 = (): boolean => {
    const start = pos;
    for (let i = 0; i < 4; i++) {
      if (i > 0) {
        if (s[pos] !== ".") return (pos = start), false;
        pos++;
      }
      if (!readOctet()) return (pos = start), false;
    }
    return true;
  };
  const readGroup = (): boolean => {
    const start = pos;
    while (pos < s.length && pos - start < 4 && isAsciiHex(s.charCodeAt(pos))) {
      pos++;
    }
    return pos > start;
  };
  // Rust's `read_separator(':', i, …)`, atomic: on failure nothing is consumed.
  const separated = (i: number, inner: () => boolean): boolean => {
    const start = pos;
    if (i > 0) {
      if (s[pos] !== ":") return false;
      pos++;
    }
    if (inner()) return true;
    pos = start;
    return false;
  };
  // Rust's `read_groups`: how many groups, and whether the last was IPv4.
  const readGroups = (limit: number): [number, boolean] => {
    for (let i = 0; i < limit; i++) {
      if (i < limit - 1 && separated(i, readIpv4)) return [i + 2, true];
      if (!separated(i, readGroup)) return [i, false];
    }
    return [limit, false];
  };

  const [head, headIpv4] = readGroups(8);
  if (head === 8) return pos === s.length;
  if (headIpv4) return false;
  if (s.slice(pos, pos + 2) !== "::") return false;
  pos += 2;
  readGroups(8 - (head + 1));
  return pos === s.length;
}

/**
 * Whether `s` is an absolute IRI by RFC 3987, exactly as `oxiri` (and so
 * `ikigai_core::Iri::parse`) decides it.
 */
export function isAbsoluteIri(s: string): boolean {
  try {
    new Parser(s).parse();
    return true;
  } catch (e) {
    if (e instanceof Invalid) return false;
    throw e;
  }
}
