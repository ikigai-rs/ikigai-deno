import { PROTOCOL_VERSION } from "../src/mod.ts";

Deno.test("the package pins wire protocol v6", () => {
  if (PROTOCOL_VERSION !== 6) {
    throw new Error(`expected wire v6, got v${PROTOCOL_VERSION}`);
  }
});
