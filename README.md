# ikigai-deno

A **zero-dependency** TypeScript (Deno-first) client and servable peer for the
[ikigai](https://github.com/ikigai-rs) wire protocol over Unix domain sockets.
This is **L0** of the polyglot ladder: no Rust, no core changes — a Deno process
can _drive_ a running ikigai kernel, and a Deno process can _be_ resources that
a Rust host mounts.

A binding = client + servable peer space; the module mechanism IS
mount-over-wire.

Implementation lands via PR; this is the repo skeleton.

## License

MIT OR Apache-2.0, at your option.
