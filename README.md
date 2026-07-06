# inkcheck

**CI for [ink](https://github.com/inkle/ink) stories.** Compile checks, exhaustive branch playtesting, runtime-error repro paths, and dead-content detection — as an MCP server for AI coding agents and as a standalone CLI for your pipeline.

inkcheck is a QA tool, not a writing tool. It doesn't generate a word of prose. It exists so that the story *you* wrote can be verified the way code is: every branch compiled, every reachable path played, every dead end and broken divert caught before a player finds it.

## What it catches

- **Compile errors and warnings** — broken diverts, unresolved variables, loose ends, with file and line numbers (via [inklecate](https://github.com/inkle/ink/releases), the official compiler)
- **Runtime errors with a reproduction path** — the exact sequence of choices that triggers a divide-by-zero, a bad external call, or out-of-content, e.g. `repro: [Enter in darkness → Descend to the cellar]`
- **Unreachable content** — knots no explored path ever visits, so orphaned scenes don't ship silently
- **Every distinct ending** — with the choice trail that reaches it, so you know your five endings are actually five reachable endings

## Example

```
$ inkcheck examples/manor.ink
✓ compiled — 92 words, 7 knots, 6 choices
✓ explored 10 states — 5 distinct ending(s)
    ending via [Enter in darkness → Search the study → Leave with your loot]: "You slip out the servant door, heavier by half a purse."
    ...
✗ 1 runtime error(s):
    obj is null or undefined (at cellar.3)
      repro: [Enter in darkness → Descend to the cellar]
⚠ 1 knot(s) never visited on any explored path:
    treasure_vault (manor.ink:35)
```

Exit code is non-zero on compile or runtime errors (add `--strict` to also fail on warnings and unvisited knots), so it drops straight into CI.

Scale check: it explores 5,000 states of inkle's published game [*The Intercept*](https://github.com/inkle/the-intercept) (14,728 words, 343 choices) in ~5 seconds, surfacing 16 distinct endings — and, correctly, zero errors.

## MCP server

Four tools for AI agents working on ink stories:

| Tool | What it does |
| --- | --- |
| `compile_story` | Structured compile issues (severity, file, line) |
| `story_stats` | Word/knot/choice counts + full knot list with locations |
| `playtest_story` | Play one scripted choice path headlessly; returns transcript, tags, variables, errors |
| `explore_story` | Bounded exhaustive walk: endings, error repro paths, knot coverage |

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
inkcheck <story.ink> [--max-depth N] [--max-states N] [--no-min-repro] [--strict] [--json]
inkcheck mcp    # start the MCP server on stdio
```

GitHub Actions:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx -y inkcheck story/main.ink --strict
```

## How it works

- **Compilation** uses `inklecate`, the canonical compiler — found via `$INKLECATE_PATH`, then `PATH`, then auto-downloaded from the official ink release into `~/.cache/inkcheck` on first run. Stories are compiled with `-c` so all knot visits are counted.
- **Exploration** runs the compiled story in [inkjs](https://github.com/y-lohse/inkjs) (the official JS runtime port), walking the choice tree depth-first from a single pooled story instance (the compiled JSON is parsed once, states rewind via `LoadJson`). States are deduplicated by content hash (ignoring turn counters and RNG seeds), which is what makes stories with loops terminate. `INCLUDE`s are followed; `EXTERNAL` functions are auto-stubbed so exploration doesn't require a game engine.
- A second breadth-first pass shortens error and ending repro paths to minimal choice trails where they're reachable within limits (skip with `--no-min-repro`).
- Bounds (`--max-depth`, `--max-states`) keep worst-case combinatorics in check; the report says explicitly when it was truncated.

## Roadmap

- Localization/tag lint (untagged lines, inconsistent tag schemas)
- State assertions ("gold must never go negative on any path")
- Yarn Spinner support via `ysc`

## License

MIT
