# Shared-search observability v2

Inkcheck's base shared search records a bounded, versioned ledger of deterministic logical retention and category-specific yield. Live CLI progress can pair the same deterministic sample with observed Node process memory. This remains a partial implementation of [issue #216](https://github.com/chaoz23/inkcheck/issues/216): it adds event-aware evidence, not a resource, allocation, or stopping policy. Issue #216 remains open.

## Deterministic ledger

Each shared pass exposes `passes[].sharedObservability` with `schemaVersion: 2`. Its `ResourceSampleV2` entries contain:

- `schemaVersion: 2`;
- a monotonic logical `sequence` retained across deterministic sample compaction;
- one canonical, sorted `reasons` vector;
- its exact 15-bit numeric `triggerMask`;
- an exact eight-count `triggerYield` tuple;
- the pass-local transition `state`;
- deterministic logical `retention`; and
- cumulative and interval `yield` vectors.

The enclosing `SharedObservabilityTelemetryV2` contains `schemaVersion`, `sampleIntervalStates`, `samplesRecorded`, `cadenceSamplesRecorded`, `samplesRetained`, `samplesCompacted`, `historyComplete`, `eventHistoryComplete`, `samples`, the existing schema-v1 `yieldSummary`, and schema-v2 `timing`. The two completeness flags carry separate meanings: `historyComplete` says whether the cadence ledger has its full prefix, while `eventHistoryComplete` says whether off-cadence event positions are reconstructable. Complete event history implies complete cadence history, but not conversely.

The default cadence remains every 10,000 completed transitions. Tests and embedders may request a different positive interval through `sharedObservabilityIntervalStates`; CLI users receive the fixed default. The four sample counters distinguish unique transition positions recorded before compaction, fixed-cadence boundaries crossed, retained entries, and entries removed by compaction. The ledger retains at most 128 samples and deterministically preserves the early and latest history while downsampling the interior. Compaction changes telemetry resolution only; it never changes frontier order, findings, or stop behavior.

### Reasons and coalescing

One transition can satisfy several triggers. Inkcheck retains one ledger sample for that pass-local state and coalesces all applicable reasons into this canonical order:

1. `cadence`
2. `runtime_error`
3. `assertion_violation`
4. `goal_reached`
5. `stage_reached`
6. `authored_knot`
7. `visible_outcome`
8. `semantic_transition`
9. `terminal_variant`
10. `frontier_compaction`
11. `frontier_ceiling`
12. `checkpoint`
13. `epoch`
14. `pressure`
15. `termination`

Reason order is schema data, not observation order. Repeated reasons are removed. Bit positions 0 through 14 in `triggerMask` map exactly to that exported canonical order, and the mask must equal the `reasons` vector: a reason is present exactly when its bit is set. `triggerYield` positions map to reason bits 1 through 8 in the same order: runtime errors, assertion violations, goals, stages, authored knots, visible outcomes, semantic transitions, and terminal variants. Every count is a nonnegative safe integer, and a tuple position is nonzero exactly when its corresponding reason is present. A cadence boundary that discovers one authored knot and one terminal variant therefore has reasons `["cadence", "authored_knot", "terminal_variant"]`, mask `289` (bits 0, 5, and 8), and trigger yield `[0, 0, 0, 0, 1, 0, 0, 1]`. Termination at an already sampled state adds `termination` and bit 14 to that same logical boundary rather than inventing a duplicate sample.

The reason vector, mask, and trigger-yield tuple encode only the exact retained boundary. They are deliberately separate from `yield.delta`. Between adjacent sample sequences with complete event history, `triggerYield` must equal the semantic-category portion of that sample's interval delta exactly. After sample compaction creates a genuine sequence gap, Inkcheck rebuilds the aggregate delta across the wider interval between retained samples but preserves the ending boundary's original `reasons`, `triggerMask`, and `triggerYield`; incomplete v1 history has the same information limit. In those gap or incomplete-history cases, every trigger-yield count must be no greater than the matching aggregate delta count. A category count inside a widened interval therefore does not imply that the category triggered at its ending boundary. The redundant vector/mask/tuple contract makes that distinction fail-closed with a fixed bounded shape.

This slice emits cadence, category, `frontier_compaction`, `frontier_ceiling`, and `termination` reasons. The `checkpoint`, `epoch`, and generic `pressure` values reserve stable vocabulary for later work; checkpoint save/reopen, epoch lifecycle, memory/time pressure, and other resource actions do not emit those boundaries yet. `frontier_ceiling` is the existing explicit shared-frontier binding event, not a general owner-pressure policy.

The bounded ledger and the live callback have deliberately different rates. The ledger retains the event boundaries above and compacts them deterministically. `onSharedObservability` and CLI `resource` progress sample process memory only at the fixed cadence and final termination. A pending cadence observation is emitted only after its state is closed, so any same-state event or termination reason is already coalesced and append-only consumers never receive partial revisions. With the production cadence and 100-million-state ceiling, one uninterrupted shared-pass execution emits at most 10,001 live resource observations; category-heavy stories do not increase that bound.

## Retention breakdown

The retention breakdown separates `current` from per-field `peak` values. The current structural subset accounts for:

- pending and active serialized state and variable payloads;
- retained ancestry and node-table slots;
- exact dedupe keys;
- semantic indexes;
- frontier-view references; and
- retained findings.

These are deterministic logical estimates compatible with the existing `sharedMemory` telemetry. Serialized strings use UTF-8 bytes and structural values use documented estimates. A peak object contains independent high-water values, so its components need not describe one simultaneous heap snapshot. Every byte-component peak is at most the observed simultaneous total peak, while that total peak is at most the sum of the independent byte-component peaks.

`passes[].sharedOwnerAccounting` is a separate schema-v1 sibling, so the exact retention-v1 and observability-v1/v2 records remain compatible. It adds the retained sample count and compact canonical UTF-8 bytes for the in-memory observability ledger. That projection excludes every embedded retention snapshot, the checkpoint-only checksum, the owner record itself, and the point-in-time `currentDryStates`/rate views that are derived only when telemetry is emitted; stable identity, first/last-position, and longest-gap timing state remains included. It therefore cannot recursively charge accounting for its own accounting or turn ordinary transitions into whole-ledger serialization work. `current.totalAccountedBytes` is the existing search-retained total plus that ledger projection. `peak.totalAccountedBytes` is the largest simultaneously observed combined total, not the sum of independent field peaks. The sample-count and byte peaks remain separate.

Fresh runs report complete owner history. A new checkpoint persists only the versioned owner high-water state beside—not inside—the checksum-bound observability ledger. Reopening an older checkpoint derives the current ledger footprint but reports `historyComplete: false` instead of inventing historical peaks. Checkpoint construction remains side-effect-free, and this sibling state does not change frontier policy.

Owner attribution remains incomplete. Separate lifecycle receipts now describe the existing checkpoint reopen path—manifest, stored and decompressed buffers, raw JSON, parsed graph, validation traversal, and a transfer-only returned checkpoint graph—and the existing report enrichment/save path. The report receipt measures compact-JSON serialized-view proxies for the source exploration graph, enriched returned report, created artifact envelope, or reuse-parsed artifact as applicable. Its conservative potential deliberately assumes no reclamation, but source and returned views can repeat shared backing; it is therefore neither exclusive retained-owner attribution nor an observed simultaneous heap peak. These lifecycle values are never added to shared retained `current`/`peak` totals.

Retained samples still do not account for Ink runtime objects, process-tree memory, parser/zlib implementation internals, or every transient combined heap peak. Configured checkpoint/finalization headroom is capacity, not retained allocation, and is never added to logical current/peak totals. A finalization time reserve is effective only inside an overall time envelope; without `maxTimeMs`, its reported effective `timeMs` is zero because no deadline exists from which time can be withheld. These values must not be described as total search-owned memory, and this slice does not set owner budgets or apply pressure actions.

## Yield vector and event timing

The yield ledger reports separate cumulative and interval counts; it never produces a weighted usefulness score:

| Category | Meaning |
| --- | --- |
| `critical` | Distinct runtime errors and assertion violations. |
| `intent` | Approved goals and cumulative goal stages reached. |
| `authoredCoverage` | Distinct knots visited. |
| `visibleOutcomes` | Distinct normalized rendered endings; a fallback, not authored-ending identity. |
| `semanticTransitions` | First observation of a bounded Boolean toggle, bounded string/enum change, or numeric zero crossing. Ordinary numeric churn is excluded. |
| `terminalVariants` | Exact terminal states, kept separate from visible outcomes. |
| `rawTerritory` | Transitions, unique exact states, and dedupe hits. These are work facts, not useful yield by themselves. |

`yieldSummary.firstUsefulAtState` marks the first critical, intent, authored-coverage, visible-outcome, or semantic-transition event. `firstCriticalAtState` is separate. `throughFirstUseful` and `afterFirstUseful` keep early value distinct from later yield without collapsing unlike categories.

Telemetry v2 also exposes `timing` entries for `critical`, `intent`, `authoredCoverage`, `visibleOutcomes`, `semanticTransitions`, and `terminalVariants`. Each entry reports:

- `identities` observed in that category;
- `firstAtState` and `lastAtState` transition positions;
- `longestDryStates` and `currentDryStates`; and
- `identitiesPerMillionTransitions`.

These are deterministic transition distances and category-specific rates, not wall-clock timing, a plateau estimate, or a coverage claim. Raw territory deliberately has no useful-yield timing entry. The existing discovery curve still records its own bounded factual discovery history; observability reasons identify why a resource sample exists.

The deterministic pass ledger itself does not add kth-event milestones, campaign-new versus rediscovered identities, wall-clock rates, or complete owner-cost attribution. A separate outer `LongRunTelemetryV1` lifecycle record now combines the live v2 observations over their exact first-to-last sampled interval. It reports search-active-minute and deterministic retained-GiB-minute rates for the six useful-yield categories without changing this checkpointed ledger. Campaign allocations separately persist explicit campaign-new and rediscovered counts; those fields remain campaign-window facts rather than additions to `passes[].sharedObservability`.

## Observed process memory

`onSharedObservability` and CLI `resource` progress events expose `SharedResourceObservationV2`: a deterministic v2 sample paired with the existing `ProcessMemoryObservationV1`. Each observation also carries numeric `runWideState`. For a standalone or general shared pass it equals the pass-local `sample.state`; for additive directed-goal work it adds the completed general-pass work. The CLI uses `runWideState` for monotonic outer progress and never rewrites the nested pass-local sample or infers an offset from the pass name.

Process fields include V8 heap used/total, process RSS, external and array-buffer bytes, compared logical accounted bytes, and an observational unattributed difference. The difference may be negative because the logical model and V8 heap measure different things. It is not proof of ownership or a leak.

Process observations are deliberately excluded from shared checkpoints, canonical JSON reports, report/checkpoint IDs, and exact-resume comparisons. Individual samples appear on live CLI progress; successful ordinary JSON and bounded evidence-stream terminal output may additionally expose their validated numeric `LongRunTelemetryV1` integral, and campaign inspection may expose the latest persisted window cost. These outer records never copy the raw sample history into a report or checkpoint. Their values are not frontier, allocation, or stopping-policy inputs. Collection does have bounded runtime overhead and can move an execution that is already immediately beside a memory or time guard, so exact-head calibration—not instrumentation alone—is required for an overhead or policy-neutrality claim.

## Resume and V1 migration

The deterministic ledger is additive inside shared checkpoint schema v1. New checkpoints persist observability schema v2, including canonical sample reasons, exact trigger masks and boundary-local trigger-yield tuples, sequences, timing state, completeness markers, and the nested ledger self-check described below. For the same source, configuration, seeds, cadence, and prior event history, split execution produces the same search result, v2 ledger, and next checkpoint as uninterrupted execution.

Checkpoint construction is side-effect-free: calling `checkpoint()` does not add or modify a sample, advance a sequence, or mutate timing. Checkpoint save/reopen likewise emits no observability boundary in this slice. Termination samples belong to finalized report telemetry and live progress, not the resumable pre-finalization checkpoint. Deterministic observability state participates in the logical checkpoint bytes and stable checkpoint ID; live process observations do not.

Every emitted `SharedObservabilityCheckpointV2` carries `integritySha256`, a 64-character lowercase SHA-256 self-check. Inkcheck validates the exact known v2 ledger shape, reconstructs every fixed field and nested sample/count/timing field in schema-defined order, omits `integritySha256` from that body, prefixes the domain separator `inkcheck:shared-observability-checkpoint:v2\0`, and hashes the resulting canonical JSON bytes. Source object-key insertion order therefore cannot change the digest: accepted reordered input is emitted again in canonical order. A missing, stale, malformed, or accidentally mutated ledger fails closed instead of being resumed.

This checksum binds the logical ledger fields together; it is not authentication, a signature, or a MAC. A writer able to alter the checkpoint can recompute it. For persisted local artifacts, the manifest digest and full stored-payload digest remain the external file-corruption/readback boundary before bounded decompression; `integritySha256` is the additional internal self-check on the decoded observability ledger. It is persisted checkpoint state only and is not added to live resource progress or report telemetry.

Older shared-checkpoint-schema-v1 artifacts remain readable. A checkpoint with observability schema v1 is deterministically migrated to v2 when resumed. Migration derives each historical reason vector and trigger mask only from the explicit v1 boundary (`interval`, `termination`, or their combination), never from a rebuilt aggregate yield delta. Because v1 did not retain exact category triggers at that boundary, migration sets all eight `triggerYield` positions to zero. Those zeros mean “no v1 category trigger was recorded”; they are not proof that no category event occurred within the interval. The existing fixed-cadence history remains usable, but v1 did not record category/frontier reason history or the event positions needed for every timing field. Migrated telemetry therefore uses `eventHistoryComplete: false`. At the migration boundary, identity counts remain calculable from cumulative yield and `identitiesPerMillionTransitions` remains calculable once the completed-transition count is nonzero; `firstAtState`, `lastAtState`, `longestDryStates`, and `currentDryStates` are `null` because the old artifact cannot prove them. Subsequent v2 events may populate position and current-gap facts that become knowable after reopening, but unknown prefix facts remain `null`. Inkcheck does not reconstruct or guess missing events. `historyComplete` continues to distinguish a checkpoint that predates the ledger entirely. Neither a v1 artifact nor a pre-ledger artifact contains the nested checksum; the first v2 checkpoint emitted after either migration carries the canonical `integritySha256`. Newly observed v2 events after the reopen remain exact, but they do not retroactively make the missing prefix complete.

Changing the sampling interval while resuming still fails closed. Sequence validation requires positive strictly increasing values bounded by the total record count, state distance, cadence count, and possible records remaining; un-compacted ledgers must be contiguous and the latest retained sequence must equal `samplesRecorded`. Compacted gaps are expected: these relational checks do not claim to reconstruct or replay the exact discarded compaction history. Noncanonical or incompatible reasons, vector/mask/tuple disagreement, an inexact adjacent complete-history trigger delta, an over-large gap/incomplete-history trigger delta, inconsistent counters, an invalid integrity self-check, and impossible timing/yield relationships also fail closed. This migration changes nested observability data, not the shared checkpoint's top-level schema version or deterministic search semantics.

## Scope and privacy

Samples and live resource events contain only aggregate counts, boundary-local numeric trigger counts, byte estimates, pass names, reason codes and their bounded numeric mask, transition positions, and process values. They contain no story source, choice prose, final text, variable names or values, runtime messages, or witness paths.

Checkpoint/epoch/pressure boundaries, complete exclusive-owner accounting, and any observability-driven allocation, eviction, compaction, or stopping policy remain future #216/#156/#217/#218 work. The outer lifecycle ledger provides a first interval-aligned deterministic retained-GiB-minute cost proxy, not a complete heap-attribution or simultaneous-peak model. The earlier V1 overhead study is tied to its measured source heads; it is not an overhead claim for this exact V2 implementation head. A separate exact-head calibration is required before any performance or promotion claim.
