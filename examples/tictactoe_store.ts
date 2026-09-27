/**
 * The tic-tac-toe game's ATOM — the stored cell — served from Deno.
 *
 * The ikigai book's applied chapter (ikigai-tutorial,
 * `crates/tic-tac-toe`, `books/ikigai/src/applied/tic-tac-toe-*.md`) builds
 * tic-tac-toe as resources. Everything above the atom — the
 * platonic cell, lines, the board, the rules — stays in a Rust kernel; this
 * file is the one piece of state, and a host mounts it:
 *
 * ```sh
 * deno run -A examples/tictactoe_store.ts /tmp/ttt.sock
 * ikigai --override urn:iki:tutorial:ttt:stored:=/tmp/ttt.sock \
 *   -c 'sink urn:iki:tutorial:ttt:stored:1:1 X'
 * ```
 *
 * The contract, honored message for message against the Rust original
 * (`stored_cell`, `CellStore`, `coordinate`/`plain_integer` in
 * `crates/tic-tac-toe/src/lib.rs`):
 *
 * - **Family** `urn:iki:tutorial:ttt:stored:{x}:{y}`. `x`, `y` are any
 *   i64 in their ONE plain spelling — optional `-`, digits, no leading
 *   zeros, no `+`, no `-0`. Anything else is an `InvalidArgument` naming the
 *   variable: two spellings of one square would be two cache threads over
 *   one piece of state.
 * - **Source**: the mark played there, `text/plain`, **cacheable**;
 *   `NotFound("nothing has been played at x,y")` when nothing has been —
 *   the typed variant crosses the wire, and the host's platonic cell turns
 *   exactly that variant (and no other failure) into the empty cell.
 * - **Sink** `content`: the mark, trimmed; any non-empty mark is kept (X, O,
 *   a Connect-Four R — the atom does not know the rules); an empty one is an
 *   `InvalidArgument` on `content`. Answers `ok`.
 * - **Delete**: clears the square; idempotent; answers `ok`.
 *
 * Nothing here cuts or declares a golden thread: the HOST kernel hangs the
 * cached read from the thread named after the resource and cuts it after a
 * successful Sink or Delete to the same name through that kernel.
 *
 * ⚠ Mount it with `--override` (or an alias mount whose prefix is
 * `urn:iki:`). An alias mount on the family's own prefix, `--mount
 * urn:iki:tutorial:ttt:stored:=…`, would forward `urn:1:1`, which no
 * pattern here names.
 */

import { defaultSocketPath } from "../src/client.ts";
import { family, type HandlerArgs, Server } from "../src/serve.ts";
import { InvalidArgumentError, NotFoundError } from "../src/wire.ts";

/** The stored cell: what has been played at `(x, y)`. */
export const STORED = "urn:iki:tutorial:ttt:stored:{x}:{y}";

/** The stored cell's name at `(x, y)`, spelled the one way it accepts. */
export function storedName(x: number | bigint, y: number | bigint): string {
  return `urn:iki:tutorial:ttt:stored:${x}:${y}`;
}

const TEXT_PLAIN_UTF8 = "text/plain;charset=utf-8";
const XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const PLAIN = /^-?(0|[1-9][0-9]*)$/;

/**
 * `text` as an integer, if it is spelled the one way that integer is
 * spelled — Rust's `text.parse::<i64>()` round-tripped through
 * `to_string()`, so the same i64 range and the same refusal text.
 */
export function plainInteger(name: string, text: string): bigint {
  if (PLAIN.test(text) && text !== "-0") {
    const value = BigInt(text);
    if (value >= I64_MIN && value <= I64_MAX) return value;
  }
  throw new InvalidArgumentError(
    name,
    `\`${text}\` is not an integer in its plain form (e.g. 0, 2, -1)`,
  );
}

/** A coordinate, captured from the name by the template. */
function coordinate(args: HandlerArgs, name: string): bigint {
  // A binding is always a string (it came out of the IRI); the check is
  // for the type system, and would be a peer bug if it ever fired.
  const text = args[name];
  if (typeof text !== "string") {
    throw new InvalidArgumentError(name, "not valid UTF-8");
  }
  return plainInteger(name, text);
}

/**
 * The marks that have been played, and how often the stored cell has been
 * READ — the counter is what lets a test prove a cached answer was served
 * by the host with no code running here.
 */
export class CellStore {
  readonly marks = new Map<string, string>();
  /** How many times the stored cell's Source has actually run. */
  reads = 0;
}

const coordinates = {
  x: { summary: "the column — any integer", class: XSD_INTEGER },
  y: { summary: "the row — any integer", class: XSD_INTEGER },
};

/** `ttt-stored`: the mark at `(x, y)`, held in memory. */
export function storedCell(store: CellStore) {
  const at = (args: HandlerArgs): string =>
    `${coordinate(args, "x")},${coordinate(args, "y")}`;
  return family(STORED, {
    id: "ttt-stored",
    title: "Stored cell",
    summary:
      "What has been played at (x, y): read it, play a mark, or clear it.",
    bindings: coordinates,
  })
    .source({
      summary: "the mark played at (x, y); NotFound if none has been",
      output: TEXT_PLAIN_UTF8,
      cacheable: true,
    }, (args) => {
      const square = at(args);
      store.reads += 1;
      const mark = store.marks.get(square);
      if (mark === undefined) {
        throw new NotFoundError(`nothing has been played at ${square}`);
      }
      return mark;
    })
    .sink({
      summary: "play a mark at (x, y)",
      args: [{
        name: "content",
        summary: "the mark to play, e.g. X or O",
        class: XSD_STRING,
      }],
      output: TEXT_PLAIN_UTF8,
    }, (args) => {
      const square = at(args);
      const content = args["content"];
      if (typeof content !== "string") {
        throw new InvalidArgumentError("content", "not valid UTF-8");
      }
      const mark = content.trim();
      if (mark === "") {
        throw new InvalidArgumentError(
          "content",
          "an empty mark — to clear a cell, delete it",
        );
      }
      store.marks.set(square, mark);
      return "ok";
    })
    .delete({
      summary: "clear the cell at (x, y)",
      output: TEXT_PLAIN_UTF8,
    }, (args) => {
      store.marks.delete(at(args));
      return "ok";
    });
}

if (import.meta.main) {
  const path = Deno.args[0] ??
    defaultSocketPath().replace(/kernel\.sock$/, "ttt-store.sock");
  const store = new CellStore();
  const server = new Server([storedCell(store)], path);
  console.error(`examples/tictactoe_store.ts: serving ${STORED} on ${path}`);
  console.error(
    `mount it:  ikigai --override urn:iki:tutorial:ttt:stored:=${path} ` +
      `-c 'sink ${storedName(1, 1)} X'`,
  );
  Deno.addSignalListener("SIGINT", () => {
    server.shutdown();
  });
  await server.serve();
}
