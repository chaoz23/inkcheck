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

`localReportArtifacts: true` means the CLI can save and reopen source-bound reports by stable ID. `savedFindingLookup: true` means an agent can page through privacy-minimal finding summaries, fetch one full finding, and replay a current indexed witness without loading the full report. Report saves obey the advertised single/project byte ceilings; cleanup is preview-first and capped by `maxReportPrunePerRun`. `resumableSearch: true` plus `resumableSearchSurfaces: ["cli", "mcp"]` means exact base-shared continuation is available through local CLI checkpoints and MCP result-window sessions. `interactiveSearchSessions: true` discovers `start_search`, `inspect_search`, `continue_search`, and `cancel_search` plus their advertised window/session limits. `campaignResultWindows: true` discovers `start_campaign` / `continue_campaign`. `campaignPolicyControls: true` adds named modes, value preferences, stop policies, stable policy IDs, empirical forecasts, and report drill-down. `campaignDirectedChildren: true` discovers additive `add_assertions` and campaign `add_goal` windows: validated root-started specialists with deterministic ledger purposes, separate accounting, deduplicated yield credit, and no mutation of the exact base checkpoint. `sessionGoalProbes: true` also permits `add_goal` on ordinary sessions. `sessionWitnessReplay: true` discovers revision-bound `replay_witness`; `sessionRegressionPins: true` discovers runtime-only `pin_regression` / `check_regression`. This does **not** claim assertion/ending pins, hosted resume, MCP mid-window preemption, concurrent campaign children, broad specialist dispatch, or a cost provider.

## Project inspection

```sh
inkcheck inspect story/main.ink --json
```

MCP: `inspect_story { "file": "story/main.ink" }`

Inspection reads source only. It does not invoke inklecate, compile the story, execute inkjs, or spend exploration states. The response includes project-local includes, static shape, turn/random semantics, external functions, knot/function locations, and bounded variable summaries.

Variable locations are capped at 20 per read/write collection and the variable list is capped at 200. The `truncation` object says when those response limits were reached; this is response truncation, not search coverage truncation. Narrative prose and choice display text are not returned.

For a predictable trust boundary, includes must resolve within the entrypoint's directory tree. Missing files and attempts to leave that root fail inspection explicitly. This restriction applies to discovery; existing compile behavior is unchanged.

The successful response recommends `compile_story` as the next operation. Inspection is a map, not validation: compilation remains authoritative for Ink syntax and structure.
