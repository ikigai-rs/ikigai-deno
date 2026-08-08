/**
 * The examples' run mode 2, end to end: HTTP -> Hono handler -> wire ->
 * Rust kernel -> `--prefer urn:ts:=` mount -> wire -> Deno peer. Nothing in
 * the app changes; the kernel in the middle owns the topology and caches the
 * pure results (the `X-Ikigai-Cache` header flips MISS -> HIT).
 *
 * Skips cleanly when the `ikigai` binary is absent (CI has no Rust host;
 * these run locally against `~/.cargo/bin/ikigai`) — or when the installed
 * binary speaks an older wire version (v7 removed the tolerances; the clean
 * cross-version mismatch is asserted in `integration_test.ts`).
 */

import { assert, assertStrictEquals } from "@std/assert";
import { PROTOCOL_VERSION } from "../src/wire.ts";
import { createApp } from "../examples/hono_app.ts";
import { withPeer } from "./examples_util.ts";
import { findIkigai, probeWireVersion, spawnServe } from "./rust_host.ts";

const IKIGAI = findIkigai();
const RUST_WIRE_VERSION = await probeWireVersion(IKIGAI);

Deno.test({
  name: "an example app through the kernel gains MISS -> HIT caching",
  ignore: IKIGAI === null || RUST_WIRE_VERSION !== PROTOCOL_VERSION,
  // The Rust CLI child and the in-process server cross test boundaries in
  // ways the strict sanitizers dislike; cleanup is explicit instead.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withPeer(async (peer) => {
      const dir = Deno.makeTempDirSync({ prefix: "ik-deno-examples-int-" });
      const kernelSocket = `${dir}/kernel.sock`;
      const child = await spawnServe(IKIGAI!, kernelSocket, [
        "--prefer",
        `urn:ts:=${peer.path}`,
      ]);
      try {
        // The app is example code, unchanged: only the socket path moved.
        const { app, kernel } = await createApp(kernelSocket);
        try {
          const first = await app.request("/upper?text=roc");
          assertStrictEquals(await first.text(), "ROC");
          assertStrictEquals(first.headers.get("x-ikigai-cache"), "MISS");
          const second = await app.request("/upper?text=roc");
          assertStrictEquals(await second.text(), "ROC");
          // The kernel cached the peer's pure result.
          assertStrictEquals(second.headers.get("x-ikigai-cache"), "HIT");
          // /catalog now lists the kernel's whole space with the mount's
          // entries composed in (cli #272: a prefer mount's entries appear
          // without prior use).
          const entries = await (await app.request("/catalog")).json() as {
            pattern: string;
          }[];
          const patterns = new Set(entries.map((e) => e.pattern));
          assert(patterns.has("urn:ts:upper"), "mounted peer not in catalog");
          assert(
            [...patterns].some((p) => !p.startsWith("urn:ts:")),
            "kernel's own space missing from the catalog",
          );
        } finally {
          kernel.close();
        }
      } finally {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        await child.status;
        Deno.removeSync(dir, { recursive: true });
      }
    });
  },
});
