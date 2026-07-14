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

The Dog promotion cell previously became `unavailable` when its worker was hard-killed. It now returns a matched partial comparison with explicit limits. Promotion workers persist one atomic evidence snapshot per deterministic scheduler window; a hard timeout can recover the latest complete snapshot, while a worker that dies before its first snapshot remains honestly unavailable.

## What this establishes

- CLI, MCP, and promotion workers share one 85%-of-V8-heap default guard implementation; evaluation can declare a higher or lower watermark explicitly.
- Time and memory stops preserve findings, schedules, curves, and structural telemetry.
- Promotion output distinguishes configured caps, ordinary completion, recovered hard-timeout snapshots, and truly unavailable cells.
- Shared-search benchmark summaries retain pending-state and serialized-byte high-water observations.
- Shared-search reports now separate live checkpoint payload, ancestry, indexes, view references, and findings, and report release/compaction counts.
- Explicit shared-frontier count/byte envelopes preserve partial evidence and report `truncatedBy.frontier`; ordinary runs retain no hidden low checkpoint cap.

## What remains in issue #98

Disk spill, compact replay recipes, and multi-worker global memory accounting remain open. Those require evidence that in-memory envelopes are insufficient before adding I/O complexity, and they remain prerequisites for durable checkpoint campaigns and #94 concurrency. Safety caps are backstops rather than the v0.6 efficiency policy: choosing a useful result window still requires marginal discovery yield, throughput, recovery-gap, and resource-growth evidence.
