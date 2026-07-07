# inkcheck

**Mechanical QA for [ink](https://github.com/inkle/ink) stories.** Compile checks, bounded systematic branch exploration, runtime-error repro paths, and dead-content detection — as a standalone CLI for writers and teams, with optional CI and MCP integrations.

inkcheck is a QA tool, not a writing tool. It does not generate, rewrite, or send away a word of prose. It exists so that the story *you* wrote can be checked mechanically: compile it with ink's official compiler, explore choice paths within explicit limits, and reproduce failures before a player finds them.

## Quick start

With Node.js 18 or newer:

```sh
npx -y inkcheck path/to/main.ink
```

No global install is required. The first run downloads the pinned official ink compiler, verifies its SHA-256 hash, and processes the story locally.

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

Large stories can exceed the defaults. On inkle's published [*The Intercept*](https://github.com/inkle/the-intercept), inkcheck reaches a 5,000-state cap and marks the report as truncated. That is a useful partial check, not proof of complete coverage; increase the limits deliberately and keep the limitation visible in CI.

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
inkcheck <story.ink> [--max-depth N] [--max-states N] [--no-min-repro] [--strict] [--json|--markdown]
inkcheck mcp    # start the MCP server on stdio
```

`--max-depth` accepts 1–200 and `--max-states` accepts 1–20,000. These hard ceilings prevent malformed automation inputs from accidentally disabling the exploration bounds.

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

## For agents

inkcheck is built to be driven by an AI coding agent, not just a human at a terminal.

- **Machine-readable interface:** `tool.json` at the repo root describes the CLI flags, MCP tools, exit codes, and `--json` output shape in one file.
- **`--json`** emits the entire report as a single JSON object (`{ compile, stats, explore }`) on stdout — parse that instead of scraping the pretty output.
- **`--markdown`** emits a GitHub Step Summary-friendly report for humans reviewing CI.
- **Deterministic exit codes:** `0` clean · `1` compile/runtime errors (or, under `--strict`, warnings, unvisited knots, truncation, or external stubs) · `2` usage error. Branch on the exit code; don't grep the text.
- **MCP:** `claude mcp add inkcheck -- npx -y inkcheck mcp` exposes `compile_story`, `story_stats`, `playtest_story`, and `explore_story` as tools.
- **The loop:** edit `.ink` → `compile_story` → `explore_story` → fix what it reports → repeat. inkcheck is a deterministic oracle for a story graph you generated or edited — use it to verify your own work before returning it.

`llms.txt` at the repo root is a compact, model-friendly summary of all of the above.

## How it works

- **Compilation** uses `inklecate`, the canonical compiler — found via `$INKLECATE_PATH`, then `PATH`, then auto-downloaded from the pinned official ink 1.2.1 release into `~/.cache/inkcheck` on first run. Downloaded archives are verified against pinned SHA-256 hashes before extraction. Stories are compiled with `-c` so all knot visits are counted.
- **Exploration** runs the compiled story in [inkjs](https://github.com/y-lohse/inkjs) (the official JS runtime port), walking the choice tree depth-first from a single pooled story instance (the compiled JSON is parsed once, states rewind via `LoadJson`). States are deduplicated by content hash. Turn and RNG state are preserved whenever the source uses those features; otherwise that bookkeeping is safely canonicalized so ordinary loops can converge. `INCLUDE`s are followed.
- A second breadth-first pass shortens error and ending repro paths to minimal choice trails where they're reachable within limits (skip with `--no-min-repro`).
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
