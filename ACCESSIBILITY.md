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
| Last reviewed    | 2026-10-31                                                                                                                                                                                                                                                         |

## What it emits that people read

The published library (`src/`):

- **Errors.** The typed failures in `src/wire.ts` (`DeniedError`,
  `NotFoundError`, `ConflictError`, and the rest), whose `display()` prints the
  error as the Rust kernel's `Display` does (`denied: needs urn:cap:x`,
  `no endpoint resolved for urn:x:y`); `AuthError` in `src/auth.ts`, a stable
  code and a fixed sentence that never holds the credential
  (`bearer-token-syntax: a bearer token must be a non-empty RFC 6750 b64token`);
  and the protocol, decode and template errors (`ProtocolError`, `DecodeError`
  in `src/postcard.ts`, `TemplateError` in `src/template.ts`).
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
- **No color is written** anywhere in the library or the console line.

The page shell's `lang`, `main` and `nav` and the stylesheet's contrast are
followed by reading; the tests below pin the rest.

## How it is tested

- `tests/failure_class_test.ts` (`failure vectors: …`, one test per case) pins
  every typed error's `display()` against `tests/failure_class_vectors.json`, a
  verbatim copy of the vectors the Rust kernel's vocabulary crate commits;
  `tests/tictactoe_app_test.ts`
  (`a refusal reads as the Rust kernel's Display prints it`) pins the same forms
  where the example shows them.
- `tests/auth_test.ts` (`an AuthError never carries the credential`, and the
  refusal vectors) pins the auth errors.
- `tests/family_test.ts` (`flat endpoint over a template: …`) pins two input
  lines of the plain-text description.
- `tests/html_test.ts` pins the escaping and link rules against
  `tests/html_vectors.json`; `tests/tictactoe_app_test.ts` pins that the page
  loads `conflict.js`, that it writes with `textContent` and never `innerHTML`,
  that a hostile mark is escaped, and the sha256 of the vendored stylesheets.
- **No automated accessibility checker, browser or assistive technology has been
  used on this output.** No test pins the page shell's `lang`, `main` or `nav`,
  and the stylesheet's contrast is a comment, not a measurement made here.

## Known limitations

Found by reading the source on 2026-10-31, not by testing with people or
assistive technology:

- The Fresh example's page (`examples/fresh_app.ts`) has no `lang` and no
  `main`; its inputs are named only by a `placeholder`, with no `<label>`; and
  the region a result is swapped into is not a live region, so a screen reader
  is not told a result arrived.
- Decode and protocol errors are fragments that do not say what to do
  (`varint too long`, `invalid Option tag 0x…`, `unexpected reply to …`); they
  are meant for implementors, but they reach whoever calls the client.
- The plain-text description writes an input with no summary as a line ending in
  a bare colon, with nothing after it.

## Contributing

Read this file before changing any output listed above: an error's words, the
description face, the console line, or an example's page. Keep meaning in words,
keep `display()` equal to the shared vectors, and keep the page shell's `lang`,
`main` and headings. Say in the pull request what was tested, with what, and
what was not.

## Reporting a barrier

[Open an issue](https://github.com/ikigai-rs/ikigai-deno/issues/new?labels=accessibility)
with the `accessibility` label (the link sets it when GitHub lets you add
labels; otherwise a maintainer adds it): what you were doing, what happened, and
your browser or terminal and any assistive technology, if you are comfortable
sharing them. Anything security-sensitive goes through
[private vulnerability reporting](https://github.com/ikigai-rs/ikigai-deno/security/advisories/new).
**We acknowledge a report within 7 days**, and promise nothing further.

## Change history

| Date       | Change         |
| ---------- | -------------- |
| 2026-10-31 | First version. |
