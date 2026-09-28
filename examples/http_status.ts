/**
 * The wire-error → HTTP-status mapping the three example apps share.
 *
 * This is THE payoff of wire v7's typed errors: the taxonomy survives the
 * trip, so an HTTP face can answer the truthful status instead of a blanket
 * 502 —
 *
 * | wire error                          | HTTP | why                          |
 * | ----------------------------------- | ---- | ---------------------------- |
 * | `DeniedError`                       | 403  | permanent: no grant          |
 * | `NotFoundError`                     | 404  | permanent: thing absent      |
 * | `ConflictError` (wire v8)           | 409  | permanent: state refuses     |
 * | `InvalidArgumentError`              | 400  | the caller's input           |
 * | `MissingArgumentError`              | 400  | the caller's input           |
 * | transient (`Timeout`/`Unavailable`) | 503  | retrying may succeed         |
 * | anything else (`Endpoint`, …)       | 502  | the upstream peer failed     |
 *
 * (`UnresolvedError` — the kernel has nothing bound at that IRI — stays 502:
 * from the app's point of view its own gateway is misconfigured, which is
 * not the caller's 404.)
 *
 * `ConflictError` is 409, not 412: the target's CURRENT STATE refused a
 * well-formed, authorized request (a move on an occupied square). 412 is
 * for a precondition the CALLER stated (`If-Match` / `If-None-Match`) and
 * stays the job of whatever evaluates those headers. Like the other
 * permanent kinds it is never 503 — retrying against the same state fails
 * the same way. (A v7 host downgrades Conflict to a plain `EndpointError`
 * reading `conflict: …`, so against one it is 502, as it was before v8.)
 */

import {
  ConflictError,
  DeniedError,
  type EndpointError,
  InvalidArgumentError,
  MissingArgumentError,
  NotFoundError,
} from "../src/mod.ts";

/** The HTTP status an {@linkcode EndpointError} truthfully maps to. */
export function httpStatus(
  error: EndpointError,
): 400 | 403 | 404 | 409 | 502 | 503 {
  if (error instanceof DeniedError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  if (
    error instanceof InvalidArgumentError ||
    error instanceof MissingArgumentError
  ) {
    return 400;
  }
  return error.transient ? 503 : 502;
}
