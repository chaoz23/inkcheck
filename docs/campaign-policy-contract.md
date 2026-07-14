# Campaign policy foundation

Inkcheck 0.6 is building toward project-level campaigns that spend a large shared budget across many useful result windows. The deterministic policy and ledger in `campaign-policy.ts` now has a first MCP execution surface over exact shared-search checkpoints. It is not a CLI, hosted, concurrent, multi-strategy, or default search mode.

## Contract

A campaign binds one versioned policy to one opaque source/configuration fingerprint. Its hard ceilings cover total states, elapsed time, deadline, peak memory, current disk use, concurrency, and optional cost microunits. Every allocation and completion appends a deterministic event containing its purpose, grant, timestamp supplied by the caller, and reason.

Three resource postures provide conservative defaults:

| Posture | Typical window | Protected long-tail share | Minimum long-tail probes | Regression reserve |
| --- | ---: | ---: | ---: | ---: |
| scarce | 5%, capped at 250K states | 5% | 1 | 15% |
| balanced | 10%, capped at 1M states | 15% | 2 | 10% |
| abundant | 10%, capped at 5M states | 25% | 4 | 5% |

All values can be bounded explicitly by a future expert surface. The planner never lets an ordinary window consume the protected regression or long-tail reserves. Pending exact regression replays receive their reserve first. A protected long-tail probe may continue after an external decision policy reports a knee, but every hard campaign ceiling still binds.

## Honesty boundary

A knee or plateau is a bounded observation, never proof of coverage, unreachability, or absence of later discovery peaks. Once protected probes are satisfied, a knee recommendation may stop a campaign with unused budget. Source/configuration changes invalidate the campaign rather than silently mixing evidence from different revisions.

The module accepts deterministic partitions by strategy, seed, indexed path prefix, checkpoint/frontier, approved goal, or depth policy. `start_campaign` executes the first bounded shared-search window and returns the same opaque capability model as ordinary MCP sessions. `continue_campaign` resumes that exact checkpoint under the persisted aggregate policy; `inspect_search` and `cancel_search` understand both surfaces. Metadata stores a canonical ledger digest, compact marginal yield, measured elapsed/heap/disk evidence, and immutable report/checkpoint IDs, but never the capability or frontier payload.

This first execution slice intentionally uses one exact shared frontier with concurrency fixed at one. It does not yet dispatch independent portfolio/seed/goal children, merge or deduplicate findings across child runs, integrate a cost provider, or automatically apply knee recommendations. Those remain #93/#94 work. Named MCP policy selection and compact forecasts remain #95; human deadline and result-window UX remains #96.

## Promotion rule

This foundation changes no production allocation and does not promote shadow policy v2. A live planner must first preserve critical evidence, deterministic replay, protected broad probes, resource honesty, and no-regression gates across the predeclared synthetic and authored corpus.
