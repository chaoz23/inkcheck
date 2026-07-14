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

## Deliberate limits

This is an engine API foundation. Inkcheck does not yet write checkpoint files from the CLI, reconnect hosted jobs from one, partition a frontier across workers, or apply retention/cleanup policy. Schema v1 supports only base `shared:deep-novelty-v1`; assertions, goals, variable-aware steering, goal-aware steering, and the default portfolio are rejected rather than resumed approximately.

Checkpoint JSON can contain authored choice text, ending text, variable snapshots, serialized Ink runtime state, and exact witness paths. Treat it as sensitive project data. Callers that persist it should use atomic replacement, restrictive access, explicit retention, and source-bound stale checks. Do not commit checkpoints by default.
