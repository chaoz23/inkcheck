# inkcheck

**Mechanical QA for [ink](https://github.com/inkle/ink) stories.** Compile checks, bounded systematic branch exploration, runtime-error repro paths, and dead-content detection — as a standalone CLI for writers and teams, with optional CI and MCP integrations.

inkcheck is a QA tool, not a writing tool. It does not generate, rewrite, or send away a word of prose. It exists so that the story *you* wrote can be checked mechanically: compile it with ink's official compiler, explore choice paths within explicit limits, and reproduce failures before a player finds them.

## Does it use AI?

No. inkcheck itself does not use AI, machine learning, LLMs, or generative models to test stories. It does not train on your source, infer prose changes, rewrite story text, or send story content to an AI service.

It is designed so humans, CI systems, and optional AI coding agents can all drive the same mechanical QA checks. The actual checking is deterministic code: the official ink compiler, the ink runtime, bounded branch exploration, and structured reports.

## Product promise

Inkcheck is bounded mechanical QA for ink stories. It does not prove that every path works in a large story. It deterministically explores reachable story states within explicit limits, reports exact repro paths for the issues it finds, and shows where — and why — coverage was partial, so authors can use it as cheap, repeatable regression insurance.

Inkcheck will not prove that a large interactive story has no bugs. Combinatorial explosion is real: loops, variables, randomness, and host-game code can create more possible states than any tool can exhaustively visit.

The promise is narrower and more useful: make mechanical story QA cheap, repeatable, and actionable. Inkcheck walks real reachable choice states within explicit limits, tells you when the run was partial, and turns failures into repro paths you can run again after a fix. If it finds a broken path today, that same configured check should be able to look for that path again tomorrow.

This is an open-source QA project because that boundary matters. If a report overclaims, misses an obvious pattern, needs a better traversal strategy, or fails on a story shape you can share safely, please bring a fixture or issue. The roadmap is about making partial coverage more transparent and more valuable, not pretending partial coverage becomes proof.

## Quick start

With Node.js 18 or newer:

```sh
npx -y inkcheck path/to/main.ink
```

No global install is required. The first run downloads the pinned official ink compiler, verifies its SHA-256 hash, and processes the story locally.

Want to see the failure-path report before trying your own story? Run the [two-minute synthetic demo](docs/two-minute-demo.md).

## Hosted checker

The repository now includes a self-hosted web interface for writers who do not want to use a terminal. Hosted mode temporarily uploads authorized `.ink` source, creates a short-lived private job, streams real phase and work-budget progress, and deletes the temporary job directory after completion, cancellation, or failure. It does not make reports public or retain story text in application logs. Optional first-party usage metrics keep only daily aggregate counts and can produce unattended weekly reports without an analytics vendor.

The local CLI remains the privacy-first option because no story upload occurs. See [Hosted checker deployment](docs/hosted-checker.md) for the threat model, Docker deployment, operating limits, and a current sub-$50/month budget.

## What it catches

- **Compile errors and warnings** — broken diverts, unresolved variables, loose ends, with file and line numbers (via [inklecate](https://github.com/inkle/ink/releases), the official compiler)
- **Runtime errors with a reproduction path** — the exact sequence of choices that triggers a divide-by-zero, a bad external call, or out-of-content, e.g. `repro: [Enter in darkness → Descend to the cellar]`
- **Unvisited content, triaged** — knots no explored path visits within the configured limits, each classified with an inbound-divert scan: "no authored divert points here — possible orphan" versus "has inbound diverts — likely beyond this run's limits"
- **Distinct terminal states** — with a choice trail that reaches each one; differing final variables are retained as distinct outcomes

## vs. the alternatives

| | Catches syntax errors | Explores choice branches | Finds unvisited content | Repro path for crashes | Runs in CI |
| --- | :---: | :---: | :---: | :---: | :---: |
| **`inklecate` (compiler)** | ✓ | — | — | — | ✓ |
| **Manual playtesting** | — | only what you click | by luck | if you remember your clicks | — |
| **Ink-Tester** | ✓ | random repeated runs | line coverage | limited | manual/CLI |
| **inkcheck** | ✓ | systematic + seeded random, bounded | knot coverage | ✓ | ✓ |

The compiler tells you the story is *valid*. Clicking through tells you the paths you *happened to click* work. [Ink-Tester](https://github.com/wildwinter/Ink-Tester) repeatedly samples random playthroughs and reports line-level frequency; inkcheck instead walks choice states systematically and returns short failure paths. The key difference is repeatability: after you fix a reported path, the same configured run can check that path again. The approaches are complementary, especially for stories with randomness or engine integrations.

## Example

```
$ inkcheck examples/manor.ink
✓ compiled — 92 words, 7 knots, 6 choices
✓ explored 18050 states within limits (depth 30, 100000 states, seed 1) — exhaustive (every reachable state visited) — 5 distinct terminal state(s)
    terminal via [Enter in darkness → Search the study → Leave with your loot]: "You slip out the servant door, heavier by half a purse."
    ...
✗ 1 runtime error(s):
    obj is null or undefined (at cellar.3)
      repro: [Enter in darkness → Descend to the cellar] (found by dfs:last)
⚠ 1 knot(s) never visited on any explored path — unreached is not necessarily unreachable:
    treasure_vault (manor.ink line 35) — no authored divert points here — possible orphan
```

When a run is cut short, the report names the limit that actually bound it — for example `⚠ coverage is partial, not a proof — paths were cut at 30 choices deep; raise --max-depth to follow longer trails`. Depth and state budget are separate axes: in local runs on *The Intercept*, raising `--max-depth` from 30 to 100 reached more late-story content with a 1,000,000-state budget than a 10× larger budget did at depth 30.

Exit code is non-zero on compile or runtime errors. Add `--strict` to also fail on warnings, unvisited knots, truncation, or external stubs, so partial coverage cannot silently pass CI.

Large stories can exceed the defaults. On inkle's published [*The Intercept*](https://github.com/inkle/the-intercept), inkcheck marks the report as truncated even when the state budget is raised well beyond the default. That is a useful partial check, not proof of complete coverage; increase the limits deliberately and keep the limitation visible in CI. The hosted checker uses a 100,000-state default and asks authors to file an issue if that still is not enough.

Within a single run, inkcheck spends its state budget across complementary search passes rather than betting everything on one traversal order. The current CLI portfolio explores last-choice-first, first-choice-first, and inside-out DFS slices, adds a seeded random-sampling slice that varies early-choice prefixes the deterministic passes tend to repeat, adds a frontier-capped diversity beam that advances level-by-level like BFS while keeping one state per variable-signature lineage, then reserves a small breadth-first slice to shorten repro paths. The random slice uses a fixed default seed and the beam needs no seed at all, so runs stay reproducible in CI; every reported ending and runtime error names the pass (and seed) that found it. This often finds more endings and reachable knots at the same `--max-states` limit, but it is still bounded QA: a truncated report is useful evidence, not an exhaustive proof.

### Bounded search vs random sampling

Inkcheck is not a promise to visit every possible state in a non-trivial story. Branches, loops, variables, random behavior, and host-game integrations can make exhaustive coverage physically impractical. Its practical advantage over random sampling is reproducibility: given the same story and limits, inkcheck walks the choice graph systematically, returns exact choice paths for failures, reports unvisited-knot clues, and says explicitly when the run was partial.

Random sampling remains useful, especially for stories with randomness or huge state spaces. Treat the approaches as complementary: random play can stumble into surprising paths, while inkcheck gives deterministic CI-friendly evidence inside a declared budget.

In a local test of *The Intercept* at the default depth of 30, higher budgets found more terminal states but still did not prove complete coverage. Timings are from one local development machine and should be read as scale evidence, not a universal benchmark:

| State budget | Time | Distinct terminal states | Runtime errors | Unvisited knots | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 50,000 | 9.4s | 7 | 0 | 9 | truncated |
| 100,000 | 19.9s | 10 | 0 | 9 | truncated |
| 500,000 | 100.2s | 17 | 0 | 8 | truncated |
| 1,000,000 | 205.5s | 25 | 0 | 8 | truncated |

That is the intended interpretation: each run tests real reachable states and can surface real broken paths, but a truncated report is evidence about what was visited, not proof that everything was reachable or correct.

## MCP server

Four tools for AI agents working on ink stories:

| Tool | What it does |
| --- | --- |
| `compile_story` | Structured compile issues (severity, file, line) |
| `story_stats` | Word/knot/choice counts + full knot list with locations |
| `playtest_story` | Play one scripted choice path headlessly; returns transcript, tags, variables, errors |
| `explore_story` | Bounded systematic walk: terminal states, error repro paths, knot coverage, limitations |

Add to Claude Code:

```sh
claude mcp add inkcheck -- npx -y inkcheck mcp
```

or to any MCP client config:

```json
{
  "mcpServers": {
    "inkcheck": { "command": "npx", "args": ["-y", "inkcheck", "mcp"] }
  }
}
```

The intended loop for an agent editing a story: edit `.ink` → `compile_story` → `explore_story` → fix what it reports → repeat. The agent never has to guess whether a story graph is sound.

## CLI

```
inkcheck <story.ink> [--max-depth N] [--max-states N] [--seed N] [--auto] [--profile] [--next] [--no-min-repro] [--strict] [--progress=auto|human|ndjson|off] [--human|--json|--markdown]
inkcheck mcp    # start the MCP server on stdio
```

`--max-depth` accepts 1–1,000 and `--max-states` accepts 1–1,000,000. These hard ceilings prevent malformed automation inputs from accidentally disabling the exploration bounds. The default state budget is 100,000.

`--max-states` is a total budget for the run, not a promise that one single DFS walk will spend all states. By default the CLI divides most of that budget across three complementary DFS views of the choice tree plus a seeded random-sampling slice, and keeps a small breadth-first slice for shorter failure and ending repro paths. Use `--no-min-repro` to spend that repro slice on the DFS portfolio instead when breadth-first shortening is less important than broader search.

`--seed` (default 1) controls the random-sampling slice. The same seed always samples the same walks, so CI results stay reproducible; change the seed across scheduled runs to sample different early-choice combinations over time. Each finding's `foundBy` field in `--json` output names the pass that discovered it, e.g. `dfs:last` or `random:seed=1`.

`--max-memory <mb>` caps how much heap the run may use before it stops cleanly. A V8 heap out-of-memory abort cannot be caught after the fact, so inkcheck watches memory during exploration and — before it would crash — stops, keeps everything found so far, and reports `truncatedBy.memory` with a partial report rather than losing the run. The default cap is 85% of the V8 heap limit (which honors any `NODE_OPTIONS=--max-old-space-size` you set), so large runs on modest hardware degrade gracefully instead of dying; pass an explicit value to tighten or loosen it. On a memory stop the `nextRun` verdict is `investigate` (raise `--max-old-space-size`, lower `--max-states`, or split the story) — never `broaden`, since more budget would only hit the wall sooner.

`--profile` prints a cheap static shape profile of the story — variables and where they are assigned, choice density, the longest divert path — plus the depth limit and pass weights inkcheck would choose for that shape, without running any exploration. `--auto` applies those suggestions: it raises `--max-depth` when static divert paths outrun the default (never lowers it, and your explicit flags always win) and hands the profile's pass weights to the portfolio. On a story whose main path is 40 choices deep, default settings find nothing while `--auto` reaches the ending and proves the story exhaustive in ~111 states.

Interactive terminals show a concise live progress line by default: real phase, states explored against the configured **work budget**, discoveries, and elapsed time. `--progress=human` forces readable snapshots for CI logs; `--progress=ndjson` writes versioned events for agents and parsers; `--progress=off` silences progress. None of these percentages claim story coverage. The final stdout report remains authoritative, and progress never includes story prose, choices, variables, or source snippets.

Every report also carries a `nextRun` verdict — a small closed vocabulary (`stop`, `deepen`, `broaden`, `reseed`, `investigate`) computed deterministically from the report itself, with concrete flags, a rationale that cites the fields it used, and the evidence-backed expected gain. `--next` acts on it: after the check, inkcheck applies the recommended escalation and reruns, up to three times, stopping on a `stop`/`investigate` verdict, at the flag ceilings, or when an escalated run finds nothing new (fixpoint). The per-run trail lands in `--json` output as `runs`; hop narration goes to stderr so machine output stays clean. Recommendations never exceed the documented hard ceilings — when no flag increase has evidence behind it, the verdict degrades to `investigate` and points at the knots worth reviewing.

GitHub Actions:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- name: Check the story and publish a readable summary
  shell: bash
  run: |
    set -o pipefail
    npx -y inkcheck story/main.ink --strict --markdown | tee -a "$GITHUB_STEP_SUMMARY"
```

`--strict` fails not only on warnings and unvisited knots, but also when exploration is truncated or an `EXTERNAL` function had to be stubbed. This prevents a partial check from wearing a green “complete” badge.

See the [InkJam QA guide](docs/inkjam-qa-guide.md) for a writer-friendly setup and help interpreting the report.

Found a misleading result? Use the public issue forms to [report an incorrect or missed result](https://github.com/chaoz23/inkcheck/issues/new?template=false-report.yml), [offer a licensed minimal fixture](https://github.com/chaoz23/inkcheck/issues/new?template=public-fixture.yml), or [request an opt-in QA clinic check](https://github.com/chaoz23/inkcheck/issues/new?template=qa-clinic.yml). Never attach private, embargoed, or jam-restricted story material to a public issue.

## For humans, CI, and agents

inkcheck can be driven by a human at a terminal, a CI job, or an optional AI coding agent. The tool itself still does not use AI; agents are just another caller of the CLI or MCP server.

- **Machine-readable interface:** `tool.json` at the repo root describes the CLI flags, MCP tools, exit codes, and `--json` output shape in one file.
- **`--json`** emits the entire report as a single JSON object (`{ compile, stats, explore }`) on stdout — parse that instead of scraping the pretty output. `explore.passes` includes lifetime telemetry per exploration pass, and `explore.schedule` shows how the adaptive rounds spent the budget.
- **`--progress=ndjson`** emits versioned lifecycle and work-progress events on stderr for an agent or CI log parser. `statesExplored / stateBudget` is budget use, not story coverage; the final stdout report remains authoritative.
- **`--human`** emits a prioritized fix list grouped by errors, warnings, and notes, with file/line locations where available, choice paths for runtime failures, and a next step for each finding.
- **`--markdown`** emits a GitHub Step Summary-friendly report for humans reviewing CI.
- **Deterministic exit codes:** `0` clean · `1` compile/runtime errors (or, under `--strict`, warnings, unvisited knots, truncation, or external stubs) · `2` usage error. Branch on the exit code; don't grep the text.
- **MCP:** `claude mcp add inkcheck -- npx -y inkcheck mcp` exposes `compile_story`, `story_stats`, `playtest_story`, and `explore_story` as tools.
- **The loop:** edit `.ink` → `compile_story` → `explore_story` → fix what it reports → repeat. inkcheck is a repeatable mechanical check for a story graph you generated or edited — use it to verify your own work before returning it.
- **The coverage loop:** `explore_story` (and CLI `--json`) returns `nextRun` — switch on its `recommendation` (`stop` / `deepen` / `broaden` / `reseed` / `investigate`) and rerun with `nextRun.flags` until `stop: true`. Or let the CLI drive it: `inkcheck story.ink --next`.

`llms.txt` at the repo root is a compact, model-friendly summary of all of the above.

## How it works

- **Compilation** uses `inklecate`, the canonical compiler — found via `$INKLECATE_PATH`, then `PATH`, then auto-downloaded from the pinned official ink 1.2.1 release into `~/.cache/inkcheck` on first run. Downloaded archives are verified against pinned SHA-256 hashes before extraction. Stories are compiled with `-c` so all knot visits are counted.
- **Exploration** runs the compiled story in [inkjs](https://github.com/y-lohse/inkjs) (the official JS runtime port), reusing pooled story instances so the compiled JSON is parsed once per pass and states rewind via `LoadJson`. States are deduplicated by content hash. Turn and RNG state are preserved whenever the source uses those features; otherwise that bookkeeping is safely canonicalized so ordinary loops can converge. `INCLUDE`s are followed.
- The CLI uses a bounded, adaptive portfolio search. Complementary passes — last-choice-first, first-choice-first, and inside-out DFS, a diversity-first beam, and seeded random walks — run interleaved in ten deterministic rounds. Initial weights (roughly 20/20/26/15/20%, or a shape profile's suggestion under `--auto`) are reallocated each round toward passes whose findings are still growing, with a guaranteed floor per pass so a discovery dry spell never defunds a pass outright. The passes are complementary: the DFS orderings systematically exhaust subtrees, the beam spreads budget across every variable-state lineage within a hard frontier cap, and the random walks re-roll every choice point so early-choice state combinations get sampled instead of repeated. Findings merge into one report, each labeled with the pass that found it, and the executed schedule appears in `--json` output.
- The moment any systematic pass visits every reachable state without hitting a limit, the whole portfolio stops: every further state would be redundant. A small fully-explorable story at the default 100,000-state budget now finishes in the handful of states it actually has.
- The beam pass answers "what should a beam optimize for" concretely: survivors are selected round-robin across variable-signature groups (diversity first), ranked within each group by novelty — newly visited knots, then new variable signatures, then new offered-choice sets. It is deterministic without a seed, and it reports the run as truncated whenever it had to prune a reachable state, so a beam never silently claims complete coverage.
- Unless skipped with `--no-min-repro`, the CLI reserves about 10% of the requested `--max-states` budget for a breadth-first repro-shortening slice. BFS reaches shared findings by shorter choice trails where possible and may contribute extra shallow findings.
- Bounds (`--max-depth`, `--max-states`) keep worst-case combinatorics in check; the report says explicitly when it was truncated.

## Coverage limits

- Exploration is bounded. A truncated report is evidence about visited states, not proof about the whole story.
- Reports state the limits they ran under (depth, state budget, seed) and, when truncated, which limit actually cut coverage (`truncatedBy` in `--json`, including `memory`) with targeted advice on which flag to raise.
- A large run that would exhaust memory stops cleanly and returns a partial report (`truncatedBy.memory`) rather than crashing — memory footprint is dominated by the deduplication hash set (~linear in distinct states) and, on deep loop-light stories, the breadth-first repro frontier, so `--no-min-repro` and a tighter `--max-states` are the levers when a story is too big to finish.
- Small stories often get the opposite guarantee: when a systematic pass visits every reachable state without hitting a limit, the report says so (`exhaustive`), and sampling-slice budget exhaustion no longer counts as truncation.
- `EXTERNAL` functions are stubbed to zero because the host game is unavailable. The report names every stub; strict mode fails rather than claiming complete coverage.
- Random behavior follows reachable RNG states but does not enumerate every possible seed. Pair inkcheck with repeated playtesting when outcome frequency matters.
- An unvisited knot may be intentionally dormant, engine-entered, or unreachable. The inbound-divert triage separates likely orphans from probably-limit-bound content, but it is a review prompt, not an automatic deletion instruction.

## Roadmap

The roadmap is focused on earning trust in bounded QA: clearer limits, better evidence, and project-specific checks authors can understand.

- Coverage transparency: clearer reporting for truncation, depth limits, visited endings, skipped search space, and what was or was not explored.
- Report quality: better source locations, shorter repro paths, stable issue identities, and clearer grouping of runtime errors, unvisited knots, and coverage limits.
- Author-defined story assertions: deterministic project rules such as "gold never goes negative", "health never exceeds max", or "required variables are set before endings."
- Repro persistence: remember known failing paths and make sure future runs keep checking them even as traversal strategies improve.
- Public compatibility fixtures: consent-safe examples and synthetic edge cases for regression testing, performance comparisons, and trust-building.
- Large-story performance controls: quick, standard, and deep check presets with clearer time/coverage tradeoffs.
- Structural lint checks: optional checks for missing tags, inconsistent tag schemas, or project-specific metadata conventions.

## License

MIT
