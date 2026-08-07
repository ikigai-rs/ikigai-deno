/**
 * The endpoint set the example apps resolve: hello / upper / reverse.
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
  cacheable: true,
}, ({ who }) => `Hello, ${who}!`);

export const upper = endpoint("urn:ts:upper", {
  summary: "Uppercase a string",
  args: [{
    name: "text",
    required: true,
    summary: "the text to uppercase",
    class: XSD_STRING,
  }],
  cacheable: true,
}, ({ text }) => String(text).toUpperCase());

export const reverse = endpoint("urn:ts:reverse", {
  summary: "Reverse a string",
  args: [{
    name: "text",
    required: true,
    summary: "the text to reverse",
    class: XSD_STRING,
  }],
  // Reverse by code point, not UTF-16 unit — "ma\u{1F5A4}" survives the trip.
  cacheable: true,
}, ({ text }) => [...String(text)].reverse().join(""));

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
