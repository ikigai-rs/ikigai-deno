# ikigai-deno

A **zero-dependency** TypeScript (Deno-first) client and servable peer for the
[ikigai](https://github.com/ikigai-rs) wire protocol over Unix domain sockets.
This is **L0** of the polyglot ladder: no Rust, no core changes — a Deno process
can _drive_ a running ikigai kernel, and a Deno process can _be_ resources that
a Rust host mounts. It is the third implementation of the wire, sibling of
[ikigai-python](https://github.com/ikigai-rs/ikigai-python), and the first born
after the codec became a versioned public ABI.

A binding = client + servable peer space; the module mechanism IS
mount-over-wire.

Wire protocol version: **7** (`PROTOCOL_VERSION`) — the version (and mount mode)
cross the wire in a hello frame at connection open, so a mismatch is a clean
error naming both sides, and a served peer _knows_ which entries form its
mounter wants. Since v7 the hello is **required** (the v6 pre-hello tolerances
are gone), and failures cross with their **taxonomy intact**: a remote denial
arrives as `DeniedError`, a remote not-found as `NotFoundError`, a remote
timeout as a `TimeoutError` with `transient === true` — not a flattened string.

## Install

Nothing to install: Deno imports by specifier, and the core of this package has
zero runtime dependencies (`@std/assert` is test-only; the web frameworks in the
import map are used only by `examples/`; **zod** is a peer dependency of the
`./zod` entry point alone — nothing else imports it, so consumers who declare
`args:` explicitly never resolve it). Until it is published to JSR, import by
path or URL:

```ts
import { connect, endpoint, serve } from "./src/mod.ts";
```

### The host this README's examples require: `ikigai-cli` ≥ 0.1.18

The client examples below name resources in the **`urn:iki:`** namespace
(`urn:iki:fn:toUpper`). That namespace arrived in **`ikigai-cli` 0.1.18**, and
**nothing here can express that floor mechanically** — Deno resolves this
package, not the host binary, so there is no manifest field to put it in. On an
older host, a line copy-pasted from below fails with **"no endpoint resolved for
`urn:iki:fn:toUpper`"** and nothing points at the cause. That message _is_ the
symptom of too old a host.

```sh
cargo install ikigai-cli --locked     # the crate is `ikigai-cli`; the BINARY is `ikigai`
ikigai --plain -c 'source urn:iki:fn:toUpper in="hi"'   # -> HI
```

⚠ Not `cargo install ikigai` — that is an unrelated crate by another author, and
it installs successfully, which is the whole problem.

⚠ **The alias protects invocation, not observation.** A 0.1.18 host still
answers the old `urn:fn:` spelling — it carries an alias table
(`prefix urn:fn: urn:iki:fn:`) for the transition window — but it
**canonicalizes before the name is ever observed**. So every IRI coming back
_out_ is the new spelling no matter what you sent: catalog patterns, a trace
event's `target`, the `.iri` on an `UnresolvedError`. Client code that sends
`urn:fn:` and then **matches on what returns** compares its own string against
the host's rewrite of it, and fails while the resolution itself succeeds. That
is the sharp edge of the transition window, and it is why this client moved: you
may still write the old name, but you must read the new one.

Dev setup: `deno task check` runs the CI gates (`deno fmt --check` · `deno lint`
· `deno check` · `deno test -A`). The integration tests drive the real `ikigai`
binary and skip themselves when it is not on `PATH` (or at
`~/.cargo/bin/ikigai`) — and the `urn:iki:fn:` ones skip again, loudly, when the
binary predates 0.1.18, so an old host reports a floor rather than a failure.

## Client (the script front door)

```ts
import { connect } from "@ikigai/wire";

await using k = await connect(); // default socket path, same as the Rust CLI
const rep = await k.source("urn:iki:fn:toUpper", { in: "hi" });
rep.text; // "HI"
rep.mediaType; // "text/plain;charset=utf-8"
rep.cacheStatus; // how the server's cache answered (Hit/Miss/Uncacheable)
await k.sink("urn:file:notes.txt", "content goes as the `content` arg");
await k.exists("urn:file:notes.txt"); // "true" — the file the sink just wrote
await k.meta("urn:iki:fn:toUpper"); // self-description, text/turtle by default
await k.describe("urn:iki:fn:toUpper"); // the JSON Meta face, parsed — ArgSpecs and all
await k.entries(); // the catalog: [{ pattern, endpoint, origin }]
await k.isCached("urn:iki:fn:toUpper", { in: "hi" });
await k.sourceTraced("urn:iki:fn:toUpper", { in: "hi" }); // [rep, TraceEvent[]]
k.close(); // or let `await using` do it
```

Notes:

- `connect(path, { capability: Capability.scoped([...]) })` sends requests as
  `Call::IssueAs` under that capability; the server clamps it to the principal
  the channel authenticated.
- `k.serverVersion` is the version the server's hello declared — since v7 always
  a real number: the hello is required, and a peer that cannot speak it is
  refused at connect with a diagnosis (a hang-UP on the hello = pre-v6; mere
  SILENCE = hung/overloaded, bounded by the timeout — never misdiagnosed as
  ancient).
- Errors surface **typed** (wire v7): `UnresolvedError`, `MissingArgumentError`,
  `InvalidArgumentError` (with `.argument`/`.detail`), `DeniedError`,
  `NotFoundError`, `TimeoutError`, `UnavailableError` — all subclassing
  `EndpointError`, all carrying `.transient` (`true` only for
  timeout/unavailable, mirroring `ikigai_core::Error::is_transient`). Message
  texts render the way the Rust kernel would. An unknown FUTURE taxonomy variant
  degrades to the base `EndpointError`, naming the variant. A dead socket raises
  `ConnectionLost`; a hung server trips the read deadline (default 300 s — long
  resolutions are silent, so silence is not proof of death; same rationale as
  the Rust client).
- The client **reconnects**: after a `ConnectionLost`, the next call redials
  once (fresh hello, same mode) before failing — a restarted peer stops meaning
  failure-forever. A call is only ever retried when its SEND failed (the frame
  never left, so it cannot have executed); a call that was sent and lost its
  reply always fails without replay — the server may have executed it (the Rust
  transports' idempotency caution).
- The wire is strictly call/reply per connection, so concurrent calls on one
  client serialize internally — `Promise.all` of several sources is safe, just
  sequential.

## Serve (the peer-module seed)

```ts
import { endpoint, serve } from "@ikigai/wire";

const hello = endpoint("urn:ts:hello", {
  summary: "Greet someone",
  args: [{
    name: "who",
    required: true,
    class: "http://www.w3.org/2001/XMLSchema#string",
  }],
}, ({ who }) => `Hello, ${who}!`);

await serve([hello], "/tmp/ts.sock"); // blocks; speaks the wire protocol
```

Then from a Rust host:

```sh
ikigai --mount urn:ts:=/tmp/ts.sock -c 'source urn:ts:hello who=Ada'
# Hello, Ada!
ikigai --mount urn:ts:=/tmp/ts.sock -c list
# urn:ts:hello  → hello   [/tmp/ts.sock]
```

Or run the packaged demo: `deno run -A examples/demo.ts [socket-path]` — serves
`urn:ts:hello` + `urn:ts:shout` and prints the try-me mount line.

For the client side in an application shape, `examples/` also carries three
small web apps (Hono, Oak, Fresh) whose route handlers are thin faces over
`kernel.source(...)` — see [examples/README.md](examples/README.md).

What a served endpoint gets for free, because its describe face is real:

- **Named-arg routing**: the host engine fetches the JSON Meta face and routes
  `who=Ada` by the declared ArgSpecs — names, `required`/optional, `class` (XSD
  datatype or rdfs:Class IRI), `default`, `oneOf`.
- **Catalog membership**: `list` on the host shows the Deno endpoints with their
  mount origin.
- **Host-side caching**: declare `cacheable: true` on a pure function and the
  representation crosses the wire with `Expiry::Never` — the _host_ kernel
  caches it (this peer keeps no cache; `IsCached` answers false).
- **Tracing**: a traced resolution through the mount gets a span for the Deno
  invocation stitched into the host's execution tree.
- Meta faces: `text/turtle` (default — skolemized `ik:` graph, no blank nodes),
  `text/plain`, `application/json`.

### The hello retires the entries guessing

`--mount urn:ts:=<socket>` is an **alias** mount: the host rewrites
`urn:ts:hello` → `urn:hello` before forwarding, and re-prefixes catalog patterns
coming back. An `--override`/`--prefer` mount forwards IRIs unchanged. Pre-v6, a
served peer had to _guess_ which form `entries` should list; since v6 the
mounter's hello says its mode, and this server answers each connection with the
form that mounter wants — both mount styles list correctly against the same
server, no flags. Since v7 the hello is required, so there is no legacy default
left to configure: a client that connects without it is refused with a stderr
diagnosis.

### Typed errors and the HTTP faces (v7)

The taxonomy crossing the wire is what lets an HTTP face answer truthfully
instead of 502-for-everything — the three example apps share one mapping
(`examples/http_status.ts`): `DeniedError` → 403, `NotFoundError` → 404,
`InvalidArgumentError`/`MissingArgumentError` → 400, transient
(timeout/unavailable) → 503, anything else → 502. It also means a **served**
Deno endpoint can speak the taxonomy: throw `NotFoundError`/`DeniedError`/
`TimeoutError`/`UnavailableError` from a handler and it crosses as that variant
— a Rust host's failover will treat your `UnavailableError` as transient and
your `DeniedError` as final, and a zod validation failure crosses as a real
`InvalidArgument` naming the field.

### zod → ArgSpec (declare the contract once)

TS types are erased at runtime, so L0 ArgSpecs are explicit spec data. The
`./zod` entry point closes that gap: a `z.object(...)` is the ONE statement of
the input contract — the ArgSpecs derive from it, the same schema validates
every dispatch (before the handler), and the handler receives the parsed, typed
output:

```ts
import { z } from "zod";
import { endpoint } from "@ikigai/wire/zod";

const hello = endpoint("urn:ts:hello", {
  summary: "Greet someone",
  input: z.object({
    who: z.string().describe("the name to greet"),
    greeting: z.string().default("Hello"),
    mode: z.enum(["loud", "soft"]).optional(),
  }),
}, ({ who, greeting, mode }) => `${greeting}, ${who}!`); // typed, defaulted
```

The derivation: `z.string()` → xsd:string, `z.number()` → xsd:double (`.int()` →
xsd:integer), `z.boolean()` → xsd:boolean, `z.enum` → `one_of`, `.default(v)` →
optional + `default`, `.optional()` → optional, `.describe()` → the per-arg
summary. Anything else (arrays, nested objects, unions) throws at declaration
time — wire arguments are named text values, and a face that cannot say what it
takes would make the manifold lie. Bad input at dispatch is a clean endpoint
error naming the field; wire text is coerced by the declared type first (`"3.5"`
→ `3.5`, `"true"` → `true`), so handlers never `String(x)` anything. Explicit
`args:` still work everywhere (the core stays zero-dep); given BOTH, the
explicit specs win the describe face but are checked against the schema, loudly,
on any contradiction.

### Families and verbs

Two door features beyond "one exact IRI, one Source":

**A family** is a door over a URI template. It answers every IRI the template
matches, and each `{variable}` reaches the handler by name, beside the
arguments:

```ts
import { endpoint } from "@ikigai/wire";

const echo = endpoint("urn:ts:echo:{msg}", {
  bindings: { msg: { summary: "what to say" } },
}, ({ msg }) => msg); // urn:ts:echo:hi -> "hi"
```

**A multi-verb door** gives each verb its own contract — core's per-verb
`ActionSpec`. `family()` returns a builder; chain the verbs it answers:

```ts
import { family, NotFoundError } from "@ikigai/wire";

const marks = new Map<string, string>();
const cell = family("urn:ts:stored:{x}:{y}", { id: "stored" })
  .source({ cacheable: true }, ({ x, y }) => {
    const mark = marks.get(`${x},${y}`);
    if (mark === undefined) throw new NotFoundError(`nothing at ${x},${y}`);
    return mark;
  })
  .sink({}, ({ x, y, content }) => (marks.set(`${x},${y}`, `${content}`), "ok"))
  .delete({}, ({ x, y }) => (marks.delete(`${x},${y}`), "ok"));
```

The rules, stated once:

- **Matching is core's `UriTemplate`, ported exactly** (`src/template.ts` states
  it): a variable name is ASCII letters, digits and `_`; a variable followed by
  literal text captures up to the LEFTMOST next occurrence of that text (lazy,
  no backtracking); a final variable takes the whole remainder, `:` included; an
  empty capture is no match; adjacent variables (`{a}{b}`) are refused at
  declaration. Values are raw — no percent-decoding.
- **Order**: doors are tried in declaration order and the first match answers,
  like an `EndpointSpace`. Two doors with the same pattern text are refused.
- **The catalog lists the TEMPLATE** (`urn:ts:stored:{x}:{y} → stored`), so a
  host's `list`, its topology and the book's URN gate see the family.
- **Describe**: every variable is a required input with `source: "binding"`. A
  flat `endpoint()` lists them with its args (the `ttt-cell` shape); a
  `family()` puts them on every action, because an explicit action inherits
  nothing from the flat fields. Meta answers on ANY member, before a binding is
  validated — the host describes a template row by Meta on a probe expansion
  (`{x}` → `probe`).
- **Sink** receives the body as `content` — declared for you (required) if the
  Sink does not declare it, so the pipeline rule holds.
- **Exists**, unless declared, answers "would Source succeed": the Source
  handler runs, success is `true`, a `NotFoundError` is `false`, any other
  failure crosses as itself. A family with no Source and no Exists refuses
  Exists. (A flat `endpoint()` keeps its L0 Exists: `true`, handler not run.)
- **Cacheability is per verb**: a Source (or explicit Exists) may be
  `cacheable`; a Sink or Delete answer is never cacheable, even if the handler
  builds a `Representation` that says otherwise. The HOST kernel cuts the
  target's cached read after a Sink/Delete through its mount — nothing to do
  here.
- **An undeclared verb** is a typed refusal naming the ones the door answers:
  ``verb Delete is not supported by `ro` (it answers Source, Exists, Meta)``.
- **Alias mounts**: both forms answer, templates included — `--override`
  forwards `urn:ts:stored:1:2`, `--mount urn:ts:=` forwards `urn:stored:1:2`.
  The forms are tried in two passes, never door by door: every door's declared
  pattern first, then every door's stripped one (each pass in declaration
  order), so a stripped form cannot swallow another door's declared name — with
  `urn:a:{x}` declared before `urn:b:c`, a verbatim `urn:b:c` reaches `urn:b:c`,
  not `urn:{x}`. A connection whose hello declared an alias mount reverses the
  passes (stripped first). Same pattern text twice is refused only within one
  form; a declared pattern equal to another door's stripped one is allowed, and
  each answers its own kind of connection. ⚠ Stripped forms can still collide
  among themselves (`urn:a:{x}` and `urn:b:c` both answer a stripped `urn:c`,
  and declaration order decides) — first-segment stripping cannot tell them
  apart, so mount a family with `--override <its prefix>=<socket>`. This is the
  Python face's rule, matched exactly.
- **Bindings arrive as raw strings — the one intended difference from the Python
  face.** Python coerces a template binding by its annotation, so an `int`
  binding refuses a second spelling (`01`, `+1`, `-0`) library-wide, because a
  binding is part of the name and two names for one resource are two cache
  threads. JavaScript has no annotation to coerce by, and a `number` loses
  integers past 2^53, so here a store checks its own coordinates — as
  `examples/tictactoe_store.ts` does, with `BigInt` for the i64 range. (The
  reasoning is recorded as ikigai ledger item 580.)
- A variable and an argument with the same name are refused at declaration: a
  name has one source. (`./zod` endpoints take exact IRIs only.)

The worked example is the ikigai book's tic-tac-toe atom,
[`examples/tictactoe_store.ts`](examples/tictactoe_store.ts): the stored cell
`urn:iki:tutorial:ttt:stored:{x}:{y}`, served from Deno to a Rust host that
keeps everything above it (the platonic cell, lines, board, rules):

```sh
deno run -A examples/tictactoe_store.ts /tmp/ttt.sock
ikigai --override urn:iki:tutorial:ttt:stored:=/tmp/ttt.sock
# ikigai> sink urn:iki:tutorial:ttt:stored:1:1 X      ok
# ikigai> source urn:iki:tutorial:ttt:stored:1:1      X  [computed]
# ikigai> source urn:iki:tutorial:ttt:stored:1:1      X  [cached]
# ikigai> sink urn:iki:tutorial:ttt:stored:1:1 O      ok (cuts the cached read)
# ikigai> source urn:iki:tutorial:ttt:stored:1:1      O  [computed]
```

`tests/tictactoe_store_test.ts` runs that round trip against the installed host
and counts the reads that reached Deno.

### Handlers

- Receive their declared args as an object (utf-8 strings; raw `Uint8Array` when
  not valid utf-8), plus a family's template variables (always strings).
  By-reference arguments (`ArgRef::Reference` / `Content`) are refused loudly
  (as a typed `InvalidArgument`): an L0 peer has no back-channel to the host to
  dereference them. Handlers registered through `./zod` instead receive the
  schema's parsed, typed output.
- Return `string` or `Uint8Array` (typed by the endpoint's declared `output`), a
  `[value, mediaType]` tuple, or a full `Representation`. Async handlers are
  fine.
- A thrown error crosses the wire typed, never as a hang: the typed classes map
  to their own taxonomy variants; anything else crosses as an `Endpoint` error
  with its message preserved.
- Missing required arguments cross as a typed `MissingArgument`, rendering the
  exact error text the Rust kernel uses, so the host-side experience is native.

## Security posture

The socket is `0600` in a `0700` directory, and the kernel enforces that mode on
`connect` (Linux and macOS). **Unlike the Rust and Python servers, this one
cannot verify the connecting peer's UID**: Deno exposes no
`SO_PEERCRED`/`LOCAL_PEERCRED` API (and no `getsockopt` at all), so the
file-permission gate is the whole transport trust story here. Do not serve on a
path whose parent directory other users can traverse. A capability carried on
`IssueAs`/`IssueTraced` is accepted and surfaced (e.g. in trace spans) but **not
enforced per-scope** — capability-on-the-wire for IPC is a known TODO on the
Rust side too; do not treat a Deno peer as a capability boundary.

## Wire-protocol notes (for implementors)

`src/wire.ts` mirrors `ikigai-wire` (Rust) field-for-field; its doc comments
record the layout. Highlights a public ABI document should state:

- Framing: `u32` **big-endian** length +
  [postcard](https://postcard.jamesmunns.com) payload; 64 MiB frame cap, checked
  before allocation.
- **The hello** (required since v7): first frame each way is
  `"IKWH" + u32 BE version + u8
  mode` (deliberately not postcard), trailing
  bytes ignored — that is the extension mechanism. Golden vector:
  `IKWH\x00\x00\x00\x06\x01` (v6, alias). Mismatch → clean error naming both
  versions. The v6 one-version tolerances (client fallback without hello;
  serving a legacy first frame) are GONE: a hang-up on the hello is diagnosed
  pre-v6, silence is diagnosed as a hang, a magic-less first frame is refused.
- **`Reply::ErrorTyped`** (v7): postcard discriminant **5**; payload is the
  `WireError` enum in declaration order — `Unresolved(iri)`=0,
  `MissingArgument(name)`=1, `InvalidArgument{name, detail}`=2 (two strings,
  field order), `Endpoint(msg)`=3, `Denied(msg)`=4, `NotFound(msg)`=5,
  `Timeout(msg)`=6, `Unavailable(msg)`=7. Append-only. Timeout and Unavailable
  are the transient pair. The flat `Reply::Error`=3 remains decodable but a v7
  server never sends it.
- Enum discriminants are the **declaration index** as a varint — `Verb::Source`
  is `0` on the wire even though it is declared `#[repr(u8)] Source = 1` (those
  codes are only for identity hashing).
- `ContentId` crosses as the _string_ `b3:<hex>` (serde `into = "String"`), not
  32 raw bytes.
- `Representation.threads` (golden threads) is `#[serde(skip)]` — cache
  provenance never crosses the wire; `expiry` does, and drives host caching.
- Map/set order is Rust `BTreeMap`/`BTreeSet` order: lexicographic over UTF-8
  bytes (NOT JS's default UTF-16 code-unit sort — they differ beyond the BMP).
- u64 fields (times, spans, trace ids) are decoded exactly up to
  `Number.MAX_SAFE_INTEGER` (2^53 − 1); beyond that this implementation fails
  loud rather than lose precision. No value in practice comes close.

## License

MIT OR Apache-2.0, at your option.
