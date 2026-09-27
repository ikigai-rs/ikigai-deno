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
 * ttt-host --socket /tmp/ttt-host.sock                  # games a and b
 * deno run -A examples/tictactoe_app.ts --socket /tmp/ttt-host.sock
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
 * `9a95b0c` — the commit `ttt-host` embeds them from, so the parity test can
 * compare them with the host's (a test also pins each sha256; the CSS
 * comments say "colour" there, and are copied as they are): htmx 2.0.4 (0BSD) from
 * `books/ikigai/src/vendor/htmx-2.0.4.min.js`, sha256
 * `e209dda5c8235479f3166defc7750e1dbcd5a5c1808b7792fc2e6733768fb447`; the ONE
 * stylesheet for the markup, `books/ikigai/css/ttt.css`, sha256
 * `4955aadc02365f9eb9e5a71038a9dbb541647ee626eaad8db45ffd32fa845a53`; and
 * `ttt-host`'s `static/host.css` (the colors `ttt.css` reads, which the book
 * gets from mdbook), sha256
 * `4427125dde3c767472ceeb387e7bebf7459130ae6b9044ac00e1611a0c30fead`.
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

const HTML = "text/html; charset=utf-8";

/** A request path as the game and the IRI-shaped name under it, or null. */
export function route(
  path: string,
): { game: string | null; name: string | null } | null {
  let game: string | null = null;
  let rest = path.slice(1);
  const m = /^game\/([A-Za-z0-9-]+)(?:\/(.*))?$/.exec(rest);
  if (m) [game, rest] = [m[1], m[2] ?? ""];
  if (rest === "") return { game, name: null };
  const segments = rest.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  // The relative path a/b/c is urn:a:b:c; the game's names are iki:tutorial:ttt:….
  const iri = segments.join(":");
  const prefix = "iki:tutorial:ttt:";
  return iri.startsWith(prefix)
    ? { game, name: iri.slice(prefix.length) }
    : null;
}

/** The app: an HTTP handler over one connection to a `ttt-host`. */
export function handler(
  client: Host,
  staticDir = new URL("./tictactoe_static/", import.meta.url),
): (request: Request) => Promise<Response> {
  const html = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, {
      headers: {
        "content-type": HTML,
        "cache-control": "no-store",
        ...headers,
      },
    });
  const status = (code: number, text: string) =>
    new Response(text, {
      status: code,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

  return async (request) => {
    const path = new URL(request.url).pathname;
    const file = STATIC[path];
    if (file !== undefined) {
      if (request.method !== "GET") return status(405, "method not allowed");
      const body = await Deno.readFile(new URL(file.file, staticDir));
      return new Response(body, { headers: { "content-type": file.type } });
    }
    const at = route(path);
    if (at === null) return status(404, "not found");
    const game = new Game(client, at.game);
    const want = (method: string) => request.method === method;
    try {
      if (at.name === null) {
        if (!want("GET")) return status(405, "method not allowed");
        const others = await games(client);
        return html(await page(game, others), {
          "content-security-policy": PAGE_CSP,
        });
      }
      if (at.name === "view:board" || at.name === "view:status") {
        if (!want("GET")) return status(405, "a view is read: GET it");
        return html(
          at.name === "view:board"
            ? await viewBoard(game)
            : await viewStatus(game),
        );
      }
      if (at.name === "view:reset") {
        if (!want("POST")) {
          return status(405, "a reset is made, not read: POST it");
        }
        return html(await reply(game, "reset"));
      }
      const play = /^view:play:([^:]+):([^:]+)$/.exec(at.name);
      if (play) {
        if (!want("POST")) {
          return status(405, "a play is made, not read: POST it");
        }
        const [x, y] = [plainInteger("x", play[1]), plainInteger("y", play[2])];
        return html(await reply(game, `move:${x}:${y}`));
      }
      return status(404, "not found");
    } catch (e) {
      if (e instanceof ConnectionLost) return status(503, `${e.message}`);
      if (!(e instanceof EndpointError)) throw e;
      // The game is in the path, so a game the host does not serve is the caller's 404.
      const code = e instanceof UnresolvedError ? 404 : httpStatus(e);
      return status(code, rustDisplay(e));
    }
  };
}

if (import.meta.main) {
  const flag = (name: string, fallback: string) => {
    const at = Deno.args.indexOf(name);
    return at >= 0 && at + 1 < Deno.args.length ? Deno.args[at + 1] : fallback;
  };
  const tmp = (Deno.env.get("TMPDIR") ?? "/tmp").replace(/\/$/, "");
  const socket = flag("--socket", `${tmp}/ttt-host.sock`);
  const port = Number(flag("--port", "8071"));
  const hostname = flag("--host", "127.0.0.1");
  const client = await connect(socket);
  const known = await games(client);
  Deno.serve({
    port,
    hostname,
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
