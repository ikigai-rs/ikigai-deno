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

Deno.test("postcard strings preserve a leading U+FEFF", () => {
  for (const value of ["\uFEFF", "\uFEFFhello", "\uFEFF\uFEFF雪😀"]) {
    const writer = new Writer();
    writer.string(value);
    const encoded = writer.finish();
    const reader = new Reader(encoded);
    const decoded = reader.string();
    reader.finish();
    assertStrictEquals(decoded, value);
    const again = new Writer();
    again.string(decoded);
    assertEquals(again.finish(), encoded);
  }
});

Deno.test("varints cannot exceed Rust postcard's byte limit even with zero padding", () => {
  for (const bits of [16, 32, 64]) {
    const maxBytes = Math.ceil(bits / 7);
    const overlong = new Uint8Array(maxBytes + 1).fill(0x80);
    overlong[maxBytes] = 0;
    assertThrows(
      () => new Reader(overlong).varint(bits),
      DecodeError,
      "too long",
    );
  }
});

Deno.test("Rust postcard permits zero-padded varints within the byte limit", () => {
  for (const bits of [16, 32, 64]) {
    const padded = new Uint8Array(Math.ceil(bits / 7)).fill(0x80);
    padded[padded.length - 1] = 0;
    assertStrictEquals(new Reader(padded).varint(bits), 0);
  }
});

Deno.test("unsafe JS integers are refused on encode and decode", () => {
  for (const value of [2 ** 53, 2 ** 64, Infinity, NaN]) {
    assertThrows(() => encodeVarint(value), RangeError);
  }
  // 2^53 and u64::MAX are valid Rust u64s but cannot be exact JS numbers.
  for (
    const bytes of [
      [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10],
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
    ]
  ) {
    assertThrows(
      () => new Reader(new Uint8Array(bytes)).varint(),
      DecodeError,
      "cannot be a JS number exactly",
    );
  }
  // u64::MAX + 1: the tenth group may hold only one bit.
  assertThrows(
    () =>
      new Reader(
        new Uint8Array([
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x80,
          0x02,
        ]),
      ).varint(),
    DecodeError,
    "exceeds u64",
  );
});

Deno.test("truncated varints and byte string lengths are refused", () => {
  for (let length = 0; length < 10; length++) {
    assertThrows(
      () => new Reader(new Uint8Array(length).fill(0x80)).varint(),
      DecodeError,
      "truncated",
    );
  }
  assertThrows(
    () => new Reader(new Uint8Array([4, 1, 2, 3])).byteString(),
    DecodeError,
    "truncated",
  );
  assertEquals(new Reader(new Uint8Array([0])).byteString(), new Uint8Array());
});

Deno.test("UTF-8 encoding replaces lone surrogates with U+FFFD", () => {
  const writer = new Writer();
  writer.string("\uD800x\uDC00");
  assertStrictEquals(new Reader(writer.finish()).string(), "\uFFFDx\uFFFD");
});
