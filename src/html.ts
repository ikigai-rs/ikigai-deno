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
