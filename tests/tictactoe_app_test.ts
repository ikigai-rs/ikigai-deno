/**
 * The tic-tac-toe app (`examples/tictactoe_app.ts`): its template filler, its
 * path rule and its routes against a stand-in host — and then THE PARITY
 * TEST, against a real `ttt-host`: for a sequence of states (empty, moves, a
 * win, a draw, refusals), the bytes the app fills in TypeScript equal the
 * bytes the Rust views fill for the same game, fetched over IPC. If they
 * differ, the TypeScript filler is wrong, not the template.
 *
 * The host half skips when no `ttt-host` binary is found (CI has no Rust
 * host): `$TTT_HOST`, then `~/.local/ttt-host/bin/ttt-host`, then `PATH`.
 */

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { connect } from "../src/client.ts";
import {
  EndpointError,
  InvalidArgumentError,
  NotFoundError,
  Representation,
  type SpaceEntry,
  UnresolvedError,
} from "../src/wire.ts";
import {
  escapeHtml,
  fill,
  handler,
  type Host,
  PAGE_CSP,
  route,
  rustDisplay,
} from "../examples/tictactoe_app.ts";

// ---------------------------------------------------------------------------
// The vendored files are the book's, byte for byte
// ---------------------------------------------------------------------------

const STATIC_DIR = new URL("../examples/tictactoe_static/", import.meta.url);

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("ttt app: the vendored htmx, ttt.css and host.css are the book's", async () => {
  const expected: Record<string, string> = {
    "htmx-2.0.4.min.js":
      "e209dda5c8235479f3166defc7750e1dbcd5a5c1808b7792fc2e6733768fb447",
    "ttt.css":
      "4955aadc02365f9eb9e5a71038a9dbb541647ee626eaad8db45ffd32fa845a53",
    "host.css":
      "4427125dde3c767472ceeb387e7bebf7459130ae6b9044ac00e1611a0c30fead",
  };
  for (const [file, digest] of Object.entries(expected)) {
    const bytes = await Deno.readFile(new URL(file, STATIC_DIR));
    assertStrictEquals(await sha256(bytes), digest, file);
  }
});

// ---------------------------------------------------------------------------
// The template format
// ---------------------------------------------------------------------------

Deno.test("ttt app: text is escaped, HTML is not", () => {
  assertStrictEquals(escapeHtml(`a&b<c>"d'e`), "a&amp;b&lt;c&gt;&quot;d&#39;e");
  const out = fill(
    `<b title="{{t}}">{{t}}</b>{{h}}`,
    ({ name }) => name === "t" ? { text: `<"x">` } : { html: "<i>raw</i>" },
  );
  assertStrictEquals(
    out,
    `<b title="&lt;&quot;x&quot;&gt;">&lt;&quot;x&quot;&gt;</b><i>raw</i>`,
  );
});

Deno.test("ttt app: a slot's arguments arrive in their plain spelling", () => {
  const seen: string[][] = [];
  fill("{{square 0 -2}}{{status}}", ({ args }) => {
    seen.push(args);
    return { text: "" };
  });
  assertEquals(seen, [["0", "-2"], []]);
});

Deno.test("ttt app: any other `{{` is refused, never passed through", () => {
  for (
    const bad of [
      "{{square 01 0}}",
      "{{square -0 0}}",
      "{{square +1 0}}",
      "{{Square 0 0}}",
      "{{square  0}}",
      "an unclosed {{slot",
    ]
  ) {
    let caught: unknown = null;
    try {
      fill(bad, () => ({ text: "" }));
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof EndpointError, bad);
  }
});

Deno.test("ttt app: a refusal reads as the Rust kernel's Display prints it", () => {
  assertStrictEquals(
    rustDisplay(
      new InvalidArgumentError("x, y", "1,1 is taken — X played there"),
    ),
    "invalid argument `x, y`: 1,1 is taken — X played there",
  );
  assertStrictEquals(
    rustDisplay(new NotFoundError("gone")),
    "not found: gone",
  );
  assertStrictEquals(
    rustDisplay(new EndpointError("boom")),
    "endpoint error: boom",
  );
  assertStrictEquals(
    rustDisplay(new UnresolvedError("urn:x")),
    "no endpoint resolved for urn:x",
  );
});

// ---------------------------------------------------------------------------
// The path <-> IRI rule
// ---------------------------------------------------------------------------

Deno.test("ttt app: the game is where the page is; a/b/c is urn:a:b:c", () => {
  assertEquals(route("/"), { game: null, name: null });
  assertEquals(route("/game/a/"), { game: "a", name: null });
  assertEquals(route("/game/a"), { game: "a", name: null });
  assertEquals(route("/iki/tutorial/ttt/view/board"), {
    game: null,
    name: "view:board",
  });
  assertEquals(route("/game/ts/iki/tutorial/ttt/view/play/1/2"), {
    game: "ts",
    name: "view:play:1:2",
  });
  for (
    const refused of [
      "/game/a/iki/tutorial/ttt//view",
      "/game/a/iki/tutorial/ttt/./view",
      "/game/a/iki/tutorial/ttt/../view",
      "/game/a/other/thing",
      "/game/a b/",
      "/favicon.ico",
    ]
  ) {
    assertStrictEquals(route(refused), null, refused);
  }
});

// ---------------------------------------------------------------------------
// The routes, against a stand-in host (no Rust needed)
// ---------------------------------------------------------------------------

/** A host with one game, `a`, whose templates are small stand-ins. */
function standIn(): Host & { writes: string[] } {
  const resources: Record<string, string> = {
    "template:game": `<section aria-label="Game {{game}}"></section>`,
    "template:board": "{{square 0 0}}|{{square 1 0}}",
    "template:square-open": `<o id="{{x}}-{{y}}"></o>`,
    "template:square-taken": `<t>{{mark}}</t>`,
    "template:square-closed": `<c></c>`,
    "template:status-turn": "{{mark}} to play.",
    "template:status-won": "{{mark}} has won.",
    "template:status-draw": "A draw.",
    "template:reply": "{{message}}. {{status}}",
    "winner": "-",
    "turn": "O",
    "cell:0:0": "X",
    "cell:1:0": "-",
  };
  const writes: string[] = [];
  const game = "urn:game:a:iki:tutorial:ttt:";
  const named = (iri: string) => {
    if (!iri.startsWith(game)) throw new UnresolvedError(iri);
    return iri.slice(game.length);
  };
  return {
    writes,
    source(iri: string) {
      const text = resources[named(iri)];
      if (text === undefined) throw new NotFoundError(`no ${iri}`);
      return Promise.resolve(new Representation(text, "text/html"));
    },
    sink(iri: string) {
      const name = named(iri);
      writes.push(name);
      if (name === "move:0:0") {
        throw new InvalidArgumentError("x, y", "0,0 is taken — X played there");
      }
      return Promise.resolve(new Representation("O plays 1,0"));
    },
    entries(): Promise<SpaceEntry[]> {
      return Promise.resolve([
        { pattern: `${game}board`, endpoint: "ttt-board", origin: null },
        { pattern: "urn:iki:tutorial:ttt:board", endpoint: "b", origin: null },
      ]);
    },
  };
}

async function call(
  host: Host,
  method: string,
  path: string,
): Promise<[number, string, Headers]> {
  const response = await handler(host)(
    new Request(`http://app.test${path}`, { method }),
  );
  return [response.status, await response.text(), response.headers];
}

Deno.test("ttt app: the page fills template:game under a <base> at the game", async () => {
  const [code, body, headers] = await call(standIn(), "GET", "/game/a/");
  assertStrictEquals(code, 200);
  assert(body.includes(`<base href="/game/a/">`));
  assert(body.includes(`<section aria-label="Game a"></section>`));
  assert(body.includes(`<li><a href="/game/a/">game a</a></li>`));
  assertStrictEquals(headers.get("content-security-policy"), PAGE_CSP);
});

Deno.test("ttt app: the views are filled from the host's raw resources", async () => {
  const host = standIn();
  const [code, board] = await call(
    host,
    "GET",
    "/game/a/iki/tutorial/ttt/view/board",
  );
  assertStrictEquals(code, 200);
  assertStrictEquals(board, `<t>X</t>|<o id="1-0"></o>`);
  const [, status] = await call(
    host,
    "GET",
    "/game/a/iki/tutorial/ttt/view/status",
  );
  assertStrictEquals(status, "O to play.");
});

Deno.test("ttt app: a play is a Sink through the host, a refusal is answered", async () => {
  const host = standIn();
  const played = await call(
    host,
    "POST",
    "/game/a/iki/tutorial/ttt/view/play/1/0",
  );
  assertEquals(played.slice(0, 2), [200, "O plays 1,0. O to play."]);
  const refused = await call(
    host,
    "POST",
    "/game/a/iki/tutorial/ttt/view/play/0/0",
  );
  assertEquals(refused.slice(0, 2), [
    200,
    "invalid argument `x, y`: 0,0 is taken — X played there. O to play.",
  ]);
  await call(host, "POST", "/game/a/iki/tutorial/ttt/view/reset");
  assertEquals(host.writes, ["move:1:0", "move:0:0", "reset"]);
});

Deno.test("ttt app: wrong verbs, bad coordinates and unknown games are refused", async () => {
  const host = standIn();
  const status = async (method: string, path: string) =>
    (await call(host, method, path))[0];
  assertStrictEquals(
    await status("GET", "/game/a/iki/tutorial/ttt/view/play/1/0"),
    405,
  );
  assertStrictEquals(
    await status("POST", "/game/a/iki/tutorial/ttt/view/board"),
    405,
  );
  assertStrictEquals(
    await status("POST", "/game/a/iki/tutorial/ttt/view/play/01/0"),
    400,
  );
  assertStrictEquals(
    await status("GET", "/game/zz/iki/tutorial/ttt/view/board"),
    404,
  );
  assertStrictEquals(
    await status("GET", "/game/a/iki/tutorial/ttt/board"),
    404,
  );
  assertStrictEquals(await status("GET", "/nothing"), 404);
  assertEquals(host.writes, []);
});

// ---------------------------------------------------------------------------
// The parity test: TypeScript's fill against Rust's, on a real ttt-host
// ---------------------------------------------------------------------------

/** The `ttt-host` binary, or null. */
function findTttHost(): string | null {
  const candidates = [
    Deno.env.get("TTT_HOST"),
    `${Deno.env.get("HOME")}/.local/ttt-host/bin/ttt-host`,
    ...(Deno.env.get("PATH") ?? "").split(":").filter((d) => d).map((d) =>
      `${d}/ttt-host`
    ),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

const TTT_HOST = findTttHost();

/** A port nothing is listening on, for the host's HTTP face. */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

Deno.test({
  name:
    "ttt app: parity — the TypeScript views are the Rust views, byte for byte",
  ignore: TTT_HOST === null,
  async fn() {
    // A short path: macOS caps a socket path at 104 bytes.
    const dir = Deno.makeTempDirSync({ prefix: "ttt-" });
    const socket = `${dir}/h.sock`;
    assert(new TextEncoder().encode(socket).length < 100, socket);
    const hostHttp = `http://127.0.0.1:${freePort()}`;
    const host = new Deno.Command(TTT_HOST!, {
      args: [
        "--socket",
        socket,
        "--http",
        hostHttp.slice("http://".length),
        "--game",
        "a",
        "--game",
        "b",
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        Deno.statSync(socket);
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error("ttt-host did not come up");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const client = await connect(socket);
    const app = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      handler(client),
    );
    const appUrl = `http://127.0.0.1:${app.addr.port}`;
    const get = async (base: string, path: string, method = "GET") => {
      const response = await fetch(`${base}${path}`, { method });
      const text = await response.text();
      assertStrictEquals(
        response.status,
        200,
        `${method} ${base}${path}: ${text}`,
      );
      return text;
    };
    const rust = async (game: string, name: string) =>
      (await client.source(`urn:game:${game}:iki:tutorial:ttt:${name}`)).text;
    const views = "iki/tutorial/ttt/view";
    const states: string[] = [];

    /** Game a's views, filled here, against the Rust views of game a — and of game b. */
    const same = async (state: string) => {
      states.push(state);
      const board = await get(appUrl, `/game/a/${views}/board`);
      const status = await get(appUrl, `/game/a/${views}/status`);
      assertStrictEquals(
        board,
        await rust("a", "view:board"),
        `board: ${state}`,
      );
      assertStrictEquals(
        status,
        await rust("a", "view:status"),
        `status: ${state}`,
      );
      assertStrictEquals(
        board,
        await rust("b", "view:board"),
        `a vs b: ${state}`,
      );
    };
    /** One play in both games: game a through the app, game b through the Rust view. */
    const play = async (x: number, y: number, expect: string) => {
      const ours = await get(appUrl, `/game/a/${views}/play/${x}/${y}`, "POST");
      const theirs = (await client.sink(
        `urn:game:b:iki:tutorial:ttt:view:play:${x}:${y}`,
      )).text;
      assertStrictEquals(ours, theirs, `reply to ${x},${y}`);
      assertStrictEquals(ours, expect);
      await same(`after ${x},${y}: ${expect}`);
    };
    const reset = async () => {
      const ours = await get(appUrl, `/game/a/${views}/reset`, "POST");
      const theirs =
        (await client.sink("urn:game:b:iki:tutorial:ttt:view:reset"))
          .text;
      assertStrictEquals(ours, theirs, "reply to a reset");
      assertStrictEquals(ours, "The board is clear. X to play.");
      await same("reset");
    };

    try {
      await same("empty");
      // A win for X down diagonal 1 (2,0 → 1,1 → 0,2), with refusals on the way.
      await play(1, 1, "X plays 1,1. O to play.");
      await play(0, 0, "O plays 0,0. X to play.");
      await play(
        1,
        1,
        "invalid argument `x, y`: 1,1 is taken — X played there. X to play.",
      );
      await play(
        3,
        1,
        "invalid argument `x, y`: 3,1 is off the board — no line passes " +
          "through it. X to play.",
      );
      await play(2, 0, "X plays 2,0. O to play.");
      await play(1, 0, "O plays 1,0. X to play.");
      await play(0, 2, "X plays 0,2. X has won.");
      await play(
        2,
        2,
        "invalid argument `x, y`: the game is over — X has won. X has won.",
      );
      await reset();
      // A draw:  X O X / X O O / O X X
      const draw: [number, number][] = [
        [0, 0],
        [1, 0],
        [2, 0],
        [1, 1],
        [0, 1],
        [2, 1],
        [1, 2],
        [0, 2],
      ];
      for (const [i, [x, y]] of draw.entries()) {
        const [mark, next] = i % 2 === 0 ? ["X", "O"] : ["O", "X"];
        await play(x, y, `${mark} plays ${x},${y}. ${next} to play.`);
      }
      await play(2, 2, "X plays 2,2. A draw.");
      await play(
        1,
        1,
        "invalid argument `x, y`: the game is over — a draw. A draw.",
      );
      // The root game (no game in the path) fills the same way.
      assertStrictEquals(
        await get(appUrl, `/${views}/board`),
        (await client.source("urn:iki:tutorial:ttt:view:board")).text,
      );
      // The page and its files are ttt-host's, byte for byte.
      for (
        const path of [
          "/",
          "/game/a/",
          "/game/b",
          "/static/htmx-2.0.4.min.js",
          "/static/ttt.css",
          "/static/host.css",
        ]
      ) {
        assertStrictEquals(
          await get(appUrl, path),
          await get(hostHttp, path),
          path,
        );
      }
      assertEquals(states.length, 1 + 8 + 1 + 10);
    } finally {
      client.close();
      await app.shutdown();
      host.kill("SIGTERM");
      await host.status;
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
