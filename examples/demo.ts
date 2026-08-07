/**
 * The money demo: two TypeScript functions served as ikigai resources.
 *
 * Terminal A:
 *
 * ```sh
 * deno run -A examples/demo.ts [socket-path] [--verbatim]
 * ```
 *
 * `--verbatim` changes the LEGACY default to unstripped entry patterns
 * (`urn:ts:hello` as-is) — only <= v5 clients need it; a v6 host's hello
 * says which form it wants, per connection.
 *
 * Terminal B:
 *
 * ```sh
 * ikigai --mount urn:ts:=<socket-path> -c 'source urn:ts:hello who=Ada'
 * # Hello, Ada!
 * ikigai --mount urn:ts:=<socket-path> -c list
 * # …urn:ts:hello  → hello   [<socket-path>]
 * ```
 */

import { defaultSocketPath } from "../src/client.ts";
import { endpoint, Server } from "../src/serve.ts";

const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

export const hello = endpoint("urn:ts:hello", {
  summary: "Greet someone",
  args: [{
    name: "who",
    required: true,
    summary: "the name to greet",
    class: XSD_STRING,
  }],
}, ({ who }) => `Hello, ${who}!`);

export const shout = endpoint("urn:ts:shout", {
  summary: "Uppercase a string, loudly",
  args: [{
    name: "in",
    required: true,
    summary: "the text to shout",
    class: XSD_STRING,
  }],
  cacheable: true, // a pure function of its input — the host kernel may cache
}, (args) => `${String(args["in"]).toUpperCase()}!`);

if (import.meta.main) {
  const stripAlias = !Deno.args.includes("--verbatim");
  const rest = Deno.args.filter((a) => a !== "--verbatim");
  const path = rest[0] ??
    defaultSocketPath().replace(/kernel\.sock$/, "ts.sock");
  console.error(
    `ikigai-deno demo: serving urn:ts:hello, urn:ts:shout on ${path}`,
  );
  const mountFlag = stripAlias ? "--mount" : "--prefer";
  console.error(
    `try:  ikigai ${mountFlag} urn:ts:=${path} -c 'source urn:ts:hello who=Ada'`,
  );
  const server = new Server([hello, shout], path, { stripAlias });
  Deno.addSignalListener("SIGINT", () => {
    server.shutdown();
  });
  await server.serve();
}
