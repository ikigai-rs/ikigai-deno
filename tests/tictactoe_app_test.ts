/**
 * The tic-tac-toe app (`examples/tictactoe_app.ts`): its template-language
 * filler (the tutorial README's cases, copied), its path rule and its routes
 * against a stand-in host — and then THE PARITY TEST, against a real
 * `ttt-host`: for a sequence of states (empty, moves, a win, a draw,
 * refusals, a hostile mark), the bytes the app composes in TypeScript equal
 * the bytes the Rust views compose for the same game, fetched over IPC. If
 * they differ, the TypeScript filler is wrong, not the template.
 *
 * The host half skips when no `ttt-host` binary is found (CI has no Rust
 * host): `$TTT_HOST`, then `~/.local/ttt-host/bin/ttt-host`, then `PATH`.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { connect } from "../src/client.ts";
import {
  ConflictError,
  EndpointError,
  InvalidArgumentError,
  MissingArgumentError,
  NotFoundError,
  Representation,
  type SpaceEntry,
  UnresolvedError,
} from "../src/wire.ts";
import {
  type Args,
  compose,
  escapeHtml,
  Game,
  handler,
  type Host,
  isIri,
  PAGE_CSP,
  parseArgs,
  PathError,
  pathSegments,
  type Resolve,
  type Route,
  route,
  rustDisplay,
  trim,
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
      "f93bde4b6dacb82b085d88c8cf33c899eb3dd435dd64acd5e1e19c63be04f09b",
    "host.css":
      "79437443cd22e56d183ebf5b4a6de625e72354d38e8a39e54894bf0dc19f27ac",
  };
  for (const [file, digest] of Object.entries(expected)) {
    const bytes = await Deno.readFile(new URL(file, STATIC_DIR));
    assertStrictEquals(await sha256(bytes), digest, file);
  }
});

// ---------------------------------------------------------------------------
// The template language
// ---------------------------------------------------------------------------

/**
 * The README's world for its `template-cases` block (ikigai-tutorial
 * `crates/tic-tac-toe/README.md`, "The template language", at `d995d90`):
 * the resources the cases are filled over, two VIEWS bound as the game binds
 * its own (a template at a name, composed with only the arguments its name
 * captures and its marker passes — a captured one winning), and nothing else.
 */
const WORLD: Resolve = (iri, args) => {
  const fixed: Record<string, string> = {
    "urn:t:mark": `<b>"&'$a{urn:t:secret}`,
    "urn:t:html": "<i>ok</i>",
    "urn:t:dash": " -\n",
    "urn:t:on": " On\n",
    "urn:t:empty": "",
    "urn:t:inner": "[$h{{x}}]",
    "urn:t:note": "($h{{message}})",
  };
  const view = (template: string, captured: Args = {}) =>
    compose(fixed[template], { ...args, ...captured }, WORLD);
  const inner = /^urn:t:view:inner:(.+)$/.exec(iri);
  if (inner) return view("urn:t:inner", { x: inner[1] });
  if (iri === "urn:t:view:note") return view("urn:t:note");
  const cell = /^urn:t:cell:([^:]+):(.+)$/.exec(iri);
  if (cell) return Promise.resolve(`${cell[1]}.${cell[2]}`);
  if (iri in fixed) return Promise.resolve(fixed[iri]);
  return Promise.reject(new UnresolvedError(iri));
};

/**
 * A case as the README writes it, with each `\u{…}` the code point it names,
 * so a case can hold a character that does not show. No other `\` is special.
 */
function unescaped(text: string): string {
  return text.replace(/\\u\{([^}]*)\}/g, (_, hex: string) => {
    assert(/^[0-9A-Fa-f]+$/.test(hex), `hex digits: \\u{${hex}}`);
    return String.fromCodePoint(parseInt(hex, 16));
  });
}

/**
 * Whether a refusal is compose's OWN (`malformed`: the template itself is
 * refused, before anything at its level resolves) rather than a marker's
 * request or argument failing (`failed`) — in Rust, `Error::Endpoint` whose
 * message starts `compose:`.
 */
function malformed(e: unknown): boolean {
  return e instanceof EndpointError && e.constructor === EndpointError &&
    e.message.startsWith("compose:");
}

/** The README's arguments for every case. */
const CASE_ARGS = { x: "1", y: "-2", message: "it's <b>" };

Deno.test("ttt app: the template-language cases in the tutorial's README hold", async () => {
  // Copied verbatim from the README's block, and parsed as the tutorial's
  // `tests/templates.rs` parses it: a kind, then the template, then (always
  // for `fill`, optionally for `refuse`) a tab and what follows it — the
  // filled text, or the refusal's class — each with its `\u{…}` decoded.
  const block = await Deno.readTextFile(
    new URL("./ttt_template_cases.txt", import.meta.url),
  );
  const lines = block.split("\n").filter((line) => line !== "");
  assert(lines.length >= 38, `${lines.length} cases`);
  for (const line of lines) {
    const kind = ["fill", "refuse"].find((k) => line.startsWith(k));
    assert(kind !== undefined, `a case is fill or refuse: ${line}`);
    const rest = line.slice(kind.length).replace(/^\p{White_Space}+/u, "");
    const tab = rest.indexOf("\t");
    const [template, after] = tab < 0
      ? [unescaped(rest), null]
      : [unescaped(rest.slice(0, tab)), unescaped(rest.slice(tab + 1))];
    if (kind === "fill") {
      assert(after !== null, `a fill case has a tab: ${line}`);
      assertStrictEquals(
        await compose(template, CASE_ARGS, WORLD),
        after,
        template,
      );
      continue;
    }
    assert(
      after === null || after === "malformed" || after === "failed",
      `a refusal's class is malformed or failed: ${line}`,
    );
    const error = await compose(template, CASE_ARGS, WORLD).then(
      (filled) => {
        throw new Error(`should be refused: ${template} gave ${filled}`);
      },
      (e: unknown) => e,
    );
    assert(error instanceof EndpointError, `${template}: ${error}`);
    if (after !== null) {
      assertStrictEquals(
        malformed(error),
        after === "malformed",
        `${template}: ${after}, but ${error.constructor.name}: ${error.message}`,
      );
    }
  }
});

Deno.test("ttt app: trimmed is Unicode White_Space, as Rust's str::trim — measured", () => {
  // `char::is_whitespace`'s list (the White_Space property), from Rust's docs.
  const rust = new Set([
    ...[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680],
    ...Array.from({ length: 11 }, (_, n) => 0x2000 + n),
    ...[0x2028, 0x2029, 0x202f, 0x205f, 0x3000],
  ]);
  assertStrictEquals(rust.size, 25);
  const differ: string[] = [];
  const js: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    const text = `${c}a${c}`;
    if ((trim(text) === "a") !== rust.has(cp)) differ.push(cp.toString(16));
    if ((text.trim() === "a") !== rust.has(cp)) js.push(cp);
  }
  assertEquals(differ, []);
  // Why `.trim()` is not the filler's: it strips U+FEFF and keeps U+0085.
  assertEquals(js, [0x85, 0xfeff]);
});

Deno.test("ttt app: conditional without equals reads its test as a boolean", async () => {
  const values: Record<string, string> = {
    "urn:c": "",
    "urn:t": "[then]",
    "urn:e": "[else]",
  };
  const world: Resolve = (iri) => Promise.resolve(values[iri]);
  const cond = (rest = "&else=urn:e") =>
    `$a{urn:iki:fn:conditional?if=urn:c&then=urn:t${rest}}`;
  for (const yes of ["true", " TRUE\n", "1", "Yes", "\u3000on\u0085"]) {
    values["urn:c"] = yes;
    assertStrictEquals(await compose(cond(), {}, world), "[then]", yes);
  }
  for (const no of ["false", "0", "NO", "off", "", " \n"]) {
    values["urn:c"] = no;
    assertStrictEquals(await compose(cond(), {}, world), "[else]", no);
    assertStrictEquals(await compose(cond(""), {}, world), "", no);
  }
  // Not a boolean: refused, never a silent branch — and a U+FEFF is not
  // trimmed away.
  for (const bad of ["-", "X", "2", "truthy", "o n", "\ufeffon"]) {
    values["urn:c"] = bad;
    await assertRejects(
      () => compose(cond(), {}, world),
      EndpointError,
      "not a boolean",
    );
  }
});

Deno.test("ttt app: $h escapes exactly & < > \" ' — ' as &#39;", () => {
  assertStrictEquals(
    escapeHtml(`a&b<c>"d'e$`),
    "a&amp;b&lt;c&gt;&quot;d&#39;e$",
  );
});

Deno.test("ttt app: a marker's IRI takes its arguments percent-encoded, a value verbatim", async () => {
  const seen: [string, Args][] = [];
  const record: Resolve = (iri, args) => {
    seen.push([iri, args]);
    return Promise.resolve("");
  };
  await compose(
    `$r{urn:x:{v}?k={v}&q="{v}"&e= a b }`,
    { v: "a b/é:~" },
    record,
  );
  assertEquals(seen, [[
    "urn:x:a%20b%2F%C3%A9%3A~",
    { k: "a b/é:~", q: "{v}", e: "a b" },
  ]]);
});

Deno.test('ttt app: a quoted value keeps its & and }, and unescapes \\" and \\\\', async () => {
  const seen: Args[] = [];
  const record: Resolve = (_, args) => {
    seen.push(args);
    return Promise.resolve("");
  };
  assertStrictEquals(
    await compose(`<$r{urn:x?a="1&2}"&b="q\\"\\\\"}>`, {}, record),
    "<>",
  );
  assertEquals(seen, [{ a: "1&2}", b: `q"\\` }]);
});

Deno.test("ttt app: conditional sources only the branch it takes", async () => {
  const seen: string[] = [];
  const world: Resolve = (iri) => {
    seen.push(iri);
    return Promise.resolve(iri === "urn:c" ? " X\n" : `[${iri}]`);
  };
  const cond = (equals: string, rest = "&else=urn:e") =>
    `$a{urn:iki:fn:conditional?if=urn:c&equals=${equals}&then=urn:t${rest}}`;
  assertStrictEquals(await compose(cond("X"), {}, world), "[urn:t]");
  assertStrictEquals(await compose(cond("O"), {}, world), "[urn:e]");
  assertStrictEquals(await compose(cond("O", ""), {}, world), "");
  assertEquals(seen, ["urn:c", "urn:t", "urn:c", "urn:e", "urn:c"]);
  // `if` and `then` are required, whichever side would be taken — and
  // before anything is sourced.
  seen.length = 0;
  for (
    const missing of [
      "if=urn:c&equals=X",
      "if=urn:c&equals=O&else=urn:e",
      "then=urn:t&equals=X",
    ]
  ) {
    await assertRejects(
      () => compose(`$a{urn:iki:fn:conditional?${missing}}`, {}, world),
      MissingArgumentError,
    );
  }
  assertEquals(seen, []);
});

Deno.test("ttt app: a malformed marker fails the template before anything resolves", async () => {
  const seen: string[] = [];
  const world: Resolve = (iri) => {
    seen.push(iri);
    return Promise.resolve("");
  };
  for (
    const bad of [
      "$r{urn:ok}$h{}",
      "$r{urn:ok}$a{{x}}",
      "$r{urn:ok}$h{urn:a || urn:b}",
      "$r{urn:ok}$h{urn:{x y}}",
      "$r{urn:ok}$h{urn:a?k}",
      "$r{urn:ok}$h{urn:a?k={x}{}}",
    ]
  ) {
    await assertRejects(() => compose(bad, { x: "1" }, world), EndpointError);
  }
  assertEquals(seen, []);
  // A `||` inside a quoted value is a value, not a fallback.
  assertStrictEquals(await compose(`$r{urn:a?k="||"}`, {}, world), "");
});

Deno.test("ttt app: $a expands with the same arguments, and a value is never rescanned", async () => {
  const world: Resolve = (iri) =>
    Promise.resolve(
      iri === "urn:outer" ? "($a{urn:inner})" : "<$h{{x}}|$r{{x}}>",
    );
  assertStrictEquals(
    await compose("$a{urn:outer}", { x: `$a{urn:outer}&` }, world),
    "(<$a{urn:outer}&amp;|$a{urn:outer}&>)",
  );
  const loop: Resolve = () => Promise.resolve("$a{urn:loop}");
  await assertRejects(
    () => compose("$a{urn:loop}", {}, loop),
    EndpointError,
    "recursion limit (32)",
  );
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
  // Core's `Error::Conflict` Display (0.1.80), carried typed since wire v8.
  assertStrictEquals(
    rustDisplay(new ConflictError("square taken")),
    "conflict: square taken",
  );
  assertStrictEquals(
    rustDisplay(new UnresolvedError("urn:x")),
    "no endpoint resolved for urn:x",
  );
});

// ---------------------------------------------------------------------------
// The path <-> IRI rule (ttt-host's)
// ---------------------------------------------------------------------------

Deno.test("ttt app: the game is where the page is; a/b/c is urn:a:b:c", () => {
  const root: Route = {
    kind: "page",
    game: null,
    iri: "urn:ttt-host:page:root",
  };
  const a: Route = { kind: "page", game: "a", iri: "urn:ttt-host:page:game:a" };
  assertEquals(route("/"), root);
  assertEquals(route("//"), root);
  assertEquals(route("/game/a/"), a);
  assertEquals(route("/game/a"), a);
  assertEquals(route("/game/a//"), a);
  assertEquals(route("/iki/tutorial/ttt/view/board"), {
    kind: "view",
    game: null,
    view: "board",
    iri: "urn:iki:tutorial:ttt:view:board",
  });
  assertEquals(route("/game/ts/iki/tutorial/ttt//view/play/1/2/"), {
    kind: "view",
    game: "ts",
    view: { x: "1", y: "2" },
    iri: "urn:game:ts:iki:tutorial:ttt:view:play:1:2",
  });
  // y takes the rest of the name, as the host's template does.
  assertEquals(route("/game/a/iki/tutorial/ttt/view/play/1/2/3"), {
    kind: "view",
    game: "a",
    view: { x: "1", y: "2:3" },
    iri: "urn:game:a:iki:tutorial:ttt:view:play:1:2:3",
  });
  assertEquals(route("/static//ttt.css"), {
    kind: "static",
    path: "/static/ttt.css",
  });
  for (
    const other of [
      "/game",
      "/game/",
      "/game/a/iki/tutorial/ttt/board",
      "/game/a/iki/tutorial/ttt/view",
      "/game/a/iki/tutorial/ttt/view/nothing",
      "/game/a/iki/tutorial/ttt/view/play/1",
      "/game/a/iki/tutorial/ttt/stored/1/1",
      "/iki/tutorial/ttt/template/board",
      "/game/a/other/thing",
      "/static/nothing.css",
      "/favicon.ico",
    ]
  ) {
    assertEquals(route(other), { kind: "other" }, other);
  }
});

Deno.test("ttt app: a path is decoded as ttt-host's edge decodes it", () => {
  assertEquals(pathSegments("/game/a%41/"), ["game", "aA"]);
  assertEquals(pathSegments("//a%20b//"), ["a b"]);
  // Split first, then decode: an encoded slash is data inside its segment.
  assertEquals(pathSegments("/game/a%2Fb/x"), ["game", "a/b", "x"]);
  assertEquals(pathSegments("/a%25%2f"), ["a%/"]);
  // `+` is a literal `+` in a path; only a query is form-encoded.
  assertEquals(pathSegments("/play/+1/0"), ["play", "+1", "0"]);
  assertEquals(pathSegments("/caf%C3%A9"), ["caf\u00e9"]);
  for (const bad of ["/%zz/", "/game/a%4", "/a%", "/a%+1", "/a%4g"]) {
    assertThrows(
      () => pathSegments(bad),
      PathError,
      "malformed percent-escape",
    );
  }
  assertThrows(() => pathSegments("/%E9"), PathError, "not UTF-8 once decoded");
});

Deno.test("ttt app: a path that is not an IRI is refused before anything resolves", () => {
  for (const ok of ["game:a:iki:tutorial:ttt:view:board", "a_b", "caf\u00e9"]) {
    assert(isIri(ok), ok);
  }
  for (const bad of ["a b", "a<b", "a%zz", "a{b}", "a#b#c", "a\u0085b"]) {
    assert(!isIri(bad), bad);
  }
});

// ---------------------------------------------------------------------------
// The command line: ttt-host's spelling
// ---------------------------------------------------------------------------

Deno.test("ttt app: --socket and --http, as ttt-host spells them", () => {
  assertEquals(parseArgs([], "/tmp/"), {
    socket: "/tmp/ttt-host.sock",
    http: { hostname: "127.0.0.1", port: 8071 },
  });
  assertEquals(
    parseArgs(["--http", "[::1]:9000", "--socket", "/tmp/s.sock"]),
    { socket: "/tmp/s.sock", http: { hostname: "::1", port: 9000 } },
  );
  const refusal = (args: string[]) => {
    try {
      parseArgs(args);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`${args.join(" ")} was accepted`);
  };
  // The old flags are refused by name, pointing at the new one.
  for (const old of ["--port", "--host"]) {
    const message = refusal([old, "8071"]);
    assert(message.startsWith(`${old} is not a flag any more`), message);
    assert(message.includes("--http <addr>"), message);
  }
  assert(refusal(["--http", "8071"]).startsWith("--http 8071: not an address"));
  assert(refusal(["--http", "h:70000"]).startsWith("--http h:70000"));
  assert(refusal(["--socket"]).startsWith("--socket needs a value"));
  assert(refusal(["--listen", "x"]).startsWith("unknown argument `--listen`"));
});

// ---------------------------------------------------------------------------
// The routes, against a stand-in host (no Rust needed)
// ---------------------------------------------------------------------------

/** The name a stand-in template spells, for the root game (as the real ones are). */
const T = "urn:iki:tutorial:ttt:";

/**
 * A host with one game, `a`, whose templates are small stand-ins in the
 * template language, with the real templates' shape: a board of square
 * views, each choosing its template by a `conditional` over its cell.
 */
function standIn(): Host & { writes: string[]; reads: string[] } {
  const choose = (test: string, then: string, otherwise: string) =>
    `$a{urn:iki:fn:conditional?if=${T}${test}&equals=-&then=${T}template:${then}&else=${T}template:${otherwise}}`;
  const resources: Record<string, string> = {
    "template:game": `<section aria-label="Game $h{{game}}"></section>`,
    "template:board":
      `$r{${T}view:square:0:0}|$r{${T}view:square:1:0}|$r{${T}view:square:0:0}`,
    "template:square": choose("cell:{x}:{y}", "square-open", "square-taken"),
    "template:square-open": `<o id="$h{{x}}-$h{{y}}"></o>`,
    "template:square-taken": `<t>$h{${T}cell:{x}:{y}}</t>`,
    "template:status": choose("winner", "status-turn", "status-won"),
    "template:status-turn": `$h{${T}turn} to play.`,
    "template:status-won": `$h{${T}winner} has won.`,
    "template:reply": `$h{{message}}. $r{${T}view:status}`,
    "winner": "-",
    "turn": "O",
    "cell:0:0": "X",
    "cell:1:0": "-",
  };
  const writes: string[] = [];
  const reads: string[] = [];
  const game = "urn:game:a:iki:tutorial:ttt:";
  const named = (iri: string) => {
    if (!iri.startsWith(game)) throw new UnresolvedError(iri);
    return iri.slice(game.length);
  };
  return {
    writes,
    reads,
    source(iri: string) {
      const name = named(iri);
      reads.push(name);
      const text = resources[name];
      if (text === undefined) throw new NotFoundError(`no ${iri}`);
      return Promise.resolve(new Representation(text, "text/html"));
    },
    sink(iri: string, value?: string | Uint8Array) {
      const name = named(iri);
      writes.push(name);
      if (name.startsWith("stored:")) {
        resources[`cell:${name.slice("stored:".length)}`] = String(value);
        return Promise.resolve(new Representation("ok"));
      }
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

Deno.test("ttt app: the page composes view:game under a <base> at the game", async () => {
  const [code, body, headers] = await call(standIn(), "GET", "/game/a/");
  assertStrictEquals(code, 200);
  assert(body.includes(`<base href="/game/a/">`));
  assert(body.includes(`<section aria-label="Game a"></section>`));
  assert(body.includes(`<li><a href="/game/a/">game a</a></li>`));
  assertStrictEquals(headers.get("content-security-policy"), PAGE_CSP);
});

Deno.test("ttt app: the views are composed here from the host's raw resources", async () => {
  const host = standIn();
  const [code, board] = await call(
    host,
    "GET",
    "/game/a/iki/tutorial/ttt/view/board",
  );
  assertStrictEquals(code, 200);
  assertStrictEquals(board, `<t>X</t>|<o id="1-0"></o>|<t>X</t>`);
  // Only the branch each conditional takes is read: no square-open for 0,0,
  // no square-taken for 1,0, and never the status templates.
  const templates = host.reads.filter((r) => r.startsWith("template:"));
  assertEquals(templates, [
    "template:board",
    "template:square",
    "template:square",
    "template:square",
    "template:square-taken",
    "template:square-open",
    "template:square-taken",
  ]);
  const [, status] = await call(
    host,
    "GET",
    "/game/a/iki/tutorial/ttt/view/status",
  );
  assertStrictEquals(status, "O to play.");
});

Deno.test("ttt app: / reads the root game's plain names, /game/root/ its gateway names", async () => {
  // Every name any request reads, answered for EITHER spelling of the root
  // game: which spelling a page reads is the whole point.
  const reads: string[] = [];
  const host: Host = {
    source(iri: string) {
      reads.push(iri);
      const name = iri.replace(/^urn:(?:game:root:)?iki:tutorial:ttt:/, "");
      const text = name === "template:status" ? "$h{" + T + "turn}" : "X";
      return Promise.resolve(new Representation(text, "text/html"));
    },
    sink: () => Promise.reject(new Error("no writes here")),
    entries: () => Promise.resolve([]),
  };
  assertStrictEquals(new Game(host, null).iri("turn"), `${T}turn`);
  assertStrictEquals(
    new Game(host, "root").iri("turn"),
    "urn:game:root:iki:tutorial:ttt:turn",
  );
  for (
    const [path, prefix] of [
      ["/iki/tutorial/ttt/view/status", T],
      [
        "/game/root/iki/tutorial/ttt/view/status",
        "urn:game:root:" + T.slice(4),
      ],
    ]
  ) {
    reads.length = 0;
    assertEquals((await call(host, "GET", path)).slice(0, 2), [200, "X"]);
    assertEquals(reads, [`${prefix}template:status`, `${prefix}turn`], path);
  }
});

Deno.test("ttt app: a hostile mark is escaped, and its marker is never expanded", async () => {
  const host = standIn();
  const hostile = `<b>"&'$a{${T}template:game}`;
  await host.sink("urn:game:a:iki:tutorial:ttt:stored:0:0", hostile);
  host.reads.length = 0;
  const [, board] = await call(
    host,
    "GET",
    "/game/a/iki/tutorial/ttt/view/board",
  );
  const escaped = `&lt;b&gt;&quot;&amp;&#39;$a{${T}template:game}`;
  assertStrictEquals(
    board,
    `<t>${escaped}</t>|<o id="1-0"></o>|<t>${escaped}</t>`,
  );
  assert(!host.reads.includes("template:game"), host.reads.join(" "));
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

Deno.test("ttt app: a Conflict from the host answers 409 in core's Display", async () => {
  // Wire v8: a host whose state refuses a read crosses a typed Conflict,
  // which ikigai-web's error_resp answers 409 — permanent, never a 503.
  const host = standIn();
  const source = host.source;
  host.source = (iri: string) =>
    iri.endsWith(":turn")
      ? Promise.reject(new ConflictError("the game is being reset"))
      : source(iri);
  const [code, body] = await call(
    host,
    "GET",
    "/game/a/iki/tutorial/ttt/view/status",
  );
  assertEquals([code, body], [409, "conflict: the game is being reset"]);
});

Deno.test("ttt app: wrong verbs, bad coordinates and unknown games are refused", async () => {
  const host = standIn();
  const view = "iki/tutorial/ttt/view";
  const cases: [string, string, number, string][] = [
    ["GET", `/game/a/${view}/play/1/0`, 405, "method not allowed"],
    ["HEAD", `/game/a/${view}/play/1/0`, 405, ""],
    ["DELETE", `/game/a/${view}/reset`, 405, "method not allowed"],
    ["POST", `/game/a/${view}/board`, 405, "method not allowed"],
    ["POST", "/game/a/", 405, "method not allowed"],
    ["FOO", `/game/a/${view}/board`, 405, "method not allowed"],
    ["OPTIONS", `/game/a/${view}/board`, 204, ""],
    [
      "PATCH",
      `/game/a/${view}/reset`,
      415,
      "no patch strategy for this Content-Type",
    ],
    [
      "POST",
      `/game/a/${view}/play/01/0`,
      400,
      "invalid argument `x`: `01` is not an integer in its plain form (e.g. 0, 2, -1)",
    ],
    [
      "POST",
      `/game/a/${view}/play/+1/0`,
      400,
      "invalid argument `x`: `+1` is not an integer in its plain form (e.g. 0, 2, -1)",
    ],
    ["POST", `/game/a/${view}/play/%+1/0`, 400, "malformed percent-escape"],
    ["GET", "/game/%E9/", 400, "not UTF-8 once decoded"],
    [
      "GET",
      `/game/zz/${view}/board`,
      404,
      "no endpoint resolved for urn:game:zz:iki:tutorial:ttt:view:board",
    ],
    // An unknown game declares nothing, so it has no 405 and no coordinate check.
    [
      "GET",
      `/game/zz/${view}/play/01/0`,
      404,
      "no endpoint resolved for urn:game:zz:iki:tutorial:ttt:view:play:01:0",
    ],
    [
      "GET",
      "/game/zz",
      404,
      "no endpoint resolved for urn:ttt-host:page:game:zz",
    ],
    ["GET", "/game/a b/", 400, "not a resource path"],
    ["GET", "/game/a/iki/tutorial/ttt/board", 404, "not found"],
    ["GET", "/game/a/stored/1/1", 404, "not found"],
    ["GET", "/nothing", 404, "not found"],
  ];
  for (const [method, path, code, body] of cases) {
    assertEquals(
      (await call(host, method, path)).slice(0, 2),
      [code, body],
      `${method} ${path}`,
    );
  }
  const [, , headers] = await call(host, "GET", `/game/a/${view}/play/1/0`);
  assertStrictEquals(headers.get("allow"), "POST, PUT, PATCH, OPTIONS");
  const [, , options] = await call(host, "OPTIONS", "/game/a/");
  assertStrictEquals(options.get("allow"), "GET, HEAD, OPTIONS");
  assertEquals(host.writes, []);
});

// ---------------------------------------------------------------------------
// The parity test: TypeScript's fill against Rust's, on a real ttt-host
// ---------------------------------------------------------------------------

const VIEWS = "iki/tutorial/ttt/view";

/**
 * The edge cases the parity test asks both faces, measured on `ttt-host`
 * (tutorial `31daf4e`; `/game/root/` since `89677bc`). None of them moves a game: they run once game `a` is
 * over, so a play is refused, and no reset is among them.
 */
const EDGES: [string, string][] = [
  // The page, with and without the trailing slash; an unknown game; a path
  // that is not an IRI; every method.
  ["GET", "/game/a"],
  ["GET", "/game/a//"],
  ["GET", "/game/zz"],
  ["GET", "/game/zz/"],
  ["GET", "/game/a_b/"],
  ["GET", "/game/a%41/"],
  ["GET", "/game/a%20b/"],
  ["GET", "/game/a%4"],
  ["GET", "/game/a%+1/"],
  ["GET", "/game/%E9/"],
  ["GET", "/game/caf%C3%A9/"],
  ["GET", "/game/a%2Fb/"],
  ["HEAD", "/game/a/"],
  ["HEAD", "/game/zz/"],
  ["POST", "/"],
  ["POST", "/game/a/"],
  ["POST", "/game/zz/"],
  ["PUT", "/game/a/"],
  ["DELETE", "/game/a"],
  ["PATCH", "/game/a/"],
  ["PATCH", "/game/zz/"],
  ["OPTIONS", "/"],
  ["OPTIONS", "/game/a/"],
  ["OPTIONS", "/game/zz/"],
  ["FOO", "/game/a/"],
  // The root game's gateway spelling is a page and a game like any other.
  ["GET", "/game/root/"],
  ["GET", "/game/root"],
  ["GET", `/game/root/${VIEWS}/status`],
  ["POST", `/game/root/${VIEWS}/play/01/0`],
  ["GET", `/game/root/${VIEWS}/play/1/1`],
  // A play: a coordinate not in its plain form, and each method.
  ["POST", `/game/a/${VIEWS}/play/01/0`],
  ["POST", `/game/a/${VIEWS}/play/-0/0`],
  ["POST", `/game/a/${VIEWS}/play/+1/0`],
  ["POST", `/game/a/${VIEWS}/play/x/0`],
  ["POST", `/game/a/${VIEWS}/play/1.0/0`],
  ["POST", `/game/a/${VIEWS}/play/0/01`],
  ["POST", `/game/a/${VIEWS}/play/99999999999999999999/0`],
  ["POST", `/game/a/${VIEWS}/play/1/2/3`],
  ["POST", `/game/a/${VIEWS}/play/a%20b/0`],
  ["POST", `/game/a/${VIEWS}/play/1%2F1/0`],
  ["POST", `/game/a/${VIEWS}/play/1/0%3A1`],
  ["POST", `/game/a/${VIEWS}/play/3/1`],
  ["PUT", `/game/a/${VIEWS}/play/1/1`],
  ["POST", `/game/a/${VIEWS}/play/1/1/`],
  ["GET", `/game/a/${VIEWS}/play/1/1`],
  ["HEAD", `/game/a/${VIEWS}/play/1/1`],
  ["DELETE", `/game/a/${VIEWS}/play/1/1`],
  ["PATCH", `/game/a/${VIEWS}/play/1/1`],
  ["OPTIONS", `/game/a/${VIEWS}/play/1/1`],
  ["GET", `/game/a/${VIEWS}/reset`],
  ["DELETE", `/game/a/${VIEWS}/reset`],
  ["PATCH", `/game/a/${VIEWS}/reset`],
  ["POST", `/${VIEWS}/play/01/0`],
  // A read view: each method, and the path's spellings.
  ["POST", `/game/a/${VIEWS}/board`],
  ["PUT", `/game/a/${VIEWS}/board`],
  ["DELETE", `/game/a/${VIEWS}/status`],
  ["PATCH", `/game/a/${VIEWS}/status`],
  ["HEAD", `/game/a/${VIEWS}/board`],
  ["OPTIONS", `/game/a/${VIEWS}/board`],
  ["FOO", `/game/a/${VIEWS}/board`],
  ["GET", `/game/a/${VIEWS}/board/`],
  ["GET", `/game/a/iki/tutorial/ttt//view//status`],
  ["GET", `/${VIEWS}/status`],
  // A game the host does not serve: no 405 and no coordinate check, a 404.
  ["GET", `/game/zz/${VIEWS}/board`],
  ["GET", `/game/zz/${VIEWS}/play/1/1`],
  ["POST", `/game/zz/${VIEWS}/play/1/1`],
  ["POST", `/game/zz/${VIEWS}/play/01/0`],
  ["POST", `/game/zz/${VIEWS}/reset`],
  ["PATCH", `/game/zz/${VIEWS}/reset`],
  ["OPTIONS", `/game/zz/${VIEWS}/board`],
  ["FOO", `/game/zz/${VIEWS}/board`],
  // The files the page loads.
  ["GET", "/static//ttt.css"],
  ["HEAD", "/static/host.css"],
  ["POST", "/static/ttt.css"],
];

/** Paths the host serves that are not views: the app answers `404 not found`. */
const NOT_VIEWS = [
  "/game/a/iki/tutorial/ttt/board",
  "/game/a/iki/tutorial/ttt/cell/1/1",
  "/game/a/iki/tutorial/ttt/winner",
  "/game/a/iki/tutorial/ttt/template/board",
  "/iki/tutorial/ttt/turn",
  "/iki/tutorial/ttt/stored/1/1",
  "/game/a/iki/tutorial/ttt/view/nothing",
  "/game/a/iki/tutorial/ttt/view/play/1",
  "/static/nothing.css",
  "/static%2Fttt.css",
  // A `/` inside a segment is data: `a/iki` is no game, and what follows no view.
  "/game/a%2Fiki/tutorial/ttt/view/board",
  "/static/x%2Fttt.css",
  "/favicon.ico",
  "/game",
];

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
      // The edges, with game a over (so every play is refused and nothing
      // moves): the app answers what the host answers, status and body.
      const answer = async (base: string, method: string, path: string) => {
        const response = await fetch(`${base}${path}`, { method });
        return {
          status: response.status,
          body: await response.text(),
          type: response.headers.get("content-type"),
          allow: response.headers.get("allow"),
        };
      };
      for (const [method, path] of EDGES) {
        assertEquals(
          await answer(appUrl, method, path),
          await answer(hostHttp, method, path),
          `${method} ${path}`,
        );
      }
      // Not views: the host serves them, the app does not proxy them.
      for (const path of NOT_VIEWS) {
        const ours = await answer(appUrl, "GET", path);
        assertEquals([ours.status, ours.body], [404, "not found"], path);
      }
      // The root game (no game in the path) fills the same way.
      assertStrictEquals(
        await get(appUrl, `/${views}/board`),
        (await client.source("urn:iki:tutorial:ttt:view:board")).text,
      );
      // A hostile mark, written to the root game's store THROUGH the host (the
      // IPC face serves `stored:`), so the host cuts what reads it: escaped
      // by `$h` in both faces, and its marker never expanded.
      const hostile = `<b>"&'$a{urn:iki:tutorial:ttt:template:game}`;
      await client.sink("urn:iki:tutorial:ttt:stored:1:1", hostile);
      const escaped =
        "&lt;b&gt;&quot;&amp;&#39;$a{urn:iki:tutorial:ttt:template:game}";
      for (const path of [`/${views}/board`, `/game/root/${views}/board`]) {
        const board = await get(appUrl, path);
        assertStrictEquals(
          board,
          (await client.source("urn:iki:tutorial:ttt:view:board")).text,
          `hostile: ${path}`,
        );
        assert(board.includes(`>${escaped}</button>`), board);
        assert(!board.includes("ttt-game"), board);
      }
      for (const path of [`/${views}/status`, `/game/root/${views}/status`]) {
        assertStrictEquals(
          await get(appUrl, path),
          (await client.source("urn:iki:tutorial:ttt:view:status")).text,
          `hostile: ${path}`,
        );
      }
      // The page and its files are ttt-host's, byte for byte.
      for (
        const path of [
          "/",
          "/game/a/",
          "/game/b",
          "/game/root/",
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
