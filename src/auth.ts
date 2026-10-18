/**
 * `Authorization` header values and standard base64: a port of
 * `ikigai_http::auth` and `ikigai_http::base64` (ikigai-http 0.2.1), pinned by
 * the shared vectors in `tests/auth_vectors.json` (ledger #1862).
 *
 * | You have | Function |
 * |---|---|
 * | a user and a password | {@link basicAuthorization} (RFC 7617) |
 * | a bearer token | {@link bearerAuthorization} (RFC 6750) |
 * | a received header value | {@link parseAuthorization} (RFC 9110) |
 * | bytes or a base64 string | {@link base64Encode}, {@link base64Decode} |
 *
 * A refusal throws an {@link AuthError} whose `code` is a stable string. Its
 * message names the rule and never the credential, so it is safe to log.
 *
 * @module
 */

/** The stable refusal codes, shared with every other face. */
export type AuthErrorCode =
  | "basic-user-id-colon"
  | "basic-user-id-control"
  | "basic-password-control"
  | "bearer-token-syntax"
  | "base64-invalid";

const MESSAGES: Record<AuthErrorCode, string> = {
  "basic-user-id-colon": "a Basic user-id must not contain a colon",
  "basic-user-id-control":
    "a Basic user-id must not contain a control character",
  "basic-password-control":
    "a Basic password must not contain a control character",
  "bearer-token-syntax": "a bearer token must be a non-empty RFC 6750 b64token",
  "base64-invalid": "not canonical, padded, standard-alphabet base64",
};

/** A refused credential or base64 string. The message never holds the input. */
export class AuthError extends Error {
  /** The stable code, e.g. `"bearer-token-syntax"`. */
  readonly code: AuthErrorCode;
  /** An error for `code`, with the fixed message for that code. */
  constructor(code: AuthErrorCode) {
    super(`${code}: ${MESSAGES[code]}`);
    this.name = "AuthError";
    this.code = code;
  }
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DECODE = new Map<string, number>(
  [...ALPHABET].map((c, i) => [c, i] as const),
);

/**
 * `bytes` as standard-alphabet (RFC 4648 section 4) base64 with `=` padding.
 *
 * ```ts
 * import { base64Encode } from "@ikigai/wire/auth";
 * import { assertEquals } from "@std/assert";
 * assertEquals(base64Encode(new TextEncoder().encode("foob")), "Zm9vYg==");
 * ```
 */
export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) |
      (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
  }
  return out;
}

/**
 * The bytes of standard-alphabet base64. Padding is required, whitespace and
 * the URL-safe alphabet are refused, and the pad bits must be zero (so `Zh==`
 * is refused: it is not what {@link base64Encode} would write).
 *
 * @throws {AuthError} `base64-invalid`
 *
 * ```ts
 * import { base64Decode } from "@ikigai/wire/auth";
 * import { assertEquals } from "@std/assert";
 * assertEquals(new TextDecoder().decode(base64Decode("Zm9vYg==")), "foob");
 * ```
 */
export function base64Decode(encoded: string): Uint8Array {
  if (encoded.length % 4 !== 0) throw new AuthError("base64-invalid");
  let pad = 0;
  if (encoded.endsWith("==")) pad = 2;
  else if (encoded.endsWith("=")) pad = 1;
  const body = encoded.slice(0, encoded.length - pad);
  const out = new Uint8Array((encoded.length / 4) * 3 - pad);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of body) {
    const v = DECODE.get(c);
    if (v === undefined) throw new AuthError("base64-invalid");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new AuthError("base64-invalid"); // non-zero pad bits
  return out;
}

// C0, DEL and C1 (RFC 7617 section 2 CTL; section 2.1 via RFC 7613).
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The `Authorization` value `Basic base64(user:password)` (RFC 7617), the
 * text encoded as UTF-8. Refused, in this order: a colon in `user`, a control
 * character in `user`, a control character in `password`.
 *
 * @throws {AuthError} `basic-user-id-colon`, `basic-user-id-control` or
 * `basic-password-control`
 *
 * ```ts
 * import { basicAuthorization } from "@ikigai/wire/auth";
 * import { assertEquals } from "@std/assert";
 * assertEquals(basicAuthorization("Aladdin", "open sesame"), "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==");
 * ```
 */
export function basicAuthorization(user: string, password: string): string {
  if (user.includes(":")) throw new AuthError("basic-user-id-colon");
  if (CONTROL.test(user)) throw new AuthError("basic-user-id-control");
  if (CONTROL.test(password)) throw new AuthError("basic-password-control");
  return "Basic " +
    base64Encode(new TextEncoder().encode(`${user}:${password}`));
}

/**
 * The `Authorization` value `Bearer token` (RFC 6750 section 2.1): the token
 * must be a b64token, `1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="`.
 *
 * @throws {AuthError} `bearer-token-syntax`
 *
 * ```ts
 * import { bearerAuthorization } from "@ikigai/wire/auth";
 * import { assertEquals } from "@std/assert";
 * assertEquals(bearerAuthorization("mF_9.B5f-4.1JqM"), "Bearer mF_9.B5f-4.1JqM");
 * ```
 */
export function bearerAuthorization(token: string): string {
  if (!/^[A-Za-z0-9\-._~+/]+=*$/.test(token)) {
    throw new AuthError("bearer-token-syntax");
  }
  return `Bearer ${token}`;
}

/** A parsed `Authorization` value. */
export interface ParsedAuthorization {
  /** `"basic"`, `"bearer"` (any case on the wire) or `"other"`. */
  scheme: "basic" | "bearer" | "other";
  /** `"Basic"` and `"Bearer"` canonically; any other scheme as spelled. */
  name: string;
  /** Everything after the scheme, without surrounding whitespace; maybe `""`. */
  credentials: string;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/;

/**
 * Splits an `Authorization` value into scheme and credentials (RFC 9110
 * section 11). Scheme names are case-insensitive; space or tab separates the
 * scheme from the credentials. `null` when there is no valid scheme token.
 * The credentials are not checked here.
 *
 * ```ts
 * import { parseAuthorization } from "@ikigai/wire/auth";
 * import { assertEquals } from "@std/assert";
 * assertEquals(parseAuthorization("BEARER abc"), { scheme: "bearer", name: "Bearer", credentials: "abc" });
 * ```
 */
export function parseAuthorization(value: string): ParsedAuthorization | null {
  const v = value.replace(/^[ \t]+|[ \t]+$/g, "");
  const m = TOKEN.exec(v);
  if (!m) return null;
  const rest = v.slice(m[0].length);
  if (rest !== "" && !/^[ \t]/.test(rest)) return null;
  const credentials = rest.replace(/^[ \t]+/, "");
  const lower = m[0].toLowerCase();
  if (lower === "basic") return { scheme: "basic", name: "Basic", credentials };
  if (lower === "bearer") {
    return { scheme: "bearer", name: "Bearer", credentials };
  }
  return { scheme: "other", name: m[0], credentials };
}
