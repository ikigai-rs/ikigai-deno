# REST faces over the ikigai wire client

Three small web apps, one pattern: **a framework handler is a thin face over
`kernel.source(...)`**. The framework does HTTP (routing, parameter validation,
status codes); ikigai does resolution (naming, arguments, caching,
self-description). The demo endpoints are humble — hello / upper / reverse —
because the point is the wiring, not the endpoints.

| module         | framework                         | the face it shows                                                                                                       |
| -------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hono_app.ts`  | [Hono](https://hono.dev)          | typed routes — the validator middleware is the contract, the closest Deno analog to an ArgSpec                          |
| `oak_app.ts`   | [Oak](https://oakserver.org)      | the minimal end — a router and middleware, `ctx.throw(400)` as the whole input contract                                 |
| `fresh_app.ts` | [Fresh](https://fresh.deno.dev) 2 | the hypermedia face — server-driven HTML + htmx, a form per endpoint, an HTML catalog (programmatic `App`, no scaffold) |

Every app serves the same surface:

- `GET /hello/:who` → resolves `urn:ts:hello`
- `GET /upper?text=…` → resolves `urn:ts:upper`
- `GET /reverse?text=…` → resolves `urn:ts:reverse`
- `GET /catalog` → `kernel.entries()` as JSON (HTML in Fresh) — the app
  _discovers_ what it can reach instead of hard-coding it
- wire errors arrive **typed** (v7) and map to truthful statuses (shared mapping
  in `http_status.ts`): `DeniedError` → **403**, `NotFoundError` → **404**,
  `InvalidArgumentError`/`MissingArgumentError` → **400**, transient
  (timeout/unavailable) → **503**, anything else → **502**; a `ConnectionLost` →
  **503** ("is the peer running?")
- the cache verdict is visible: an `X-Ikigai-Cache` response header in Hono and
  Oak, printed in each result fragment in Fresh

`examples/endpoints.ts` is the endpoint set they resolve: three
`endpoint()`-defined pure functions, `cacheable: true`, ArgSpecs declared.
(`examples/demo.ts` is the separate two-endpoint mount demo from L0.)

## Setup

Nothing to install: the frameworks come from JSR/npm on first run (they are
example-only dependencies — `src/` itself still imports nothing).

Each app reads the kernel socket path from `IKIGAI_SOCKET`, defaulting to
`defaultSocketPath()` — the Rust CLI's per-user socket.

## Run mode 1: direct (pure Deno, no Rust)

Point an app straight at a served Deno space:

```sh
deno run -A examples/endpoints.ts /tmp/ts-examples.sock &
IKIGAI_SOCKET=/tmp/ts-examples.sock deno run -A examples/hono_app.ts
# …or examples/oak_app.ts, or examples/fresh_app.ts
curl localhost:8000/hello/Ada          # Hello, Ada!
curl 'localhost:8000/upper?text=roc'   # ROC   (X-Ikigai-Cache: MISS every time)
curl localhost:8000/catalog
```

There is no cache in this mode: the Deno peer computes every request and
`X-Ikigai-Cache` stays `MISS` (`cacheable: true` only _marks_ the result).

## Run mode 2: through the kernel (the same call, plus caching)

Put a Rust kernel in the middle and let IT own the topology — the REST call then
traverses **Deno app → Rust kernel → mount → Deno peer**, and the kernel caches
the pure results:

```sh
deno run -A examples/endpoints.ts /tmp/ts-examples.sock &
ikigai serve /tmp/kernel.sock --prefer urn:ts:=/tmp/ts-examples.sock &
IKIGAI_SOCKET=/tmp/kernel.sock deno run -A examples/hono_app.ts
curl -i 'localhost:8000/upper?text=roc'   # X-Ikigai-Cache: MISS
curl -i 'localhost:8000/upper?text=roc'   # X-Ikigai-Cache: HIT — the kernel cached the peer's result
```

Nothing in the app changed — same code, same IRIs; only `IKIGAI_SOCKET` moved.
`/catalog` now lists the kernel's whole space (`urn:fn:*`, `urn:kernel:*`, …)
with the `urn:ts:*` entries composed in.

## Connection lifecycle

Each app opens **one** wire connection in `createApp()` and holds it for the
app's lifetime — never per request. A single `Client` serializes concurrent
round trips internally (the wire is strictly call/reply per connection); that is
a deliberate simplification at example scale — a pool would be the next step,
not a different pattern. There is no automatic reconnect either: a peer that
dies mid-life turns requests into 503s until the app restarts.

## Tests

`tests/examples_*_test.ts` smoke-test each app with its framework's own
in-process dispatch (Hono `app.request()`, Oak `app.handle()`, Fresh
`app.handler()`) against an in-process `serve()` space on a temp socket — the
whole stack (HTTP → handler → wire → served space) is pure Deno, so it runs on
CI with no Rust binary. `tests/examples_integration_test.ts` adds run mode 2
against the real `ikigai` binary (MISS → HIT through a `--prefer` mount) and
skips itself when the binary is absent.
