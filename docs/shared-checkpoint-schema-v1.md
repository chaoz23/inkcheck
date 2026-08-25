# Shared checkpoint schema v1

Inkcheck's experimental base shared engine can pause at a state-budget boundary and serialize the complete live search frontier as JSON. Resuming to a larger total grant continues the same deterministic trajectory rather than starting again at the story root.

```js
const { exploreSharedResumable } = require("inkcheck/dist/explore");

const first = exploreSharedResumable(storyJson, knots, externals, {
  maxStates: 100_000,
  seed: 7,
});

const continued = exploreSharedResumable(storyJson, knots, externals, {
  maxStates: 1_000_000,
  seed: 7,
}, first.checkpoint);
```

`maxStates` is the new **total grant**, not extra work. In this example, the resumed call may issue 900,000 more states. Lowering the total below the checkpoint's prior grant is rejected.

## Exact-resume contract

Schema v1 stores the partially expanded choice cursor, pending nodes and witness ancestry, deep/novelty/seeded frontier internals, PRNG state, deduplication and semantic indexes, findings, coverage, discovery-curve state, counters, deterministic memory accounting, and the additive deterministic resource/yield ledger. New checkpoints nest observability schema v2 inside this unchanged top-level checkpoint schema. Tests pause partway through a choice list, round-trip the checkpoint through JSON, and require the resumed result and next checkpoint to deep-equal uninterrupted execution at the same final grant.

Observability v2 persists monotonic sample sequences, canonical coalesced reason vectors, their exact 15-bit `triggerMask` values, fixed eight-count `triggerYield` tuples, category timing/dry-gap state, and separate cadence/event-history completeness. Bits 0 through 14 map to the exported canonical reason order, while tuple positions map to yield-reason bits 1 through 8. Validation requires the mask and vector to agree exactly; each tuple count to be a nonnegative safe integer; and its nonzero positions to equal the vector's yield-reason subset. For adjacent sequences with complete event history, the tuple must equal the semantic-category portion of the interval delta exactly. Across a genuine compaction gap or incomplete v1 history, it is boundary-local while the interval has widened, so each component instead must be no greater than the matching aggregate delta. The vector, mask, and tuple remain attached to their exact boundary when compaction rebuilds an aggregate `yield.delta` across several removed samples. Sequence validation uses monotonicity plus total-record, state, cadence, and possible-remaining-record bounds; it requires contiguous values only before compaction, and does not claim exact replay of discarded compaction choices. Calling `checkpoint()` is side-effect-free: it does not record a checkpoint reason, add a sample, advance a sequence, or change timing. Checkpoint save/reopen also emits no boundary in this slice, and the termination sample is added only to finalized result telemetry after the resumable checkpoint has been captured. The persisted deterministic ledger participates in canonical checkpoint content and therefore in the stable checkpoint ID; live process heap/RSS does not.

Each emitted `SharedObservabilityCheckpointV2` includes a 64-character lowercase `integritySha256`. Inkcheck accepts exactly the known v2 ledger shape, rebuilds every fixed ledger field—including all nested sample, retention, yield, counter, base/cursor, milestone, completeness, and timing fields—in schema-defined order, excludes the checksum from that body, prefixes `inkcheck:shared-observability-checkpoint:v2\0`, and SHA-256 hashes the canonical JSON bytes. Raw object-key order is irrelevant, and accepted input is re-emitted in canonical key order. Missing or unknown fields, a malformed checksum, or a stale digest after accidental mutation fail closed.

`integritySha256` is a deterministic self-check, not authentication: a writer capable of changing the checkpoint can recompute it. It catches stale or accidental internal ledger mutation and binds all fixed known fields together. The persisted artifact's manifest digest and full stored-payload digest remain the separate external corruption/readback boundary; after decoding that payload, the nested digest checks the logical observability ledger.

Older top-level schema-v1 checkpoints remain readable. An artifact is first validated against its original logical bytes and stable ID; migration does not rewrite that stored artifact or change its ID. A checkpoint with the earlier observability schema v1 resumes through a deterministic v2 migration. It synthesizes each retained mask from the explicit v1 interval/termination boundary, not from the sample's potentially rebuilt aggregate yield delta, and sets `triggerYield` to eight zeros because v1 recorded no exact category trigger tuple. Zero means no v1 trigger was recorded, not that no category event occurred in the interval. Its fixed-cadence prefix remains available, but missing category/frontier event history is marked with `eventHistoryComplete: false`. At migration, identity counts remain calculable, the per-million rate is calculable once state is nonzero, and the unprovable first/last position and dry-gap fields are `null`. Subsequent v2 events populate only facts that become knowable after reopening; Inkcheck never invents the missing prefix. A checkpoint that predates the observability ledger continues with `historyComplete: false`. Neither older form contains the nested digest; its first emitted v2 checkpoint gains the canonical `integritySha256` and one deterministic identity without rewriting the input artifact. A checkpoint that contains either ledger version must resume with the same sampling interval. See [shared-search observability](shared-search-observability.md).

The checkpoint is bound to:

- compiled story SHA-256;
- knot/source-location map SHA-256;
- checkpoint schema and shared-engine identity;
- depth, search seed, Ink story seed, hidden-state sensitivity, randomness detection, frontier envelopes, and external bindings.

A mismatch or malformed reference fails closed. A checkpoint is returned only when a state-budget boundary leaves live work. Exhausted searches and memory-, time-, or frontier-stopped searches return their final result without a resumable checkpoint.

## CLI persistence

The local CLI stores this schema inside a separate versioned artifact envelope:

```sh
inkcheck story.ink --search=shared --no-min-repro --max-states 100000 --save-checkpoint --json
inkcheck resume checkpoint-0123456789abcdef01234567 --max-states 1000000 --json
```

See [local resumable checkpoints](local-checkpoints.md) for freshness, privacy, atomic-write, quota, and retention behavior.

The logical checkpoint remains schema v1. The default local artifact still streams that one JSON value through gzip as `.json.gz`, while library callers may explicitly choose the framed-v2 `.inkcp` storage codec. Both layouts reconstruct the same property-ordered logical checkpoint before the unchanged stable-ID check; readers continue to accept earlier plain `.json` artifacts. Compression or framing therefore changes neither the checkpoint ID, deterministic frontier order, nor split-run equivalence. A verified artifact in either layout wins same-ID reuse, and new writers never publish both layouts for one ID.

New artifacts have a small canonical self-checksummed metadata sidecar, allowing list and retention operations to read bounded metadata plus payload file size without opening the frontier. A framed-v2 sidecar additionally binds the exact private component/frame/index summary; its public projection contains only fixed component names and numeric counts/bytes. Those checksums detect isolated field corruption but are not authentication against a hostile local writer who can recompute them. Opening and resuming remain full-integrity boundaries: manifest validation and the full stored-payload digest are the external stored-file corruption boundary, framed records or the legacy one-value payload are decoded under explicit bounds, the nested observability `integritySha256` is checked as part of logical checkpoint validation, and the original stable-ID, envelope, configuration, and freshness checks follow. Read failures explicitly distinguish corruption, unsupported schemas, and an artifact that cannot fit its configured readback envelope.

The library reopen APIs return a separate schema-v1 read-accounting receipt outside this envelope; typed `CheckpointReadError` failures carry the partial receipt reached before failure. For legacy artifacts it distinguishes the manifest and its checksum-validation string, stored payload, gzip output versus plain JSON, raw string, parsed source graph, existing stable-ID traversal and configuration-comparison strings, effective limits, conservative potential, and checkpoint graph retained on return. Framed v2 marks the monolithic payload/string/parsed-artifact owners `not_applied` and adds fixed component/frame/index totals. Metadata-only open retains no checkpoint graph; successful resume transfers one. Conservative potential is not an observed peak or full V8/runtime heap. These counters change neither bytes, stable identity, validation order, source-freshness behavior, nor split-run trajectory.

## Deliberate limits

Schema v1 supports only base `shared:deep-novelty-v1`; assertions, goals, variable-aware steering, goal-aware steering, and the default portfolio are rejected rather than resumed approximately. Hosted-job resume and frontier partitioning remain future work; MCP continuation is available through cooperative result-window sessions. The default gzip layout is still one JSON value and cannot safely reopen a payload above the runtime's maximum string length even when gzip keeps the stored file below quota. Its compressed buffer, decompressed buffer, JSON string, and parsed graph may overlap in memory. The reader reports an unsafe boundary as a resource limit and preserves the artifact. The opt-in framed-v2 codec removes those whole-value readback materializations by delivering bounded records into the same logical schema-v1 resume graph; that graph and bounded frame/runtime workspace still consume memory.

The observability reason vocabulary reserves `checkpoint`, `epoch`, and `pressure`, but this slice emits none of those boundaries. The optional artifact-v2 storage encoding adds no resource policy, owner ceiling, epoch behavior, default-format promotion, or claim that issue #156 or #216 is complete.

Checkpoint JSON can contain authored choice text, ending text, variable snapshots, serialized Ink runtime state, and exact witness paths. Treat it as sensitive project data and do not commit checkpoints by default.
