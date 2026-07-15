# Next-action decision table

The table names logical operations. In the default compact MCP profile, call `inkcheck_workflow` with the named `operation` and its `request` after the typed discovery, compile, and `start_search` calls.

| Observed state | Next safe action | Do not claim |
| --- | --- | --- |
| Capabilities unknown | `inkcheck_capabilities` | Feature support from memory |
| Project unfamiliar | `inspect_story` once | Syntax validity or reachability |
| Inspection inventory omitted | Page only the needed `inspect_story` section | Need to load every variable or knot |
| Compile errors | Fix one issue, recompile | Exploration evidence |
| Compile clean, no session | `start_search` | Full coverage |
| Runtime finding | `get_finding`, `replay_witness`, optionally `pin_regression` | Approximate line is exact |
| Assertion violation | Confirm rule intent, replay, repair, rerun | Rule itself is correct by definition |
| Unvisited knot | Review inbound triage, conditions, and binding limit | Dead code unless proved |
| Recoverable partial session | `continue_search` within ceilings | New run equals continuation |
| Campaign result window | Act on findings or `continue_campaign` from its decision | Knee is proof |
| Source edited | Recompile, replay/check pin, then rerun same contract | Old witness still applies |
| Full detail needed | `open_report` explicitly | Default responses contain no prose |
| `exhaustive: true` | Report proof under exact configuration | Proof across host externals or all random seeds |
