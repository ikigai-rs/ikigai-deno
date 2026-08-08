/**
 * Shared fixtures for the example-app smoke tests: in-process served spaces
 * on temp sockets. The whole stack (HTTP -> handler -> wire -> served space)
 * is pure Deno, so these run on CI with no Rust binary.
 */

import { z } from "zod";
import type { Client } from "../src/client.ts";
import { endpoint, type EndpointDef, Server } from "../src/serve.ts";
import { endpoint as zodEndpoint } from "../src/zod.ts";
import { DeniedError, NotFoundError, UnavailableError } from "../src/mod.ts";
import { ENDPOINTS } from "../examples/endpoints.ts";

/** An example app under test: whatever `createApp` returned. */
export interface ExampleApp {
  kernel: Client;
}

export interface Peer {
  path: string;
  /** Severs live connections too — the 503 tests hang up mid-life. */
  shutdown(): void;
}

/**
 * Serve `endpoints` on a temp socket around `fn`. The default set is the
 * examples' own; the 502 tests pass a partial space instead (a route then
 * hits an unresolved target).
 */
export async function withPeer(
  fn: (peer: Peer) => Promise<void>,
  endpoints: readonly EndpointDef[] = ENDPOINTS,
): Promise<void> {
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-examples-" });
  const path = `${dir}/peer.sock`;
  const server = new Server(endpoints, path);
  const serving = server.serve();
  try {
    await fn({ path, shutdown: () => server.shutdown() });
  } finally {
    server.shutdown();
    await serving;
    Deno.removeSync(dir, { recursive: true });
  }
}

/**
 * A space whose endpoints fail TYPED (wire v7) — the fixtures for the
 * status-mapping smoke tests: `/upper` meets a denial (403), `/reverse` a
 * not-found (404), `/hello` a transient unavailability (503).
 */
export function typedFailureEndpoints(): EndpointDef[] {
  return [
    endpoint("urn:ts:upper", { summary: "gated" }, () => {
      throw new DeniedError("needs urn:cap:upper");
    }),
    endpoint("urn:ts:reverse", { summary: "absent" }, () => {
      throw new NotFoundError("no such row");
    }),
    endpoint("urn:ts:hello", { summary: "flaky" }, () => {
      throw new UnavailableError("upstream down");
    }),
  ];
}

/**
 * A space whose endpoints refuse the APP's (framework-valid) input at the
 * wire: `/hello/:who` fails zod validation (InvalidArgument), `/upper`
 * lacks an argument the endpoint requires (MissingArgument) — both must
 * surface as 400, not a blanket 502.
 */
export function invalidInputEndpoints(): EndpointDef[] {
  return [
    zodEndpoint("urn:ts:hello", {
      summary: "only greets Ada",
      input: z.object({ who: z.enum(["Ada"]) }),
    }, ({ who }) => `Hello, ${who}!`),
    endpoint("urn:ts:upper", {
      summary: "wants an argument the app does not send",
      args: [{ name: "extra", required: true }, { name: "text" }],
    }, ({ text }) => String(text).toUpperCase()),
  ];
}

/** `withPeer`, plus app construction and kernel-client cleanup. */
export async function withApp<A extends ExampleApp>(
  createApp: (path: string) => Promise<A>,
  fn: (app: A, peer: Peer) => Promise<void>,
  endpoints: readonly EndpointDef[] = ENDPOINTS,
): Promise<void> {
  await withPeer(async (peer) => {
    const app = await createApp(peer.path);
    try {
      await fn(app, peer);
    } finally {
      app.kernel.close();
    }
  }, endpoints);
}
