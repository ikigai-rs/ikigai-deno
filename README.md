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

Wire protocol version: **6** (`PROTOCOL_VERSION`) — the version (and mount mode)
cross the wire in a hello frame at connection open, so a mismatch is a clean
error naming both sides, and a served peer finally _knows_ which entries form
its mounter wants.

## Install

Nothing to install: Deno imports by specifier, and this package has zero runtime
dependencies (`@std/assert` is test-only; the web frameworks in the import map
are used only by `examples/` — `src/` imports nothing). Until it is published to
JSR, import by path or URL:

```ts
import { connect, endpoint, serve } from "./src/mod.ts";
```

Dev setup: `deno task check` runs the CI gates (`deno fmt --check` · `deno lint`
· `deno check` · `deno test -A`). The integration tests drive the real `ikigai`
binary and skip themselves when it is not on `PATH` (or at
`~/.cargo/bin/ikigai`).

## Client (the script front door)

```ts
import { connect } from "@ikigai/wire";

await using k = await connect(); // default socket path, same as the Rust CLI
const rep = await k.source("urn:fn:toUpper", { in: "hi" });
rep.text; // "HI"
rep.mediaType; // "text/plain;charset=utf-8"
rep.cacheStatus; // how the server's cache answered (Hit/Miss/Uncacheable)
await k.sink("urn:file:notes.txt", "content goes as the `content` arg");
await k.exists("urn:file:notes.txt"); // "true" — the file the sink just wrote
await k.meta("urn:fn:toUpper"); // self-description, text/turtle by default
await k.describe("urn:fn:toUpper"); // the JSON Meta face, parsed — ArgSpecs and all
await k.entries(); // the catalog: [{ pattern, endpoint, origin }]
await k.isCached("urn:fn:toUpper", { in: "hi" });
await k.sourceTraced("urn:fn:toUpper", { in: "hi" }); // [rep, TraceEvent[]]
k.close(); // or let `await using` do it
```

Notes:

- `connect(path, { capability: Capability.scoped([...]) })` sends requests as
  `Call::IssueAs` under that capability; the server clamps it to the principal
  the channel authenticated.
- `k.serverVersion` is the version the server's hello declared — `null` when a
  pre-v6 server was reached through the fallback (reconnect without the hello,
  with a loud warning; the tolerance goes away at wire v7).
- Errors surface as `EndpointError` carrying the server's error string
  (`endpoint error:` prefix stripped, as the Rust wire clients do). A dead
  socket raises `ConnectionLost`; a hung server trips the read deadline (default
  300 s — long resolutions are silent, so silence is not proof of death; same
  rationale as the Rust client).
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

### The hello retires the entries guessing (v6)

`--mount urn:ts:=<socket>` is an **alias** mount: the host rewrites
`urn:ts:hello` → `urn:hello` before forwarding, and re-prefixes catalog patterns
coming back. An `--override`/`--prefer` mount forwards IRIs unchanged. Pre-v6, a
served peer had to _guess_ which form `entries` should list; since v6 the
mounter's hello says its mode, and this server answers each connection with the
form that mounter wants — both mount styles list correctly against the same
server, no flags. `stripAlias` (and the demo's `--verbatim`) only set the
default for legacy (<= v5) clients that cannot say.

### Handlers

- Receive their declared args as an object (utf-8 strings; raw `Uint8Array` when
  not valid utf-8). By-reference arguments (`ArgRef::Reference` / `Content`) are
  refused loudly: an L0 peer has no back-channel to the host to dereference
  them.
- Return `string` or `Uint8Array` (typed by the endpoint's declared `output`), a
  `[value, mediaType]` tuple, or a full `Representation`. Async handlers are
  fine.
- A thrown error crosses the wire as `endpoint error: …` — never a hang.
- Missing required arguments are reported with the exact error text the Rust
  kernel uses, so the host-side experience is native.

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
- **The v6 hello**: first frame each way is
  `"IKWH" + u32 BE version + u8
  mode` (deliberately not postcard), trailing
  bytes ignored — that is the extension mechanism. Golden vector:
  `IKWH\x00\x00\x00\x06\x01` (v6, alias). Mismatch → clean error naming both
  versions. One-version tolerances (client fallback without hello; serving a
  legacy first frame) disappear at v7.
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
