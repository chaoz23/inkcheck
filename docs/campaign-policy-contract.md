# Campaign policy foundation

Inkcheck 0.6 is building toward project-level campaigns that spend a large shared budget across many useful result windows. The first foundation is a pure, deterministic policy and ledger in `campaign-policy.ts`; it is not yet a CLI, MCP, hosted, concurrent, or default search mode.

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

The module accepts deterministic partitions by strategy, seed, indexed path prefix, checkpoint/frontier, approved goal, or depth policy. It does not yet execute those partitions, merge child reports, or persist the ledger. Those are follow-up slices of #93. MCP policy inputs and explanations remain #95; human deadline and result-window UX remains #96.

## Promotion rule

This foundation changes no production allocation and does not promote shadow policy v2. A live planner must first preserve critical evidence, deterministic replay, protected broad probes, resource honesty, and no-regression gates across the predeclared synthetic and authored corpus.
