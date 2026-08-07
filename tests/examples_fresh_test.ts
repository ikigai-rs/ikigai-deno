/**
 * Smoke tests for the Fresh example: HTTP -> route -> wire -> served space,
 * pure Deno end to end (no Rust binary needed). Fresh's `app.handler()`
 * returns a fetch handler — no listener.
 */

import { assert, assertStrictEquals } from "@std/assert";
import { createApp } from "../examples/fresh_app.ts";
import { hello } from "../examples/endpoints.ts";
import { withApp } from "./examples_util.ts";

type Handler = (req: Request) => Promise<Response>;

async function makeApp(path: string) {
  const { app, kernel } = await createApp(path);
  return { handler: app.handler() as Handler, kernel };
}

function get(handler: Handler, path: string): Promise<Response> {
  return handler(new Request(`http://localhost${path}`));
}

Deno.test("fresh: the index page offers a form per endpoint", async () => {
  await withApp(makeApp, async ({ handler }) => {
    const res = await get(handler, "/");
    assertStrictEquals(res.status, 200);
    const body = await res.text();
    assert(body.includes("<!doctype html>"));
    for (const action of ["/hello", "/upper", "/reverse"]) {
      assert(body.includes(`hx-get="${action}"`), `no form for ${action}`);
    }
  });
});

Deno.test("fresh: a form route returns a fragment with the cache verdict", async () => {
  await withApp(makeApp, async ({ handler }) => {
    const res = await get(handler, "/upper?text=abc");
    assertStrictEquals(res.status, 200);
    // Direct to the peer there is no kernel cache upstream: MISS every time.
    assertStrictEquals(res.headers.get("x-ikigai-cache"), "MISS");
    const body = await res.text();
    assert(body.includes("ABC"));
    assert(body.includes("[cache: MISS]"));
  });
});

Deno.test("fresh: path and query faces of hello, and reverse", async () => {
  await withApp(makeApp, async ({ handler }) => {
    assert(
      (await (await get(handler, "/hello/Ada")).text()).includes("Hello, Ada!"),
    );
    assert(
      (await (await get(handler, "/hello?who=Ada")).text()).includes(
        "Hello, Ada!",
      ),
    );
    assert(
      (await (await get(handler, "/reverse?text=abc")).text()).includes("cba"),
    );
  });
});

Deno.test("fresh: peer output is HTML-escaped in fragments", async () => {
  await withApp(makeApp, async ({ handler }) => {
    const body = await (await get(handler, "/hello/%3Cscript%3E")).text();
    assert(!body.includes("<script>"));
    assert(body.includes("&lt;script"));
  });
});

Deno.test("fresh: a missing query parameter is a client error", async () => {
  await withApp(makeApp, async ({ handler }) => {
    const res = await get(handler, "/upper");
    assertStrictEquals(res.status, 400);
    await res.body?.cancel();
  });
});

Deno.test("fresh: the catalog page lists the space", async () => {
  await withApp(makeApp, async ({ handler }) => {
    const body = await (await get(handler, "/catalog")).text();
    for (const iri of ["urn:ts:hello", "urn:ts:upper", "urn:ts:reverse"]) {
      assert(body.includes(iri), `catalog is missing ${iri}`);
    }
  });
});

Deno.test("fresh: an endpoint error maps to 502", async () => {
  await withApp(makeApp, async ({ handler }) => {
    const res = await get(handler, "/upper?text=abc");
    assertStrictEquals(res.status, 502);
    assert(
      (await res.text()).includes("no endpoint resolved for urn:ts:upper"),
    );
  }, [hello]);
});

Deno.test("fresh: a dead peer maps to 503", async () => {
  await withApp(makeApp, async ({ handler }, peer) => {
    assertStrictEquals((await get(handler, "/hello/Ada")).status, 200);
    peer.shutdown(); // severs the app's live connection too
    const res = await get(handler, "/hello/Ada");
    assertStrictEquals(res.status, 503);
    assert((await res.text()).includes("is the peer running?"));
  });
});
