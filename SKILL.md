---
name: inkcheck
version: 0.7.2
description: >
  CI for ink interactive-fiction stories. Use it whenever a .ink file
  changes hands or changes state: "does my story compile?", "can any path
  crash it?", "are all my endings reachable?", "is there content nobody can
  ever see?", pre-commit checks, reviewing a story PR, or validating a
  generated/edited ink file before play. Compiles, then explores the story
  graph (exhaustively when it fits the budget), reporting runtime errors
  with minimal repro paths and knots no path visits.
---

# inkcheck — play every branch before a player does

Compile checks catch what the ink compiler sees; the explorer catches what
it can't — runtime errors three choices deep, endings that don't exist,
content orphaned by a refactor. Deterministic: same story, same seed, same
report.

## Three things to remember

1. **A repro path is the finding.** Runtime errors come with the exact
   choice sequence that triggers them (`repro: [Enter in darkness → Descend
   to the cellar]`) — relay it verbatim; `artifacts replay` re-executes it.
2. **Exit 2 here is a usage error, not a verdict.** This tool predates the
   family's honest-refusal lane: `0` clean · `1` findings · `2` bad
   invocation. Don't read exit 2 as "cannot adjudicate."
3. **Read the coverage claim.** The report says whether exploration was
   *exhaustive* or budget-limited; only an exhaustive run proves absence.
   "Unreached is not necessarily unreachable" — the report states it.

## Exit codes

`0` = compiled and explored clean · `1` = compile/runtime errors (or, under
`--strict`, warnings, unvisited knots, truncation, or external stubs) ·
`2` = usage error. Branch on the exit code; don't grep the text.

## Invocation

```bash
inkcheck story.ink                    # compile + explore (defaults: depth 100, 10M states)
inkcheck story.ink --strict --json    # CI mode: machine report, warnings fail
inkcheck story.ink --max-time 60      # big story: clean partial report after 60s
inkcheck resume <checkpoint-id> --max-states N   # continue a budget-limited run
inkcheck artifacts findings <report-id>          # page through stored findings
inkcheck artifacts replay <report-id> <finding-id>  # re-execute a repro
inkcheck campaign story.ink           # multi-run campaign over seeds/goals
inkcheck init [dir]                   # scaffold inkcheck.yml config
inkcheck mcp                          # MCP server (stdio)
```

## Worked example

```bash
inkcheck examples/manor.ink
```

```text
✓ compiled — 92 words, 7 knots, 6 choices
✓ explored 20 states within limits — exhaustive (every reachable state
  visited) — 5 distinct terminal state(s)
    terminal via [Enter in darkness → Search the study → Leave with your loot]: "You slip out the servant door, heavier by half a purse."
    ...
✗ 1 runtime error(s):
    obj is null or undefined (at cellar.3)
      repro: [Enter in darkness → Descend to the cellar] (found by dfs:inside-out)
⚠ 1 knot(s) never visited on any explored path — unreached is not necessarily unreachable:
    treasure_vault (manor.ink line 35) — no authored divert points here — possible orphan
```

Exit 1: the runtime error is a hard fail; the unvisited knot is a warning
(fails only under `--strict`). Because this run says **exhaustive**, the
5 terminals are provably all of them.

## MUST / MUST NOT

- MUST run after every edit to a .ink file an agent makes — generated ink
  that compiles can still crash at runtime three choices in.
- MUST relay repro paths verbatim; use `artifacts replay` to confirm a fix
  killed the finding.
- MUST check whether the report claims *exhaustive*; if budget-limited,
  either raise budgets, `resume` from the checkpoint, or state the caveat.
- MUST use `--json` when another tool consumes the result, and `--strict`
  when a warning should block a merge.
- MUST NOT judge story *quality* — pacing, tone, and lore are outside this
  tool's jurisdiction; only structure gets a verdict.
- MUST NOT auto-"fix" unvisited knots by deleting them; the report's
  "possible orphan" hint is a question for the author, not a deletion list.
- MUST NOT treat exploration-clean as proof for stories using external
  functions the explorer stubs (`--strict` fails them; report the caveat
  otherwise).

## Validation checkpoints (self-audit before reporting)

compile status · coverage claim read (exhaustive vs budget-limited) · every
runtime error carries its repro · strictness level named · terminal count
sanity-checked against author intent.

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

- **0.7.x:** exploration defaults are large (depth 100, 10M states) and
  runs claim *exhaustive* when true; artifacts store (`findings`, `replay`,
  `prune`), checkpoints + `resume`, `campaign` mode, `inkcheck.yml` config
  (`init`, `validate-config`), portfolio/shared search, `--max-time`/
  `--max-memory` clean partial reports. If you remember 0.1.x's
  depth-30/500-state defaults and no artifact store, that's stale.
- Structural checks are hard-binary by design; there is no escalate lane.
  Anything tone- or lore-flavored is out of scope rather than a soft
  warning.

Verdicts are structural facts about the story, advisory to the author.
