# Concurrent portfolio evaluation

Inkcheck issue #94 asks whether complementary explorers can run concurrently while preserving deterministic reports, global resource limits, partial evidence after worker loss, and the value of the adaptive sequential portfolio. The first fixed-allocation executor failed. Persistent workers now retain the production adaptive rounds and pass the authored 5M gate below, but broad default promotion remains open.

## Predeclared gate

The candidate must be compared with the current adaptive sequential portfolio on the same authored story, budget, depth, seeds, repro setting, runtime, and machine. Promotion requires:

1. no lost runtime errors or authored-knot coverage;
2. no material regression in exact terminal identities;
3. lower wall clock without violating the global state or memory envelope;
4. deterministic evidence and accounting across repeated worker schedules; and
5. a useful partial report when one worker fails.

The worker-contract fixtures cover items 4 and 5. The fixed candidates failed items 2 or 3. The adaptive candidate passes this authored-story gate; the broader #56 corpus and remaining #94 resource/cancellation criteria still gate any default change.

## Matched 5M result

The input is Inkle's MIT-licensed *The Intercept* at the repository's pinned authored benchmark revision. Every run used depth 100, 5,000,000 states, search seed 7, story seed 1, `--no-min-repro`, Node 24.14.0 with a 4 GiB old-space ceiling, and the same Apple Silicon development machine.

| Executor | Wall clock | States consumed | Exact terminal identities | Runtime errors | Authored knots | Peak RSS | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| adaptive sequential baseline | 744.2s | 5,000,000 | 4,456 | 0 | 29/30 | 385 MiB | reference |
| fixed grants, barrier prototype | 569.3s | 4,256,165 | 2,566 | 0 | 29/30 | 786 MiB | fail |
| fixed grants, rolling slots | 876.7s | 4,256,165 | 2,566 | 0 | 29/30 | 718 MiB | fail |
| adaptive sequential, matched verification | 601.1s | 5,000,000 | 4,456 | 0 | 29/30 | 546 MiB | reference |
| adaptive persistent workers, concurrency 4 | 369.5s | 5,000,000 | 4,456 | 0 | 29/30 | 801 MiB | pass authored gate |

The fixed allocator gave the beam 750,000 states, but that pass exhausted after 6,165. The unused 743,835 states were never returned to productive explorers. Both concurrent forms therefore lost 1,890 terminal identities (42.4%) despite retaining the same knot and runtime-error counts. Rolling slots removed barrier idling but increased contention enough to run 17.8% slower than sequential. The barrier prototype was faster, but its evidence loss still fails the product gate.

Terminal multiplicity is not itself a correctness oracle. It is nevertheless the predeclared authored-diversity regression signal here; a scheduler cannot discard that much bounded evidence merely because critical findings happened to match on a story with no observed runtime error.

The adaptive candidate keeps each pass alive across the same deterministic rounds and returns unused beam work to later rounds through the existing allocator. On the quiet matched verification it reduced wall clock by 38.5% while increasing peak RSS by 46.8%. A second concurrent run finished in 369.3s. Sequential and concurrent SHA-256 digests match for all 4,456 exact terminal identities, runtime messages, visited knots, and the complete adaptive schedule. The 100K correctness screen also matched all 757 terminal identities and the schedule while reducing wall clock from 18.9s to 13.1s.

The machine-readable observations are checked in at `benchmarks/results/concurrency-intercept-5m-v1.json`.

## Broad promotion timing

The promotion harness now compares `fixed-portfolio` with `concurrent-portfolio` in isolated workers and records complete result-window time-to-1/5/10 meaningful signals. Meaningful evidence is the deduplicated union of runtime errors, assertion violations, authored knots visited, and visible ending outcomes. Raw terminal multiplicity and worker heartbeats do not earn timing credit.

Two preregistered synthetic-corpus rungs were run with concurrency 4 and a 1 GiB worker heap envelope on the same Apple Silicon development machine:

| Rung | Pairs | Evidence/proof regressions | Median elapsed B/C | Median RSS B/C | T1 median B/C | T5 median B/C | T10 median B/C |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| representative minimum budget (50/100 states) | 20 | 0 | 138/172 ms | 61/119 MiB | 13.5/43.9 ms | 21.4/50.5 ms | 28.0/56.9 ms |
| all 20 families at 100K, both depths and seeds | 80 | 0 | 121/240 ms | 57/135 MiB | 12.6/119.0 ms | 19.4/140.4 ms | 24.3/150.5 ms |

The broad median is a clear promotion failure: most synthetic stories exhaust before worker startup can amortize. Concurrency won total time in only 3/80 100K cells. Those wins identify the useful workload boundary rather than noise: both depth-100 `early-choice-grid` seeds fell from about 6.8s to 3.0s, while T1/T5/T10 moved from about 809ms to 416ms with exact evidence parity. Together with the 5M *The Intercept* result, this shows real left shift on sustained combinatorial work and real regressions on small/exhaustible work.

The decision remains **opt-in, default 1**. A future automatic default needs workload-aware activation that avoids paying worker startup for quickly exhaustible stories; budget alone is not a sufficient signal. The compact checked result is `benchmarks/results/concurrency-promotion-summary-v1.json`, and the full rows can be reproduced with:

```sh
npm run build
npm run --silent evaluate-promotion -- benchmarks/promotion-manifest.json --ci \
  --candidate-strategy concurrent-portfolio --candidate-concurrency 4 \
  --worker-timeout-ms 30000 --worker-max-memory-mb 1024
npm run --silent evaluate-promotion -- benchmarks/promotion-manifest.json --budget 100000 \
  --candidate-strategy concurrent-portfolio --candidate-concurrency 4 \
  --worker-timeout-ms 120000 --worker-max-memory-mb 1024
```

## Engineering decision

The useful foundation remains opt-in:

- worker grants and final merge order are deterministic;
- state grants sum to the global ceiling;
- worker heap limits plus the parent reserve sum to one declared heap envelope;
- workers publish current isolate heap use through shared memory, allowing the parent to trigger one cooperative aggregate memory stop while preserving partial snapshots;
- reports expose the planned heap shares, aggregate tracked-heap high-water mark, and whether the parent bound the run (peak RSS remains a separate observation because runtime overhead is not heap);
- one failed worker produces a trustworthy partial report with a distinct binding reason;
- concurrent workers stream aggregate budget progress instead of leaving long runs silent; and
- constrained machines fall back to sequential execution.

The fixed allocator is not a viable production scheduler and has been removed. The adaptive worker design passes this authored gate and remains opt-in. Hosted concurrency is independently capped, real hosted child cancellation cleans temporary uploads, and deterministic contention tests force an aggregate memory stop without losing the partial report. Before default promotion, #94 still requires matched time-to-finding evidence across the broader #56 corpus. Small exhaustive stories may spend a few redundant in-flight states within the final round before a systematic worker's proof is merged; they still remain under the global grant and return the same proof/findings.

These timings are observations from one machine, not portable performance promises. The bounded results do not prove complete story coverage.

## Workload-aware activation pilot

Issue #169 tests whether Inkcheck can earn concurrent startup only after a deterministic 1,024-state sequential pilot. The first exhaustion-only rule was too weak: in the 80-cell 100K synthetic matrix it activated 18 cells, but only the two depth-100 early-choice cells became faster. Sixteen false activations paid worker startup and higher memory. No evidence or proof regressed because the research candidate reran the full unchanged ceiling after its pilot.

Policy `pilot-frontier-v2` adds two product-aligned rejections:

- stay sequential when the pilot binds on depth, because parallelism cannot repair the binding depth limit; and
- stay sequential when every authored knot has already been visited, because the broad authored frontier is saturated even if exact terminal variants remain.

At 100K, the revised policy classified 62/80 cells as pilot-exhaustive, 14 as depth-bound, two as authored-frontier-saturated, and only the two sustained depth-100 early-choice cells as open-frontier. Those two retained exact evidence and reduced total time from 6.95/6.91 seconds to 3.25/3.12 seconds. The other 78 stayed sequential. There were no runtime, assertion, knot, visible-outcome, exact-terminal, or proof regressions.

Two matched 5M *The Intercept* cells establish the depth boundary:

| Depth | Decision | Sequential | Pilot candidate | Exact terminals | Knots | Visible outcomes | Peak RSS B/C | Result |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 30 | stay sequential: depth-bound | 497.5s | 508.0s | 828/828 | 25/25 | 1/1 | 498/521 MiB | correct rejection; 2.1% pilot cost |
| 100 | activate: open frontier | 624.1s | 393.0s | 4,456/4,456 | 29/29 | 12/12 | 570/905 MiB | 37.0% faster; T1 85.9s to 46.2s |

This is credible activation evidence, not a production-ready executor. The pilot currently restarts the selected full run, so activated and non-exhaustive rejected cells perform 1,024 duplicate state evaluations outside the reported search ceiling. Every result marks `productionEligible: false`, reports the duplicate work, and keeps uncertainty high. A production implementation must migrate or reuse pilot pass state under the original global state/time/memory envelope, then rerun the broad and authored gates. The compact evidence is checked in at `benchmarks/results/concurrency-activation-pilot-v2.json`.
