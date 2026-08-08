/**
 * Smoke tests for the Hono example: HTTP -> handler -> wire -> served space,
 * pure Deno end to end (no Rust binary needed). Hono's `app.request()`
 * dispatches in-process — no listener.
 */

import { assert, assertStrictEquals } from "@std/assert";
import { createApp } from "../examples/hono_app.ts";
import { hello } from "../examples/endpoints.ts";
import {
  invalidInputEndpoints,
  typedFailureEndpoints,
  withApp,
} from "./examples_util.ts";

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

Deno.test("hono: typed wire errors map to truthful statuses", async () => {
  // The v7 payoff at the HTTP face: 403/404/503 by TYPE, not 502-for-all.
  await withApp(createApp, async ({ app }) => {
    const denied = await app.request("/upper?text=abc");
    assertStrictEquals(denied.status, 403);
    assert((await denied.text()).includes("needs urn:cap:upper"));
    const missing = await app.request("/reverse?text=abc");
    assertStrictEquals(missing.status, 404);
    assert((await missing.text()).includes("no such row"));
    const flaky = await app.request("/hello/Ada");
    assertStrictEquals(flaky.status, 503); // transient — retrying may work
    assert((await flaky.text()).includes("upstream down"));
  }, typedFailureEndpoints());
});

Deno.test("hono: the ENDPOINT refusing input is a 400, not a 502", async () => {
  await withApp(createApp, async ({ app }) => {
    // Framework validation passes (`who` is present); the WIRE refuses it.
    const invalid = await app.request("/hello/Bob"); // the enum wants Ada
    assertStrictEquals(invalid.status, 400);
    assert((await invalid.text()).includes("invalid argument `who`"));
    const missing = await app.request("/upper?text=abc");
    assertStrictEquals(missing.status, 400);
    assert((await missing.text()).includes("missing required argument"));
  }, invalidInputEndpoints());
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
