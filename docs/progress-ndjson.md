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
| `type` | string | Event kind: `run_start`, `phase_start`, `progress`, `discovery`, `phase_end`, or `run_end`. |
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

Progress counts are cumulative over the run, not per-pass, so a consumer can render them as a live running total: endings and errors only rise, unvisited knots only fall. (`--next` starts a fresh exploration per escalation, so the counts rebuild at each escalation boundary; see Lifecycle.)

Fields may be added in a future schema or minor version. Consumers should branch on `type`, use fields they understand, and ignore unknown fields.

## Lifecycle

A normal complete run looks like this:

1. `run_start`
2. `phase_start` for `compile`
3. `phase_end` for `compile`
4. `phase_start` / `phase_end` for source scanning and exploration phases as applicable
5. zero or more `progress` activity events and `discovery` evidence events during exploration
6. `phase_start` for `report`
7. `phase_end` for `report`
8. `run_end`

Compilation failures still produce progress events through the report phase, then a `run_end`, and the process exits nonzero. The final stdout report or human output remains the source of truth.

`--next` may run multiple bounded checks inside one CLI process. Progress `sequence`, `elapsedMs`, and `statesExplored` continue across the whole process. The final stdout JSON may include a `runs` array describing the escalations.

Issue #37 tracks a future improvement for best-effort terminal `run_end` events on SIGINT, SIGTERM, and unexpected top-level failures. Until that ships, consumers should treat a process exit without `run_end` as an interrupted or failed run and fall back to the process exit status.

## Examples

Progress event:

```json
{"schemaVersion":1,"sequence":4,"type":"progress","elapsedMs":532,"statesExplored":5000,"stateBudget":100000,"budgetFraction":0.05,"phase":"explore","pass":"random:seed=1","endingsFound":3,"runtimeErrorsFound":0,"unvisitedKnots":8}
```

Privacy-safe discovery event:

```json
{"schemaVersion":1,"sequence":5,"type":"discovery","elapsedMs":611,"statesExplored":5200,"stateBudget":100000,"budgetFraction":0.052,"pass":"beam:w=64","endingsFound":4,"runtimeErrorsFound":1,"unvisitedKnots":7,"knotsVisited":12,"discoveries":{"endings":1,"runtimeErrors":1,"knotsVisited":2,"visibleOutcomes":1,"assertionViolations":0,"goalsReached":0,"stagesReached":0}}
```

Terminal event:

```json
{"schemaVersion":1,"sequence":12,"type":"run_end","elapsedMs":1842,"statesExplored":9000,"stateBudget":100000,"budgetFraction":0.09,"endingsFound":7,"runtimeErrorsFound":1,"unvisitedKnots":2}
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

## Privacy

Progress events are intentionally telemetry-like. They must not contain:

- story source text;
- choice prose;
- final story text;
- variable names or values;
- uploaded file contents;
- runtime error messages or repro paths.

Those can appear in the final report because the report is story material. Keep the final report wherever you would be comfortable storing project QA artifacts. Progress streams are safer for logs, status UIs, and agent orchestration, but they still reveal operational facts such as run duration, state budget, pass names, and counts.

## Compatibility notes

- stdout is reserved for the requested report format. Do not read progress from stdout.
- stderr may contain either NDJSON progress, human progress, or ordinary diagnostic text depending on `--progress` mode and errors before argument parsing.
- `--progress=ndjson` is the machine contract. `--progress=human` and terminal `auto` output are for people and may change wording.
- `budgetFraction` is useful for progress indicators but must be labelled as budget use. Do not describe it as coverage.
- The final report's `explore.truncated`, `explore.truncatedBy`, `explore.exhaustive`, `explore.passes`, and `nextRun` fields explain what the run did and did not prove.
