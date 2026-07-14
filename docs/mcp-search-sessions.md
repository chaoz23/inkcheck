# MCP result-window sessions

Inkcheck's MCP server can continue one exact base-shared search across calls and fresh MCP processes:

1. `start_search` runs a bounded synchronous window and returns a bearer `sessionCapability`.
2. `inspect_search` reopens bounded status and privacy-minimal finding summaries.
3. `continue_search` raises the cumulative state grant and continues the exact saved frontier.
4. `cancel_search` marks the session cancelled between windows while retaining recoverability by default.
5. `replay_witness` executes one stable finding from the latest report against current source.

This is cooperative **result-window execution**, not a background job. A `start_search` or `continue_search` call runs until its durable boundary. `cancel_search` cannot interrupt a window already running; call it after that tool returns. Use hosted async jobs when mid-run reconnect/cancel behavior is required.

## Bounds

- First-window default: 1,000,000 states.
- Added work per call: at most 5,000,000 states.
- Cumulative session grant: at most 100,000,000 states.
- One recoverable session per story entrypoint.
- At most 100 session metadata files per project and 64 retained events per session.

`maxStates` is always a cumulative total. A session at 1M can continue to 6M in one call, not to 7M. Every mutation requires the last returned `revision`; stale concurrent operations fail closed.

## Supported scope

Sessions preserve the exact frontier only for base shared search without assertions, goals, variable-aware steering, or the min-repro slice. Source, knot map, depth, seeds, hidden turn/random sensitivity, external bindings, and frontier envelopes are checkpoint-bound. A source change makes continuation fail rather than silently restart.

Every completed window writes a normal source-bound report under `.inkcheck/reports/`. When live work remains it also writes an exact checkpoint under `.inkcheck/checkpoints/`. Session responses expose stable IDs, counters, binding reason, bounded event history, and paged finding summaries; they do not return the full report or checkpoint payload.

## Witness replay

`replay_witness` requires the bearer capability, last observed revision, and a stable finding ID returned by `inspect_search`. It binds to the latest immutable report, requires current source and an indexed witness, recompiles, and executes the saved choices with the saved Ink story seed. Success increments the session revision and appends only report/finding IDs plus replay status to bounded metadata.

Search-session schema v2 adds that replay audit event. Inkcheck reads v1 foundation sessions and upgrades them atomically on the next mutation; unknown future schemas still fail closed.

This is an explicit content-revealing execution boundary: the response includes the selected transcript, choice text, runtime result, and final variables. None of that payload is copied into session metadata or ordinary inspection. Stale revisions/source, missing or foreign IDs, findings without indexed replay, and concurrent session mutations fail instead of replaying approximately.

## Capability and privacy

The session capability is a high-entropy local bearer secret. Keep it out of commits, logs, issues, and chat transcripts. Session files are named by the capability hash and stored under `.inkcheck/sessions/` with private directory/file modes where supported. Metadata contains no story prose, variables, choice paths, transcript, report payload, or frontier payload.

Checkpoints and reports can contain authored text and executable runtime state. They retain their own storage and privacy contracts. `cancel_search` keeps the checkpoint by default so work can resume. `discard: true` forgets session metadata and the capability, but does not bypass the normal report/checkpoint retention lifecycle.
