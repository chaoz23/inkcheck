# Report schema v1

Inkcheck machine reports are additive envelopes around the established compile, statistics, exploration, and next-run sections.

## Envelope

Successful JSON checks contain:

- `schemaVersion`: `1`
- `inkcheckVersion`
- `storyFingerprint`: SHA-256 of the compiled story used for exploration
- `effectiveConfiguration`: strategy, repro policy, strict/resource settings, and effective search limits
- `bindingLimit`: `null` or the resource/coverage limit that stopped the run
- `compile`, `stats`, optional `profile`, `explore`, `nextRun`, `shadowDecision`, and optional `runs`

Compile-failure reports use the same schema/version fields and fingerprint the entry source because no compiled story exists.

## Findings

Compile issues, runtime errors, and endings have deterministic IDs derived from their normalized kind and stable identity fields. IDs do not depend on report formatting or array position.

Common kinds include:

- `compile.missing_divert`
- `compile.invalid_expression`
- `compile.error`, `compile.warning`, `compile.todo`
- `runtime.content_exhaustion`
- `runtime.choice_failure`
- `runtime.state_restore_failure`
- `runtime.error`
- `ending.reached`

Runtime errors and endings include:

- `path`: human-readable choice labels
- `choiceIndices`: matching zero-based indices
- `firstDiscoveredAtState`: transition count within the finding pass
- `replay`: `{ "tool": "playtest_story", "choices": [...] }`
- `witness`: choice text/indices and, for errors where available, the triggering source location
- `foundBy`, suggested action, and an `inkcheck://findings/...` documentation identifier

Search goals may contain ordered `stages`. Each stage reports `reached`, `not_reached_within_limits`, `proven_unreachable`, or `blocked_by_stage`. Reached stages carry the same indexed replay metadata as a reached top-level goal. A later stage is cumulative: its witness satisfies that stage and every earlier stage on one path.

Each `explore.passes` entry includes a deterministic `discoveryCurve`, bounded to at most 64 samples. Samples record pass-local state count; cumulative and marginal exact terminals, fallback visible outcomes, runtime errors, assertion violations, reached goals/stages, authored knots, and unique-state novelty; plus the gap from the immediately preceding discovery event. Portfolio reports also carry a merged curve recorded in actual scheduler order (cross-pass unique-state novelty is zero because independent pass hashes are not globally comparable). When compaction occurs, early and latest samples are retained while intermediate samples are deterministically downsampled. Wall-clock time remains observational in progress `elapsedMs`, outside the deterministic curve. These are measured yield facts, not an asymptote estimate, stopping recommendation, or coverage proof.

Portfolio pass telemetry additionally contains `portfolioMarginalCurve` and `portfolioMarginalSummary`. The pass-local curve answers “what did this explorer find itself?”; the marginal curve answers “which findings did this explorer add first to the combined portfolio?” Runtime and assertion credit uses stable identities, approximate runtime locations are conservatively normalized for allocation credit, and every exact ending, visible outcome, authored knot, goal/stage, or critical finding is paid once. Cross-pass state novelty remains zero because independent pass hashes are not comparable. Shadow allocation reads this marginal curve when present; diagnostics retain both.

`discoverySummary` preserves factual distances that curve compaction must not lose: total discovery events, first/latest discovery states, current states since discovery, latest discovery gap, and longest observed gap. These fields intentionally contain no plateau probability, knee estimate, value score, or automatic decision.

`shadowDecision` is Inkcheck's versioned, deterministic v0.6 decision-policy hypothesis over those facts. It is deliberately advisory: `mode` is `shadow`, `applied` is always `false`, and it cannot change allocation or stop a run. The action vocabulary is `continue`, `reallocate`, `probe`, `stop_at_knee`, `stop_at_deadline`, `stop_at_resource_limit`, and `stop_exhaustive`. Each decision records the binding constraint, uncertainty, evidence, reason, and current/suggested per-pass shares. Suggested shares preserve an 8% fractional probe floor (or an equal share for portfolios with more than 12 passes). This is a policy-share intent, not yet a cumulative integer service guarantee when small execution windows round shares to state grants (#106).

Value is compared lexicographically rather than collapsed into an opaque score: runtime errors/assertion violations first, then author/agent intent goals, authored coverage, terminal variants, and finally state novelty. A knee is only a shadow candidate based on the observed recovery envelope, never an exhaustive or coverage-proof claim. Critical evidence remains separately visible in `evidence.criticalEvidenceObserved`.

Choice indices are authoritative for replay because authored labels need not be unique. `playtest_story.replayStatus` is `completed`, `runtime_error`, or `path_changed`; the last status means source changes invalidated the indexed path.

## Compatibility

Within schema v1, fields may be added but existing field meanings and types do not change. A breaking machine-contract change increments `schemaVersion`. Human text/Markdown formatting is not part of the JSON compatibility contract.

Approximate source locations retain `approximate: true`. A bounded non-finding remains partial unless `explore.exhaustive` is true.
