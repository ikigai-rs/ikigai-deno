/**
 * The shared vectors stay LF in every checkout (ledger #1205).
 *
 * devtools' vector-drift digests `contract_vectors.json`,
 * `capability_vectors.json` and `ttt_template_cases.txt` as raw bytes
 * against the other faces, and Git for Windows checks text out with CRLF
 * unless an `eol=lf` attribute says otherwise. Two checks: the bytes this
 * checkout holds carry no CR, and git resolves `eol: lf` for each vector
 * path, which is what makes a CRLF-defaulted clone come out LF. The second
 * reads the working tree's `.gitattributes`, never history, so a shallow CI
 * checkout runs it; it skips only when there is no git or no repository (a
 * published package).
 */

import { assertEquals } from "@std/assert";

const ROOT = new URL("..", import.meta.url);
const VECTORS = [
  "tests/contract_vectors.json",
  "tests/capability_vectors.json",
  "tests/validation_vectors.json",
  "tests/ttt_template_cases.txt",
];

function inGitCheckout(): boolean {
  try {
    const out = new Deno.Command("git", {
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: ROOT,
      stdout: "null",
      stderr: "null",
    }).outputSync();
    return out.success;
  } catch {
    return false; // no git on PATH
  }
}

Deno.test("the shared vectors hold no CR bytes in this checkout", async () => {
  for (const path of VECTORS) {
    const bytes = await Deno.readFile(new URL(path, ROOT));
    assertEquals(bytes.indexOf(0x0d), -1, `${path} contains a CR byte`);
  }
});

Deno.test({
  name: "git resolves eol=lf for every shared vector path",
  ignore: !inGitCheckout(),
  fn: async () => {
    const out = await new Deno.Command("git", {
      args: ["check-attr", "eol", "--", ...VECTORS],
      cwd: ROOT,
    }).output();
    assertEquals(out.success, true, new TextDecoder().decode(out.stderr));
    const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
    assertEquals(lines, VECTORS.map((path) => `${path}: eol: lf`));
  },
});
