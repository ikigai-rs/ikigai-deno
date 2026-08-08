/**
 * Fresh face: server-driven HTML + htmx over the ikigai wire client.
 *
 * The pattern to notice: the hypermedia idiom (the house style of
 * ikigai-runbook). No JSON API, no client-side app — each form `hx-get`s a
 * route, the route resolves an ikigai resource, and the returned HTML
 * fragment swaps into the page. The catalog page is the same idea pointed at
 * `kernel.entries()`: the UI is *discovered* from the running space.
 *
 * Fresh is used in its programmatic ("code mode") shape: one file, `App`
 * routes + middleware, no scaffold, no build step, no islands. Markup is
 * functional `h(...)` calls (the FastHTML idiom) rendered server-side —
 * which also keeps JSX compiler options out of the repo config. htmx loads
 * from a CDN; without it the forms still work as plain GET forms, you just
 * see the fragment on its own page.
 *
 * Every result fragment shows the cache verdict — served direct it reads
 * MISS; served through a Rust kernel mount, repeats read HIT.
 *
 * Run (direct, no Rust needed):
 *
 * ```sh
 * deno run -A examples/endpoints.ts /tmp/ts-examples.sock &
 * IKIGAI_SOCKET=/tmp/ts-examples.sock deno run -A examples/fresh_app.ts
 * ```
 */

import { App, type FreshContext } from "@fresh/core";
import { h, type VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import {
  type Client,
  connect,
  ConnectionLost,
  defaultSocketPath,
  EndpointError,
  type Representation,
} from "../src/mod.ts";

const HTMX = "https://unpkg.com/htmx.org@2.0.6/dist/htmx.min.js";

export function socketPath(): string {
  return Deno.env.get("IKIGAI_SOCKET") ?? defaultSocketPath();
}

function html(vnode: VNode, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(renderToString(vnode), { ...init, headers });
}

/** A full document: head carries htmx, body carries the vnodes. */
function page(title: string, ...children: VNode[]): Response {
  const doc = h(
    "html",
    null,
    h(
      "head",
      null,
      h("meta", { charset: "utf-8" }),
      h("title", null, title),
      h("script", { src: HTMX }),
    ),
    h("body", null, h("h1", null, title), ...children),
  );
  return new Response("<!doctype html>" + renderToString(doc), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Resolve and render: one fragment shape for every endpoint. */
function fragment(rep: Representation): Response {
  const status = rep.cacheStatusName;
  return html(
    h("p", null, rep.text, " ", h("small", null, `[cache: ${status}]`)),
    { headers: { "X-Ikigai-Cache": status } },
  );
}

/** A form per endpoint: htmx GETs the route, the fragment swaps in. */
function demoForm(
  title: string,
  action: string,
  field: string,
  target: string,
): VNode {
  return h(
    "div",
    null,
    h("h2", null, title),
    h(
      "form",
      { action, "hx-get": action, "hx-target": `#${target}` },
      h("input", { name: field, placeholder: field, required: true }),
      h("button", null, "Resolve"),
    ),
    h("div", { id: target }),
  );
}

function requiredParam(ctx: FreshContext, name: string): string | null {
  return ctx.url.searchParams.get(name);
}

/**
 * One wire connection for the app's lifetime (never connect per request).
 * A single Client serializes concurrent round trips internally — fine at
 * example scale.
 */
type AppState = Record<string, unknown>;

export async function createApp(
  path: string = socketPath(),
): Promise<{ app: App<AppState>; kernel: Client }> {
  const kernel = await connect(path);
  const app = new App<AppState>();

  // Wire errors become gateway answers, as plain-text pages.
  app.use(async (ctx) => {
    try {
      return await ctx.next();
    } catch (e) {
      if (e instanceof EndpointError) {
        return new Response(e.message, { status: 502 });
      }
      if (e instanceof ConnectionLost) {
        return new Response(`${e.message} — is the peer running?`, {
          status: 503,
        });
      }
      throw e;
    }
  });

  app.get("/", () =>
    page(
      "ikigai examples",
      h(
        "p",
        null,
        "Each form resolves a ",
        h("code", null, "urn:ts:*"),
        " resource over the wire.",
      ),
      demoForm("hello", "/hello", "who", "hello-out"),
      demoForm("upper", "/upper", "text", "upper-out"),
      demoForm("reverse", "/reverse", "text", "reverse-out"),
      h("p", null, h("a", { href: "/catalog" }, "Browse the catalog")),
    ));

  app.get(
    "/hello/:who",
    async (ctx) =>
      fragment(await kernel.source("urn:ts:hello", { who: ctx.params.who })),
  );
  app.get("/hello", async (ctx) => {
    // The form's face: htmx sends the input as a query parameter.
    const who = requiredParam(ctx, "who");
    if (who === null) {
      return new Response("missing required query parameter `who`", {
        status: 400,
      });
    }
    return fragment(await kernel.source("urn:ts:hello", { who }));
  });
  for (const name of ["upper", "reverse"]) {
    app.get(`/${name}`, async (ctx) => {
      const text = requiredParam(ctx, "text");
      if (text === null) {
        return new Response("missing required query parameter `text`", {
          status: 400,
        });
      }
      return fragment(await kernel.source(`urn:ts:${name}`, { text }));
    });
  }

  app.get("/catalog", async () => {
    const entries = await kernel.entries();
    return page(
      "Catalog",
      h("p", null, "Every binding the connected space enumerates."),
      h(
        "table",
        null,
        h(
          "tr",
          null,
          h("th", null, "pattern"),
          h("th", null, "endpoint"),
          h("th", null, "origin"),
        ),
        ...entries.map((e) =>
          h(
            "tr",
            null,
            h("td", null, h("code", null, e.pattern)),
            h("td", null, e.endpoint),
            h("td", null, e.origin ?? "local"),
          )
        ),
      ),
      h("p", null, h("a", { href: "/" }, "Back")),
    );
  });

  return { app, kernel };
}

if (import.meta.main) {
  const { app } = await createApp();
  await app.listen({ port: 8000 });
}
