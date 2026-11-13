/**
 * Run the shared vectors, and a socket smoke test through the Node adapter,
 * under Deno, Node and Bun (spike, ledger #3627).
 *
 * ```sh
 * deno run -A tests/cross_runtime/run.ts [--node=node] [--bun=bun] [--require]
 *   [--no-deno]
 * ```
 *
 * Under Deno each vector test runs as itself (`deno test`). For Node and Bun
 * it is bundled by `deno bundle` behind `shim.ts`, which stands in for
 * `Deno.test`/`Deno.readTextFile`; the bundle (library code, `@std/assert`
 * and `@std/crypto` inlined) runs under each runtime that is on PATH. The
 * socket smoke test drives the Node adapter under all three. A runtime that
 * is not on PATH is reported, not failed, unless `--require` is given (CI,
 * which installs all three); `--no-deno` skips the Deno rows, which
 * `deno test` already covers (`tests/cross_runtime_test.ts` passes it). Prints
 * one line per file and runtime and exits non-zero on any failure.
 *
 * @module
 */

const HERE = new URL(".", import.meta.url).pathname;
const TESTS = new URL("..", import.meta.url).pathname;
const VECTORS = ["failure_class", "contract", "capability", "html", "auth"];

const flag = (name: string, fallback: string) =>
  Deno.args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ??
    fallback;
/**
 * `bin` as found on PATH (or as given, when it has a slash), else `null`.
 * Deno puts a `node` that is Deno itself on a subprocess's PATH
 * (`node_compat_bin`), and running it would report Deno as Node, so a
 * candidate whose real path is this Deno does not count.
 */
function which(bin: string): string | null {
  const deno = Deno.realPathSync(Deno.execPath());
  const dirs = bin.includes("/") ? [""] : (Deno.env.get("PATH") ?? "")
    .split(":").map((d) => `${d}/`);
  for (const dir of dirs) {
    try {
      const real = Deno.realPathSync(`${dir}${bin}`);
      if (real !== deno && Deno.statSync(real).isFile) return `${dir}${bin}`;
    } catch {
      // not here
    }
  }
  return null;
}
const node = which(flag("node", "node"));
const bun = which(flag("bun", "bun"));
const RUNTIMES: Record<string, string[] | null> = {
  ...(Deno.args.includes("--no-deno")
    ? {}
    : { deno: [Deno.execPath(), "run", "-A"] }),
  node: node === null ? null : [node],
  bun: bun === null ? null : [bun, "run"],
};

type Result = { file: string; passed: number; failed: unknown[] };

async function bundle(dir: string, name: string, entry: string) {
  const src = `${dir}/${name}_entry.ts`;
  await Deno.writeTextFile(src, entry);
  const out = `${dir}/${name}.mjs`;
  const { success, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["bundle", "--quiet", "--platform=deno", "-o", out, src],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  return out;
}

/** Under Deno the vectors run as themselves: `deno test` on the test file. */
async function denoTest(name: string): Promise<Result | string> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--no-check", `${TESTS}${name}_test.ts`],
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stdout);
  const m = text.match(/(\d+) passed \| (\d+) failed/);
  if (m === null) return `crashed (exit ${output.code})`;
  const failed = [...text.matchAll(/^(.+) \.\.\. FAILED/gm)].map((f) => f[1]);
  return { file: name, passed: Number(m[1]), failed };
}

async function run(cmd: string[], file: string): Promise<Result | string> {
  const output = await new Deno.Command(cmd[0], {
    args: [...cmd.slice(1), file],
    env: { IKIGAI_VECTORS_DIR: TESTS },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stdout);
  const line = text.split("\n").find((l) => l.startsWith("CROSS_RUNTIME "));
  if (line === undefined) {
    const err = new TextDecoder().decode(output.stderr).trim().split("\n");
    return `crashed (exit ${output.code}): ${err.slice(0, 3).join(" | ")}`;
  }
  return JSON.parse(line.slice("CROSS_RUNTIME ".length));
}

const dir = await Deno.makeTempDir({ prefix: "ikigai-cross-" });
const bundles: [string, string][] = [];
for (const name of VECTORS) {
  bundles.push([
    name,
    await bundle(
      dir,
      name,
      `import { runAll } from "${HERE}shim.ts";\n` +
        `import "${TESTS}${name}_test.ts";\n` +
        `await runAll(${JSON.stringify(name)});\n`,
    ),
  ]);
}
bundles.push([
  "socket_smoke",
  await bundle(
    dir,
    "socket_smoke",
    `import "${HERE}socket_smoke.ts";\n`,
  ),
]);

let bad = 0;
for (const [runtime, cmd] of Object.entries(RUNTIMES)) {
  for (const [name, file] of bundles) {
    if (cmd === null) {
      if (Deno.args.includes("--require")) bad++;
      console.log(`${runtime}\t${name}\tabsent (not on PATH)`);
      continue;
    }
    const r = runtime === "deno" && name !== "socket_smoke"
      ? await denoTest(name)
      : await run(cmd, file);
    if (typeof r === "string") {
      bad++;
      console.log(`${runtime}\t${name}\t${r}`);
      continue;
    }
    if (r.failed.length > 0) bad++;
    console.log(
      `${runtime}\t${name}\t${r.passed} passed, ${r.failed.length} failed` +
        (r.failed.length ? `\t${JSON.stringify(r.failed)}` : ""),
    );
  }
}
await Deno.remove(dir, { recursive: true });
Deno.exit(bad === 0 ? 0 : 1);
