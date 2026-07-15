# Agent-readiness benchmark

This benchmark tests whether a fresh agent can use Inkcheck safely and economically, not whether it can memorize a favorable repair. The versioned fixture is under `benchmarks/agent-readiness-v1/`.

## Protocol

1. Give the agent only the packaged `skills/inkcheck/SKILL.md`, its normal tool descriptions, a fresh copy of `initial/story.ink`, and `manifest.publicPrompt`.
2. Do not add hidden workflow hints, fixture answers, expected IDs, or the approval prompt.
3. After the agent proposes an invariant, send `manifest.approvalPrompt` verbatim. Do not approve an unrelated rule merely to help the run pass.
4. Preserve the complete tool/edit transcript and final source. Record provider-reported input usage when available; otherwise record the reproducible UTF-8 byte estimate below and mark it as an estimate.
5. Have an evaluator map the transcript to `submission.schema.json`. Run the scorer. A failed criterion must be attributed to `tool`, `skill`, `model`, or `environment` with evidence; attribution explains the failure but does not turn it into a pass.

The public task requires the agent to inspect once, compile, find and reproduce a runtime content-exhaustion path, repair it without changing prose, propose an invariant, wait for approval, add `gold >= 0`, reproduce its counterexample, repair the unambiguous arithmetic, verify both repairs, and describe proof boundaries correctly.

## Targets

- At most 3,000 bootstrap tokens before useful action.
- Exactly one project discovery call.
- At most two progressive-reference loads.
- Correct runtime verification workflow selected/completed within five calls after discovery.
- Stable runtime and assertion finding identities plus indexed replay.
- No story-prose or choice-label change and no unsafe edit.
- Final compile success and `gold_nonnegative` reported `exhaustively_verified` on this finite fixture.
- Coverage language says proof is under the exact configuration and is not a universal guarantee.

The fixture's exhaustive result is intentionally small and real. Passing it establishes workflow competence, not search quality on a large story. Search promotion remains governed by the separate corpus benchmark.

The preregistered bootstrap estimate is `ceil((skillBytes + toolCatalogBytes) / 4)`, where `skillBytes` is the packaged `skills/inkcheck/SKILL.md` UTF-8 size and `toolCatalogBytes` is the compact MCP `tools/list` array serialized as compact JSON. This is a reproducible conservative approximation, not a provider tokenizer. At this revision the measured inputs are 6,660 skill bytes plus 4,291 tool-catalog bytes, or 2,738 estimated tokens. CI remeasures the live compact catalog and fails above 3,000; benchmark submissions record both byte counts so results remain auditable.

## Commands

```sh
npm run evaluate-agent-readiness -- benchmarks/agent-readiness-v1
npm run evaluate-agent-readiness -- benchmarks/agent-readiness-v1 --submission path/to/result.json
npm run evaluate-agent-readiness -- benchmarks/agent-readiness-v1 --gate path/to/agent-a.json path/to/agent-b.json
```

The first command must reproduce `expected.json`. The second scores one run. The gate command requires two passing runs from distinct provider/implementation pairs with separate transcript/final-source evidence. CI validates fixture/tool determinism and scorer behavior. Model runs are manual or scheduled because provider behavior is observational and may change independently of Inkcheck.

## Release gate

Do not declare the 0.6 agent kit complete until two distinct agent implementations have run this exact protocol without bespoke hidden instructions and their evidence-backed results are checked in. A synthetic scorer fixture, a maintainer walkthrough, or two aliases for the same implementation do not satisfy that gate.
