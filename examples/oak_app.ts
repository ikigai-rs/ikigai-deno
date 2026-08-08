/**
 * Oak face: middleware and a router, nothing else, over the ikigai wire
 * client.
 *
 * The pattern to notice: Oak adds almost nothing between HTTP and the wire —
 * a router entry per route, `searchParams` + `ctx.throw(400)` as the whole
 * input contract, and the handler body is one `kernel.source(...)`. Error
 * mapping is one middleware wrapping `next()` (wire errors become 502/503).
 *
 * Run (direct, no Rust needed):
 *
 * ```sh
 * deno run -A examples/endpoints.ts /tmp/ts-examples.sock &
 * IKIGAI_SOCKET=/tmp/ts-examples.sock deno run -A examples/oak_app.ts
 * ```
 *
 * Or through a Rust kernel (see examples/README.md) — the `X-Ikigai-Cache`
 * response header then reports the kernel cache's answer (HIT on repeats).
 */

import {
  Application,
  type Context,
  isHttpError,
  Router,
  Status,
} from "@oak/oak";
import {
  type Client,
  connect,
  ConnectionLost,
  defaultSocketPath,
  EndpointError,
  type Representation,
} from "../src/mod.ts";

export function socketPath(): string {
  return Deno.env.get("IKIGAI_SOCKET") ?? defaultSocketPath();
}

/** A representation IS a response: bytes + media type + cache verdict. */
function send(ctx: Context, rep: Representation): void {
  ctx.response.headers.set("Content-Type", rep.mediaType);
  ctx.response.headers.set("X-Ikigai-Cache", rep.cacheStatusName);
  ctx.response.body = rep.data;
}

/** The whole input contract: Oak 400s a missing query parameter. */
function requiredParam(ctx: Context, name: string): string {
  const value = ctx.request.url.searchParams.get(name);
  if (value === null) {
    ctx.throw(
      Status.BadRequest,
      `missing required query parameter \`${name}\``,
    );
  }
  return value;
}

/**
 * One wire connection for the app's lifetime (never connect per request).
 * A single Client serializes concurrent round trips internally — fine at
 * example scale.
 */
export async function createApp(
  path: string = socketPath(),
): Promise<{ app: Application; kernel: Client }> {
  const kernel = await connect(path);

  const router = new Router();
  router.get("/hello/:who", async (ctx) => {
    send(ctx, await kernel.source("urn:ts:hello", { who: ctx.params.who }));
  });
  router.get("/upper", async (ctx) => {
    const text = requiredParam(ctx, "text");
    send(ctx, await kernel.source("urn:ts:upper", { text }));
  });
  router.get("/reverse", async (ctx) => {
    const text = requiredParam(ctx, "text");
    send(ctx, await kernel.source("urn:ts:reverse", { text }));
  });
  // The kernel's catalog, as JSON: what this app could reach, discovered
  // from the running space rather than hard-coded.
  router.get("/catalog", async (ctx) => {
    const entries = await kernel.entries();
    ctx.response.body = entries.map((e) => ({
      pattern: e.pattern,
      endpoint: e.endpoint,
      origin: e.origin,
    }));
  });

  const app = new Application();
  // Wire errors become gateway answers; an `HttpError` from `ctx.throw`
  // keeps its own status (handling it here keeps Oak's default logger
  // quiet); anything else stays Oak's problem.
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (e) {
      if (e instanceof EndpointError) {
        ctx.response.status = 502;
        ctx.response.body = e.message;
      } else if (e instanceof ConnectionLost) {
        ctx.response.status = 503;
        ctx.response.body = `${e.message} — is the peer running?`;
      } else if (isHttpError(e)) {
        ctx.response.status = e.status;
        ctx.response.body = e.message;
      } else {
        throw e;
      }
    }
  });
  app.use(router.routes());
  app.use(router.allowedMethods());

  return { app, kernel };
}

if (import.meta.main) {
  const { app } = await createApp();
  console.error("oak_app: listening on http://localhost:8000");
  await app.listen({ port: 8000 });
}
