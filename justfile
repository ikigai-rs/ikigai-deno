# ikigai-deno local gates.
#
# `just gates` runs exactly what .github/workflows/ci.yml runs, in the same order:
# `deno fmt --check`, `deno lint`, `deno check` over the entry points and examples,
# then `deno test -A`. One source of truth: the commands are the `tasks` of
# deno.json, CI runs them one step per task, and `deno task check` chains the same
# four with `&&`, so it stops at the first failure and its exit status is the
# failing command's own. Nothing here needs more than Deno itself.
#
# The devtools gates (`just -f ~/git-personal/ikigai-devtools/justfile gates`) find
# this recipe because the repo has no Cargo.toml, and run it with a full log and a
# real exit status. Do not call those gates from here: they refuse to loop.
#
# Integration tests that drive the real `ikigai` binary skip themselves when it is
# absent (as on CI), so a local run with it installed covers MORE than CI does.

# Format check, lint, type-check, test (the deno.json tasks CI runs).
gates:
    deno task check
