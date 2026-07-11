# Contributing to inkcheck

Thanks for wanting to help. inkcheck is a QA tool for [ink](https://github.com/inkle/ink) stories — it verifies stories, it never writes prose. Contributions that keep it that way and make the checks sharper are very welcome.

## Development setup

```sh
git clone https://github.com/chaoz23/inkcheck
cd inkcheck
npm install
npm test        # tsc + node --test
```

`npm test` compiles TypeScript and runs the test suite (`test/**/*.test.js`). On first run, the tests (and the CLI) auto-download `inklecate`, the official ink compiler, into `~/.cache/inkcheck`. Set `$INKLECATE_PATH` to point at your own build if you have one.

Try it end to end:

```sh
npm run build
node dist/cli.js examples/manor.ink          # a story with a runtime error + dead knot
node dist/cli.js examples/broken.ink          # a story that fails to compile
node dist/cli.js examples/manor.ink --json    # machine-readable report
```

## What makes a good contribution

- **A failing test first.** Bugs and new checks should come with an `.ink` fixture in `examples/`, `test/fixtures/`, or inline in a test that demonstrates the case. The graph-walk logic is subtle; a reproduction fixture is worth more than a description.
- **Keep exit-code semantics stable.** `0` clean, `1` errors (or strict failures), `2` usage. CI and other agents depend on these.
- **Keep `--json` output backward-compatible** where you can — it's a machine interface. Additive changes are fine; renames/removals need a note in the PR.
- **No prose generation, ever.** Features that author or rewrite story content are out of scope by design.

## Good first issues

- Additional `.ink` fixtures that stress bounded exploration (loops, deep nesting, randomness, heavy `EXTERNAL` use).
- Localization / tag lint (untagged lines, inconsistent tag schemas) — see the roadmap in the README.
- State assertions (e.g. "gold must never go negative on any path").

## Pull requests

- Run `npm test` and make sure it's green (CI runs on ubuntu + macos, Node 22).
- Keep PRs focused; one check or fix per PR is easiest to review.
- Describe the story pattern your change catches or fixes.

## Search-strategy benchmarks

Search changes should use `summarizeSearchResult()` from `src/search-benchmark.ts`
against the adversarial fixtures in `test/fixtures/search/`. The deterministic
summary deliberately keeps three ideas separate:

- visible ending outcomes, runtime errors, and authored knots are useful findings;
- exact terminal states retain final-variable differences;
- variable snapshots and transitions are novelty signals, not automatically new endings.

Keep elapsed time outside deterministic snapshots. Also keep missing variable
values as `<absent>`: inkjs can omit an unchanged declaration default from
`variablesState`, and only source-aware analysis can safely interpret that as a
specific value such as `false` or `0`.

## Reporting bugs

Open an issue with the smallest `.ink` file that reproduces it and the command you ran. "inkcheck missed X" and "inkcheck falsely reported Y" are both valuable — false positives are bugs too.

MIT-licensed; by contributing you agree your work ships under the same license.
