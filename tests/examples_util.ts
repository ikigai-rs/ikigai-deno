/**
 * Shared fixtures for the example-app smoke tests: in-process served spaces
 * on temp sockets. The whole stack (HTTP -> handler -> wire -> served space)
 * is pure Deno, so these run on CI with no Rust binary.
 */

import type { Client } from "../src/client.ts";
import { type EndpointDef, Server } from "../src/serve.ts";
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
