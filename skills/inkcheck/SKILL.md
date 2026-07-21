---
name: inkcheck
description: Use Inkcheck to inspect, compile, mechanically explore, replay, repair, and verify Ink interactive-fiction projects without rewriting author prose or overstating bounded coverage.
---

# Inkcheck QA

Use this skill when a project contains `.ink` files or asks for Ink compile checks, runtime-path reproduction, assertions, unreachable-content review, or repeatable narrative CI. Inkcheck is a deterministic, non-AI QA engine. It does not generate prose, judge story quality, or model a human player. It does not prove complete coverage unless its systematic pass explicitly reports `exhaustive: true`.

This skill targets Inkcheck 0.7.x, capabilities schema 1, report schema 1, search-session schema 5, and campaign-policy schema 1. Begin with `inkcheck_capabilities`; use reported feature flags and schema versions rather than assuming optional behavior. The default compact MCP profile exposes typed `inkcheck_capabilities`, `inspect_story`, `compile_story`, and `start_search` entry calls plus `inkcheck_workflow` for later operations. If the installed contract differs, prefer its bundled docs and avoid unsupported operations.

## Default Loop

1. **Discover.** Call `inkcheck_capabilities`, then `inspect_story` once on the project entrypoint. Inspection reads a compact structural overview without compiling, executing, or returning narrative prose. Request only the needed inventory section when the overview shows more knots or variables.
2. **Compile.** Call `compile_story`. Compile issues are prerequisite failures. Fix syntax or structural defects before interpreting exploration results.
3. **Review a proposed contract.** When the author asks for an invariant or target, use `inkcheck_workflow` with `operation: "review_contract"` before editing `inkcheck.yml`. It validates typed assertions/goals against the story but is read-only and always requires author approval. Broad QA remains the default; a goal-only probe is separate, explicit work for a requested witness.
4. **Explore in a result window.** Prefer typed `start_search` for agent work. Its response is bounded, durable, source-bound, and paginated. Use `inkcheck_workflow` with `operation: "start_campaign"` only when the user has chosen a campaign posture or deadline. Avoid loading a full one-shot report merely to find the first action.
5. **Select and replay.** Inspect privacy-minimal finding summaries. Through `inkcheck_workflow`, fetch one finding with `operation: "get_finding"`, then use `operation: "replay_witness"` before editing a runtime defect. Keep the search seed and Ink `storySeed` fixed.
6. **Repair narrowly.** Change mechanical logic only when the intended behavior is unambiguous. Ask before changing story prose, choice wording, narrative outcomes, puzzle difficulty, or which branch should be canonical.
7. **Verify.** Compile again. For a runtime defect, assertion violation, or approved goal witness, pin it before editing when useful, then route `check_regression` through `inkcheck_workflow`. A pin checks one exact witness, so run broad QA again after meaningful edits. Otherwise replay the same indexed witness and continue or repeat the same source/config/seed window. State whether the result is fixed, still failing, still reached, lost, path changed, partial, or exhaustive.

## Evidence Rules

- Treat runtime errors and assertion violations as separate critical findings. Do not average them into an overall coverage score.
- A witness is an observed path, not proof that it is the only path to the defect.
- `truncated: true` describes exploration limits. Response pagination or omitted finding summaries describes output limits. Never confuse the two.
- `unvisitedKnots` are review leads. `staticOrphanCandidate: true` means no authored inbound divert was found; it is still not semantic proof of dead content.
- External functions are stubbed to zero when disclosed. Randomness is repeatable only for the reported `storySeed`; one seed does not cover every random outcome.
- A bounded run that observes no violation has not verified an invariant. Only `exhaustive: true` can support exhaustive verification under the configured semantics.
- Approximate runtime source locations are navigation hints. Stable finding identity and indexed witness replay are stronger evidence.
- Preserve exact source/config/seed inputs when comparing runs. If source changes, expect freshness checks and path-change outcomes.

## Choosing Work

Use the smallest content-revealing call that answers the question. Names below are logical operations; in the default compact profile, route every operation after `start_search` through `inkcheck_workflow { operation, request }`. Set `INKCHECK_MCP_PROFILE=full` only for compatibility with clients that require separate named tools.

- Need project shape or feature detection: `inspect_story`.
- Need authoritative syntax diagnostics: `compile_story`.
- Need bounded mechanical QA: `start_search`, then `inspect_search`.
- Need one finding: `get_finding`, not `open_report`.
- Need exact observed behavior: `replay_witness`.
- Need post-edit evidence status: `pin_regression`, then `check_regression`.
- Need an author-approved invariant such as `gold >= 0`: add a typed assertion through project config or an explicit `runtime_assertions` campaign child. Never execute arbitrary expressions.
- Need an author-approved target condition: use `add_goal` with an explicit additive budget. Goal work starts at the root and does not replace baseline QA.
- Need full report internals: call `open_report` deliberately and acknowledge that it may contain prose, variables, and complete witnesses.

## Stop And Ask

Ask the author when a repair requires deciding what the story should say or do. Typical cases include choosing between two plausible diverts, deleting apparently unreachable scenes, changing a combination or resource economy, replacing an external host function, or interpreting a stale flag whose intended lifecycle is unclear. You may propose a minimal mechanical patch and a test, but do not silently invent intent.

Do not "fix" content exhaustion by appending `-> END` blindly. First replay the path and inspect the surrounding divert/gather structure. `DONE` ends the current thread; `END` ends the whole story. The correct choice depends on authored control flow.

## Progressive References

Load only the reference triggered by the current task:

- New to Ink syntax or a semantic feature appears: [Ink for mechanical QA](references/ink-qa-primer.md).
- A particular finding or limit needs action: [Finding workflows](references/finding-workflows.md).
- Choosing the next safe tool call: [Decision table](references/decision-table.md).
- Evaluating or teaching the workflow: [Golden exercises](exercises/manifest.json).

## Completion Report

Report the finding IDs acted on, the exact verification performed, source/config/seed continuity, and remaining binding limits. Say "no violation observed within this run" for partial evidence. Say "exhaustively verified under this configuration" only when Inkcheck reports proof. Keep author-intent questions separate from mechanical defects.
