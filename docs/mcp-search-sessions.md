# MCP result-window sessions

Inkcheck's MCP server can continue one exact base-shared search across calls and fresh MCP processes:

The operation names below describe the workflow contract. The default compact MCP profile exposes `start_search` directly and routes the other operations through `inkcheck_workflow { operation, request }`; `inkcheck_capabilities.mcp.workflowOperations` is the authoritative compact request map. Set `INKCHECK_MCP_PROFILE=full` only when a client needs every operation registered as a separate named tool.

1. `start_campaign` creates a durable aggregate policy and executes its first exact synchronous window.
2. `continue_campaign` asks that policy to allocate and execute the next exact window.
3. `start_search` runs an explicitly granted synchronous window and returns a bearer `sessionCapability`.
4. `inspect_search` reopens bounded status and privacy-minimal finding summaries for either surface.
5. `continue_search` raises an ordinary session's cumulative state grant and continues the exact saved frontier.
6. `add_goal` spends an explicit additional budget on one safe typed goal from the story root without mutating that frontier; campaign use requires `approved_goals`.
7. `add_assertions` spends an explicit additional budget on validated rules for a `runtime_assertions` campaign without mutating that frontier.
8. `cancel_search` terminates a campaign with its latest report provenance, or marks an ordinary session cancelled while retaining recoverability by default.
8. `replay_witness` executes one stable finding from the latest report against current source.
9. `pin_regression` and `check_regression` preserve and recheck one confirmed runtime failure across source edits.

This is cooperative **result-window execution**, not a background job. A `start_search` or `continue_search` call runs until its durable boundary. `cancel_search` cannot interrupt a window already running; call it after that tool returns. Use hosted async jobs when mid-run reconnect/cancel behavior is required.

## Bounds

- First-window default: 1,000,000 states.
- Added work per call: at most 5,000,000 states.
- Base plus cumulative directed grants: at most 100,000,000 states.
- One recoverable session per story entrypoint.
- At most 100 session metadata files per project and 64 retained events per session.
- At most 1,024 planned campaign windows. This is a hard metadata safety ceiling, not a useful-work target; knee stopping normally ends campaigns earlier and the independent session-byte ceiling remains authoritative.

For `continue_search`, `maxStates` is always the new cumulative base total. A session at 1M can continue to 6M in one call, not to 7M. For `add_goal`, `maxStates` is additional directed work for that probe. Inspection exposes `budget.base`, `budget.directed`, and `budget.total`; directed work never disappears inside the base total. Every mutation requires the last returned `revision`; stale concurrent operations fail closed.

## Supported scope

Sessions preserve the exact frontier only for base shared search without assertions, goals, variable-aware steering, or the min-repro slice. Source, knot map, depth, seeds, hidden turn/random sensitivity, external bindings, and frontier envelopes are checkpoint-bound. A source change makes continuation fail rather than silently restart.

Every completed window writes a normal source-bound report under `.inkcheck/reports/`. When live work remains it also writes an exact checkpoint under `.inkcheck/checkpoints/`. Session responses expose stable IDs, counters, binding reason, bounded event history, and paged finding summaries; they do not return the full report or checkpoint payload.

Default session responses are capped at 32 KiB and expose at most ten recent events and goal probes plus 20 finding summaries. `inspect_search`, `continue_search`, and `continue_campaign` accept the opaque `session.eventPage.nextSince` cursor from an earlier response. When supplied, `session.events` contains only newer retained events. `eventPage` states the returned/latest sequence, omitted/dropped-history boundaries, and whether a gap exists; the cursor is bound to one private session and fails closed when foreign or ahead of the durable log. This output cursor does not change exploration state or coverage.

## Campaign windows

`start_campaign` defaults to a `balanced` named mode. `quick`, `deep`, `overnight`, and `campaign` provide progressively larger bounded postures; `fixed` and the deprecated `intent` input preserve explicit callers. Optional state/window/time/memory/disk/deadline ceilings, resource/value/stop preferences, long-tail share/probe count, regression reserve, seeds, depth, and frontier envelopes remain bounded and replayable. Exact base continuation is sequential. Protected long-tail allocations are independent root-started portfolio children using production automatic concurrency under the same aggregate state, time, memory, and disk ceilings.

Campaign state lives inside the same private, revisioned session artifact as the exact checkpoint capability hash. Each completed allocation records marginal critical/intent/authored/terminal yield, measured elapsed time and peak heap, referenced artifact bytes, report ID, optional checkpoint ID, purpose, partition, grant, consumption, and stop reason. `inspect_search.campaign.latestWindow` exposes that latest immutable provenance without returning report or frontier contents. A long-tail child has its own report but no checkpoint; the session's base report and checkpoint remain unchanged and recoverable.

`campaign.decision` is the default compact explanation: stable policy ID/version, named mode and sorted overrides, latest allocation reason, preferred-yield rate, three-window empirical next range, high/medium uncertainty, throughput/resources, binding constraint, changes that permit more work, and the latest report ID. Use `open_report` for full curves and `get_finding` for one finding rather than expanding every report by default.

Source edits invalidate continuation and retain prior evidence. Deadlines, cancellation, and hard resource boundaries keep prior report provenance. `stopPolicy: knee` becomes eligible only after three consecutive preferred-yield-dry windows, then spends protected long-tail obligations before stopping; the response repeatedly states that this is not coverage proof. `ceilings` ignores the knee. Campaign capabilities cannot be passed to ordinary `continue_search`. Long-tail, goal, and assertion children preserve the base report/checkpoint and keep full evidence in separate reports. Long-tail yield is identity-deduplicated across prior campaign reports for critical findings, reached goals, visited authored knots, and exact terminal variants. Concurrent child scheduling, merged child/base reports, broader specialist dispatch, and cost-provider accounting are not yet implemented.

## Additive goal probes

`add_goal` accepts one existing safe typed goal or ordered staged goal and a grant of at most 5M states. It validates the goal against current story variables and knots, then runs deterministic goal-directed shared search from the story root. It does not continue, reorder, or mutate the exact base frontier. The base report/checkpoint IDs and base counters remain unchanged.

The call saves a separate private source-bound goal report and returns the goal result, closest state or exact witness, plus explicit directed and campaign accounting. Because that response can include variable names/values and choice text, it is a content-revealing operation. Ordinary inspection retains only an opaque goal handle, reached/missed status, report ID, and grant/consumption counts; conditions, descriptions, variables, and witnesses are not copied into session metadata.

A bounded miss remains `not_reached_within_limits`. Goal work is additional evidence, never baseline-equivalent coverage. This first slice intentionally does not persist a directed frontier, continue one probe, or reprioritize the saved base frontier.

## Witness replay

`replay_witness` requires the bearer capability, last observed revision, and a stable finding ID returned by `inspect_search`. It binds to the latest immutable report, requires current source and an indexed witness, recompiles, and executes the saved choices with the saved Ink story seed. Success increments the session revision and appends only report/finding IDs plus replay status to bounded metadata.

Search-session schema v2 adds that replay audit event. Schema v3 adds regression audit events, schema v4 adds additive-goal accounting and opaque summaries, and schema v5 adds the digest-bound campaign ledger. Inkcheck reads v1-v4 sessions and upgrades them atomically on the next mutation; unknown future schemas still fail closed.

This is an explicit content-revealing execution boundary: the response includes the selected transcript, choice text, runtime result, and final variables. None of that payload is copied into session metadata or ordinary inspection. Stale revisions/source, missing or foreign IDs, findings without indexed replay, and concurrent session mutations fail instead of replaying approximately.

## Regression pins

`pin_regression` accepts one runtime-error finding from the latest current report. It verifies the witness, then stores indexed choices, story seed, baseline fingerprint, and SHA-256 hashes of the observed runtime errors under `.inkcheck/regressions/`. It stores no error text, choice labels, transcript, variables, ending text, or story prose. The deterministic pin ID makes retries idempotent.

After an edit, `check_regression` recompiles current source and replays the saved indexed choices without spending search states:

- `fixed`: the path completes without the pinned runtime failure;
- `still_failing`: the pinned runtime-error hash is observed again;
- `path_changed`: indexed choices no longer follow the path or a different runtime failure blocks it first.

Compile failures are prerequisite errors, never `fixed`. The first pin schema intentionally rejects endings and assertion violations: ending reachability is not a failure, and assertions need assertion-aware evaluation rather than plain playtest. Pins are private `0700`/`0600` artifacts where supported, capped at 1 MiB each and 100 per project, session-bound, and ignored by the agent kit. Search-session schema v3 introduced privacy-safe pin/check audit events; schema v4 retains them unchanged.

## Capability and privacy

The session capability is a high-entropy local bearer secret. Keep it out of commits, logs, issues, and chat transcripts. Session files are named by the capability hash and stored under `.inkcheck/sessions/` with private directory/file modes where supported. Metadata contains no story prose, variables, choice paths, transcript, report payload, or frontier payload.

Checkpoints and reports can contain authored text and executable runtime state. They retain their own storage and privacy contracts. `cancel_search` keeps the checkpoint by default so work can resume. `discard: true` forgets session metadata and the capability, but does not bypass the normal report/checkpoint retention lifecycle.
