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

The Dog promotion cell previously became `unavailable` when its worker was hard-killed. It now returns a matched partial comparison with explicit limits. Promotion workers persist one atomic evidence snapshot per deterministic scheduler window; a hard timeout can recover the latest complete snapshot, while a worker that dies before its first snapshot remains honestly unavailable.

## What this establishes

- CLI, MCP, and promotion workers share one 85%-of-V8-heap default guard implementation; evaluation can declare a higher or lower watermark explicitly.
- Time and memory stops preserve findings, schedules, curves, and structural telemetry.
- Promotion output distinguishes configured caps, ordinary completion, recovered hard-timeout snapshots, and truly unavailable cells.
- Shared-search benchmark summaries retain pending-state and serialized-byte high-water observations.

## What remains in issue #98

This does not bound checkpoint count/bytes, implement spill or compact replay recipes, or establish multi-worker global memory accounting. Those remain prerequisites for durable checkpoint campaigns and #94 concurrency. Safety caps also remain backstops rather than the v0.6 efficiency policy: choosing a useful result window still requires marginal discovery yield, throughput, recovery-gap, and resource-growth evidence.
