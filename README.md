# inkcheck

**Mechanical QA for [ink](https://github.com/inkle/ink) stories.** Compile checks, bounded systematic branch exploration, runtime-error repro paths, and dead-content detection — as a standalone CLI for writers and teams, with optional CI and MCP integrations.

inkcheck is a QA tool, not a writing tool. It does not generate, rewrite, or send away a word of prose. It exists so that the story *you* wrote can be checked mechanically: compile it with ink's official compiler, explore choice paths within explicit limits, and reproduce failures before a player finds them.

## Does it use AI?

No. inkcheck itself does not use AI, machine learning, LLMs, or generative models to test stories. It does not train on your source, infer prose changes, rewrite story text, or send story content to an AI service.

It is designed so humans, CI systems, and optional AI coding agents can all drive the same mechanical QA checks. The actual checking is deterministic code: the official ink compiler, the ink runtime, bounded branch exploration, and structured reports.

## Quick start

With Node.js 18 or newer:

```sh
npx -y inkcheck path/to/main.ink
```

No global install is required. The first run downloads the pinned official ink compiler, verifies its SHA-256 hash, and processes the story locally.

Want to see the failure-path report before trying your own story? Run the [two-minute synthetic demo](docs/two-minute-demo.md).

## Hosted checker

The repository now includes a self-hosted web interface for writers who do not want to use a terminal. Hosted mode temporarily uploads authorized `.ink` source, runs a bounded check, returns the report, and deletes the temporary job directory. It does not make reports public or retain story text in application logs. Optional first-party usage metrics keep only daily aggregate counts and can produce unattended weekly reports without an analytics vendor.

The local CLI remains the privacy-first option because no story upload occurs. See [Hosted checker deployment](docs/hosted-checker.md) for the threat model, Docker deployment, operating limits, and a current sub-$50/month budget.

## What it catches

- **Compile errors and warnings** — broken diverts, unresolved variables, loose ends, with file and line numbers (via [inklecate](https://github.com/inkle/ink/releases), the official compiler)
- **Runtime errors with a reproduction path** — the exact sequence of choices that triggers a divide-by-zero, a bad external call, or out-of-content, e.g. `repro: [Enter in darkness → Descend to the cellar]`
- **Unvisited content** — knots no explored path visits within the configured limits, so possible orphaned scenes are visible for review
- **Distinct terminal states** — with a choice trail that reaches each one; differing final variables are retained as distinct outcomes

## vs. the alternatives

| | Catches syntax errors | Explores choice branches | Finds unvisited content | Repro path for crashes | Runs in CI |
| --- | :---: | :---: | :---: | :---: | :---: |
| **`inklecate` (compiler)** | ✓ | — | — | — | ✓ |
| **Manual playtesting** | — | only what you click | by luck | if you remember your clicks | — |
| **Ink-Tester** | ✓ | random repeated runs | line coverage | limited | manual/CLI |
| **inkcheck** | ✓ | systematic, bounded | knot coverage | ✓ | ✓ |

The compiler tells you the story is *valid*. Clicking through tells you the paths you *happened to click* work. [Ink-Tester](https://github.com/wildwinter/Ink-Tester) repeatedly samples random playthroughs and reports line-level frequency; inkcheck instead walks choice states systematically and returns short failure paths. The approaches are complementary, especially for stories with randomness or engine integrations.

## Example

```
$ inkcheck examples/manor.ink
✓ compiled — 92 words, 7 knots, 6 choices
✓ explored 10 states — 5 distinct terminal state(s)
    ending via [Enter in darkness → Search the study → Leave with your loot]: "You slip out the servant door, heavier by half a purse."
    ...
✗ 1 runtime error(s):
    obj is null or undefined (at cellar.3)
      repro: [Enter in darkness → Descend to the cellar]
⚠ 1 knot(s) never visited on any explored path:
    treasure_vault (manor.ink:35)
```

Exit code is non-zero on compile or runtime errors. Add `--strict` to also fail on warnings, unvisited knots, truncation, or external stubs, so partial coverage cannot silently pass CI.

Large stories can exceed the defaults. On inkle's published [*The Intercept*](https://github.com/inkle/the-intercept), inkcheck marks the report as truncated even when the state budget is raised well beyond the default. That is a useful partial check, not proof of complete coverage; increase the limits deliberately and keep the limitation visible in CI. The hosted checker uses a 100,000-state default and asks authors to file an issue if that still is not enough.

Within a single run, inkcheck spends its state budget across complementary search passes rather than betting everything on one traversal order. The current CLI portfolio explores last-choice-first, first-choice-first, and inside-out DFS slices, then reserves a small breadth-first slice to shorten repro paths. This often finds more endings and reachable knots at the same `--max-states` limit, but it is still bounded QA: a truncated report is useful evidence, not an exhaustive proof.

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
inkcheck <story.ink> [--max-depth N] [--max-states N] [--no-min-repro] [--strict] [--human|--json|--markdown]
inkcheck mcp    # start the MCP server on stdio
```

`--max-depth` accepts 1–1,000 and `--max-states` accepts 1–1,000,000. These hard ceilings prevent malformed automation inputs from accidentally disabling the exploration bounds. The default state budget is 100,000.

`--max-states` is a total budget for the run, not a promise that one single DFS walk will spend all states. By default the CLI divides most of that budget across three complementary DFS views of the choice tree and keeps a small breadth-first slice for shorter failure and ending repro paths. Use `--no-min-repro` to spend that repro slice on the DFS portfolio instead when breadth-first shortening is less important than broader search.

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
- **`--json`** emits the entire report as a single JSON object (`{ compile, stats, explore }`) on stdout — parse that instead of scraping the pretty output.
- **`--human`** emits a prioritized fix list grouped by errors, warnings, and notes, with file/line locations where available, choice paths for runtime failures, and a next step for each finding.
- **`--markdown`** emits a GitHub Step Summary-friendly report for humans reviewing CI.
- **Deterministic exit codes:** `0` clean · `1` compile/runtime errors (or, under `--strict`, warnings, unvisited knots, truncation, or external stubs) · `2` usage error. Branch on the exit code; don't grep the text.
- **MCP:** `claude mcp add inkcheck -- npx -y inkcheck mcp` exposes `compile_story`, `story_stats`, `playtest_story`, and `explore_story` as tools.
- **The loop:** edit `.ink` → `compile_story` → `explore_story` → fix what it reports → repeat. inkcheck is a deterministic oracle for a story graph you generated or edited — use it to verify your own work before returning it.

`llms.txt` at the repo root is a compact, model-friendly summary of all of the above.

## How it works

- **Compilation** uses `inklecate`, the canonical compiler — found via `$INKLECATE_PATH`, then `PATH`, then auto-downloaded from the pinned official ink 1.2.1 release into `~/.cache/inkcheck` on first run. Downloaded archives are verified against pinned SHA-256 hashes before extraction. Stories are compiled with `-c` so all knot visits are counted.
- **Exploration** runs the compiled story in [inkjs](https://github.com/y-lohse/inkjs) (the official JS runtime port), reusing pooled story instances so the compiled JSON is parsed once per pass and states rewind via `LoadJson`. States are deduplicated by content hash. Turn and RNG state are preserved whenever the source uses those features; otherwise that bookkeeping is safely canonicalized so ordinary loops can converge. `INCLUDE`s are followed.
- The CLI uses a bounded portfolio search: roughly 30% last-choice-first DFS, 30% first-choice-first DFS, and 40% inside-out DFS. Those passes are complementary; for example, one ordering may find a runtime error while another reaches an ending or late knot. Their findings are merged into one report.
- Unless skipped with `--no-min-repro`, the CLI reserves about 10% of the requested `--max-states` budget for a breadth-first repro-shortening slice. BFS reaches shared findings by shorter choice trails where possible and may contribute extra shallow findings.
- Bounds (`--max-depth`, `--max-states`) keep worst-case combinatorics in check; the report says explicitly when it was truncated.

## Coverage limits

- Exploration is bounded. A truncated report is evidence about visited states, not proof about the whole story.
- `EXTERNAL` functions are stubbed to zero because the host game is unavailable. The report names every stub; strict mode fails rather than claiming complete coverage.
- Random behavior follows reachable RNG states but does not enumerate every possible seed. Pair inkcheck with repeated playtesting when outcome frequency matters.
- An unvisited knot may be intentionally dormant, engine-entered, or unreachable. Treat it as a review prompt, not an automatic deletion instruction.

## Roadmap

- Localization/tag lint (untagged lines, inconsistent tag schemas)
- State assertions ("gold must never go negative on any path")
- Yarn Spinner support via `ysc`

## License

MIT
