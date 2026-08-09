---
name: inkcheck
version: 0.1.1
description: >
  CI for ink interactive-fiction stories. Use it whenever a .ink file
  changes hands or changes state: "does my story compile?", "can any path
  crash it?", "are all my endings reachable?", "is there content nobody can
  ever see?", pre-commit checks, reviewing a story PR, or validating a
  generated/edited ink file before play. Compiles, then plays every branch
  to a depth budget, reporting runtime errors with minimal repro paths and
  knots no path visits.
---

# inkcheck — play every branch before a player does

Compile checks catch what the ink compiler sees; the explorer catches what
it can't — runtime errors three choices deep, endings that don't exist,
content orphaned by a refactor. Deterministic: same story, same report.

## Three things to remember

1. **A repro path is the finding.** Runtime errors come with the exact
   choice sequence that triggers them (`repro: [Enter in darkness → Descend
   to the cellar]`) — relay it verbatim; it replays the bug.
2. **Exit 2 here is a usage error, not a verdict.** This tool predates the
   family's honest-refusal lane: `0` clean · `1` findings · `2` bad
   invocation. Don't read exit 2 as "cannot adjudicate."
3. **Unvisited ≠ unreachable.** A knot never visited within the exploration
   budget might need a deeper `--max-depth`; check the budget before
   declaring content dead.

## Exit codes

`0` = compiled and explored clean · `1` = compile errors, runtime errors,
or (under `--strict`) warnings and unvisited knots · `2` = usage error.
Branch on the exit code; don't grep the text.

## Invocation

```bash
inkcheck story.ink                    # compile + explore (default: 30 deep, 500 states)
inkcheck story.ink --strict           # warnings and unvisited knots also fail
inkcheck story.ink --json             # full machine-readable report
inkcheck story.ink --max-depth 50 --max-states 2000   # bigger stories
inkcheck mcp                          # MCP server (stdio)
```

## Worked example

```bash
inkcheck examples/manor.ink
```

```text
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

Exit 1: the runtime error is a hard fail; the unvisited knot is a warning
(fails only under `--strict`). A story with compile errors reports each
with file:line and exits 1 without exploring.

## MUST / MUST NOT

- MUST run after every edit to a .ink file an agent makes — generated ink
  that compiles can still crash at runtime three choices in.
- MUST relay repro paths verbatim when reporting a runtime error.
- MUST raise `--max-depth`/`--max-states` (not conclusions) when a story is
  larger than the default budget; say when a budget was hit.
- MUST use `--json` when another tool consumes the result.
- MUST NOT judge story *quality* — pacing, tone, and lore are outside this
  tool's jurisdiction; only structure gets a verdict.
- MUST NOT auto-"fix" unvisited knots by deleting them; orphaned content is
  a question for the author.
- MUST NOT treat exploration-clean as proof for stories using external
  functions the explorer stubs; note the caveat when relevant.

## Validation checkpoints (self-audit before reporting)

compile status · explorer budget sufficient (or stated) · every runtime
error carries its repro · strictness level named · endings count sanity-
checked against author intent.

## Cross-skill workflows (check family)

- **Authored-rail pipeline:** story spine in ink → inkcheck green is the
  merge gate → the live table (table-kit) runs the spine with a model as
  narrator; structural truth stays checked here so the narrator never has
  to be trusted with it.
- **Session retro:** if a session exposed a story hole, reproduce it here
  as a failing check before patching the ink.

Family contract: [FAMILY.md](https://github.com/chaoz23/srdcheck/blob/main/FAMILY.md).
Note this tool's exit-2 divergence from the D&D trio, recorded there.

## Changelog / stale-knowledge deltas

- Structural checks are hard-binary by design; there is no escalate lane in
  this tool. Anything tone- or lore-flavored is out of scope rather than a
  soft warning.
- `--no-min-repro` skips the second pass that shortens repro paths — repros
  are then valid but not minimal.

Verdicts are structural facts about the story, advisory to the author.
