import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "../src/mod.ts";

Deno.test("the package pins wire protocol v9, speaking down to v7", () => {
  if (PROTOCOL_VERSION !== 9) {
    throw new Error(`expected wire v9, got v${PROTOCOL_VERSION}`);
  }
  if (MIN_PROTOCOL_VERSION !== 7) {
    throw new Error(`expected the v7 floor, got v${MIN_PROTOCOL_VERSION}`);
  }
});
