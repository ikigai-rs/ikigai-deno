/**
 * The wire-error → HTTP-status mapping the three example apps share.
 *
 * This is THE payoff of wire v7's typed errors: the taxonomy survives the
 * trip, so an HTTP face can answer the truthful status instead of a blanket
 * 502. The table is the edge column of core 0.1.108's shared
 * `failure_class_vectors.json`, which `tests/failure_class_test.ts` pins:
 *
 * | wire error                          | HTTP | why                          |
 * | ----------------------------------- | ---- | ---------------------------- |
 * | `InvalidArgumentError`              | 400  | the caller's input           |
 * | `MissingArgumentError`              | 400  | the caller's input           |
 * | `DeniedError`                       | 403  | permanent: no grant          |
 * | `NotFoundError`, `UnresolvedError`  | 404  | permanent: thing absent      |
 * | `UnsupportedError` with a verb      | 405  | the verb is not answered     |
 * | `ConflictError` (wire v8)           | 409  | permanent: state refuses     |
 * | `OverBudgetError`                   | 422  | the input exceeds a bound    |
 * | `RetryAfterError`                   | 429  | plus `Retry-After` seconds   |
 * | `EndpointError`, `DepthExceeded`    | 500  | the handler failed           |
 * | `UnsupportedError`, no verb         | 501  | the host lacks a facility    |
 * | `RefusedError`                      | 502  | the upstream refused us      |
 * | `UnavailableError`                  | 503  | retrying may succeed         |
 * | `TimeoutError`                      | 504  | retrying may succeed         |
 *
 * `ConflictError` is 409, not 412: the target's CURRENT STATE refused a
 * well-formed, authorized request (a move on an occupied square). 412 is
 * for a precondition the CALLER stated (`If-Match` / `If-None-Match`) and
 * stays the job of whatever evaluates those headers. Like the other
 * permanent kinds it is never 503 — retrying against the same state fails
 * the same way. (A v7 host downgrades Conflict to a plain `EndpointError`
 * reading `conflict: …`, so against one it is 500.)
 */

import {
  ConflictError,
  DeniedError,
  DepthExceededError,
  type EndpointError,
  InvalidArgumentError,
  MissingArgumentError,
  NotFoundError,
  OverBudgetError,
  RefusedError,
  RetryAfterError,
  TimeoutError,
  UnavailableError,
  UnresolvedError,
  UnsupportedError,
} from "../src/mod.ts";

/** The HTTP status an {@linkcode EndpointError} truthfully maps to. */
export function httpStatus(
  error: EndpointError,
): 400 | 403 | 404 | 405 | 409 | 422 | 429 | 500 | 501 | 502 | 503 | 504 {
  if (error instanceof DeniedError) return 403;
  if (error instanceof NotFoundError || error instanceof UnresolvedError) {
    return 404;
  }
  if (error instanceof ConflictError) return 409;
  if (
    error instanceof InvalidArgumentError ||
    error instanceof MissingArgumentError
  ) {
    return 400;
  }
  if (error instanceof OverBudgetError) return 422;
  if (error instanceof RetryAfterError) return 429;
  if (error instanceof RefusedError) return 502;
  if (error instanceof UnsupportedError) return error.verb === null ? 501 : 405;
  if (error instanceof TimeoutError) return 504;
  if (error instanceof UnavailableError) return 503;
  if (error instanceof DepthExceededError) return 500;
  return error.transient ? 503 : 500;
}

/**
 * The `Retry-After` header value for an error: the delay in whole seconds,
 * rounded up and never 0, or `null` when no header is sent (every error but
 * a {@linkcode RetryAfterError} with a delay).
 */
export function retryAfterHeader(error: EndpointError): number | null {
  return error instanceof RetryAfterError ? error.retryAfterSeconds() : null;
}
