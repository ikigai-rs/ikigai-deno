import { PROTOCOL_VERSION } from "../src/mod.ts";

Deno.test("the package pins wire protocol v7", () => {
  if (PROTOCOL_VERSION !== 7) {
    throw new Error(`expected wire v7, got v${PROTOCOL_VERSION}`);
  }
});
