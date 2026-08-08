/**
 * Smoke tests for the Oak example: HTTP -> middleware -> wire -> served
 * space, pure Deno end to end (no Rust binary needed). Oak's `app.handle()`
 * dispatches in-process — no listener.
 */

import { assert, assertStrictEquals } from "@std/assert";
import { createApp } from "../examples/oak_app.ts";
import { hello } from "../examples/endpoints.ts";
import {
  invalidInputEndpoints,
  typedFailureEndpoints,
  withApp,
} from "./examples_util.ts";

function get(
  app: { handle(req: Request): Promise<Response | undefined> },
  path: string,
): Promise<Response | undefined> {
  return app.handle(new Request(`http://localhost${path}`));
}

Deno.test("oak: hello resolves through the wire", async () => {
  await withApp(createApp, async ({ app }) => {
    const res = await get(app, "/hello/Ada");
    assert(res !== undefined);
    assertStrictEquals(res.status, 200);
    assertStrictEquals(await res.text(), "Hello, Ada!");
    // Direct to the peer there is no kernel cache upstream: MISS every time.
    assertStrictEquals(res.headers.get("x-ikigai-cache"), "MISS");
    assert(res.headers.get("content-type")!.startsWith("text/plain"));
  });
});

Deno.test("oak: upper and reverse take query parameters", async () => {
  await withApp(createApp, async ({ app }) => {
    assertStrictEquals(
      await (await get(app, "/upper?text=abc"))!.text(),
      "ABC",
    );
    assertStrictEquals(
      await (await get(app, "/reverse?text=abc"))!.text(),
      "cba",
    );
  });
});

Deno.test("oak: a missing query parameter is a client error", async () => {
  // `ctx.throw(Status.BadRequest, ...)` is the whole input contract: Oak
  // turns it into a 400 before any resolution happens.
  await withApp(createApp, async ({ app }) => {
    const res = await get(app, "/upper");
    assert(res !== undefined);
    assertStrictEquals(res.status, 400);
    await res.body?.cancel();
  });
});

Deno.test("oak: the catalog lists the space", async () => {
  await withApp(createApp, async ({ app }) => {
    const entries = await (await get(app, "/catalog"))!.json() as {
      pattern: string;
    }[];
    const patterns = new Set(entries.map((e) => e.pattern));
    for (const iri of ["urn:ts:hello", "urn:ts:upper", "urn:ts:reverse"]) {
      assert(patterns.has(iri), `catalog is missing ${iri}`);
    }
  });
});

Deno.test("oak: an endpoint error maps to 502", async () => {
  await withApp(createApp, async ({ app }) => {
    const res = await get(app, "/upper?text=abc");
    assert(res !== undefined);
    assertStrictEquals(res.status, 502);
    assert(
      (await res.text()).includes("no endpoint resolved for urn:ts:upper"),
    );
  }, [hello]);
});

Deno.test("oak: typed wire errors map to truthful statuses", async () => {
  // The v7 payoff at the HTTP face: 403/404/503 by TYPE, not 502-for-all.
  await withApp(createApp, async ({ app }) => {
    const denied = await get(app, "/upper?text=abc");
    assertStrictEquals(denied!.status, 403);
    assert((await denied!.text()).includes("needs urn:cap:upper"));
    const missing = await get(app, "/reverse?text=abc");
    assertStrictEquals(missing!.status, 404);
    assert((await missing!.text()).includes("no such row"));
    const flaky = await get(app, "/hello/Ada");
    assertStrictEquals(flaky!.status, 503); // transient — retrying may work
    assert((await flaky!.text()).includes("upstream down"));
  }, typedFailureEndpoints());
});

Deno.test("oak: the ENDPOINT refusing input is a 400, not a 502", async () => {
  await withApp(createApp, async ({ app }) => {
    // The route's own contract passes; the WIRE refuses the value.
    const invalid = await get(app, "/hello/Bob"); // the enum wants Ada
    assertStrictEquals(invalid!.status, 400);
    assert((await invalid!.text()).includes("invalid argument `who`"));
    const missing = await get(app, "/upper?text=abc");
    assertStrictEquals(missing!.status, 400);
    assert((await missing!.text()).includes("missing required argument"));
  }, invalidInputEndpoints());
});

Deno.test("oak: a dead peer maps to 503", async () => {
  await withApp(createApp, async ({ app }, peer) => {
    assertStrictEquals((await get(app, "/hello/Ada"))!.status, 200);
    peer.shutdown(); // severs the app's live connection too
    const res = await get(app, "/hello/Ada");
    assert(res !== undefined);
    assertStrictEquals(res.status, 503);
    assert((await res.text()).includes("is the peer running?"));
  });
});
