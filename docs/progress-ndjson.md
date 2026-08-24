# NDJSON progress contract

`inkcheck --progress=ndjson` writes newline-delimited JSON progress events to stderr while the final report stays on stdout. It is for agents, CI log parsers, hosted wrappers, and other automation that need to watch a bounded run without scraping human output.

Progress is about work-budget activity. `statesExplored / stateBudget` tells you how much of the configured state budget has been spent, not how much of the story has been proven covered. Treat the final stdout report as authoritative for compile results, endings, runtime errors, unvisited knots, truncation causes, `nextRun`, and exit status.

## Stream shape

Each stderr line is one JSON object. Consumers should parse one line at a time and ignore blank lines.

Current events use `schemaVersion: 1`.

Common fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | number | Progress schema version. Currently `1`. |
| `sequence` | number | Monotonic event number starting at `1` for each CLI process. |
| `type` | string | Event kind: `run_start`, `phase_start`, `progress`, `discovery`, `resource`, `phase_end`, or `run_end`. |
| `elapsedMs` | number | Milliseconds since the CLI run started. |
| `statesExplored` | number | Total story states explored so far in this CLI process. |
| `stateBudget` | number | Total configured work budget: baseline plus additional goal states. |
| `baselineStateBudget` | number | General exploration budget, unchanged by goal steering. |
| `goalStateBudget` | number | Additional directed-goal budget; zero unless explicitly requested. |
| `budgetFraction` | number | `statesExplored / stateBudget`, capped at `1`. This is work-budget progress, not story coverage. |

Optional fields:

| Field | Type | When present |
| --- | --- | --- |
| `phase` | string | Phase events and some progress events. Known phases are `compile`, `source_scan`, `explore`, `min_repro`, and `report`. |
| `pass` | string | The pass whose slice produced this progress event, such as `dfs:last`, `beam:w=64`, `random:seed=1`, or `bfs`. Identifies which pass ran; the counts below are run-wide, not scoped to it. |
| `visibleOutcomes` | number | Distinct normalized visible ending texts observed; a fallback outcome identity, not authored semantic proof. |
| `assertionViolations` | number | Distinct configured assertions observed violated. |
| `goalsReached` | number | Distinct configured top-level goals reached. |
| `stagesReached` | number | Distinct configured staged-goal milestones reached. |
| `discoveryEvents` | number | Meaningful discovery events observed by the active pass or merged portfolio recorder. |
| `statesSinceLastDiscovery` | number or null | Work states since the latest meaningful discovery; factual dry distance, not plateau proof. |
| `endingsFound` | number | Distinct endings found so far across the whole run (all passes deduplicated). Non-decreasing within a run. |
| `runtimeErrorsFound` | number | Distinct runtime errors found so far across the whole run. Non-decreasing within a run. |
| `unvisitedKnots` | number | Knots not yet reached by any pass in this run. Non-increasing within a run. |
| `knotsVisited` | number | Cumulative authored knots reached. Present on `discovery` events. |
| `discoveries` | object | Numeric deltas first observed at this event: `endings`, `runtimeErrors`, `knotsVisited`, `visibleOutcomes`, `assertionViolations`, `goalsReached`, and `stagesReached`. Present only on `discovery` events. |
| `sharedObservability` | object | Shared-search `resource` events only: one deterministic `ResourceSampleV2` paired with observed process heap/RSS. `runWideState` is the explicit outer-run position; nested `sample.state` remains local to its shared pass. See [shared-search observability](shared-search-observability.md). |
| `status` | string | Terminal process status: `complete`, `cancelled`, or `error`. Hosted wrappers also use queue/job states. |
| `stopReason` | string | Binding terminal reason such as `exhaustive`, `state_budget`, `depth_limit`, `time_limit`, `memory_limit`, `frontier_limit`, `worker_failure`, `compile_error`, `cancelled`, or `error`. |
| `outcome` | string | Result classification separate from the stop cause: `clean`, `issues_found`, `review_required`, or `compile_error`. |

Progress counts are cumulative over the run, not per-pass, so a consumer can render them as a live running total: endings and errors only rise, unvisited knots only fall. (`--next` starts a fresh exploration per escalation, so the counts rebuild at each escalation boundary; see Lifecycle.)

Fields may be added in a future schema or minor version. Consumers should branch on `type`, use fields they understand, and ignore unknown fields.

Nested contracts carry their own versions. A `resource` event still has progress `schemaVersion: 1`, while its `sharedObservability` live observation and `sample` use schema v2. Consumers must branch on each nested discriminator rather than assuming it matches the outer progress version; historical v1 observations remain valid recorded data.

## Lifecycle

A normal complete run looks like this:

1. `run_start`
2. `phase_start` for `compile`
3. `phase_end` for `compile`
4. `phase_start` / `phase_end` for source scanning and exploration phases as applicable
5. zero or more `progress` activity, `discovery` evidence, and shared-search `resource` events during exploration
6. `phase_start` for `report`
7. `phase_end` for `report`
8. `run_end`

Compilation failures still produce progress events through the report phase, then a `run_end`, and the process exits nonzero. The final stdout report or human output remains the source of truth.

`--next` may run multiple bounded checks inside one CLI process. Progress `sequence`, `elapsedMs`, and `statesExplored` continue across the whole process. The final stdout JSON may include a `runs` array describing the escalations.

Unexpected top-level failures after progress initialization emit a best-effort `run_end` with `status: "error"`. Signal handlers also attempt `status: "cancelled"`, but the current synchronous compile/explore path can delay JavaScript signal delivery until work has already finished. Issue #37 remains open for responsive, deterministically tested SIGINT/SIGTERM cancellation. Consumers must still treat a process exit without `run_end` as interrupted and fall back to the process exit status.

`stopReason` explains why work ended; `outcome` explains what it found. A run can truthfully be `stopReason: "exhaustive"` and `outcome: "issues_found"` when every modeled reachable state was explored and one of those states produced a runtime error. Runtime findings do not become a false stop cause merely because they make CI exit nonzero.

## Examples

Progress event:

```json
{"schemaVersion":1,"sequence":4,"type":"progress","elapsedMs":532,"statesExplored":5000,"stateBudget":100000,"budgetFraction":0.05,"phase":"explore","pass":"random:seed=1","endingsFound":3,"runtimeErrorsFound":0,"unvisitedKnots":8}
```

Privacy-safe discovery event:

```json
{"schemaVersion":1,"sequence":5,"type":"discovery","elapsedMs":611,"statesExplored":5200,"stateBudget":100000,"budgetFraction":0.052,"pass":"beam:w=64","endingsFound":4,"runtimeErrorsFound":1,"unvisitedKnots":7,"knotsVisited":12,"discoveries":{"endings":1,"runtimeErrors":1,"knotsVisited":2,"visibleOutcomes":1,"assertionViolations":0,"goalsReached":0,"stagesReached":0}}
```

Shared-search resource event (abridged here; consumers should ignore unknown nested fields):

```json
{"schemaVersion":1,"sequence":6,"type":"resource","elapsedMs":702,"statesExplored":10000,"stateBudget":100000,"budgetFraction":0.1,"pass":"shared:deep-novelty-v1:seed=1","sharedObservability":{"schemaVersion":2,"pass":"shared:deep-novelty-v1:seed=1","runWideState":10000,"sample":{"schemaVersion":2,"sequence":17,"reasons":["cadence","authored_knot"],"triggerMask":33,"triggerYield":[0,0,0,0,1,0,0,0],"state":10000,"retention":{"schemaVersion":1,"current":{"totalAccountedBytes":8388608}},"yield":{"schemaVersion":1,"fromStateExclusive":9999,"throughState":10000,"delta":{"critical":{"runtimeErrors":0,"assertionViolations":0},"authoredCoverage":{"knotsVisited":1}}}},"process":{"schemaVersion":1,"scope":"process","heapUsedBytes":67108864,"heapTotalBytes":83886080,"rssBytes":104857600,"externalBytes":2097152,"arrayBuffersBytes":1048576,"comparedLogicalAccountedBytes":8388608,"unattributedBytes":58720256}}}
```

Terminal event:

```json
{"schemaVersion":1,"sequence":12,"type":"run_end","elapsedMs":1842,"statesExplored":100000,"stateBudget":100000,"budgetFraction":1,"status":"complete","stopReason":"state_budget","outcome":"issues_found","endingsFound":7,"runtimeErrorsFound":1,"unvisitedKnots":2}
```

CI parsing sketch:

```js
for await (const line of stderrLines) {
  if (!line.trim()) continue;
  const event = JSON.parse(line);
  if (event.schemaVersion !== 1) continue;
  if (event.type === "progress") {
    updateStatus({
      phase: event.phase,
      pass: event.pass,
      states: event.statesExplored,
      budget: event.stateBudget,
    });
  }
  if (event.type === "discovery") {
    recordNumericDiscovery(event.discoveries);
  }
}
```

`discovery` means that a cumulative run counter increased. It is useful for a concise terminal update, hosted status, or agent scheduling, but it is not a finding record and does not replace the final report. Counts stay privacy-safe by omitting identities, story labels, source locations, messages, paths, and variable data. A later bounded run can still find more.

The bounded shared-pass ledger records the fixed cadence; new runtime errors, assertion violations, goals, stages, authored knots, visible outcomes, bounded semantic transitions, or exact terminal variants; frontier compaction or the existing shared-frontier ceiling; and termination. If several triggers occur at one pass-local state, one v2 sample coalesces them into a deduplicated `reasons` vector in canonical schema order. Consumers should use the vector rather than infer a primary trigger from array position.

The complete reason vocabulary, in order, is `cadence`, `runtime_error`, `assertion_violation`, `goal_reached`, `stage_reached`, `authored_knot`, `visible_outcome`, `semantic_transition`, `terminal_variant`, `frontier_compaction`, `frontier_ceiling`, `checkpoint`, `epoch`, `pressure`, and `termination`. `checkpoint`, `epoch`, and generic `pressure` are reserved but are not emitted by this slice. Checkpoint save/reopen and memory/time pressure therefore remain absent as resource-event boundaries; no allocation or stopping policy reads these events.

`triggerMask` is the exact bounded numeric encoding of the same vector: bits 0 through 14 correspond to that canonical order, and a valid sample has a set bit exactly for each listed reason. The example's cadence and authored-knot reasons therefore produce mask `33`. This mask stays attached to the exact ending boundary when deterministic sample compaction rebuilds `yield.delta` across a wider retained interval; consumers must not infer boundary triggers from that aggregate delta.

`triggerYield` supplies the exact boundary-local counts for reason bits 1 through 8: runtime errors, assertion violations, goals, stages, authored knots, visible outcomes, semantic transitions, and terminal variants. Its eight safe nonnegative integers have nonzero positions exactly matching those yield reasons. Between adjacent sequences with complete event history, this tuple equals the semantic-category portion of `yield.delta` exactly. Across a genuine compaction gap or incomplete v1 history, compaction/migration preserves the boundary tuple while the aggregate delta covers a wider or incompletely known interval, so each tuple component is only required to be no greater than its matching delta count. A v1-migrated all-zero tuple means v1 recorded no exact category trigger at that boundary; it does not prove the wider interval contained no category event.

The nested checkpoint-only `integritySha256` self-check is intentionally absent from live progress. A `resource` event carries the validated sample projection and observational process values, not the persisted `SharedObservabilityCheckpointV2` envelope or its artifact-integrity metadata.

Live `resource` events are intentionally sparser than that deterministic ledger: the CLI samples process memory and emits them only at the fixed cadence and final termination. A cadence observation is delayed until its pass-local state is closed, so a later same-state reason is coalesced before append-only output and no partial revision is emitted. With the production cadence and 100-million-state ceiling, one uninterrupted shared-pass execution emits at most 10,001 resource events; category-heavy stories do not increase the count.

`sample` contains deterministic aggregate counts, canonical reason codes, their equivalent bounded numeric mask, the fixed boundary-local trigger tuple, transition positions, and logical byte estimates. The full pass telemetry's separate `timing` summary contains category dry-gap/rate facts; it is not duplicated into every live sample. `process` contains nondeterministic Node process observations and must not participate in report identity, checkpoint identity, exact-resume comparison, frontier order, or a coverage claim. The outer `statesExplored` is CLI-process progress and equals the run base plus `sharedObservability.runWideState`. The nested `sample.state` always belongs to that shared pass. During additive goal work, Inkcheck advances `runWideState` by the general pass's consumed work instead of rewriting the directed pass's local sample position; consumers must not infer this offset from pass names.

## Privacy

Progress events are intentionally telemetry-like. They must not contain:

- story source text;
- choice prose;
- final story text;
- variable names or values;
- uploaded file contents;
- runtime error messages or repro paths.

Those can appear in the final report because the report is story material. Keep the final report wherever you would be comfortable storing project QA artifacts. Progress streams are safer for logs, status UIs, and agent orchestration, but they still reveal operational facts such as run duration, state budget, pass names, counts, and process memory.

## Compatibility notes

- stdout is reserved for the requested report format. Do not read progress from stdout.
- stderr may contain either NDJSON progress, human progress, or ordinary diagnostic text depending on `--progress` mode and errors before argument parsing.
- `--progress=ndjson` is the machine contract. `--progress=human` and terminal `auto` output are for people and may change wording.
- `budgetFraction` is useful for progress indicators but must be labelled as budget use. Do not describe it as coverage.
- The final report's `explore.truncated`, `explore.truncatedBy`, `explore.exhaustive`, `explore.passes`, and `nextRun` fields explain what the run did and did not prove.
