/**
 * Smoke tests for the Hono example: HTTP -> handler -> wire -> served space,
 * pure Deno end to end (no Rust binary needed). Hono's `app.request()`
 * dispatches in-process — no listener.
 */

import { assert, assertStrictEquals } from "@std/assert";
import { createApp } from "../examples/hono_app.ts";
import { hello } from "../examples/endpoints.ts";
import { withApp } from "./examples_util.ts";

Deno.test("hono: hello resolves through the wire", async () => {
  await withApp(createApp, async ({ app }) => {
    const res = await app.request("/hello/Ada");
    assertStrictEquals(res.status, 200);
    assertStrictEquals(await res.text(), "Hello, Ada!");
    // Direct to the peer there is no kernel cache upstream: MISS every time.
    assertStrictEquals(res.headers.get("x-ikigai-cache"), "MISS");
    assert(res.headers.get("content-type")!.startsWith("text/plain"));
  });
});

Deno.test("hono: upper and reverse take query parameters", async () => {
  await withApp(createApp, async ({ app }) => {
    assertStrictEquals(
      await (await app.request("/upper?text=abc")).text(),
      "ABC",
    );
    assertStrictEquals(
      await (await app.request("/reverse?text=abc")).text(),
      "cba",
    );
  });
});

Deno.test("hono: a missing query parameter is a client error", async () => {
  // The validator IS the contract: Hono rejects the request before the
  // handler runs — the framework analog of a required ArgSpec.
  await withApp(createApp, async ({ app }) => {
    const res = await app.request("/upper");
    assertStrictEquals(res.status, 400);
    await res.body?.cancel();
  });
});

Deno.test("hono: the catalog lists the space", async () => {
  await withApp(createApp, async ({ app }) => {
    const entries = await (await app.request("/catalog")).json() as {
      pattern: string;
    }[];
    const patterns = new Set(entries.map((e) => e.pattern));
    for (const iri of ["urn:ts:hello", "urn:ts:upper", "urn:ts:reverse"]) {
      assert(patterns.has(iri), `catalog is missing ${iri}`);
    }
  });
});

Deno.test("hono: an endpoint error maps to 502", async () => {
  // A space serving ONLY urn:ts:hello — /upper then hits an unresolved
  // target, which is how the smoke tests exercise the 502 mapping.
  await withApp(createApp, async ({ app }) => {
    const res = await app.request("/upper?text=abc");
    assertStrictEquals(res.status, 502);
    assert(
      (await res.text()).includes("no endpoint resolved for urn:ts:upper"),
    );
  }, [hello]);
});

Deno.test("hono: a dead peer maps to 503", async () => {
  await withApp(createApp, async ({ app }, peer) => {
    assertStrictEquals((await app.request("/hello/Ada")).status, 200);
    peer.shutdown(); // severs the app's live connection too
    const res = await app.request("/hello/Ada");
    assertStrictEquals(res.status, 503);
    assert((await res.text()).includes("is the peer running?"));
  });
});
