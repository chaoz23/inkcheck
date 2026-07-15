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

## Engineering decision

The useful foundation remains opt-in:

- worker grants and final merge order are deterministic;
- state grants sum to the global ceiling;
- worker heap limits derive from one declared memory envelope;
- one failed worker produces a trustworthy partial report with a distinct binding reason;
- concurrent workers stream aggregate budget progress instead of leaving long runs silent; and
- constrained machines fall back to sequential execution.

The fixed allocator is not a viable production scheduler and has been removed. The adaptive worker design passes this authored gate and remains opt-in. Before default promotion, #94 still requires matched time-to-finding evidence across the broader #56 corpus, shared cancellation, a hosted concurrency cap, stronger aggregate parent/worker resource proof, and cancellation/contention tests. Small exhaustive stories may spend a few redundant in-flight states within the final round before a systematic worker's proof is merged; they still remain under the global grant and return the same proof/findings.

These timings are observations from one machine, not portable performance promises. The bounded results do not prove complete story coverage.
