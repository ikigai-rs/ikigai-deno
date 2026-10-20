# Changelog

## Unreleased — interop follows ikigai-cli 0.1.67: a run reaches a `--prefer` peer (ledger #1991)

- **CI `interop` job** pins `IKIGAI_CLI_VERSION` 0.1.67.
- **The door changed, tests followed** (ikigai-cli 0.1.67, ledger #1942): a
  `--prefer` mount now forwards a v9 client's run deadline to the peer as time
  left; the retry budget still stops at the door, by design. The two real-door
  run tests now pin that: the peer's `RunContext` has `retriesLeft` null and a
  deadline within the 10 s sent (a tolerance, never an exact value), and a spent
  deadline arrives as zero time left and is still answered. The face's bytes
  needed no change.

## Unreleased — interop against the real door at ikigai-cli 0.1.66 (ledger #1925)

- **CI `interop` job** (NOT in this PR: the worker token lacks the `workflow`
  scope; the patch is in the PR description): builds `ikigai-cli` 0.1.66 (cached
  by version, `IKIGAI_CLI_VERSION`) and runs the whole suite with it on `PATH`,
  so the host-backed tests run instead of skipping. The old `test` job still
  skips them.
- **Real-door IssueWith tests**: a v9 client with a run is answered by
  `ikigai
  serve`; the face's bytes needed no change. Observed, not a face bug:
  0.1.66 does not forward the run to a mounted peer, nor enforce a spent
  deadline.
- **The door changed, tests followed**: 0.1.64 (the first release with the rule;
  the interop job pins 0.1.66) holds every mounted read as `Expiry::Always`
  (`as_held_here`), so the host never answers HIT for a Deno peer; the three
  tests asserting host-side caching now assert the new rule. The face's
  `cacheable: true` bytes (`Expiry::Never`) were correct throughout.
- The HTTP statuses the Rust edge returns (504, 429 + Retry-After, 422, 502,
  405/501) are not asserted anywhere in this repo; the statuses tested here are
  this face's own mapping.

## Unreleased — wire v9: IssueWith and the failure classes on send (ledger #1915, step 2 of #1546)

- **`PROTOCOL_VERSION = 9`** (`MIN_PROTOCOL_VERSION` stays 7). Negotiation is as
  before: a v7 or v8 peer is spoken to at its own version.
- **`Call::IssueWith` (variant 5)** decodes and encodes: `trace`, `retries`,
  `time_left_ms`, each optional (`IssueWith`, `encodeIssueWith`). **The deadline
  is time left in whole ms, never an absolute instant**: a server adds it to its
  OWN now.
- **Server.** A handler's second argument is a `RunContext` (`retriesLeft`,
  `deadline` on the server's clock, `timeLeftMs()`); a peer that sends none gets
  `NO_RUN`, today's behavior. `issueWith` with no trace records none.
- **Client.** `ConnectOptions.run` / `Client.run` (`{ retries, deadline }`): the
  client sends `IssueWith` only to a peer that negotiated 9 and only when a
  retry budget or deadline is set; otherwise the exact pre-v9 `Issue`/`IssueAs`/
  `IssueTraced` bytes.
- **Failure classes are now sent.** A thrown `RetryAfterError` etc. crosses as
  tags 9-13 to a v9 peer; `replyForPeer` downgrades them to `Endpoint(display)`
  for a v7/v8 peer, byte-identical to before. (This replaces the receive-only
  note below; `toWireFailure` now returns the typed class.)
- Interop against the real Rust door at ikigai-cli 0.1.66 is pending its
  publication (0.1.65 is the latest published).

## Unreleased — a refused move is a 409 (ledger #1911, from #585 step 5)

Changed:

- **`examples/tictactoe_app.ts`**: a typed `ConflictError` from a move (a taken
  square, a finished game, the wrong mark) is no longer swallowed by `reply()`;
  the app answers `409` with the `text/plain` body `conflict: {msg}`, as
  `ttt-host` does (ikigai-tutorial #138). Off the board stays an
  `InvalidArgument`, answered `200` with its text. The page loads
  `/static/conflict.js` (vendored from the tutorial's host), which swaps a 409
  into the status region as text; the next successful play restores the status.

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
