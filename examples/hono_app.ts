/**
 * Hono face: typed routes over the ikigai wire client.
 *
 * The pattern to notice: the validator middleware IS the input contract —
 * `c.req.valid("query")` is typed by what the validator returned, and a
 * missing `text` is a 400 from the framework before the handler runs (the
 * closest Deno analog to an ikigai ArgSpec). The handler body is then one
 * line of HTTP-independent resolution: `kernel.source(...)`.
 *
 * Run (direct, no Rust needed):
 *
 * ```sh
 * deno run -A examples/endpoints.ts /tmp/ts-examples.sock &
 * IKIGAI_SOCKET=/tmp/ts-examples.sock deno run -A examples/hono_app.ts
 * ```
 *
 * Or through a Rust kernel (see examples/README.md) — the `X-Ikigai-Cache`
 * response header then reports the kernel cache's answer (HIT on repeats).
 */

import { Hono } from "@hono/hono";
import { validator } from "@hono/hono/validator";
import {
  type Client,
  connect,
  ConnectionLost,
  defaultSocketPath,
  EndpointError,
  type Representation,
} from "../src/mod.ts";
import { cacheStatusName } from "./support.ts";

export function socketPath(): string {
  return Deno.env.get("IKIGAI_SOCKET") ?? defaultSocketPath();
}

/** A representation IS a response: bytes + media type + cache verdict. */
function reply(rep: Representation): Response {
  // The copy is a type workaround: `Representation.data` is typed
  // `Uint8Array<ArrayBufferLike>`, which TS 6 no longer accepts as BodyInit.
  return new Response(new Uint8Array(rep.data), {
    headers: {
      "Content-Type": rep.mediaType,
      "X-Ikigai-Cache": cacheStatusName(rep),
    },
  });
}

/**
 * The framework's face of a required ArgSpec: the validator rejects the
 * request (400) before the handler runs, and types `c.req.valid("query")`.
 */
const requiredText = validator("query", (value, c) => {
  const text = value["text"];
  if (typeof text !== "string") {
    return c.text("missing required query parameter `text`", 400);
  }
  return { text };
});

/**
 * One wire connection for the app's lifetime (never connect per request).
 * A single Client serializes concurrent round trips internally — fine at
 * example scale.
 */
export async function createApp(
  path: string = socketPath(),
): Promise<{ app: Hono; kernel: Client }> {
  const kernel = await connect(path);
  const app = new Hono();

  app.get(
    "/hello/:who",
    async (c) =>
      reply(await kernel.source("urn:ts:hello", { who: c.req.param("who") })),
  );
  app.get(
    "/upper",
    requiredText,
    async (c) =>
      reply(
        await kernel.source("urn:ts:upper", {
          text: c.req.valid("query").text,
        }),
      ),
  );
  app.get(
    "/reverse",
    requiredText,
    async (c) =>
      reply(
        await kernel.source("urn:ts:reverse", {
          text: c.req.valid("query").text,
        }),
      ),
  );

  // The kernel's catalog, as JSON: what this app could reach, discovered
  // from the running space rather than hard-coded.
  app.get("/catalog", async (c) => {
    const entries = await kernel.entries() ?? [];
    return c.json(
      entries.map((e) => ({
        pattern: e.pattern,
        endpoint: e.endpoint,
        origin: e.origin,
      })),
    );
  });

  app.onError((err, c) => {
    // The peer answered with an error: a bad gateway, carrying its message.
    if (err instanceof EndpointError) return c.text(err.message, 502);
    if (err instanceof ConnectionLost) {
      return c.text(`${err.message} — is the peer running?`, 503);
    }
    console.error(err);
    return c.text("internal error", 500);
  });

  return { app, kernel };
}

if (import.meta.main) {
  const { app } = await createApp();
  Deno.serve(app.fetch);
}
