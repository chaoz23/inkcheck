# Resource-safe deep-run evaluation

Evaluated 2026-07-13 on local Apple Silicon. Timing and memory observations are machine-specific. Every run below had a 5,000,000-state ceiling; none is a coverage claim or an efficient-stop recommendation.

## Scheduler guard defect

Before this change, a guard binding inside one portfolio explorer did not stop the remaining explorers in that scheduler window. On Dog Ink Adventure, a four-second time guard returned after 16.1 seconds and 2,936 states because each remaining explorer consumed another guard interval. After stopping the portfolio immediately and checking timed runs every 64 work iterations, the same probe returned after 4.3 seconds and 639 states with its partial evidence intact.

Untimed runs retain the 512-iteration memory-check cadence. A time-bounded run checks both guards at the tighter cadence so memory remains the precedence rule if both bind together.

## Authored 5M-ceiling probes

| Project and strategy | Safety envelope | States reached | Evidence retained | Frontier observation | Result |
| --- | --- | ---: | --- | --- | --- |
| Dog Ink Adventure, fixed portfolio | 13.5 s internal / 15 s hard; 2 GiB heap watermark | 3,135 | 0 errors; partial authored coverage | independent portfolio; n/a | clean `time` stop |
| Dog Ink Adventure, policy-v2 replay | 13.5 s internal / 15 s hard; 2 GiB heap watermark | 3,199 | evidence-identical to baseline | independent portfolio; n/a | clean `time` stop |
| The Intercept, shared deep-novelty | 15 s internal; 2 GiB heap watermark | 43,575 | 206 terminal states, 29 knots, 0 errors | 30,419 unique states; 11,427 peak pending states; 38,339,036 peak serialized pending bytes | clean `time` stop |

## Retained-memory lifecycle slice

The second #98 slice distinguishes deterministic retained-payload accounting from process heap/RSS. It measures pending and active state JSON/variable snapshots, retained witness ancestry, dedupe keys, semantic indexes, frontier references, and findings. Structural byte values are documented estimates; serialized strings are counted as UTF-8 bytes. These fields explain growth but do not claim to equal V8 heap usage.

Expanded shared nodes now release state JSON immediately. Their compact parent metadata remains only while an active or pending descendant needs the exact witness, then reference-counted ancestry is released recursively. Lazy frontier views are rebuilt when stale IDs materially exceed live work. Optional checkpoint envelopes stop before adding a pending state that would exceed `--max-frontier-states` or `--max-frontier-memory`; no checkpoint cap is imposed by default.

| Project and strategy | Safety envelope | States reached | Evidence retained | Retained-memory observation | Result |
| --- | --- | ---: | --- | --- | --- |
| The Intercept, shared, depth 30 | 5M-state ceiling; 15 s | 61,191 | 284 terminal states, 22 knots, 0 errors | 44,108 unique; 16,223 peak pending; 52,997,459 pending-state bytes; 68,896,754 peak accounted bytes; 14,858 nodes released; 1 view compaction | clean `depth` + `time` stop |
| The Intercept, shared, depth 100 | 5M-state ceiling; 30 s | 107,319 | 370 terminal states, 29 knots, 0 errors | 72,206 unique; 25,528 peak pending; 86,773,254 pending-state bytes; 111,723,227 peak accounted bytes; 25,220 nodes released; 1 view compaction | clean `time` stop |

These probes show that expanded payload and dead ancestry are collectible while a large live frontier remains available for continued search. They do not establish a universal frontier size, a complete 5M run, or an optimal stopping point.

## Adversarial scaling fixtures

Two checked-in fixtures isolate the growth modes behind the original failure. `low-dedup-wide.ink` is a ternary depth-14 tree whose path code keeps every state distinct. `deep-branching.ink` is a binary depth-100 tree whose string witness prefix makes both state payload and ancestry depth explicit. Both produced zero dedupe hits in these cells.

| Fixture | Budget | Unique states | Peak pending | Peak accounted bytes | Nodes released | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| low-dedup wide | 500 | 351 | 184 | 440,481 | 69 | clean `maxStates` stop |
| low-dedup wide | 2,000 | 1,245 | 578 | 1,560,209 | 352 | clean `maxStates` stop |
| deep branching | 500 | 493 | 243 | 565,854 | 5 | clean `maxStates` stop |
| deep branching | 2,000 | 1,589 | 589 | 2,235,754 | 402 | clean `maxStates` stop |

The regression suite verifies the direction of growth rather than freezing machine timing. A 64-checkpoint count envelope stopped the wide fixture at 114 transitions while preserving 12 terminal findings. A 128 KiB checkpoint-payload envelope stopped the deep fixture at 230 transitions with 130,718 live pending JSON/variable bytes. Both reported only `truncatedBy.frontier`, stayed inside their configured envelope, and did not pretend the state budget was exhausted.

## Matched Intercept checkpoint envelopes

The original failure class now also has a real-story envelope test. Both cells used depth 100, seed 1, a 5,000,000-state ceiling, no repro slice, and a 120-second time backstop that did not bind.

| Pending payload envelope | States reached | Terminal states | Knots | Unique states | Peak pending payload | Peak accounted bytes | Nodes released | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 64 MiB | 71,971 | 299 | 29 | 48,929 | 67,105,965 | 76,655,622 | 16,465 | clean `frontier` stop |
| 128 MiB | 151,324 | 461 | 29 | 100,562 | 134,216,791 | 152,911,941 | 36,403 | clean `frontier` stop |

Doubling the pending payload envelope produced 162 more terminal-state variants but no additional authored-knot coverage or critical findings. The shadow curve still observed terminal/state novelty near the 128 MiB stop, so the long tail is real; this comparison does not establish that every additional terminal-state variant has equivalent author value.

### Spill decision

Disk spill remains deferred, not assumed. The in-memory envelope already turns the former OOM class into predictable partial evidence, and authors with available RAM can raise one explicit limit. A disk-backed shared frontier would add random-access I/O, ordering, schema/checksum, cleanup, and corruption-recovery contracts while dedupe and semantic indexes would still grow in memory.

A spill prototype becomes justified when a predeclared matched evaluation shows that, under a fixed total memory ceiling, it recovers critical findings, assertion/goal progress, authored coverage, or independently validated ending diversity that the in-memory envelope loses, with acceptable wall-clock and deterministic-report cost across more than one story family. Intercept terminal multiplicity alone is not that evidence. Compact durable replay belongs with #63; aggregate ceilings across concurrent workers remain an acceptance condition of #94.

The Dog promotion cell previously became `unavailable` when its worker was hard-killed. It now returns a matched partial comparison with explicit limits. Promotion workers persist one atomic evidence snapshot per deterministic scheduler window; a hard timeout can recover the latest complete snapshot, while a worker that dies before its first snapshot remains honestly unavailable.

## What this establishes

- CLI, MCP, and promotion workers share one 85%-of-V8-heap default guard implementation; evaluation can declare a higher or lower watermark explicitly.
- Time and memory stops preserve findings, schedules, curves, and structural telemetry.
- Promotion output distinguishes configured caps, ordinary completion, recovered hard-timeout snapshots, and truly unavailable cells.
- Shared-search benchmark summaries retain pending-state and serialized-byte high-water observations.
- Shared-search reports now separate live checkpoint payload, ancestry, indexes, view references, and findings, and report release/compaction counts.
- Explicit shared-frontier count/byte envelopes preserve partial evidence and report `truncatedBy.frontier`; ordinary runs retain no hidden low checkpoint cap.

## What remains in issue #98

The direct single-worker #98 failure class now has component accounting, collection, adversarial scaling characterization, and explicit count/byte envelopes proven on The Intercept. Disk spill is gated by the evidence rule above rather than treated as mandatory. Compact durable replay remains #63 work, and multi-worker aggregate ceilings remain with #94 because no concurrent production engine exists yet. Safety caps are backstops rather than the v0.6 efficiency policy: choosing a useful result window still requires marginal discovery yield, throughput, recovery-gap, and resource-growth evidence.
