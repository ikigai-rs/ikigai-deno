import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { DecodeError, encodeVarint, Reader, Writer } from "../src/postcard.ts";

function roundTrip(n: number): number {
  return new Reader(encodeVarint(n)).varint();
}

Deno.test("varint round-trips the edges", () => {
  for (
    const n of [
      0,
      1,
      127,
      128,
      129,
      16383,
      16384,
      2 ** 32 - 1,
      2 ** 32,
      Number.MAX_SAFE_INTEGER,
    ]
  ) {
    assertStrictEquals(roundTrip(n), n);
  }
});

Deno.test("varint golden bytes: 7-bit groups, LSB first, high bit continues", () => {
  assertEquals(encodeVarint(0), new Uint8Array([0x00]));
  assertEquals(encodeVarint(127), new Uint8Array([0x7f]));
  assertEquals(encodeVarint(128), new Uint8Array([0x80, 0x01]));
  assertEquals(encodeVarint(300), new Uint8Array([0xac, 0x02]));
});

Deno.test("negative and non-integer varints are refused", () => {
  assertThrows(() => encodeVarint(-1), RangeError);
  assertThrows(() => encodeVarint(1.5), RangeError);
});

Deno.test("a varint exceeding its width errors", () => {
  // 2^32 encoded, decoded as u32.
  const tooWide = encodeVarint(2 ** 32);
  assertThrows(() => new Reader(tooWide).varint(32), DecodeError, "exceeds");
});

Deno.test("an endless varint errors instead of spinning", () => {
  const endless = new Uint8Array(12).fill(0x80);
  assertThrows(() => new Reader(endless).varint(), DecodeError, "too long");
});

Deno.test("a truncated read is loud and names its offset", () => {
  const r = new Reader(new Uint8Array([1, 2]));
  r.take(2);
  assertThrows(() => r.take(1), DecodeError, "truncated");
});

Deno.test("finish rejects trailing bytes", () => {
  const r = new Reader(new Uint8Array([1, 2]));
  r.u8();
  assertThrows(() => r.finish(), DecodeError, "trailing");
});

Deno.test("bool and Option tags accept only 0x00/0x01", () => {
  assertStrictEquals(new Reader(new Uint8Array([1])).bool(), true);
  assertStrictEquals(new Reader(new Uint8Array([0])).option(), false);
  assertThrows(() => new Reader(new Uint8Array([2])).bool(), DecodeError);
  assertThrows(() => new Reader(new Uint8Array([7])).option(), DecodeError);
});

Deno.test("strings are varint length + utf-8, validated on decode", () => {
  const w = new Writer();
  w.string("héllo");
  const r = new Reader(w.finish());
  assertStrictEquals(r.string(), "héllo");
  r.finish();
  // Invalid utf-8 in a string position errors.
  const bad = new Writer();
  bad.byteString(new Uint8Array([0xff, 0xfe]));
  assertThrows(() => new Reader(bad.finish()).string(), DecodeError, "utf-8");
});

Deno.test("the writer grows past its initial capacity", () => {
  const w = new Writer();
  const big = new Uint8Array(10_000).fill(0xab);
  w.byteString(big);
  const r = new Reader(w.finish());
  assertEquals(r.byteString(), big);
  r.finish();
});
