/**
 * The endpoint set the example apps resolve: hello / upper / reverse.
 *
 * Declared in the zod style: the schema is the ONE statement of the input
 * contract — the ArgSpecs the host engine routes named arguments by derive
 * from it, the same schema validates every dispatch, and the handlers
 * receive TYPED strings (no `String(text)` coercion). Compare
 * `examples/demo.ts`, which declares explicit `args:` and stays
 * zero-dependency.
 *
 * All three are pure functions of their inputs, so they declare
 * `cacheable: true` — served directly that only marks the representation
 * (`Expiry::Never`); served through a Rust kernel mount the kernel actually
 * caches them, and the apps' `X-Ikigai-Cache` header flips to `HIT`.
 *
 * Serve them on a socket:
 *
 * ```sh
 * deno run -A examples/endpoints.ts [socket-path]
 * ```
 *
 * Then point any example app at that socket via `IKIGAI_SOCKET`.
 */

import { z } from "zod";
import { defaultSocketPath } from "../src/client.ts";
import { Server } from "../src/serve.ts";
import { endpoint } from "../src/zod.ts";

export const hello = endpoint("urn:ts:hello", {
  summary: "Greet someone",
  input: z.object({ who: z.string().describe("the name to greet") }),
  cacheable: true,
}, ({ who }) => `Hello, ${who}!`);

export const upper = endpoint("urn:ts:upper", {
  summary: "Uppercase a string",
  input: z.object({ text: z.string().describe("the text to uppercase") }),
  cacheable: true,
}, ({ text }) => text.toUpperCase());

export const reverse = endpoint("urn:ts:reverse", {
  summary: "Reverse a string",
  input: z.object({ text: z.string().describe("the text to reverse") }),
  // Reverse by code point, not UTF-16 unit — "ma\u{1F5A4}" survives the trip.
  cacheable: true,
}, ({ text }) => [...text].reverse().join(""));

export const ENDPOINTS = [hello, upper, reverse];

if (import.meta.main) {
  const path = Deno.args[0] ??
    defaultSocketPath().replace(/kernel\.sock$/, "ts-examples.sock");
  console.error(
    `examples/endpoints.ts: serving urn:ts:hello, urn:ts:upper, ` +
      `urn:ts:reverse on ${path}`,
  );
  console.error(`point an example app at it:  IKIGAI_SOCKET=${path}`);
  const server = new Server(ENDPOINTS, path);
  Deno.addSignalListener("SIGINT", () => {
    server.shutdown();
  });
  await server.serve();
}
