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

### Project configuration

Commit an `inkcheck.yml` when a project should use the same entrypoint and bounded CI settings for every human or agent session:

```yaml
schemaVersion: 1
entrypoint: story.ink
ci:
  maxDepth: 100
  maxStates: 1000000
  seed: 1
  search: portfolio
  strict: true
```

Run `inkcheck validate-config` to check it. From that directory, `inkcheck` uses the configured entrypoint and defaults; explicit CLI flags still win. Unknown keys fail validation so future assertions, goals, external behavior, and edit-policy fields cannot appear supported before their implementations exist. The published contract is [config schema v1](docs/config-schema-v1.json).

For a new project containing one `.ink` file, `inkcheck init` creates this config. Multi-file projects must name the root with `--entrypoint`. `inkcheck agent-kit --format codex` adds the config when needed, a pinned GitHub Actions example, `.inkcheck/` artifact ignore rules, and compact version-matched agent instructions. Both commands are idempotent and preflight every target; they refuse the whole operation rather than overwrite or partially modify existing authored files.

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
✓ explored 18050 states within limits (depth 100, 10000000 states, seed 1) — exhaustive (every reachable state visited) — 5 distinct terminal state(s)
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

A story does not have to be long to exceed the default budget. On inkle's published [*The Intercept*](https://github.com/inkle/the-intercept) — a short story — inkcheck still marks the report as truncated even at a large state budget, because branching and variables create far more reachable states than there are choices. That is a useful partial check, not proof of complete coverage; the run stops on whichever comes first — the state budget, the depth limit, or the memory guard — and says which. The hosted web checker defaults to and caps at 1,000,000 states so one story cannot monopolize the shared server; jobs larger than that (up to the CLI's 100M ceiling) belong on the local CLI, where you control the heap. See [Performance and memory](#performance-and-memory) for how to size a run for your hardware.

Within a single run, inkcheck spends its state budget across complementary search passes rather than betting everything on one traversal order. The current CLI portfolio explores last-choice-first, first-choice-first, and inside-out DFS slices, adds a seeded random-sampling slice that varies early-choice prefixes the deterministic passes tend to repeat, adds a frontier-capped diversity beam that advances level-by-level like BFS while keeping one state per variable-signature lineage, then reserves a small breadth-first slice to shorten repro paths. The random slice uses a fixed default seed and the beam needs no seed at all, so runs stay reproducible in CI; every reported ending and runtime error names the pass (and seed) that found it. This often finds more endings and reachable knots at the same `--max-states` limit, but it is still bounded QA: a truncated report is useful evidence, not an exhaustive proof.

`--search=shared` opts into an experimental alternative: deep, novelty-first, and seeded views draw from one deduplicated frontier and each reachable state is expanded at most once. This can spend a tight budget more efficiently when several strategies would otherwise rediscover the same state, and JSON telemetry reports unique states, peak pending states/bytes, and observed rare variable transitions. It is not the default yet: the evidence is promising on finite locks, deceptive suffixes, and storylet-like graphs, but some early-choice structures may still favor the portfolio's independent random and beam passes. The variable signals are measured for evaluation; they do not steer choices yet.

`--search=shared-variable` is a narrower experiment that gives 12.5% of shared-frontier selections to states reached through uncommon variable snapshots or transitions. The boost is bounded and the deep, novelty, and seeded views remain active. It can help mechanically driven storylet graphs, but it is not uniformly better; the checked-in [comparison table](docs/search-experiments.md) includes both gains and regressions.

The adaptive portfolio remains the general-purpose default. Experimental modes do not change its weights or behavior. Inkcheck's [search strategy policy](docs/search-strategy-policy.md) defines the benchmark breadth and regression gates required before any future default change.

### Bounded search vs random sampling

Inkcheck is not a promise to visit every possible state in a non-trivial story. Branches, loops, variables, random behavior, and host-game integrations can make exhaustive coverage physically impractical. Its practical advantage over random sampling is reproducibility: given the same story and limits, inkcheck walks the choice graph systematically, returns exact choice paths for failures, reports unvisited-knot clues, and says explicitly when the run was partial.

Random sampling remains useful, especially for stories with randomness or huge state spaces. Treat the approaches as complementary: random play can stumble into surprising paths, while inkcheck gives deterministic CI-friendly evidence inside a declared budget.

In a local test of *The Intercept* at a depth limit of 30, higher budgets found more terminal states but still did not prove complete coverage. Timings are from one local development machine and should be read as scale evidence, not a universal benchmark:

| State budget | Time | Distinct terminal states | Runtime errors | Unvisited knots | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 50,000 | 9.4s | 7 | 0 | 9 | truncated |
| 100,000 | 19.9s | 10 | 0 | 9 | truncated |
| 500,000 | 100.2s | 17 | 0 | 8 | truncated |
| 1,000,000 | 205.5s | 25 | 0 | 8 | truncated |

That is the intended interpretation: each run tests real reachable states and can surface real broken paths, but a truncated report is evidence about what was visited, not proof that everything was reachable or correct.

## Performance and memory

The default budget is 10,000,000 states and the ceiling is 100,000,000, so it is worth knowing what a big run costs. Two resources bound a run: **time** and **memory**. Small or exhaustible stories touch neither — the portfolio early-exits the moment a systematic pass proves the reachable space complete, so `inkcheck small.ink` finishes in the handful of states it has regardless of the default. The numbers below matter only for large, non-exhaustive stories.

**Time** scales roughly linearly with states explored. On one development machine, *The Intercept* ran about 200 seconds per million states (see the table above), so a 10M-state run is tens of minutes and a 100M run is hours. There is no wall-clock limit on the local CLI, so for CI or interactive use, pin `--max-states` to the coverage you actually need rather than relying on the default — or run the default with `--progress` (on by default in an interactive terminal) so you can watch and interrupt.

**Memory** is a sum of terms with different growth, and it is why the ceiling is high rather than dangerous:

| What grows | How it scales | Notes |
| --- | --- | --- |
| Deduplication hash set (`seenStates`) | **~linear**, ≈200 bytes per *distinct* state | The dominant term. inkcheck stores a hash per state, not the state, which is what makes millions of states affordable. |
| DFS / beam frontier | **flat** | DFS is bounded by depth; the beam has a hard frontier cap. Neither grows with the budget. |
| Random sampling | **flat** (O of findings) | Keeps no dedup structure. |
| BFS repro-shortening frontier | **the one super-linear risk** | On a deep, loop-light, branching story it can balloon (a research run queued ~631K full states). `--no-min-repro` removes this slice entirely. |

Two practical rules of thumb from that:

- **Budget heap, not just states.** As a worst-case estimate (no state deduplication), plan for roughly **2 GB of heap per 10M distinct states**. Stories with loops deduplicate heavily and use far less; a low-dedup story uses close to the worst case. So a 10M-state run's worst case (~2 GB) sits near Node's default heap limit: a loop-heavy story stays well under it, but a large low-dedup one can reach the memory guard before finishing even at the default budget. A 100M-state run exceeds a normal default heap and will stop at the guard unless you raise `--max-old-space-size`. Either way it stops cleanly with a partial report — the guard is what makes the high ceiling safe to point at, not a promise the run will complete.
- **The memory guard is the real limiter, not the ceiling.** A run stops cleanly at 85% of the V8 heap (or your `--max-memory`) and returns a *partial* report with `truncatedBy.memory` rather than crashing. So setting `--max-states 100000000` is not reckless — on a normal machine the guard, not the ceiling, decides where it stops. To go further, give Node more heap: `NODE_OPTIONS=--max-old-space-size=8192 inkcheck big.ink --max-states 100000000`.

Levers, in order of impact, when a story is too big to finish: raise `--max-old-space-size` (more headroom), pass `--no-min-repro` (drops the super-linear BFS frontier), lower `--max-states` (bounds both time and memory), or split the story and check parts separately. The `nextRun` verdict names the binding limit after each run so you know which lever applies.

## MCP server

Four tools for AI agents working on ink stories:

| Tool | What it does |
| --- | --- |
| `inkcheck_capabilities` | Versioned schemas, limits, search modes, and explicit feature availability |
| `inspect_story` | Source-only project map: includes, shape, semantics, externals, knots, and variables |
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
inkcheck capabilities [--json]
inkcheck inspect <story.ink> [--json]
inkcheck <story.ink> [--max-depth N] [--max-states N] [--seed N] [--search=portfolio|shared|shared-variable] [--auto] [--profile] [--next] [--no-min-repro] [--strict] [--progress=auto|human|ndjson|off] [--human|--json|--markdown]
inkcheck mcp    # start the MCP server on stdio
```

`inkcheck capabilities --json` lets agents check schema versions, limits, search modes, and explicit supported or unavailable features before relying on them. `inkcheck inspect story.ink --json` performs deterministic source-only discovery without compiling or exploring: it follows project-local includes and returns a bounded map of story shape, semantics, externals, knots/functions, and variable declarations/reads/writes. See the [agent discovery contract](docs/agent-discovery.md).

JSON checks use the versioned [report schema](docs/report-schema-v1.md). Findings have stable IDs and normalized kinds; ending and runtime-error witnesses carry both human choice text and zero-based choice indices, so duplicate labels remain exactly replayable through `playtest_story`. The envelope records the Inkcheck version, compiled-story fingerprint, effective configuration, and binding limit while retaining the established `compile`, `stats`, `explore`, and `nextRun` sections.

`--max-depth` accepts 1–1,000 and `--max-states` accepts 1–100,000,000, with a **default budget of 10,000,000**. These hard ceilings prevent malformed automation inputs from accidentally disabling the exploration bounds. The default is deliberately ambitious because three things make a big budget safe rather than reckless: a fully-explorable story early-exits the moment a systematic pass proves it exhaustive (so small stories still finish in a handful of states), the memory guard stops cleanly before an out-of-memory crash, and progress reporting lets you watch and interrupt a long run. A large, non-exhaustive story will therefore *use* that budget — see [Performance and memory](#performance-and-memory) before running one in CI, and pin a smaller `--max-states` there if a bounded runtime matters more than depth of coverage.

`--max-states` is a total budget for the run, not a promise that one single DFS walk will spend all states. By default the CLI divides most of that budget across three complementary DFS views of the choice tree plus a seeded random-sampling slice, and keeps a small breadth-first slice for shorter failure and ending repro paths. Use `--no-min-repro` to spend that repro slice on the DFS portfolio instead when breadth-first shortening is less important than broader search.

`--seed` (default 1) controls the random-sampling slice. The same seed always samples the same walks, so CI results stay reproducible; change the seed across scheduled runs to sample different early-choice combinations over time. Each finding's `foundBy` field in `--json` output names the pass that discovered it, e.g. `dfs:last` or `random:seed=1`.

`--search=shared` selects the experimental shared-state multi-frontier engine; `--search=portfolio` is the unchanged default. Shared mode remains deterministic for a fixed seed and still honors depth, state, memory, time, progress, and repro-shortening controls.

`--search=shared-variable` adds a small variable-rarity frontier to shared search. It prioritizes observed uncommon variable values and changes mechanically; it does not use AI, understand story meaning, or infer which values are desirable.

`--max-memory <mb>` caps how much heap the run may use before it stops cleanly. A V8 heap out-of-memory abort cannot be caught after the fact, so inkcheck watches memory during exploration and — before it would crash — stops, keeps everything found so far, and reports `truncatedBy.memory` with a partial report rather than losing the run. The default cap is 85% of the V8 heap limit (which honors any `NODE_OPTIONS=--max-old-space-size` you set), so large runs on modest hardware degrade gracefully instead of dying; pass an explicit value to tighten or loosen it. On a memory stop the `nextRun` verdict is `investigate` (raise `--max-old-space-size`, lower `--max-states`, or split the story) — never `broaden`, since more budget would only hit the wall sooner.

`--max-time <s>` is the wall-clock counterpart: after `s` seconds the run stops cleanly and returns the partial report it has (`truncatedBy.time`) instead of running to the state budget. There is no default time limit on the local CLI. It's meant for CI or any context that needs a bounded runtime but still wants the findings so far — the same graceful-partial idea as the memory guard, applied to time. The hosted web checker sets this automatically, just under its hard timeout, so a slow story hands back a partial report rather than being killed.

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
    npx -y inkcheck story/main.ink --strict --markdown --max-states 500000 | tee -a "$GITHUB_STEP_SUMMARY"
```

The example pins `--max-states 500000` so the job has a predictable runtime; the default budget is 10,000,000, which a large, non-exhaustive story would actually spend (see [Performance and memory](#performance-and-memory)). Pin a budget in CI whenever a bounded wall-clock matters more than maximum coverage.

`--strict` fails not only on warnings and unvisited knots, but also when exploration is truncated or an `EXTERNAL` function had to be stubbed. This prevents a partial check from wearing a green “complete” badge.

See the [InkJam QA guide](docs/inkjam-qa-guide.md) for a writer-friendly setup and help interpreting the report.

Found a misleading result? Use the public issue forms to [report an incorrect or missed result](https://github.com/chaoz23/inkcheck/issues/new?template=false-report.yml), [offer a licensed minimal fixture](https://github.com/chaoz23/inkcheck/issues/new?template=public-fixture.yml), or [request an opt-in QA clinic check](https://github.com/chaoz23/inkcheck/issues/new?template=qa-clinic.yml). Never attach private, embargoed, or jam-restricted story material to a public issue.

## For humans, CI, and agents

inkcheck can be driven by a human at a terminal, a CI job, or an optional AI coding agent. The tool itself still does not use AI; agents are just another caller of the CLI or MCP server.

- **Machine-readable interface:** `tool.json` at the repo root describes the CLI flags, MCP tools, exit codes, and `--json` output shape in one file.
- **`--json`** emits the entire report as a single JSON object (`{ compile, stats, explore }`) on stdout — parse that instead of scraping the pretty output. `explore.passes` includes lifetime telemetry per exploration pass, and `explore.schedule` shows how the adaptive rounds spent the budget.
- **`--progress=ndjson`** emits versioned lifecycle and work-progress events on stderr for an agent or CI log parser. `statesExplored / stateBudget` is budget use, not story coverage; the final stdout report remains authoritative. See the [NDJSON progress contract](docs/progress-ndjson.md).
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
- Experimental `--search=shared` keeps one global state identity and exposes the pending work through deep, novelty, and seeded frontier views. A state chosen by any view is expanded once and removed lazily from the others; compact parent links preserve exact repro paths without retaining a full path on every pending state. Variable-state and variable-transition rarity are recorded as evaluation telemetry, not yet used as a search heuristic.
- Experimental `--search=shared-variable` replaces one of every eight shared-frontier selections with a variable-rarity view. Its score combines the observed frequency of the destination variable snapshot and the rarest change on that edge; it cannot consume more than its fixed slice, so graph novelty, depth, and seeded exploration remain represented.
- The moment any systematic pass visits every reachable state without hitting a limit, the whole portfolio stops: every further state would be redundant. A small fully-explorable story at the default 10,000,000-state budget still finishes in the handful of states it actually has — the large default costs nothing when a story is exhaustible.
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
- Search promotion harness: a broad, predeclared scorecard across structural families, budgets, depths, and seeds before any experimental strategy can change the default.
- Large-story performance controls: quick, standard, and deep check presets with clearer time/coverage tradeoffs.
- Structural lint checks: optional checks for missing tags, inconsistent tag schemas, or project-specific metadata conventions.

## License

MIT
