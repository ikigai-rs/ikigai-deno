/**
 * JSR readiness is kept ready (ledger #1364).
 *
 * ikigai-deno is not on JSR yet — publishing stays Brian's — but the package
 * must stay publishable, and CI must say so on every change. Two gates, run
 * here so the existing CI `Test` step (`deno test -A`) exercises them:
 *
 * 1. `deno publish --dry-run` (the `publish-check` task): the real publish
 *    validation without an upload. It fails on a TypeScript **slow type** in
 *    the exported API and on a missing license. A real `deno publish` is
 *    refused by the publish fence; the dry run is allowed and never uploads.
 * 2. `deno doc --lint` over the exported entrypoints: the dry run does NOT
 *    score symbol documentation, so the missing-**doc** half is linted here
 *    (the same command as the `doc-lint` task).
 *
 * The worker that added this cannot edit `.github/workflows/` (its GitHub
 * token deliberately has no Workflows permission: "a worker must not edit
 * CI", `worker/README.md` §3), so the dry run is invoked from the suite the
 * CI `Test` step already runs, rather than from a new workflow step. The
 * command itself still lives in ONE place — the `publish-check` task of
 * deno.json — which this calls.
 *
 * The manifest facts those gates read are pinned below too, so a regression
 * is caught with a message that names the cause even before the subprocesses
 * run.
 *
 * The manifest is read as plain JSON on purpose: it is strict JSON
 * (explanations live in the README), so a comment accidentally left in it is
 * a parse failure, not a silent skip.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";

const ROOT = new URL("..", import.meta.url);

interface Manifest {
  name: string;
  version: string;
  license: string;
  exports: Record<string, string>;
}

const manifest: Manifest = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", ROOT)),
);

/** The entrypoints the package publishes, exactly. `./zod` is not one. */
const EXPECTED_EXPORTS: Record<string, string> = {
  ".": "./src/mod.ts",
  "./wire": "./src/wire.ts",
  "./client": "./src/client.ts",
  "./serve": "./src/serve.ts",
};

Deno.test("JSR: the manifest carries the publish fields", () => {
  assertMatch(manifest.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/, "scoped name");
  assertMatch(manifest.version, /^\d+\.\d+\.\d+/, "SemVer version");
  assertEquals(manifest.license, "MIT OR Apache-2.0");
  // JSR refuses a publish with neither a license field nor a LICENSE file;
  // the field above satisfies it, and both license texts ship beside it.
  assert(
    ["LICENSE-MIT", "LICENSE-APACHE"].every((f) =>
      Deno.statSync(new URL(f, ROOT)).isFile
    ),
    "both license texts must be present",
  );
});

Deno.test("JSR: exports are exactly the four entrypoints", () => {
  assertEquals(manifest.exports, EXPECTED_EXPORTS);
});

Deno.test("JSR: ./zod stays out of exports until ledger #1350", () => {
  assert(
    !("./zod" in manifest.exports),
    "`./zod` must not be exported: its signatures name zod's own types " +
      "(private-type-ref). Import it by path until ledger #1350 is decided.",
  );
  // ...but the file stays in the tree, importable by path.
  assert(Deno.statSync(new URL("src/zod.ts", ROOT)).isFile);
});

Deno.test("JSR: every entrypoint file exists and carries a module doc", async () => {
  for (const [subpath, rel] of Object.entries(EXPECTED_EXPORTS)) {
    const path = new URL(rel, ROOT);
    assert(Deno.statSync(path).isFile, `${subpath} -> ${rel} must exist`);
    const source = await Deno.readTextFile(path);
    // The module doc is the first JSDoc block; JSR scores `@module` in it.
    const firstBlock = source.slice(0, source.indexOf("*/") + 2);
    assertMatch(
      firstBlock,
      /@module\b/,
      `${rel} must carry a module doc with @module (JSR scores it)`,
    );
  }
});

/** Strip ANSI SGR escapes (deno colorizes its output even when piped). */
function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Run a deno task in the repo root and return its combined, de-colorized output. */
async function runTask(
  task: string,
): Promise<Deno.CommandOutput & { text: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["task", task],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = stripAnsi(
    new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
  );
  return Object.assign(out, { text });
}

Deno.test("JSR: deno publish --dry-run succeeds (no slow types)", async () => {
  const out = await runTask("publish-check");
  assert(
    out.success,
    `\`deno publish --dry-run\` must succeed; a slow type or a missing ` +
      `license fails it. Output:\n${out.text}`,
  );
  assertMatch(
    out.text,
    /Success Dry run complete/,
    "the dry run must report success",
  );
});

Deno.test("JSR: the exported entrypoints are fully documented", async () => {
  // The dry run does not score symbol docs, so lint them: a missing JSDoc on
  // an exported symbol (or a private-type-ref) fails this, exactly as the
  // `doc-lint` CI step does.
  const out = await runTask("doc-lint");
  assert(
    out.success,
    `\`deno doc --lint\` must report no missing docs on the exported ` +
      `entrypoints. Output:\n${out.text}`,
  );
});
