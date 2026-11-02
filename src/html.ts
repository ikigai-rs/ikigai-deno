/**
 * Escaping and URL rules for HTML built from data: ONE implementation for
 * every door. A port of `ikigai_fn::html` (ikigai-fn), pinned by the shared
 * vectors in `tests/html_vectors.json` (ledger #1813).
 *
 * | Where the value goes | Function |
 * |---|---|
 * | element text: `<p>${…}</p>` | {@link htmlText} |
 * | a quoted attribute: `title="${…}"` or `title='${…}'` | {@link attr} |
 * | one path segment or query value: `/item/${…}?q=${…}` | {@link urlSegment} |
 * | reading one back: a segment or (`plusIsSpace`) a form value | {@link percentDecode}, {@link percentDecodeBytes} |
 * | a whole link target from data: `href="${…}"` | {@link safeHref}, then {@link attr} |
 * | htmx's `hx-vals='${…}'` | {@link jsonAttr} |
 *
 * Nothing here makes an UNQUOTED attribute, an event-handler attribute
 * (`onclick=`), or the inside of `<script>` or `<style>` safe: those are
 * code, and no escape turns data into safe code.
 *
 * @module
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * `text`, safe as HTML (or XML) element text: `&`, `<`, `>`, `"` and `'`
 * become `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&#39;`, and a C0 control
 * other than tab, line feed and carriage return becomes U+FFFD. Not
 * idempotent, by design.
 *
 * ```ts
 * import { htmlText } from "@ikigai/wire/html";
 * import { assertEquals } from "@std/assert";
 * assertEquals(htmlText("<b>Tom & Jerry's</b>"), "&lt;b&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;");
 * ```
 */
export function htmlText(text: string): string {
  return text.replace(
    // deno-lint-ignore no-control-regex
    /[&<>"']|[\x00-\x08\x0B\x0C\x0E-\x1F]/g,
    (c) => ESCAPES[c] ?? "�",
  );
}

/**
 * `value`, safe inside a QUOTED attribute value, whichever quote the markup
 * uses. The same output as {@link htmlText}, under the name that says where
 * it goes. A `href` or `src` from data goes through {@link safeHref} first.
 */
export function attr(value: string): string {
  return htmlText(value);
}

/**
 * `value` percent-encoded as ONE path segment or ONE query value: every
 * UTF-8 byte outside RFC 3986's unreserved set (`A-Z a-z 0-9 - . _ ~`)
 * becomes `%XX`, uppercase hex. `%` is encoded too.
 */
export function urlSegment(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    if (
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) ||
      (byte >= 0x61 && byte <= 0x7A) || byte === 0x2D || byte === 0x2E ||
      byte === 0x5F || byte === 0x7E
    ) {
      out += String.fromCharCode(byte);
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** Why {@link percentDecode} or {@link percentDecodeBytes} refused an input. */
export type PercentDecodeErrorKind = "malformed_escape" | "invalid_utf8";

/**
 * A refused percent-decode: `kind` says why, as the shared vectors name it.
 * `malformed_escape` carries the input BYTE `offset` of the `%` that was not
 * followed by two hex digits; `invalid_utf8` (the text form only) has none.
 */
export class PercentDecodeError extends Error {
  /** Why the input was refused. */
  readonly kind: PercentDecodeErrorKind;
  /** For `malformed_escape`, the byte offset of the bad `%` in the input. */
  readonly offset: number | undefined;
  /** An error of `kind`, at `offset` for a malformed escape. */
  constructor(
    kind: PercentDecodeErrorKind,
    offset?: number,
    options?: ErrorOptions,
  ) {
    super(
      kind === "malformed_escape"
        ? `percent_decode: malformed percent-escape at byte ${offset}`
        : "percent_decode: decoded bytes are not UTF-8",
      options,
    );
    this.name = "PercentDecodeError";
    this.kind = kind;
    this.offset = kind === "malformed_escape" ? offset : undefined;
  }
}

/** The value of one ASCII hex digit byte, or -1. */
function hexDigit(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

/**
 * Decode `%XX` escapes in `data` into bytes, exactly once, refusing every
 * malformed escape. Upper and lower hex are accepted; `+` becomes a space only
 * when `plusIsSpace`, and an escaped plus (`%2B`) stays a plus either way.
 * Every other byte passes through, so the result may hold any bytes.
 *
 * @throws {PercentDecodeError} `malformed_escape`, at the input byte offset of
 * a `%` not followed by two hex digits.
 *
 * ```ts
 * import { percentDecodeBytes } from "@ikigai/wire/html";
 * import { assertEquals } from "@std/assert";
 * const raw = new TextEncoder().encode("%FF+%2b");
 * assertEquals(percentDecodeBytes(raw, true), new Uint8Array([0xFF, 0x20, 0x2B]));
 * ```
 */
export function percentDecodeBytes(
  data: Uint8Array,
  plusIsSpace: boolean,
): Uint8Array {
  const out = new Uint8Array(data.length);
  let n = 0;
  let i = 0;
  while (i < data.length) {
    const byte = data[i];
    if (byte === 0x25) {
      const hi = hexDigit(data[i + 1]);
      const lo = hexDigit(data[i + 2]);
      if (hi < 0 || lo < 0) throw new PercentDecodeError("malformed_escape", i);
      out[n++] = (hi << 4) | lo;
      i += 3;
    } else {
      out[n++] = byte === 0x2B && plusIsSpace ? 0x20 : byte;
      i += 1;
    }
  }
  return out.slice(0, n);
}

/**
 * Decode `%XX` escapes in `text` exactly once, refusing malformed escapes and
 * decoded bytes that are not UTF-8. Choose `plusIsSpace` explicitly: `true`
 * for a form or query value, `false` for a path segment. `text` is read as
 * UTF-8, so an error offset is a byte offset, not a UTF-16 index. Decoding
 * does not escape HTML or validate a link: the result is still data, for
 * {@link htmlText}, {@link attr} or {@link safeHref}.
 *
 * Not `decodeURIComponent`: that refuses with no offset and never reads `+`.
 *
 * @throws {PercentDecodeError} `malformed_escape` with the input byte offset,
 * or `invalid_utf8` (use {@link percentDecodeBytes} for binary data).
 *
 * ```ts
 * import { percentDecode, urlSegment } from "@ikigai/wire/html";
 * import { assertEquals } from "@std/assert";
 * assertEquals(percentDecode("caf%C3%A9+a", true), "café a");
 * assertEquals(percentDecode("a+b%2Bc", false), "a+b+c");
 * assertEquals(percentDecode(urlSegment("café + %"), false), "café + %");
 * ```
 */
export function percentDecode(text: string, plusIsSpace: boolean): string {
  const bytes = percentDecodeBytes(new TextEncoder().encode(text), plusIsSpace);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    throw new PercentDecodeError("invalid_utf8", undefined, { cause });
  }
}

/**
 * The link target to put in `href` when `href` came from data, or `null`
 * when it must not be a link (render the label as text instead).
 *
 * Past any leading and trailing space or C0 control, the target must start
 * with `http://` or `https://` (any case) or a single `/` (not `//` or
 * `/\`). A target still holding a C0 control or DEL after trimming is
 * refused. The answer is the TRIMMED target, still unescaped: put it in a
 * quoted attribute through {@link attr}.
 */
export function safeHref(href: string): string | null {
  let start = 0;
  let end = href.length;
  while (start < end && href.charCodeAt(start) <= 0x20) start++;
  while (end > start && href.charCodeAt(end - 1) <= 0x20) end--;
  const t = href.slice(start, end);
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1F\x7F]/.test(t)) return null;
  const lower = t.slice(0, 8).toLowerCase();
  const sameOriginPath = t.startsWith("/") && !t.startsWith("//") &&
    !t.startsWith("/\\");
  return lower.startsWith("https://") || lower.startsWith("http://") ||
      sameOriginPath
    ? t
    : null;
}

/** `s` as a JSON string literal; JSON.stringify but with Rust's escapes. */
function jsonString(s: string): string {
  return '"' + s.replace(
    // deno-lint-ignore no-control-regex
    /["\\\x00-\x1F]/g,
    (c) => {
      switch (c) {
        case '"':
          return '\\"';
        case "\\":
          return "\\\\";
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "\t":
          return "\\t";
        case "\b":
          return "\\b";
        case "\f":
          return "\\f";
        default:
          return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
      }
    },
  ) + '"';
}

/**
 * `pairs` as a JSON object of strings, escaped for a quoted attribute: the
 * value of htmx's `hx-vals`. Members keep the order given, with no
 * whitespace; a duplicate key is written as given.
 */
export function jsonAttr(pairs: Iterable<readonly [string, string]>): string {
  const members: string[] = [];
  for (const [k, v] of pairs) members.push(jsonString(k) + ":" + jsonString(v));
  return attr("{" + members.join(",") + "}");
}
