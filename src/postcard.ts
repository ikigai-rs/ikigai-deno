/**
 * The postcard primitives this package needs — nothing more.
 *
 * Postcard (https://postcard.jamesmunns.com) is a non-self-describing binary
 * codec: the byte stream carries no field names or type tags, so encode and
 * decode must mirror the Rust type layout field-for-field. The subset used by
 * the ikigai wire protocol:
 *
 * - `u8`: one byte, verbatim.
 * - `bool`: one byte, `0x00` / `0x01`.
 * - `u16`/`u32`/`u64`/`usize`: unsigned LEB128 varint — 7 bits per byte,
 *   least-significant group first, high bit = continuation.
 * - `Option<T>`: `0x00` for `None`, `0x01` + payload for `Some`.
 * - `String` / `Vec<u8>`: varint length + bytes (a `Vec<u8>` is a sequence
 *   of `u8`, which is byte-for-byte identical to a byte string).
 * - sequences (`Vec<T>`, `BTreeSet<T>`): varint length + elements.
 * - maps (`BTreeMap<K, V>`): varint length + key/value pairs. Rust's
 *   `BTreeMap` iterates in key order, so the canonical encoding sorts keys
 *   (for `String` keys: lexicographic over UTF-8 bytes).
 * - structs and tuples: fields in declaration order, no framing.
 * - enums: varint `u32` discriminant = the variant's declaration INDEX
 *   (`#[repr(u8)]` values do not participate), then the payload.
 *
 * JS numbers are IEEE doubles, exact only to 2^53 - 1. A u64 whose value
 * exceeds `Number.MAX_SAFE_INTEGER` cannot be represented faithfully as a
 * `number`, so this reader throws {@linkcode DecodeError} rather than
 * silently losing precision (no such value occurs in practice: the wire's
 * u64s are epoch milliseconds, span sequence numbers, and this side never
 * decodes a foreign trace id).
 */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** A byte stream that does not parse as the expected postcard layout. */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/** Unsigned LEB128. */
export function encodeVarint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(
      `postcard varints are unsigned integers <= 2^53 - 1 (got ${n})`,
    );
  }
  let big = BigInt(n);
  const out: number[] = [];
  while (true) {
    const group = Number(big & 0x7fn);
    big >>= 7n;
    if (big !== 0n) {
      out.push(group | 0x80);
    } else {
      out.push(group);
      return new Uint8Array(out);
    }
  }
}

/** A growable byte buffer for one postcard message. */
export class Writer {
  #buf = new Uint8Array(256);
  #len = 0;

  #ensure(extra: number): void {
    if (this.#len + extra <= this.#buf.length) return;
    let capacity = this.#buf.length * 2;
    while (capacity < this.#len + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  byte(b: number): void {
    this.#ensure(1);
    this.#buf[this.#len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.#ensure(b.length);
    this.#buf.set(b, this.#len);
    this.#len += b.length;
  }

  bool(b: boolean): void {
    this.byte(b ? 1 : 0);
  }

  varint(n: number): void {
    this.bytes(encodeVarint(n));
  }

  /** varint length + raw bytes (`Vec<u8>` / `String` payload). */
  byteString(b: Uint8Array): void {
    this.varint(b.length);
    this.bytes(b);
  }

  string(s: string): void {
    this.byteString(utf8Encoder.encode(s));
  }

  /** An `Option` tag followed (when present) by a varint payload. */
  optionVarint(value: number | null): void {
    if (value === null) {
      this.byte(0);
    } else {
      this.byte(1);
      this.varint(value);
    }
  }

  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

/** A cursor over one postcard message. Every read is bounds-checked. */
export class Reader {
  #data: Uint8Array;
  #pos = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  take(n: number): Uint8Array {
    const end = this.#pos + n;
    if (end > this.#data.length) {
      throw new DecodeError(
        `truncated message: wanted ${n} bytes at offset ${this.#pos}, ` +
          `have ${this.#data.length - this.#pos}`,
      );
    }
    const chunk = this.#data.slice(this.#pos, end);
    this.#pos = end;
    return chunk;
  }

  u8(): number {
    return this.take(1)[0];
  }

  bool(): boolean {
    const b = this.u8();
    if (b === 0) return false;
    if (b === 1) return true;
    throw new DecodeError(`invalid bool byte 0x${b.toString(16)}`);
  }

  varint(maxBits = 64): number {
    let n = 0n;
    let shift = 0n;
    while (true) {
      const b = this.u8();
      n |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
      if (shift >= BigInt(maxBits) + 7n) {
        throw new DecodeError("varint too long");
      }
    }
    if (n >= 1n << BigInt(maxBits)) {
      throw new DecodeError(`varint exceeds u${maxBits}`);
    }
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DecodeError(
        `varint ${n} exceeds 2^53 - 1 and cannot be a JS number exactly`,
      );
    }
    return Number(n);
  }

  byteString(): Uint8Array {
    return this.take(this.varint());
  }

  string(): string {
    const raw = this.byteString();
    try {
      return utf8Decoder.decode(raw);
    } catch (e) {
      throw new DecodeError(`invalid utf-8 in string: ${e}`);
    }
  }

  /** Read an `Option` tag; `true` means a payload follows. */
  option(): boolean {
    const b = this.u8();
    if (b === 0) return false;
    if (b === 1) return true;
    throw new DecodeError(`invalid Option tag 0x${b.toString(16)}`);
  }

  /** Assert the message was consumed exactly. */
  finish(): void {
    if (this.#pos !== this.#data.length) {
      throw new DecodeError(
        `${this.#data.length - this.#pos} trailing bytes after message`,
      );
    }
  }
}
