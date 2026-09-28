/**
 * Tic-tac-toe, played in a browser — a standalone Deno app that renders the
 * game's own HTMX markup from the game's RESOURCES.
 *
 * The ikigai book's applied chapter (ikigai-tutorial, `crates/tic-tac-toe`)
 * builds tic-tac-toe as resources and ships its HTML as TEMPLATE resources
 * (`template:{name}`), so that any host in any language can fill them. The
 * Rust kernel fills them itself (`view:board`, `view:status`); this app fills
 * them HERE, in TypeScript, from the raw resources a `ttt-host` serves over
 * its IPC socket:
 *
 * ```sh
 * ttt-host --socket /tmp/ttt-host.sock                  # games a and b, :8070
 * deno run -A examples/tictactoe_app.ts --socket /tmp/ttt-host.sock   # :8071
 * open http://127.0.0.1:8071/game/a/
 * ```
 *
 * The renderer is {@linkcode fill} plus {@linkcode viewBoard},
 * {@linkcode viewStatus} and {@linkcode reply} — about a hundred lines of code
 * over `template:*`, `cell:{x}:{y}`, `winner` and `turn`, half of it refusing
 * the malformed slots the Rust filler refuses. What it does NOT do is the interesting part. It
 * computes nothing about the game: the winner, whose turn it is, whether a
 * move is legal — each is a resource the host resolves. And it caches
 * nothing: every read goes to the host, and the HOST's kernel answers from
 * its cache, recomputing only what a move cut (a move cuts one stored cell,
 * and the lines, winner and turn through it recompute; the templates never
 * do). The app is a view over resources, and the kernel does the rest.
 *
 * **Routes** (the book's path ↔ IRI rule: the game is where the page is):
 *
 * - `GET /` and `GET /game/{id}/` — the page: `template:game` filled, with a
 *   `<base href>` at the game's path, loading the book's vendored htmx and
 *   stylesheet from `/static/`.
 * - `GET {game}iki/tutorial/ttt/view/board` and `…/view/status` — the
 *   fragments, filled here.
 * - `POST {game}iki/tutorial/ttt/view/play/{x}/{y}` and `…/view/reset` — the
 *   write goes THROUGH the host (a Sink to `move:{x}:{y}` / `reset`), and the
 *   answer is the `reply` template filled here. A refused move is answered,
 *   not failed: the refusal's text, as the Rust view shows it.
 *
 * On those paths the app answers what `ttt-host` answers — status and body,
 * the refusals included (a coordinate not in its plain form, a game the host
 * does not serve, a method the view does not take); see {@linkcode handler}.
 * Every other path is `404 not found`: the app serves views, not the host's
 * raw resources. The flags are the host's too: `--socket <path>` and
 * `--http <addr>` (default `127.0.0.1:8071`; the host takes 8070).
 *
 * A game `id` is reached as `urn:game:{id}:iki:tutorial:ttt:{name}`, the
 * host's gateway names, which carry the game as a VALUE the host turns into
 * the game's corridor; the root game's names are `urn:iki:tutorial:ttt:{name}`
 * as they are.
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
// The template format (crates/tic-tac-toe/README.md, "The template format")
// ---------------------------------------------------------------------------

/** A slot: `{{name}}` or `{{name 0 -2}}`. */
const SLOT = /\{\{([a-z][a-z-]*)((?: -?[0-9]+)*)\}\}/g;

/** One slot of a template: its name and its arguments, each in its plain spelling. */
export type Slot = { name: string; args: string[] };

/** What fills a slot: text (escaped on the way in) or another template's HTML. */
export type Fill = { text: string } | { html: string };

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** `text`, safe in HTML text or a quoted attribute — the Rust `escape`. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * `template` as literal text and slots, alternating (text first and last).
 * Any other `{{` — unclosed, capitalized, an argument not in its one plain
 * spelling (`01`, `+1`, `-0`) — is refused, as the Rust `fill` refuses it: a
 * slot nobody fills would reach the page as `{{…}}`.
 */
export function pieces(template: string): (string | Slot)[] {
  const refuse = (what: string) => {
    throw new EndpointError(`a template: ${what}`);
  };
  const out: (string | Slot)[] = [];
  let at = 0;
  for (const m of template.matchAll(SLOT)) {
    out.push(template.slice(at, m.index));
    const args = m[2].split(" ").slice(1);
    for (const arg of args) {
      if (arg === "-0" || /^-?0[0-9]/.test(arg)) {
        refuse(`\`${m[0]}\` has an argument \`${arg}\``);
      }
    }
    out.push({ name: m[1], args });
    at = m.index + m[0].length;
  }
  out.push(template.slice(at));
  for (const text of out) {
    if (typeof text === "string" && text.includes("{{")) {
      refuse(`\`${text}\` has a \`{{\` that is not a slot`);
    }
  }
  return out;
}

/** `template`, every slot replaced by what `value` says fills it. */
export function fill(template: string, value: (slot: Slot) => Fill): string {
  return pieces(template).map((piece) => {
    if (typeof piece === "string") return piece;
    const filled = value(piece);
    return "html" in filled ? filled.html : escapeHtml(filled.text);
  }).join("");
}

/** The refusal for a slot this view does not fill (the Rust `unfilled`). */
function unfilled(template: string, name: string): never {
  throw new EndpointError(
    `the template \`${template}\` has a slot \`${name}\` this view does not fill`,
  );
}

// ---------------------------------------------------------------------------
// A game, as the host names it
// ---------------------------------------------------------------------------

/** What the app needs of a connection to `ttt-host`: a {@linkcode Client} has it. */
export type Host = Pick<Client, "source" | "sink" | "entries">;

/** A game's resources on a `ttt-host`: the root game when `id` is null. */
export class Game {
  constructor(readonly client: Host, readonly id: string | null) {}

  /** The IRI of the game's resource `name` (e.g. `cell:1:1`). */
  iri(name: string): string {
    return this.id === null
      ? `urn:iki:tutorial:ttt:${name}`
      : `urn:game:${this.id}:iki:tutorial:ttt:${name}`;
  }

  /** Source `name` in this game, as text. */
  async text(name: string): Promise<string> {
    return (await this.client.source(this.iri(name))).text;
  }

  /** Sink `name` in this game — the write the host's kernel cuts from. */
  async write(name: string): Promise<string> {
    return (await this.client.sink(this.iri(name))).text;
  }
}

// ---------------------------------------------------------------------------
// The views — the Rust `view_board` / `view_status` / `reply`, in TypeScript
// ---------------------------------------------------------------------------

/** The board: each `{{square x y}}` filled by the square template its cell calls for. */
export async function viewBoard(game: Game): Promise<string> {
  const board = await game.text("template:board");
  const over = await game.text("winner") !== "-";
  const squares = new Map<string, string>();
  for (const slot of pieces(board)) {
    if (typeof slot === "string") continue;
    if (slot.name !== "square" || slot.args.length !== 2) {
      unfilled("board", slot.name);
    }
    const [x, y] = slot.args;
    if (squares.has(`${x} ${y}`)) continue;
    const mark = await game.text(`cell:${x}:${y}`);
    const kind = mark !== "-"
      ? "square-taken"
      : over
      ? "square-closed"
      : "square-open";
    const fills: Record<string, string> = { x, y, mark };
    const square = await game.text(`template:${kind}`);
    squares.set(
      `${x} ${y}`,
      fill(
        square,
        ({ name }) =>
          name in fills ? { text: fills[name] } : unfilled(kind, name),
      ),
    );
  }
  return fill(board, ({ args }) => ({ html: squares.get(args.join(" "))! }));
}

/** `X to play.`, `O has won.` or `A draw.`: a status template, filled with the mark. */
export async function viewStatus(game: Game): Promise<string> {
  const won = await game.text("winner");
  const [kind, mark] = won === "-"
    ? ["status-turn", await game.text("turn")]
    : won === "draw"
    ? ["status-draw", ""]
    : ["status-won", won];
  const template = await game.text(`template:${kind}`);
  return fill(
    template,
    ({ name }) => name === "mark" ? { text: mark } : unfilled(kind, name),
  );
}

/**
 * A write's answer: the `reply` template — what the write said, or the
 * refusal's text — then the status. The error is rendered, never inspected.
 */
export async function reply(game: Game, write: string): Promise<string> {
  let message: string;
  try {
    message = await game.write(write);
  } catch (e) {
    if (!(e instanceof EndpointError)) throw e;
    message = rustDisplay(e);
  }
  const status = await viewStatus(game);
  const template = await game.text("template:reply");
  return fill(
    template,
    ({ name }) =>
      name === "message"
        ? { text: message }
        : name === "status"
        ? { html: status }
        : unfilled("reply", name),
  );
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
  const shell = fill(
    await game.text("template:game"),
    ({ name }) => name === "game" ? { text: label } : unfilled("game", name),
  );
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

/**
 * A request path, percent-decoded exactly as `ttt-host` decodes it: its edge
 * (`ikigai-web` 0.1.29, `urldecode`) decodes `%XX` and turns `+` into a space
 * in the PATH as well as the query. The second is a quirk of the reference,
 * copied so both faces answer alike: `play/+1/0` is a path with a space in it
 * there, so it is refused as `not a resource path`, not as a coordinate.
 */
export function decodePath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    // Rust's `u8::from_str_radix` takes a leading `+`, so `%+1` is byte 1 there.
    const hex = path.slice(i + 1, i + 3);
    if (b === 0x25 && i + 2 < bytes.length && /^\+?[0-9A-Fa-f]+$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 3;
    } else {
      out.push(b === 0x2b ? 0x20 : b);
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(out));
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
 * A request path, classified. Empty segments collapse (`ttt-host` joins the
 * non-empty ones), so `/game/a` and `/game/a/` are one page, and the relative
 * path `a/b/c` is `urn:a:b:c` — the game is where the page is. A play's `y`
 * takes the rest of the name, as the host's template does, so `play/1/2/3`
 * is the play `(1, "2:3")`, refused for its coordinate.
 */
export function route(path: string): Route {
  const segments = decodePath(path).split("/").filter((s) => s !== "");
  if (segments.length === 0) {
    return { kind: "page", game: null, iri: "urn:ttt-host:page:root" };
  }
  if (segments.length === 2 && segments[0] === "game") {
    const game = segments[1];
    return { kind: "page", game, iri: `urn:ttt-host:page:game:${game}` };
  }
  const joined = "/" + segments.join("/");
  if (STATIC[joined] !== undefined) return { kind: "static", path: joined };
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
 * 1. a path that is not an IRI → `400 not a resource path`;
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

    const at = route(new URL(request.url).pathname);
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
        if (!served.includes(at.game)) {
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
      if (view === "board") return html(await viewBoard(game));
      if (view === "status") return html(await viewStatus(game));
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
