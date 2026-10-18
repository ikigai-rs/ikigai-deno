# Changelog

## Unreleased — the core 0.1.108 failure classes (ledger #1897, step 2 of #1546)

New:

- **Error variants.** `RetryAfterError` (`delayMs`, optional, and `detail`),
  `OverBudgetError`, `RefusedError`, `UnsupportedError` (an optional `verb`) and
  `DepthExceededError`, each with Rust's `Display` form from `display()`.
- **`class()` and `kind()`** on every `EndpointError`: the seven classes
  `transient`, `retry-after`, `over-budget`, `denied`, `refused`, `permanent`,
  `unknown` (`FailureClass`, `FAILURE_CLASSES`). `transient` keeps its meaning
  (timeout and unavailable only): a `RetryAfterError` is **not** transient.
- **Wire, receive side only.** Error tags 9-13 decode (depth-exceeded 9,
  retry-after 10, over-budget 11, refused 12, unsupported 13). The protocol
  version stays 8, nothing sends 9-13 (a handler that throws one of the new
  errors crosses as `Endpoint(display)`, as to any v8 peer), and the `IssueWith`
  retry and deadline fields are not added. The payload layouts of 10 and 13
  follow serde field order (`delay_ms` then `detail`; `verb` then `detail`):
  ikigai-wire has not published them yet, so confirm them against wire v9.
- **Contracts.** `ActionSpecModel.failures` and `DescriptionModel.failures`
  (stated failure classes). They are digested LAST and only when stated, in the
  v2 form; an empty list is stated. `ik:mayFail` is written to the Turtle face,
  flat on the endpoint and per verb on each `ik:Action`. No existing contract
  IRI moves.
- Vectors: `tests/failure_class_vectors.json` (new) and the changed
  `tests/contract_vectors.json`, both byte-identical to ikigai-vocab 0.1.108's.

Behavior changes (the example apps' `httpStatus`, pinned to the vectors' edge
statuses):

- `EndpointError` (a handler failure) is **500**, was 502.
- `TimeoutError` is **504**, was 503. `UnavailableError` stays 503.
- `UnresolvedError` is **404**, was 502.
- New: `OverBudgetError` 422; `RetryAfterError` 429 with `Retry-After` in
  seconds, rounded up and never 0 (`retryAfterHeader`); `RefusedError` 502;
  `UnsupportedError` 405 with a verb, else 501; `DepthExceededError` 500.
- A failure tag above 13 still decodes as `Endpoint`; the "newer than protocol"
  text now names variant 14 or later in its example, not 9.
