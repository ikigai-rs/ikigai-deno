# Accessibility

What `ikigai-deno` emits that people read (error messages, a plain-text
description face, one console line, and the HTML of its examples), the rules
that output follows, how it is tested, and how to report a barrier. It is not a
conformance claim. Adapted from the
[ACCESSIBILITY.md template](https://github.com/mgifford/ACCESSIBILITY.md) (MIT).

| Field            | Value                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target           | WCAG 2.2 Level AA for the HTML this repository's examples write; the published library writes text only                                                                                                                                                            |
| Status           | Evaluation in progress. No conformance claim.                                                                                                                                                                                                                      |
| Owner            | the maintainers of this repository                                                                                                                                                                                                                                 |
| Report a barrier | [a GitHub issue](https://github.com/ikigai-rs/ikigai-deno/issues/new?labels=accessibility) with the `accessibility` label; anything security-sensitive through [private vulnerability reporting](https://github.com/ikigai-rs/ikigai-deno/security/advisories/new) |
| Last reviewed    | 2026-11-13                                                                                                                                                                                                                                                         |

## What it emits that people read

The published library (`src/`):

- **Errors.** The typed failures in `src/wire.ts` (`DeniedError`,
  `NotFoundError`, `ConflictError`, and the rest), whose `display()` prints the
  error as the Rust kernel's `Display` does (`denied: needs urn:cap:x`,
  `no endpoint resolved for urn:x:y`); `AuthError` in `src/auth.ts`, a stable
  code and a fixed sentence that never holds the credential
  (`bearer-token-syntax: a bearer token must be a non-empty RFC 6750 b64token`);
  and the protocol, decode and template errors (`ProtocolError`, `DecodeError`
  in `src/postcard.ts`, `TemplateError` in `src/template.ts`);
  `PercentDecodeError` in `src/html.ts`, whose message is the Rust
  `PercentDecodeError`'s `Display`
  (`percent_decode: malformed percent-escape at byte 2`). `FormPairsError` in
  the same module keeps Rust's form error message and the original input byte
  offset (`form_pairs: decoded bytes are not UTF-8 at byte 2`).
- **A plain-text description.** A served endpoint's Meta face, asked for as
  `text/plain` (`descriptionText` in `src/serve.ts`): its id and title, its
  verbs, one line per input (`input name [source] (optional): summary`), and its
  outputs.
- **One console line.** `serve` writes to stderr when it refuses a client that
  sent no version hello, naming both protocol versions and ending
  `Update the client.`
- **HTML helpers, not HTML.** `src/html.ts` escapes text and attributes and
  checks link targets for a caller that writes HTML; it writes no page itself.

The examples (`examples/`, not part of the published package):

- `examples/tictactoe_app.ts` serves a page around the tic-tac-toe game: the
  document shell (its `page` function), the vendored `host.css` and `ttt.css`,
  and `conflict.js`, which puts a refused move's sentence into the board's
  status region as text.
- `examples/fresh_app.ts` serves a page of forms and HTML fragments;
  `examples/hono_app.ts` and `examples/oak_app.ts` answer in plain text and
  JSON.

Not this repository's: the game's own views (`view:game`, the board, the status
region) and the stylesheets, which come from the ikigai tutorial's templates and
are vendored or resolved as they are; and the text of a failure a remote kernel
sends, which this package carries unchanged.

## The rules that output follows

- **A refusal reads as the Rust kernel prints it.** `display()` gives the same
  words for the same failure in every implementation, and an `AuthError` names
  the rule that was broken.
- **The tic-tac-toe page shell** has `<html lang="en">`, a viewport meta, a
  `<title>` and one `<h1>` naming the game, one `<main>` holding the game and a
  `<nav aria-label="Games">` of links with a heading; its stylesheet
  (`host.css`) is light by default and dark under `prefers-color-scheme: dark`,
  and its comment states that text and links clear 4.5:1 and rules 3:1.
- **A refused move is announced as text.** `conflict.js` writes the `409` answer
  into the status region with `textContent`, never as HTML, and the board is
  left as it was.
- **The Fresh example's pages** have `<html lang="en">` and one `<main>` holding
  the heading and content. Every form input has a visible `<label>` associated
  with its unique id; each result target has `aria-live="polite"` so updates can
  be announced without moving focus.
- **No color is written** anywhere in the library or the console line.

These are implementation rules, not evidence of accessibility. The results below
distinguish automated assertions from checks that have not run.

## How it is tested

Every named check has a result: Pass, Fail or Blocked, with evidence. A Pass
covers only the stated assertions, not overall accessibility or WCAG
conformance. An unrun check is Blocked. A historical run that CI does not repeat
must be Blocked with its date, not carried forward as Pass.

The automated checks below ran on 2026-11-13 with Deno 2.9.7 (V8
15.0.245.2-rusty, TypeScript 6.0.3), on main commit
[`a3dfdbd`](https://github.com/ikigai-rs/ikigai-deno/commit/a3dfdbd49e28e9f22805d3c33440be9e7b9729cd),
before this documentation change. Command:

```sh
deno test -A tests/failure_class_test.ts tests/auth_test.ts tests/family_test.ts tests/html_test.ts tests/tictactoe_app_test.ts tests/examples_fresh_test.ts
```

Result: 105 passed, 0 failed, 1 ignored. These suites run in CI's `test` job;
Rust-host parity is separate in `interop`. The tests assert strings, markup and
protocol behavior; they do not render pages or establish usability with
assistive technology. The results format follows
[gonk-starter PR 91](https://github.com/ikigai-rs/ikigai-gonk-starter/pull/91).

| Check                                                                         | Result  | Evidence                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed failure wording matches shared vectors                                  | Pass    | Command and Deno version above; `tests/failure_class_test.ts` compares typed failures with `tests/failure_class_vectors.json`; `tests/tictactoe_app_test.ts` checks refusal display forms. Does not assess whether the words help a person recover. |
| Auth refusal wording and credential exclusion                                 | Pass    | Command above; `tests/auth_test.ts`, including `an AuthError never carries the credential`, checks refusal vectors and credential exclusion. Does not test every caller's handling of errors.                                                       |
| Plain-text description input lines                                            | Pass    | Command above; `tests/family_test.ts`, `flat endpoint over a template: …`, checks required binding and optional argument lines. Does not assess the whole description's readability.                                                                |
| HTML escaping, link targets, percent-decoding and form errors                 | Pass    | Command above; `tests/html_test.ts` checks helpers and error messages against `tests/html_vectors.json`; `tests/tictactoe_app_test.ts` checks hostile-mark escaping. Does not evaluate rendered HTML.                                               |
| Refused move inserted as text                                                 | Pass    | Command above; `tests/tictactoe_app_test.ts` checks loading `conflict.js`, use of `textContent` rather than `innerHTML`, and refusal responses. Does not verify a screen reader announcement or browser focus behavior.                             |
| Vendored stylesheet and script integrity                                      | Pass    | Command above; `tests/tictactoe_app_test.ts` checks sha256 hashes of vendored assets. Byte identity does not establish contrast or accessibility.                                                                                                   |
| Fresh language, main landmark, input labels and live-result markup            | Pass    | Command above; `tests/examples_fresh_test.ts` checks index and catalog language/main markup and each index form's visible label, unique input id and polite result target. Does not verify accessible names or announcements in a browser.          |
| Decode and protocol errors explain recovery                                   | Fail    | Source review on 2026-11-13: `src/postcard.ts` still emits `varint too long`; `src/client.ts` emits `unexpected reply to …` without a recovery instruction. A wording limitation, not a determination of WCAG failure.                              |
| Description provides text after every input colon                             | Fail    | Command above; `tests/family_test.ts` explicitly asserts `input suffix [argument] (optional):` with no summary. Confirms the known readability limitation; the regression test itself passes.                                                       |
| Tic-tac-toe shell language, title, viewport, headings, main and navigation    | Blocked | Present in `examples/tictactoe_app.ts` by source reading; no dedicated assertions or browser evaluation of these shell features were run.                                                                                                           |
| Text and link contrast (4.5:1), rule contrast (3:1), light and dark themes    | Blocked | `examples/tictactoe_static/host.css` states these thresholds in a comment. No contrast measurement was run; asset hashes do not measure contrast.                                                                                                   |
| Library and console meaning independent of color; version-refusal instruction | Blocked | Source rules above describe plain text and `Update the client.` in `src/serve.ts`; no dedicated accessibility check of console output was run.                                                                                                      |
| Rust-host tic-tac-toe parity                                                  | Blocked | The command above ignored the parity test because no `ttt-host` binary was available. CI's `interop` job builds the pinned host and runs parity; local results do not establish that parity.                                                        |
| Browser rendering, zoom, 320 px reflow and theme behavior                     | Blocked | No browser evaluation was run for this review; no browser accessibility harness is configured here.                                                                                                                                                 |
| Manual keyboard navigation, focus visibility and focus after updates          | Blocked | No person performed a keyboard pass; no interactive browser session was available for this review.                                                                                                                                                  |
| Automated accessibility checker                                               | Blocked | No axe or other browser accessibility checker was run; none is configured in this repository's CI.                                                                                                                                                  |
| Screen reader                                                                 | Blocked | No screen reader session was available or used for this review. Live-region markup tests do not verify announcements.                                                                                                                               |
| Screen magnifier                                                              | Blocked | No magnifier session was available or used for this review.                                                                                                                                                                                         |
| Speech input                                                                  | Blocked | No speech-input session was available or used for this review.                                                                                                                                                                                      |
| Switch access                                                                 | Blocked | No switch-access session was available or used for this review.                                                                                                                                                                                     |
| Braille display                                                               | Blocked | No braille display was available or used for this review.                                                                                                                                                                                           |

## Known limitations

Found by reading the source on 2026-10-31 and confirmed on 2026-11-13 by source
review and the description regression test above, not by testing with people or
assistive technology:

- Decode and protocol errors are fragments that do not say what to do
  (`varint too long`, `invalid Option tag 0x…`, `unexpected reply to …`); they
  are meant for implementors, but they reach whoever calls the client.
- The plain-text description writes an input with no summary as a line ending in
  a bare colon, with nothing after it.

## Contributing

Read this file before changing any output listed above: an error's words, the
description face, the console line, or an example's page. Keep meaning in words,
keep `display()` equal to the shared vectors, and keep the page shell's `lang`,
`main` and headings. In the pull request, give each accessibility check a
`Check | Result | Evidence` row with Pass, Fail or Blocked, the command or test
and tool version, or why it could not run. Keep unrun assistive-technology
checks as Blocked. State the scope of each Pass; retain dates for historical
runs that CI does not repeat as Blocked.

## Reporting a barrier

[Open an issue](https://github.com/ikigai-rs/ikigai-deno/issues/new?labels=accessibility)
with the `accessibility` label (the link sets it when GitHub lets you add
labels; otherwise a maintainer adds it): what you were doing, what happened, and
your browser or terminal and any assistive technology, if you are comfortable
sharing them. Anything security-sensitive goes through
[private vulnerability reporting](https://github.com/ikigai-rs/ikigai-deno/security/advisories/new).
**We acknowledge a report within 7 days**, and promise nothing further.

## Change history

| Date       | Change                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-31 | First version.                                                                                                           |
| 2026-11-07 | Added Fresh page landmarks, input labels and polite live result regions, with regression tests.                          |
| 2026-11-13 | Recorded scoped Pass / Fail / Blocked results, baseline test evidence and unrun browser and assistive-technology checks. |
