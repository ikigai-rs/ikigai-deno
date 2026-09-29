/**
 * Tic-tac-toe, played in a browser — a standalone Deno app that renders the
 * game's own HTMX markup from the game's RESOURCES.
 *
 * The ikigai book's applied chapter (ikigai-tutorial, `crates/tic-tac-toe`)
 * builds tic-tac-toe as resources and ships its HTML as TEMPLATE resources
 * (`template:{name}`) written in `ikigai-fn`'s template language, so that any
 * host in any language can fill them. The Rust kernel binds each view that
 * reads as a template at a name (`view:board`, `view:square:{x}:{y}`,
 * `view:status`, `view:reply`, `view:game:{game}`); this app composes those
 * same views HERE, in TypeScript, from the raw resources a `ttt-host` serves
 * over its IPC socket:
 *
 * ```sh
 * ttt-host --socket /tmp/ttt-host.sock                  # games a and b, :8070
 * deno run -A examples/tictactoe_app.ts --socket /tmp/ttt-host.sock   # :8071
 * open http://127.0.0.1:8071/game/a/
 * ```
 *
 * The renderer is {@linkcode compose} — the subset of the template language
 * the templates use (`$a{…}`, `$r{…}`, `$h{…}`, `{x}` arguments, and
 * `urn:iki:fn:conditional`, which the host's gateway does not forward) — plus
 * {@linkcode Game}'s table of views. It holds no rule about the game: which
 * square or status template shows is a `conditional` in the templates, over
 * `cell:{x}:{y}`, `winner` and `turn`. What it does NOT do is the interesting
 * part. It computes nothing about the game: the winner, whose turn it is,
 * whether a move is legal — each is a resource the host resolves. And it
 * caches nothing: every read goes to the host, and the HOST's kernel answers
 * from its cache, recomputing only what a move cut (a move cuts one stored
 * cell, and the lines, winner and turn through it recompute; the templates
 * never do). The app is a view over resources, and the kernel does the rest.
 *
 * **Routes** (the book's path ↔ IRI rule: the game is where the page is):
 *
 * - `GET /` and `GET /game/{id}/` — the page: `view:game:{id}` composed, with a
 *   `<base href>` at the game's path, loading the book's vendored htmx and
 *   stylesheet from `/static/`.
 * - `GET {game}iki/tutorial/ttt/view/board` and `…/view/status` — the
 *   fragments, composed here.
 * - `POST {game}iki/tutorial/ttt/view/play/{x}/{y}` and `…/view/reset` — the
 *   write goes THROUGH the host (a Sink to `move:{x}:{y}` / `reset`), and the
 *   answer is `view:reply` composed here. A refused move is answered,
 *   not failed: the refusal's text, as the Rust view shows it.
 *
 * On those paths the app answers what `ttt-host` answers — status and body,
 * the refusals included (a coordinate not in its plain form, a game the host
 * does not serve, a method the view does not take); see {@linkcode handler}.
 * Every other path is `404 not found`: the app serves views, not the host's
 * raw resources. The flags are the host's too: `--socket <path>` and
 * `--http <addr>` (default `127.0.0.1:8071`; the host takes 8070).
 *
 * Every name in a template is spelled for the root game. A game `id` is
 * reached as `urn:game:{id}:iki:tutorial:ttt:{name}`, the host's gateway
 * names, which carry the game as a VALUE the host turns into the game's
 * corridor; the root game is `urn:game:root:…`, and `/game/root/` is its page
 * as it is on the host.
 *
 * ⚠ **Write through the host, always.** The host cuts its cached reads when
 * ITS kernel issues the write; a write made behind its back (to a peer store
 * directly) leaves it serving the old board.
 *
 * ⚠ **Render from raw resources, never compute the game here.** A TypeScript
 * composite that called back into the host for its inputs would be a
 * traccessor — its answer would depend on reads the host never saw it make,
 * so nothing could cut it.
 *
 * One board per page, so the squares keep the template's ids (`ttt-square-1-1`)
 * and the fragments stay byte-identical to the Rust views. A page that showed
 * two boards would need them prefixed per game, as the book's shim does:
 * htmx restores focus by id after a swap.
 */

import { type Client, connect, ConnectionLost } from "../src/client.ts";
import {
  ConflictError,
  DeniedError,
  EndpointError,
  InvalidArgumentError,
  MissingArgumentError,
  NotFoundError,
  TimeoutError,
  UnavailableError,
  UnresolvedError,
} from "../src/wire.ts";
import { httpStatus } from "./http_status.ts";
import { plainInteger } from "./tictactoe_store.ts";

// ---------------------------------------------------------------------------
// The template language (crates/tic-tac-toe/README.md, "The template language")
// ---------------------------------------------------------------------------

/** A template's arguments: what a view's name captured, or the request's own. */
export type Args = Record<string, string>;

/** A Source a marker makes: the IRI (arguments filled in) and its query arguments. */
export type Resolve = (iri: string, args: Args) => Promise<string>;

/** How a marker splices: `$a` expands the answer, `$r` as it is, `$h` HTML-escaped. */
type Mode = "a" | "r" | "h";

/** A scanned template: literal text, or a marker's mode and trimmed body. */
type Segment = string | { mode: Mode; body: string };

/** A marker body: an argument, or a Source with its (possibly quoted) values. */
type Marker =
  | { arg: string }
  | { iri: string; args: [string, { text: string; quoted: boolean }][] };

/** The function the templates call, which the host's gateway does not forward. */
export const CONDITIONAL = "urn:iki:fn:conditional";

/** How deep `$a` may transclude — `ikigai-fn`'s `COMPOSE_MAX_DEPTH`. */
const MAX_DEPTH = 32;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** `text`, safe in HTML text or an attribute quoted either way — what `$h` splices. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function refuse(body: string, detail: string): never {
  throw new EndpointError(`compose: marker \`${body}\`: ${detail}`);
}

/**
 * The index of the `}` closing the marker whose `{` is at `brace`: nested
 * `{…}` counted, `"…"` spans skipped (`\"` and `\\` escape). -1 if it never closes.
 */
function markerEnd(text: string, brace: number): number {
  let [depth, quoted] = [0, false];
  for (let i = brace + 1; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === "\\") i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === "{") depth++;
    else if (!quoted && c === "}" && depth-- === 0) return i;
  }
  return -1;
}

/** `text` as literal runs and markers. `$$` is `$`; an unclosed marker is literal. */
export function scan(text: string): Segment[] {
  const out: Segment[] = [];
  let literal = "";
  for (let i = 0; i < text.length; i++) {
    const [c, mode] = [text[i], text[i + 1]];
    if (c === "$" && mode === "$") {
      literal += "$";
      i++;
      continue;
    }
    const end = c === "$" && "arh".includes(mode) && text[i + 2] === "{"
      ? markerEnd(text, i + 2)
      : -1;
    if (end < 0) {
      literal += c;
      continue;
    }
    if (literal) out.push(literal);
    literal = "";
    out.push({ mode: mode as Mode, body: text.slice(i + 3, end).trim() });
    i = end;
  }
  if (literal) out.push(literal);
  return out;
}

/** `s` split on every `sep` outside a `"…"` span. */
function splitOutsideQuotes(s: string, sep: string): string[] {
  const parts: string[] = [];
  let [start, quoted] = [0, false];
  for (let i = 0; i < s.length; i++) {
    if (quoted && s[i] === "\\") i++;
    else if (s[i] === '"') quoted = !quoted;
    else if (!quoted && s.startsWith(sep, i)) {
      parts.push(s.slice(start, i));
      start = i + sep.length;
      i = start - 1;
    }
  }
  return [...parts, s.slice(start)];
}

const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Refuse a `{` in `text` that does not open a `{name}` argument. */
function checkPlaceholders(body: string, text: string): void {
  for (const m of text.matchAll(/\{([^}]*)(\}?)/g)) {
    if (!m[2]) refuse(body, "a `{` is never closed");
    if (!ARG_NAME.test(m[1])) {
      refuse(body, `\`{${m[1]}}\` is not an argument name`);
    }
  }
}

/** A marker body, parsed: `{name}`, or `IRI[?k=v&…]`. */
function parseMarker(mode: Mode, body: string): Marker {
  if (!body) refuse(body, "an empty marker");
  if (splitOutsideQuotes(body, "||").length > 1) {
    refuse(body, "`||` fallbacks are not implemented by this filler");
  }
  const arg = /^\{(.*)\}$/.exec(body)?.[1];
  if (arg !== undefined && ARG_NAME.test(arg)) {
    if (mode === "a") {
      refuse(body, `\`{${arg}}\` is an argument, never a template`);
    }
    return { arg };
  }
  const q = body.indexOf("?");
  const iri = (q < 0 ? body : body.slice(0, q)).trim();
  checkPlaceholders(body, iri);
  const args: [string, { text: string; quoted: boolean }][] = [];
  for (const raw of q < 0 ? [] : splitOutsideQuotes(body.slice(q + 1), "&")) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) refuse(body, `the argument \`${pair}\` is not key=value`);
    const value = pair.slice(eq + 1).trim();
    const quoted = value.length >= 2 && value.startsWith('"') &&
      value.endsWith('"');
    if (!quoted) checkPlaceholders(body, value);
    const text = quoted
      ? value.slice(1, -1).replace(/\\([\s\S]?)/g, (_, c) => c || "\\")
      : value;
    args.push([pair.slice(0, eq).trim(), { text, quoted }]);
  }
  return { iri, args };
}

/** Argument `name`, or the refusal a missing one is. */
function argument(args: Args, name: string): string {
  if (!Object.hasOwn(args, name)) throw new MissingArgumentError(name);
  return args[name];
}

/** Every `{name}` in `text` replaced: percent-encoded (RFC 6570 simple) in an IRI, verbatim in a value. */
function fillArguments(text: string, args: Args, encode: boolean): string {
  return text.replace(/\{([^}]*)\}/g, (_, name) => {
    const value = argument(args, name);
    if (!encode) return value;
    return [...new TextEncoder().encode(value)].map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~]/.test(c)
        ? c
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }).join("");
  });
}

/**
 * `urn:iki:fn:conditional?if=A&equals=V&then=B&else=C`: source `A`, and
 * source ONLY `B` when its trimmed text is exactly `V`, else only `C` (nothing
 * when there is no `else`). The answer is the chosen template, unexpanded.
 */
async function conditional(args: Args, resolve: Resolve): Promise<string> {
  const [test, equals, then] = ["if", "equals", "then"].map((name) =>
    argument(args, name)
  );
  if ((await resolve(test, {})).trim() === equals) return resolve(then, {});
  return Object.hasOwn(args, "else") ? resolve(args.else, {}) : "";
}

/**
 * `template` filled: every marker resolved through `resolve` (or answered by
 * {@linkcode conditional}) and spliced by its mode. A marker that fails fails
 * the whole template; a `$h` or `$r` value is never scanned again.
 */
export async function compose(
  template: string,
  args: Args,
  resolve: Resolve,
  depth = 0,
): Promise<string> {
  if (depth >= MAX_DEPTH) {
    throw new EndpointError(`compose: recursion limit (${MAX_DEPTH}) exceeded`);
  }
  const segments = scan(template);
  // Every marker is parsed before any resolves: a malformed one fails the template.
  const markers = segments.map((s) =>
    typeof s === "string" ? null : parseMarker(s.mode, s.body)
  );
  const filled = await Promise.all(segments.map(async (s, n) => {
    const marker = markers[n];
    if (typeof s === "string" || marker === null) return s as string;
    let answer: string;
    if ("arg" in marker) {
      answer = argument(args, marker.arg);
    } else {
      const iri = fillArguments(marker.iri, args, true);
      const query: Args = {};
      for (const [key, { text, quoted }] of marker.args) {
        query[key] = quoted ? text : fillArguments(text, args, false);
      }
      answer = iri === CONDITIONAL
        ? await conditional(query, resolve)
        : await resolve(iri, query);
      if (s.mode === "a") {
        return compose(answer, args, resolve, depth + 1);
      }
    }
    return s.mode === "h" ? escapeHtml(answer) : answer;
  }));
  return filled.join("");
}

// ---------------------------------------------------------------------------
// A game, as the host names it, and its views composed here
// ---------------------------------------------------------------------------

/** What the app needs of a connection to `ttt-host`: a {@linkcode Client} has it. */
export type Host = Pick<Client, "source" | "sink" | "entries">;

/** The names every template is spelled with: the root game's. */
const GAME = "urn:iki:tutorial:ttt:";

/**
 * The views that read, as the tutorial's table binds them: the template each
 * composes and the arguments its name captures (`y` takes the rest, as a
 * trailing template variable does).
 */
const VIEWS: [RegExp, string, string[]][] = [
  [/^view:board$/, "board", []],
  [/^view:status$/, "status", []],
  [/^view:reply$/, "reply", []],
  [/^view:square:([^:]+):(.+)$/, "square", ["x", "y"]],
  [/^view:game:(.+)$/, "game", ["game"]],
];

/** A game's resources on a `ttt-host`: the root game when `id` is null. */
export class Game {
  constructor(readonly client: Host, readonly id: string | null) {}

  /** The host's gateway name for the game's resource `name` (e.g. `cell:1:1`). */
  iri(name: string): string {
    return `urn:game:${this.id ?? "root"}:iki:tutorial:ttt:${name}`;
  }

  /** Sink `name` in this game — the write the host's kernel cuts from. */
  async write(name: string): Promise<string> {
    return (await this.client.sink(this.iri(name))).text;
  }

  /**
   * A marker's Source, in this game: a view is composed HERE from its
   * template; any other game name is read from the host in this game.
   */
  resolve: Resolve = (iri, args) => {
    const name = iri.startsWith(GAME) ? iri.slice(GAME.length) : null;
    for (const [pattern, template, vars] of VIEWS) {
      const m = name === null ? null : pattern.exec(name);
      if (m === null) continue;
      const captured = Object.fromEntries(vars.map((v, n) => [v, m[n + 1]]));
      return this.view(template, { ...args, ...captured });
    }
    const target = name === null ? iri : this.iri(name);
    return this.client.source(target, args).then((r) => r.text);
  };

  /** `template:{name}`, read from the host and composed with `args`. */
  async view(name: string, args: Args = {}): Promise<string> {
    const template = await this.resolve(`${GAME}template:${name}`, {});
    return compose(template, args, this.resolve);
  }
}

/**
 * A write's answer: the write through the host, then `view:reply` with its
 * `message` — what the write said, or the refusal's text. The error is
 * rendered, never inspected.
 */
export async function reply(game: Game, write: string): Promise<string> {
  let message: string;
  try {
    message = await game.write(write);
  } catch (e) {
    if (!(e instanceof EndpointError)) throw e;
    message = rustDisplay(e);
  }
  return game.resolve(`${GAME}view:reply`, { message });
}

/**
 * An error's text as the Rust kernel's `Display` prints it — what the Rust
 * view shows, since it catches the refusal inside the host. The typed
 * errors' `message` already matches for the argument and resolution variants;
 * the others carry the bare message, so the variant's prefix goes back on.
 */
export function rustDisplay(e: EndpointError): string {
  if (
    e instanceof InvalidArgumentError || e instanceof MissingArgumentError ||
    e instanceof UnresolvedError
  ) {
    return e.message;
  }
  const prefix = e instanceof DeniedError
    ? "denied"
    : e instanceof NotFoundError
    ? "not found"
    : e instanceof TimeoutError
    ? "timeout"
    : e instanceof UnavailableError
    ? "unavailable"
    : e instanceof ConflictError
    ? "conflict"
    : "endpoint error";
  return `${prefix}: ${e.message}`;
}

// ---------------------------------------------------------------------------
// The page and the HTTP face
// ---------------------------------------------------------------------------

/** A page's Content-Security-Policy — `ttt-host`'s: `base-uri 'self'` lets the `<base>` work. */
export const PAGE_CSP =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/**
 * The files the page loads, vendored byte-for-byte from ikigai-tutorial at
 * `31daf4e` — the commit the prebuilt `ttt-host` is built from, so the parity
 * test can compare them with the host's (a test also pins each sha256):
 * htmx 2.0.4 (0BSD) from `books/ikigai/src/vendor/htmx-2.0.4.min.js`, sha256
 * `e209dda5c8235479f3166defc7750e1dbcd5a5c1808b7792fc2e6733768fb447`; the ONE
 * stylesheet for the markup, `books/ikigai/css/ttt.css`, sha256
 * `f93bde4b6dacb82b085d88c8cf33c899eb3dd435dd64acd5e1e19c63be04f09b`; and
 * `ttt-host`'s `static/host.css` (the colors `ttt.css` reads, which the book
 * gets from mdbook), sha256
 * `79437443cd22e56d183ebf5b4a6de625e72354d38e8a39e54894bf0dc19f27ac`.
 */
export const STATIC: Record<string, { file: string; type: string }> = {
  "/static/htmx-2.0.4.min.js": {
    file: "htmx-2.0.4.min.js",
    type: "text/javascript",
  },
  "/static/ttt.css": { file: "ttt.css", type: "text/css" },
  "/static/host.css": { file: "host.css", type: "text/css" },
};

/** The games the host serves, discovered from its catalog (its gateway names). */
export async function games(client: Host): Promise<string[]> {
  const ids = new Set<string>();
  for (const entry of await client.entries()) {
    const m = /^urn:game:([A-Za-z0-9-]+):iki:tutorial:ttt:/.exec(entry.pattern);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

/** A game's page: the document around its `game` template — `ttt-host`'s, byte for byte. */
export async function page(game: Game, others: string[]): Promise<string> {
  const label = game.id ?? "root";
  const shell = await game.resolve(`${GAME}view:game:${label}`, {});
  const base = game.id === null ? "/" : `/game/${game.id}/`;
  const title = escapeHtml(
    game.id === null ? "the root game" : `game ${label}`,
  );
  const links = [
    '<li><a href="/">the root game</a></li>',
    ...others.map((o) => `<li><a href="/game/${o}/">game ${o}</a></li>`),
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="htmx-config" content='{"allowEval":false,"includeIndicatorStyles":false,"historyEnabled":false}'>
<title>Tic-tac-toe: ${title}</title>
<base href="${base}">
<link rel="stylesheet" href="/static/host.css">
<link rel="stylesheet" href="/static/ttt.css">
<script src="/static/htmx-2.0.4.min.js"></script>
</head>
<body>
<main>
<h1>Tic-tac-toe: ${title}</h1>
<div class="ttt-boards"><div class="ttt-play">
${shell}
</div></div>
<nav aria-label="Games"><h2>Games on this host</h2><ul>${
    links.join("")
  }</ul></nav>
</main>
</body>
</html>
`;
}

/** The media type of a page and a fragment — `ttt-host`'s spelling, no space. */
const HTML = "text/html;charset=utf-8";

// ---------------------------------------------------------------------------
// The path rule — `ttt-host`'s, which is `ikigai-web`'s
// ---------------------------------------------------------------------------

/** A request path `ttt-host`'s edge refuses before routing it: `400` with this text. */
export class PathError extends Error {}

/**
 * A request path's segments, decoded exactly as `ttt-host`'s edge
 * (`ikigai-web` 0.1.30) decodes them: split on `/` FIRST, each segment
 * percent-decoded on its own (so `%2F` is data inside its segment, never a
 * separator), `+` a literal `+`, and empty segments dropped. A `%` not
 * followed by two hex digits is refused (`malformed percent-escape`), and so
 * is a segment that is not UTF-8 once decoded.
 */
export function pathSegments(path: string): string[] {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const hex = (c: string | undefined) =>
    c !== undefined && /^[0-9A-Fa-f]$/.test(c) ? c : null;
  return path.split("/").filter((s) => s !== "").map((segment) => {
    const bytes: number[] = [];
    for (let i = 0; i < segment.length; i++) {
      if (segment[i] !== "%") {
        bytes.push(...new TextEncoder().encode(segment[i]));
        continue;
      }
      const [hi, lo] = [hex(segment[i + 1]), hex(segment[i + 2])];
      if (hi === null || lo === null) {
        throw new PathError("malformed percent-escape");
      }
      bytes.push(parseInt(hi + lo, 16));
      i += 2;
    }
    try {
      return utf8.decode(new Uint8Array(bytes));
    } catch {
      throw new PathError("not UTF-8 once decoded");
    }
  });
}

/**
 * Whether `urn:{rest}` is an IRI (RFC 3987) — what `ttt-host` asks before it
 * resolves anything, answering `400 not a resource path` when it is not.
 * `rest` is a decoded path, so a `?` or a `#` in it came from `%3F` / `%23`.
 */
export function isIri(rest: string): boolean {
  const hash = rest.indexOf("#");
  if (hash >= 0 && rest.indexOf("#", hash + 1) >= 0) return false;
  return /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?# -퟿豈-﷏ﷰ-￯\u{10000}-\u{EFFFD}]|%[0-9A-Fa-f]{2})*$/u
    .test(rest);
}

/** A game's view, as a request names it. */
export type View = "board" | "status" | "reset" | {
  x: string;
  y: string;
};

/** What a request path is, by `ttt-host`'s rule. */
export type Route =
  /** A game's page: `/` (the root game) or `/game/{id}`, trailing slash or not. */
  | { kind: "page"; game: string | null; iri: string }
  /** One of the three files the page loads. */
  | { kind: "static"; path: string }
  /** A view of a game — the root game when `game` is null. `iri` is the view's edge name. */
  | { kind: "view"; game: string | null; view: View; iri: string }
  /** Anything else: not the app's to answer (the app is not a proxy). */
  | { kind: "other" };

/**
 * A request path, classified (a {@linkcode PathError} if the edge refuses
 * it). Empty segments collapse (`ttt-host` joins the non-empty ones), so `/game/a` and `/game/a/` are one page, and the relative
 * path `a/b/c` is `urn:a:b:c` — the game is where the page is. A play's `y`
 * takes the rest of the name, as the host's template does, so `play/1/2/3`
 * is the play `(1, "2:3")`, refused for its coordinate.
 */
export function route(path: string): Route {
  const segments = pathSegments(path);
  if (segments.length === 0) {
    return { kind: "page", game: null, iri: "urn:ttt-host:page:root" };
  }
  if (segments.length === 2 && segments[0] === "game") {
    const game = segments[1];
    return { kind: "page", game, iri: `urn:ttt-host:page:game:${game}` };
  }
  const file = `/static/${segments[1]}`;
  if (segments.length === 2 && segments[0] === "static" && STATIC[file]) {
    return { kind: "static", path: file };
  }
  const rest = segments.join(":");
  let game: string | null = null;
  let name = rest;
  if (rest.startsWith("game:")) {
    const at = rest.indexOf(":", "game:".length);
    if (at < 0) return { kind: "other" };
    [game, name] = [rest.slice("game:".length, at), rest.slice(at + 1)];
  }
  const prefix = "iki:tutorial:ttt:view:";
  if (!name.startsWith(prefix)) return { kind: "other" };
  const local = name.slice(prefix.length);
  const play = /^play:([^:]+):(.+)$/.exec(local);
  const view: View | null = local === "board" || local === "status" ||
      local === "reset"
    ? local
    : play
    ? { x: play[1], y: play[2] }
    : null;
  return view === null
    ? { kind: "other" }
    : { kind: "view", game, view, iri: `urn:${rest}` };
}

// ---------------------------------------------------------------------------
// The HTTP face
// ---------------------------------------------------------------------------

/** The kernel verb an HTTP method maps to, as `ttt-host`'s edge maps it. */
function verbOf(method: string): "source" | "sink" | "delete" | null {
  switch (method) {
    case "GET":
    case "HEAD":
      return "source";
    case "PUT":
    case "POST":
    case "PATCH":
      return "sink";
    case "DELETE":
      return "delete";
    default:
      return null;
  }
}

/** The `Allow` list for a resource that declares `verb` (a read when nothing is declared). */
function allowOf(verb: "source" | "sink" | null): string {
  return verb === "sink" ? "POST, PUT, PATCH, OPTIONS" : "GET, HEAD, OPTIONS";
}

/**
 * The app: an HTTP handler over one connection to a `ttt-host`.
 *
 * It answers exactly as `ttt-host` does on every page and view path — the
 * status and the body — and `404 not found` on every other path, since it
 * serves no raw resource (`board`, `stored:…`, `template:…`): a view over
 * resources, not a proxy for them. What the host's edge does, in its order:
 *
 * 1. a malformed percent-escape, or a segment that is not UTF-8 once
 *    decoded → `400` saying which; a path that is not an IRI →
 *    `400 not a resource path`;
 * 2. `OPTIONS` → `204` with the `Allow` list; a method with no verb → `405`;
 * 3. a game the host does not serve declares nothing, so it has no `405`:
 *    `PATCH` → `415`, anything else → `404 no endpoint resolved for <iri>`;
 * 4. a verb the resource does not declare → `405 method not allowed`
 *    (GET/HEAD read; POST/PUT/PATCH write);
 * 5. `PATCH` → `415` — the edge's only patch format is JSON merge-patch,
 *    which this app does not model (see the README);
 * 6. a play's coordinates, each in its plain form → else `400`;
 * 7. the view, or the write through the host.
 */
export function handler(
  client: Host,
  staticDir = new URL("./tictactoe_static/", import.meta.url),
): (request: Request) => Promise<Response> {
  return async (request) => {
    const head = request.method === "HEAD";
    const respond = (
      code: number,
      body: BodyInit | null,
      headers: Record<string, string>,
    ) =>
      new Response(head || code === 204 ? null : body, {
        status: code,
        headers,
      });
    const text = (code: number, body: string, headers = {}) =>
      respond(code, body, {
        "content-type": "text/plain; charset=utf-8",
        ...headers,
      });
    const html = (body: string, headers: Record<string, string> = {}) =>
      respond(200, body, {
        "content-type": HTML,
        "cache-control": "no-store",
        ...headers,
      });

    let at: Route;
    try {
      at = route(new URL(request.url).pathname);
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
      return text(400, e.message);
    }
    if (at.kind === "other") return text(404, "not found");
    if (at.kind !== "static" && !isIri(at.iri.slice("urn:".length))) {
      return text(400, "not a resource path");
    }
    const writes = at.kind === "view" &&
      (at.view === "reset" || typeof at.view === "object");
    const declared = writes ? "sink" : "source";
    const allow = { allow: allowOf(declared) };
    if (request.method === "OPTIONS") return respond(204, null, allow);
    const verb = verbOf(request.method);
    if (verb === null) return text(405, "method not allowed", allow);

    try {
      // The host's games, read from its catalog on every request: nothing here caches.
      const served = at.kind === "static" ? [] : await games(client);
      if (at.kind !== "static" && at.game !== null) {
        if (at.game !== "root" && !served.includes(at.game)) {
          if (request.method === "PATCH") {
            return text(415, "no patch strategy for this Content-Type");
          }
          return text(404, rustDisplay(new UnresolvedError(at.iri)));
        }
      }
      if (verb !== declared) return text(405, "method not allowed", allow);
      if (request.method === "PATCH") {
        return text(415, "no patch strategy for this Content-Type");
      }

      if (at.kind === "static") {
        const file = STATIC[at.path];
        const body = await Deno.readFile(new URL(file.file, staticDir));
        return respond(200, body, { "content-type": file.type });
      }
      const game = new Game(client, at.game);
      if (at.kind === "page") {
        return html(await page(game, served), {
          "content-security-policy": PAGE_CSP,
        });
      }
      const view = at.view;
      if (view === "board" || view === "status") {
        return html(await game.resolve(`${GAME}view:${view}`, {}));
      }
      if (view === "reset") return html(await reply(game, "reset"));
      const [x, y] = [plainInteger("x", view.x), plainInteger("y", view.y)];
      return html(await reply(game, `move:${x}:${y}`));
    } catch (e) {
      if (e instanceof ConnectionLost) return text(503, `${e.message}`);
      if (!(e instanceof EndpointError)) throw e;
      // The game is in the path, so a game the host does not serve is the caller's 404.
      const code = e instanceof UnresolvedError ? 404 : httpStatus(e);
      return text(code, rustDisplay(e));
    }
  };
}

// ---------------------------------------------------------------------------
// The command line — `ttt-host`'s spelling
// ---------------------------------------------------------------------------

/** The address the app listens on when `--http` is not given (ttt-host 8070, Deno 8071, Python 8072). */
export const DEFAULT_HTTP = "127.0.0.1:8071";

/** The usage text. */
export const USAGE =
  `usage: deno run -A examples/tictactoe_app.ts [--socket <path>] [--http <addr>]
  --socket <path>   the ttt-host IPC socket (default: ttt-host.sock in the temp dir)
  --http <addr>     serve the pages over HTTP (default ${DEFAULT_HTTP})`;

/** What the app connects to and where it listens. */
export type Options = {
  socket: string;
  http: { hostname: string; port: number };
};

/** `host:port` (or `[v6]:port`) as a listen address; the error names the flag. */
export function parseAddr(text: string): { hostname: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:\[\]]+)):([0-9]+)$/.exec(text);
  const port = m ? Number(m[3]) : NaN;
  if (!m || !(port <= 65535)) {
    throw new Error(
      `--http ${text}: not an address (host:port, e.g. ${DEFAULT_HTTP})`,
    );
  }
  return { hostname: m[1] ?? m[2], port };
}

/**
 * The command line (without the program name). `--port` and `--host` were
 * this app's flags before it took `ttt-host`'s spelling; they are refused by
 * name, pointing at `--http`, rather than silently ignored.
 */
export function parseArgs(args: string[], tmpdir = "/tmp"): Options {
  let socket = `${tmpdir.replace(/\/$/, "")}/ttt-host.sock`;
  let http = parseAddr(DEFAULT_HTTP);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = () => {
      if (i + 1 >= args.length) {
        throw new Error(`${flag} needs a value\n${USAGE}`);
      }
      return args[++i];
    };
    switch (flag) {
      case "--socket":
        socket = value();
        break;
      case "--http":
        http = parseAddr(value());
        break;
      case "--port":
      case "--host":
        throw new Error(
          `${flag} is not a flag any more: the listen address is --http <addr> ` +
            `(e.g. --http ${DEFAULT_HTTP}), as ttt-host spells it`,
        );
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        throw new Error(`unknown argument \`${flag}\`\n${USAGE}`);
    }
  }
  return { socket, http };
}

if (import.meta.main) {
  let options: Options;
  try {
    options = parseArgs(Deno.args, Deno.env.get("TMPDIR") ?? "/tmp");
  } catch (e) {
    console.error(`examples/tictactoe_app.ts: ${(e as Error).message}`);
    Deno.exit(1);
  }
  const { socket, http } = options;
  const client = await connect(socket);
  const known = await games(client);
  Deno.serve({
    ...http,
    onListen: ({ hostname, port }) => {
      console.error(
        `examples/tictactoe_app.ts: http://${hostname}:${port}/ (the root game); ` +
          `games at /game/<id>/: ${
            known.join(", ")
          } — from ttt-host at ${socket}`,
      );
    },
  }, handler(client));
}
