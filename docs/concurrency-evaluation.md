# Concurrent portfolio evaluation

Inkcheck issue #94 asks whether complementary explorers can run concurrently while preserving deterministic reports, global resource limits, partial evidence after worker loss, and the value of the adaptive sequential portfolio. This first implementation establishes the worker and report contracts. It does **not** justify concurrent search as a default.

## Predeclared gate

The candidate must be compared with the current adaptive sequential portfolio on the same authored story, budget, depth, seeds, repro setting, runtime, and machine. Promotion requires:

1. no lost runtime errors or authored-knot coverage;
2. no material regression in exact terminal identities;
3. lower wall clock without violating the global state or memory envelope;
4. deterministic evidence and accounting across repeated worker schedules; and
5. a useful partial report when one worker fails.

The worker-contract fixtures cover items 4 and 5. The authored 5M comparison below fails items 2 and 3, so concurrency remains explicit and experimental.

## Matched 5M result

The input is Inkle's MIT-licensed *The Intercept* at the repository's pinned authored benchmark revision. Every run used depth 100, 5,000,000 states, search seed 7, story seed 1, `--no-min-repro`, Node 24.14.0 with a 4 GiB old-space ceiling, and the same Apple Silicon development machine.

| Executor | Wall clock | States consumed | Exact terminal identities | Runtime errors | Authored knots | Peak RSS | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| adaptive sequential baseline | 744.2s | 5,000,000 | 4,456 | 0 | 29/30 | 385 MiB | reference |
| fixed grants, barrier prototype | 569.3s | 4,256,165 | 2,566 | 0 | 29/30 | 786 MiB | fail |
| fixed grants, rolling slots | 876.7s | 4,256,165 | 2,566 | 0 | 29/30 | 718 MiB | fail |

The fixed allocator gave the beam 750,000 states, but that pass exhausted after 6,165. The unused 743,835 states were never returned to productive explorers. Both concurrent forms therefore lost 1,890 terminal identities (42.4%) despite retaining the same knot and runtime-error counts. Rolling slots removed barrier idling but increased contention enough to run 17.8% slower than sequential. The barrier prototype was faster, but its evidence loss still fails the product gate.

Terminal multiplicity is not itself a correctness oracle. It is nevertheless the predeclared authored-diversity regression signal here; a scheduler cannot discard that much bounded evidence merely because critical findings happened to match on a story with no observed runtime error.

The machine-readable observations are checked in at `benchmarks/results/concurrency-intercept-5m-v1.json`.

## Engineering decision

The useful foundation remains opt-in:

- worker grants and final merge order are deterministic;
- state grants sum to the global ceiling;
- worker heap limits derive from one declared memory envelope;
- one failed worker produces a trustworthy partial report with a distinct binding reason;
- concurrent workers stream aggregate budget progress instead of leaving long runs silent; and
- constrained machines fall back to sequential execution.

The fixed allocator is not a viable production scheduler. The next candidate must keep pass engines alive across deterministic rounds, run each round's grants concurrently, collect snapshots, then let the existing adaptive allocator assign the next round. That design must also stream per-worker progress, account for aggregate parent/worker memory, and rerun this gate plus the broader promotion corpus before any default changes.

These timings are observations from one machine, not portable performance promises. The bounded results do not prove complete story coverage.
