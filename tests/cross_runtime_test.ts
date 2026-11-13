/**
 * The shared vectors and the Node adapter's socket checks under Node and Bun
 * (ledger #3627), through `tests/cross_runtime/run.ts`. A runtime not on PATH
 * is reported absent, not failed, so a machine with Deno alone still passes;
 * the Deno rows are this suite's own tests, so they are skipped here.
 */

Deno.test("cross-runtime: shared vectors and socket checks under Node and Bun", async () => {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      new URL("./cross_runtime/run.ts", import.meta.url).pathname,
      "--no-deno",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(stdout);
  console.log(out.trimEnd());
  if (code !== 0) {
    throw new Error(
      `cross-runtime run failed (exit ${code}):\n${out}\n` +
        new TextDecoder().decode(stderr),
    );
  }
});
