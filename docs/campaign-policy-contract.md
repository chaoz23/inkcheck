# Campaign policy foundation

Inkcheck 0.6 defines project-level campaigns that spend a large shared budget across bounded result windows. The deterministic policy and ledger has MCP and CLI execution surfaces over exact shared-search checkpoints plus versioned high-level controls and compact decision explanations. Protected long-tail allocations can spend campaign budget on independent root-started portfolio trajectories without replacing the exact base checkpoint. Hosted Quick and Balanced remain one bounded result window rather than resumable campaigns.

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

A child that finishes just beyond the elapsed ceiling is accepted only when it explicitly reports a time stop. Its partial report, marginal evidence, and actual elapsed overshoot are committed, then the next campaign decision stops at `time_ceiling`. A late ordinary result still fails closed. This preserves evidence produced under the guard without turning serialization overhead into an unexpected campaign error.

Value preference changes which observed marginal evidence counts toward the knee: all structured QA yield, runtime/assertion evidence, terminal outcomes, or approved-goal progress. Exact resumable checkpoints still exclude assertions and goals. Instead, `add_assertions` and campaign `add_goal` create explicit root-started child windows only for matching `runtime_assertions` and `approved_goals` campaigns. Their grants and reports are additive, so they cannot reduce the protected base-search ceiling. Repeated evidence is deduplicated before campaign yield credit. A preference does not rewrite the story or imply that one exact shared trajectory became a specialist search.

## Honesty boundary

A knee requires at least three completed windows and three consecutive windows with no preferred yield. Until then the forecast is `insufficient_evidence`; after five windows uncertainty improves only from high to medium because one trajectory cannot justify a low-uncertainty asymptote claim. Once protected probes are satisfied, `stopPolicy: knee` may stop with unused budget. `stopPolicy: ceilings` never uses this efficiency signal. Source/configuration changes invalidate the campaign rather than silently mixing evidence from different revisions.

The next-window range is a zero-to-upper empirical range derived from the last three completed windows; its state count is an upper bound before reserve accounting. It is not a probability or completion estimate. Responses identify the policy version/hash, latest allocation and reason, preferred-yield rate, observed throughput, peak memory/current disk with recent deltas, binding constraint, changes that could permit more work, and a report ID for `open_report`/`get_finding` drill-down.

The module accepts deterministic partitions by strategy, seed, indexed path prefix, checkpoint/frontier, approved goal, or depth policy. `start_campaign` executes the first bounded shared-search window and returns the same opaque capability model as ordinary MCP sessions. `continue_campaign` either resumes that exact checkpoint or, for a protected long-tail allocation, runs a deterministic portfolio child from the root with an alternate search seed and deeper bound. Metadata stores a canonical ledger digest, compact identity-deduplicated marginal yield, measured elapsed/heap/disk evidence, and immutable report/checkpoint IDs, but never the capability or frontier payload. Independent children also retain category counts before campaign deduplication and bounded report-local discovery-spacing summaries; no finding text or full curve is copied into the ledger.

This 0.6 execution contract uses one exact shared base frontier with concurrency fixed at one, automatic-concurrency long-tail portfolio children, and explicit sequential assertion or approved-goal children. Child identity and ledger purpose are deterministic, full evidence remains in separate source-bound reports, and compact inspection exposes purpose, partition, yield, and report provenance while remaining privacy-minimal. It does not merge child findings into the base report, schedule children concurrently, or integrate a cost provider. Adaptive first-window sizing remains #190, compact large checkpoints remain #156, and measured provider-attributed cost ceilings remain #152.

## Long-tail shadow decision

Policy version 1 observes completed independent children but never changes `campaignRecommendation()` or live allocation. It returns `expand_same_family`, `rotate_partition`, or `stop_after_floor` with `liveEffect: false`, the selected value preference, uncertainty, protected-floor status, remaining authorized states, and recent campaign-new yield per million states and per second. It also reports selected-value identities observed, campaign-new, and rediscovered across the recent windows, plus factual report-local discovery gaps. Critical or intent progress earns expansion without being averaged against terminal counts. Declining nonzero preferred yield rotates; sufficiently repeated dry preferred yield recommends stopping only after the floor. Scarce, balanced, and abundant postures require three, four, and five dry probes respectively.

Older or manually constructed ledgers without observability keep both signals explicitly unavailable rather than inferred. Rediscovery means a distinct evidence identity in the current report that was already present in an earlier campaign report; it is not a raw duplicate-state rate. Discovery spacing covers meaningful events inside each child report and is not filtered to campaign-new identities. Neither signal changes the shadow action. A decline or widening gap is a bounded observation, not an asymptote or coverage claim. The completed #180 gate did not promote live allocation: only one of three authored families reached the policy phase, and it added terminal-state diversity without a new author-facing finding.

## Promotion rule

Campaign knee stopping changes only whether another exact result window is requested under an explicit MCP campaign policy. The long-tail shadow decision is observational and does not change the shared explorer or child allocator. The 0.6 promotion gate is closed with no live promotion. Any future live allocation still requires critical-evidence preservation, deterministic replay, protected broad probes, resource honesty, and no-regression gates across the predeclared synthetic and authored corpus.
