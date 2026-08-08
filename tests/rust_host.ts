/**
 * Locating and probing the installed Rust host for the integration tests.
 *
 * v7 removed the version tolerances, so the integration suite must first
 * learn which wire version the installed `ikigai` binary speaks: full
 * two-directional integration runs against a v7 binary, and against an
 * older (v6) binary the suite instead asserts the CLEAN MISMATCH — the
 * hello names both versions, which is exactly the behavior the tolerance
 * removal promises.
 */

import * as wire from "../src/wire.ts";
import { FrameStream } from "../src/wire.ts";

/** The installed binary, `~/.cargo/bin` first, then `PATH`; else null. */
export function findIkigai(): string | null {
  const home = Deno.env.get("HOME");
  const candidates = home ? [`${home}/.cargo/bin/ikigai`] : [];
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (dir) candidates.push(`${dir}/ikigai`);
  }
  for (const candidate of candidates) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Spawn `ikigai serve` on `path` and wait for the socket to appear. */
export async function spawnServe(
  ikigai: string,
  path: string,
  extraArgs: string[] = [],
): Promise<Deno.ChildProcess> {
  const child = new Deno.Command(ikigai, {
    args: ["serve", path, ...extraArgs],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      Deno.statSync(path);
      return child;
    } catch {
      if (Date.now() >= deadline) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        await child.status;
        throw new Error("ikigai serve did not come up");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/**
 * The wire version the installed binary's server declares in its hello —
 * probed with a raw hello frame (a mismatched server still ANSWERS before
 * closing; that is the point of the hello). `null` when no binary exists or
 * the probe fails outright.
 */
export async function probeWireVersion(
  ikigai: string | null,
): Promise<number | null> {
  if (ikigai === null) return null;
  const dir = Deno.makeTempDirSync({ prefix: "ik-deno-probe-" });
  const path = `${dir}/probe.sock`;
  let child: Deno.ChildProcess | null = null;
  try {
    child = await spawnServe(ikigai, path);
    const conn = await Deno.connect({ transport: "unix", path });
    try {
      const stream = new FrameStream(conn);
      await stream.writeFrame(
        wire.encodeHello(wire.hello(wire.PROTOCOL_VERSION)),
      );
      const answer = wire.decodeHello(await stream.readFrame());
      return answer?.version ?? null;
    } finally {
      conn.close();
    }
  } catch {
    return null; // a pre-v6 server hangs up without answering
  } finally {
    if (child !== null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      await child.status;
    }
    Deno.removeSync(dir, { recursive: true });
  }
}
