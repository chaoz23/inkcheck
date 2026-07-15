# Campaign policy foundation

Inkcheck 0.6 is building toward project-level campaigns that spend a large shared budget across many useful result windows. The deterministic policy and ledger has MCP and CLI execution surfaces over exact shared-search checkpoints plus versioned high-level controls and compact decision explanations. Hosted Quick and Balanced are currently one bounded result window rather than resumable campaigns; concurrent and multi-strategy campaign execution remain future work.

## Contract

A campaign binds one versioned policy to one opaque source/configuration fingerprint. Its hard ceilings cover total states, elapsed time, deadline, peak memory, current disk use, concurrency, and optional cost microunits. Every allocation and completion appends a deterministic event containing its purpose, grant, timestamp supplied by the caller, and reason.

Named modes give a fresh agent bounded defaults without strategy weights:

| Mode | Total states | Window | Elapsed ceiling | Disk ceiling | Resource | Stop |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| quick | 250K | 50K | 60 s | 128 MiB | scarce | knee |
| balanced | 1M | 100K | 10 min | 256 MiB | balanced | knee |
| deep | 10M | 1M | 2 h | 1 GiB | abundant | knee |
| overnight | 100M | 5M | 12 h | 4 GiB | abundant | knee |
| campaign | 100M | 5M | 7 d | 8 GiB | abundant | ceilings |
| fixed | explicit | derived or explicit | explicit | explicit | explicit | ceilings |

The memory ceiling defaults to Inkcheck's V8-safe watermark. Every explicit override is sorted and persisted in policy v2. Three resource preferences control protected reserves:

| Posture | Typical window | Protected long-tail share | Minimum long-tail probes | Regression reserve |
| --- | ---: | ---: | ---: | ---: |
| scarce | 5%, capped at 250K states | 5% | 1 | 15% |
| balanced | 10%, capped at 1M states | 15% | 2 | 10% |
| abundant | 10%, capped at 5M states | 25% | 4 | 5% |

Agents can override the bounded ceilings, resource preference, value preference, stop policy, and protected reserves without setting explorer weights. The planner never lets an ordinary window consume the protected regression or long-tail reserves. Pending exact regression replays receive their reserve first. A protected long-tail probe may continue after a knee signal, but every hard campaign ceiling still binds.

Value preference changes which observed marginal evidence counts toward the knee: all structured QA yield, runtime-error evidence, or terminal outcomes. The internal policy vocabulary reserves approved-goal progress, but MCP does not advertise it while exact resumable campaigns exclude configured goals. For the same reason, `runtime_assertions` currently means runtime errors on this surface; assertion-aware campaign checkpoints remain future work. A preference does not rewrite the story or imply that one exact shared trajectory became a specialist search.

## Honesty boundary

A knee requires at least three completed windows and three consecutive windows with no preferred yield. Until then the forecast is `insufficient_evidence`; after five windows uncertainty improves only from high to medium because one trajectory cannot justify a low-uncertainty asymptote claim. Once protected probes are satisfied, `stopPolicy: knee` may stop with unused budget. `stopPolicy: ceilings` never uses this efficiency signal. Source/configuration changes invalidate the campaign rather than silently mixing evidence from different revisions.

The next-window range is a zero-to-upper empirical range derived from the last three completed windows; its state count is an upper bound before reserve accounting. It is not a probability or completion estimate. Responses identify the policy version/hash, latest allocation and reason, preferred-yield rate, observed throughput, peak memory/current disk with recent deltas, binding constraint, changes that could permit more work, and a report ID for `open_report`/`get_finding` drill-down.

The module accepts deterministic partitions by strategy, seed, indexed path prefix, checkpoint/frontier, approved goal, or depth policy. `start_campaign` executes the first bounded shared-search window and returns the same opaque capability model as ordinary MCP sessions. `continue_campaign` resumes that exact checkpoint under the persisted aggregate policy; `inspect_search` and `cancel_search` understand both surfaces. Metadata stores a canonical ledger digest, compact marginal yield, measured elapsed/heap/disk evidence, and immutable report/checkpoint IDs, but never the capability or frontier payload.

This execution slice intentionally uses one exact shared frontier with concurrency fixed at one. It does not yet dispatch independent portfolio/seed/goal children, merge or deduplicate findings across child runs, or integrate a cost provider. Campaign-directed goals and assertion-aware children are #151; measured provider-attributed cost ceilings are #152. They remain unavailable rather than reporting decorative zeroes. Broader campaign/parallel work remains #93/#94; the CLI and hosted human surfaces now expose bounded intents and result-window evidence without changing those engine limits.

## Promotion rule

Campaign knee stopping changes only whether another exact result window is requested under an explicit MCP campaign policy. It does not change the shared explorer's internal allocation or promote portfolio shadow policy v2. Broader live allocation still requires critical-evidence preservation, deterministic replay, protected broad probes, resource honesty, and no-regression gates across the predeclared synthetic and authored corpus.
