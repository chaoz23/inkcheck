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

Schema v1 stores the partially expanded choice cursor, pending nodes and witness ancestry, deep/novelty/seeded frontier internals, PRNG state, deduplication and semantic indexes, findings, coverage, discovery-curve state, counters, and deterministic memory accounting. Tests pause partway through a choice list, round-trip the checkpoint through JSON, and require the resumed result and next checkpoint to deep-equal uninterrupted execution at the same final grant.

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

The logical checkpoint remains schema v1 JSON. New local artifacts stream that JSON through gzip as `.json.gz`; stable IDs still hash the same uncompressed logical checkpoint, and readers continue to accept earlier plain `.json` artifacts. Storage compression therefore changes neither deterministic frontier order nor split-run equivalence.

New artifacts have a small canonical self-checksummed metadata sidecar, allowing list and retention operations to read bounded metadata plus payload file size without opening the frontier. That checksum detects isolated field corruption but is not authentication against a hostile local writer who can recompute it. Opening and resuming remain full-integrity boundaries: manifest validation and the full stored-payload digest precede bounded decompression, then the original stable-ID, envelope, configuration, and freshness checks run. Read failures explicitly distinguish corruption, unsupported schemas, and an artifact that cannot fit the schema-v1 readback envelope.

## Deliberate limits

Schema v1 supports only base `shared:deep-novelty-v1`; assertions, goals, variable-aware steering, goal-aware steering, and the default portfolio are rejected rather than resumed approximately. Hosted/MCP resume, frontier partitioning, and cross-version migration remain future work. Because v1 is one JSON value, it also cannot safely reopen a payload above the runtime's maximum string length even when gzip keeps the stored file below quota. Its compressed buffer, decompressed buffer, JSON string, and parsed graph may overlap in memory. The reader reports an unsafe boundary as a resource limit and preserves the artifact; framed incremental schema v2 is required to remove both the string ceiling and this peak-memory shape.

Checkpoint JSON can contain authored choice text, ending text, variable snapshots, serialized Ink runtime state, and exact witness paths. Treat it as sensitive project data and do not commit checkpoints by default.
