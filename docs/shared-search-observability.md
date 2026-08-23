# Shared-search observability v1

Inkcheck's base shared search now records a bounded, versioned ledger of deterministic logical retention and category-specific yield. Live CLI progress can pair the same sample with observed Node process memory. This is a partial implementation slice tracked by [issue #216](https://github.com/chaoz23/inkcheck/issues/216), which remains open; it is not the complete long-run resource policy.

## Deterministic ledger

Each shared pass exposes `passes[].sharedObservability` with `schemaVersion: 1`. Inkcheck records a `ResourceSampleV1` every 10,000 completed transitions and at termination. Tests and embedders may request a different positive interval through the library option `sharedObservabilityIntervalStates`; CLI users receive the fixed default.

Those are the only sampling boundaries in this slice. Checkpoint save/resume, discovery events, memory or frontier pressure, and other lifecycle events do not trigger an additional sample. Boundary-specific sampling and the policy for choosing it remain deferred under #216.

The ledger retains at most 128 samples. If it grows beyond that bound, Inkcheck deterministically keeps the first and latest boundaries and downsamples the interior. `samplesRecorded`, `samplesRetained`, and `samplesCompacted` make that loss of interval resolution explicit. Every retained sample keeps cumulative counters, and its `delta` is recomputed over the retained interval. This compaction changes telemetry resolution only; it never changes frontier order or findings.

`RetentionBreakdownV1` separates `current` from per-field `peak` values. The current structural subset accounts for:

- pending and active serialized state and variable payloads;
- retained ancestry and node-table slots;
- exact dedupe keys;
- semantic indexes;
- frontier-view references; and
- retained findings.

These are deterministic logical estimates compatible with the existing `sharedMemory` telemetry. Serialized strings use UTF-8 bytes and structural values use documented estimates. A peak object contains independent high-water values, so its components need not describe one simultaneous heap snapshot.

The subset is not complete owner attribution. It does not yet account for Ink runtime objects, checkpoint encode/decode buffers, report serialization, process-tree memory, or reserved finalization headroom. It must not be described as total memory owned by search.

## Yield vector

`YieldIntervalV1` reports separate cumulative and interval counts; it never produces a weighted usefulness score:

| Category | Version-1 meaning |
| --- | --- |
| `critical` | Distinct runtime errors and assertion violations. |
| `intent` | Approved goals and cumulative goal stages reached. |
| `authoredCoverage` | Distinct knots visited. |
| `visibleOutcomes` | Distinct normalized rendered endings; a fallback, not authored-ending identity. |
| `semanticTransitions` | First observation of a bounded Boolean toggle, bounded string/enum change, or numeric zero crossing. Ordinary numeric churn is excluded. |
| `terminalVariants` | Exact terminal states, kept separate from visible outcomes. |
| `rawTerritory` | Transitions, unique exact states, and dedupe hits. These are work facts, not useful yield by themselves. |

`yieldSummary.firstUsefulAtState` marks the first critical, intent, authored-coverage, visible-outcome, or semantic-transition event. `firstCriticalAtState` is separate. `throughFirstUseful` and `afterFirstUseful` keep early value distinct from later yield without collapsing unlike categories. The existing discovery curve also samples assertion and goal changes after those trackers run, and visible-outcome-only changes are valid discovery boundaries.

This slice does not yet expose kth/last event timing, full dry-gap history, rediscovery identities, throughput, retained GiB-minutes, campaign-new attribution, or checkpoint-, pressure-, and discovery-triggered samples.

## Observed process memory

`onSharedObservability` and CLI `resource` progress events pair a deterministic sample with `ProcessMemoryObservationV1`. Each observation also carries numeric `runWideState`. For a standalone or general shared pass it equals the pass-local `sample.state`; for additive directed-goal work it adds the completed general-pass work. The CLI uses `runWideState` for monotonic outer progress and never rewrites the nested pass-local sample or infers an offset from the pass name.

Process fields are:

- `heapUsedBytes` and `heapTotalBytes` from V8;
- process `rssBytes`;
- `externalBytes` and `arrayBuffersBytes`;
- `comparedLogicalAccountedBytes`; and
- `unattributedBytes`, calculated as `heapUsedBytes - comparedLogicalAccountedBytes`.

The difference may be negative because the logical model and V8 heap measure different things. It is an observational comparison, not proof of ownership or a leak. Heap/RSS values vary with runtime, garbage collection, machine load, and Node version.

For that reason, process observations are deliberately excluded from shared checkpoints, canonical JSON reports, report/checkpoint IDs, exact-resume comparisons, and compact machine summaries. They appear only on live CLI progress and the bounded `--json-stream` terminal resource summary. Turning these values into automatic stopping, eviction, or allocation decisions is outside this slice.

## Resume and compatibility

The deterministic ledger is additive inside shared checkpoint schema v1. A split run with the same source, configuration, seed, and sampling interval produces the same search result, ledger, and next checkpoint as one uninterrupted run. Saving a checkpoint preserves the latest fixed-cadence ledger state but does not create a checkpoint-boundary sample. Changing the interval while resuming fails closed.

Resumable checkpoints contain interval samples only; termination samples belong to finalized report telemetry and live progress. For checkpoint state `S`, ledger base `B`, and cadence `I`, `samplesRecorded` is exactly `floor(S / I) - floor(B / I)`. Retained samples stay on cadence boundaries, preserve the first boundary after `B` and the latest completed boundary through `S`, and keep transition counters aligned with their sample/cursor states. Milestone fields must agree with cumulative critical/useful yield: samples before the first-useful state cannot already contain useful yield, and the milestone vector cannot exceed any retained cumulative sample at or after that state. A complete history has base state zero. These cross-field checks fail closed on tampering while still permitting useful evidence discovered before the first retained sample.

Older schema-v1 checkpoints remain readable. Because they contain no historical interval ledger or meaningful-transition counter, resumed telemetry sets `historyComplete: false` and begins interval deltas from the reopen boundary. Search frontier and finding compatibility remain exact; Inkcheck does not invent missing historical telemetry.

Samples and live resource events contain only aggregate counts, byte estimates, pass names, and process values. They contain no story source, choice prose, final text, variable names or values, runtime messages, or witness paths.
