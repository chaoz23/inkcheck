# Agent discovery contract

Use discovery before loading a large Ink project or relying on optional Inkcheck features.

## Capabilities

```sh
inkcheck capabilities --json
```

MCP: `inkcheck_capabilities`

The default MCP profile is deliberately compact: `inkcheck_capabilities`, `inspect_story`, `compile_story`, `start_search`, and the `inkcheck_workflow` router. Capabilities lists every router operation and its required/optional request fields. This keeps a fresh agent's tool-schema bootstrap bounded while preserving the complete workflow. Set `INKCHECK_MCP_PROFILE=full` to expose every operation as a separate named tool for compatibility; the underlying behavior and evidence contracts are identical.

The response is deterministic for an installed Inkcheck version and reports:

- `schemaVersion` and `inkcheckVersion`
- report, configuration, project-inspection, report-artifact, checkpoint-artifact, search-session, and campaign-policy schema versions
- default and maximum state/depth limits
- supported search modes
- explicit feature flags, including `false` for features not yet available

`concurrentPortfolio: true` advertises the worker-backed portfolio surface. `defaultConcurrencyMode: "auto"` and `defaultAutoConcurrencyCeiling: 4` mean local CLI and one-shot MCP checks classify workload before starting workers; the ceiling is not a worker-count promise. Agents should inspect `effectiveConfiguration.concurrencyMode` plus `explore.execution.activation` for the versioned decision, reason, pilot spend, uncertainty, production eligibility, and duplicate-work count. `requestedConcurrency` and `effectiveConcurrency` then show the resource-bounded plan that actually ran. Explicit concurrency `1` is a hard opt-out. Treat `truncatedBy.worker` as a partial execution failure rather than ordinary bounded coverage.

Agents should check a feature flag instead of inferring support from missing documentation. Schema version `0` means that contract is not yet available.

`localReportArtifacts: true` means the CLI can save and reopen source-bound reports by stable ID. `savedFindingLookup: true` means an agent can page through privacy-minimal finding summaries, fetch one full finding, and replay a current indexed witness without loading the full report. Report saves obey the advertised single/project byte ceilings; cleanup is preview-first and capped by `maxReportPrunePerRun`. `resumableSearch: true` plus `resumableSearchSurfaces: ["cli", "mcp"]` means exact base-shared continuation is available through local CLI checkpoints and MCP result-window sessions. `interactiveSearchSessions: true` discovers logical `start_search`, `inspect_search`, `continue_search`, and `cancel_search` operations plus their advertised window/session limits. `campaignResultWindows: true` discovers `start_campaign` / `continue_campaign`. In the compact profile, all but `start_search` are invoked through `inkcheck_workflow`. `campaignPolicyControls: true` adds named modes, value preferences, stop policies, stable policy IDs, empirical forecasts, protected long-tail allocations, shadow-only long-tail expand/rotate/stop evidence, and report drill-down. A long-tail allocation is a deterministic root-started portfolio child whose compact provenance exposes its partition, campaign-new yield, observed-versus-rediscovered evidence counts, and report-local discovery gaps without changing the exact base checkpoint. The shadow recommendation always reports `liveEffect: false`; agents must not treat it as an executed allocation decision or infer completion from widening gaps. `campaignDirectedChildren: true` discovers additive `add_assertions` and campaign `add_goal` windows with the same separate-accounting invariant. `sessionGoalProbes: true` also permits `add_goal` on ordinary sessions. `sessionWitnessReplay: true` discovers revision-bound `replay_witness`; `sessionRegressionPins: true` discovers runtime-only `pin_regression` / `check_regression`. This does **not** claim assertion/ending pins, hosted resume, MCP mid-window preemption, concurrently scheduled campaign children, broad specialist dispatch, or a cost provider.

`bundledAgentSkill: true` means the npm artifact includes `skills/inkcheck/SKILL.md`, progressive Ink/workflow references, and ten versioned golden exercises. The skill names the capabilities/report/session contract it targets; agents should still call capabilities before relying on optional behavior.

## Project inspection

```sh
inkcheck inspect story/main.ink --json
```

MCP: `inspect_story { "file": "story/main.ink" }`

Inspection reads source only. It does not invoke inklecate, compile the story, execute inkjs, or spend exploration states. The response includes project-local includes, static shape, turn/random semantics, external functions, knot/function locations, and bounded variable summaries.

Variable locations are capped at 20 per read/write collection and the variable list is capped at 200. The `truncation` object says when those response limits were reached; this is response truncation, not search coverage truncation. Narrative prose and choice display text are not returned.

For a predictable trust boundary, includes must resolve within the entrypoint's directory tree. Missing files and attempts to leave that root fail inspection explicitly. This restriction applies to discovery; existing compile behavior is unchanged.

The successful response recommends `compile_story` as the next operation. Inspection is a map, not validation: compilation remains authoritative for Ink syntax and structure.

MCP `inspect_story` defaults to a compact overview capped at 16 KiB: complete shape/semantic counters plus at most ten names/locations from each inventory. It omits variable initial values, expressions, and full read/write locations. The local CLI's explicit JSON inspection retains its established detailed bounded map.

For projects whose overview reports additional inventory, MCP `inspect_story` accepts `section: includes | externals | knots | variables`, a page size up to 100, and the returned source-bound cursor. Section pages are deterministic and expose total/returned counts. A cursor fails closed after the relevant inventory changes or when reused for another section. Variable pages are an explicit content-revealing request: they include names, initial values or expressions, and bounded read/write locations.
