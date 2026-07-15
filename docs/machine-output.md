# Compact machine output

The default compact MCP registration profile contains five tools: typed capabilities, inspection, compilation, and search entry calls plus the `inkcheck_workflow` router. The router changes only bootstrap schema size; each logical operation keeps the response bounds and disclosure rules below. `INKCHECK_MCP_PROFILE=full` restores separate named tools for compatibility.

Inkcheck separates the amount of search performed from the amount of report data returned. `explore.truncated` and its binding limit describe bounded exploration. `response.dataTruncated`, page counts, and cursors describe only output projection. Neither implies the other.

## Default bounds

| MCP surface | Default | Bound | Deliberate drill-down |
| --- | --- | --- | --- |
| `inspect_story` | shape/semantic counts plus ten-item inventory samples | 16 KiB | request one `section` page, up to 100 items |
| `compile_story` | counts plus 20 bounded diagnostic summaries | 32 KiB | raise `findingLimit` to 100 or request `detail: full` |
| `story_stats` | counts plus 20 bounded knot locations | 32 KiB | page `inspect_story`'s `knots` section or request `detail: full` |
| `explore_story` | counts, limits, next action, and 20 privacy-minimal findings | 32 KiB | prefer `start_search` for stable pages/fetch-by-ID; use `detail: full` deliberately |
| result-window sessions | counters, ten recent events/probes, 20 finding summaries, decision/next action | 32 KiB | pass finding cursors, `session.eventPage.nextSince`, `get_finding`, or `open_report` |

`summary` omits finding collections. `standard` is the default bounded response. `full` is explicit and may contain authored prose, choices, variables, transcripts, and complete witnesses; it has no compact-response byte guarantee.

## Privacy and actionability

Compact output omits story prose, choice text, variable values, transcripts, and witness payloads. Standard compile diagnostics retain a bounded message and source location because an issue list without the diagnostic is not actionable. Standard finding summaries otherwise contain stable identity, kind, section, replay/witness availability, and a bounded source location when known.

Variable inventory pages are explicitly content revealing: they include names, initial values or expressions, and bounded read/write locations. `get_finding`, `replay_witness`, `playtest_story`, and `open_report` are also deliberate content-revealing operations.

## Cursor guarantees

- Saved-finding cursors are bound to one immutable report.
- Source-inventory cursors are bound to one section and its deterministic inventory fingerprint; changed or foreign inventories fail closed.
- Session `since` cursors are bound to one private session and sequence. Responses state when older retained events were omitted or dropped.
- Pagination never changes search state, evidence identity, or coverage claims.
