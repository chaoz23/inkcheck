# Agent discovery contract

Use discovery before loading a large Ink project or relying on optional Inkcheck features.

## Capabilities

```sh
inkcheck capabilities --json
```

MCP: `inkcheck_capabilities`

The response is deterministic for an installed Inkcheck version and reports:

- `schemaVersion` and `inkcheckVersion`
- report, configuration, project-inspection, report-artifact, checkpoint-artifact, search-session, and campaign-policy schema versions
- default and maximum state/depth limits
- supported search modes
- explicit feature flags, including `false` for features not yet available

Agents should check a feature flag instead of inferring support from missing documentation. Schema version `0` means that contract is not yet available.

`localReportArtifacts: true` means the CLI can save and reopen source-bound reports by stable ID. `savedFindingLookup: true` means an agent can page through privacy-minimal finding summaries, fetch one full finding, and replay a current indexed witness without loading the full report. Report saves obey the advertised single/project byte ceilings; cleanup is preview-first and capped by `maxReportPrunePerRun`. `resumableSearch: true` plus `resumableSearchSurfaces: ["cli", "mcp"]` means exact base-shared continuation is available through local CLI checkpoints and MCP result-window sessions. `interactiveSearchSessions: true` discovers `start_search`, `inspect_search`, `continue_search`, and `cancel_search` plus their advertised window/session limits. `campaignResultWindows: true` discovers `start_campaign` / `continue_campaign`: one persisted aggregate policy over the exact shared frontier, with at most `maxMcpCampaignWindows` durable windows and no claim of concurrent/multi-strategy orchestration. `campaignPolicyControls: true` adds the advertised named modes, value preferences, stop policies, stable policy IDs, empirical forecasts, and report-ID drill-down. `sessionGoalProbes: true` discovers `add_goal`: an explicit additive root-started probe with separate accounting, not directed-frontier resume or reprioritization. `sessionWitnessReplay: true` discovers revision-bound `replay_witness`; unlike inspection, that explicit operation returns transcript, choice text, and variables for one finding. `sessionRegressionPins: true` discovers runtime-only `pin_regression` / `check_regression` and the `regressionArtifact` schema plus pin byte/count ceilings. This does **not** claim assertion/ending pins, hosted resume, MCP mid-window preemption, campaign concurrency, multi-child allocation, or a cost provider. Check the artifact, checkpoint, regression, campaign, and session limits before relying on these workflows.

## Project inspection

```sh
inkcheck inspect story/main.ink --json
```

MCP: `inspect_story { "file": "story/main.ink" }`

Inspection reads source only. It does not invoke inklecate, compile the story, execute inkjs, or spend exploration states. The response includes project-local includes, static shape, turn/random semantics, external functions, knot/function locations, and bounded variable summaries.

Variable locations are capped at 20 per read/write collection and the variable list is capped at 200. The `truncation` object says when those response limits were reached; this is response truncation, not search coverage truncation. Narrative prose and choice display text are not returned.

For a predictable trust boundary, includes must resolve within the entrypoint's directory tree. Missing files and attempts to leave that root fail inspection explicitly. This restriction applies to discovery; existing compile behavior is unchanged.

The successful response recommends `compile_story` as the next operation. Inspection is a map, not validation: compilation remains authoritative for Ink syntax and structure.
