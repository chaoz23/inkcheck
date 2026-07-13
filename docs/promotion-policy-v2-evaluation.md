# Policy v2 promotion evaluation

Policy v2 remains experimental. The first complete #56 matrix and the #118 correction do not show a broad enough advantage to replace Inkcheck's fixed portfolio.

## Protocol

- Candidate: scale-normalized policy v2 replay
- Baseline: fixed production portfolio
- Corpus: 20 repository-owned MIT synthetic structural families
- Matrix: three budgets, two depths (including a binding depth), and two seeds per family
- Total: 240 matched baseline/candidate pairs in isolated processes
- Critical evidence: stable runtime-error and assertion-violation identities
- Other evidence: authored knots, visible outcomes, exact terminal states, proof/truncation, determinism, elapsed time, and peak RSS

This is a broad structural-fixture evaluation, not validation on medium or large public stories. Larger independent budgets are bounded comparisons, not coverage oracles.

## Initial results

| View | Neutral pairs | Authored differences | Critical identity differences | Terminal-only gains |
| --- | ---: | ---: | ---: | ---: |
| All 240 pairs | 222 | 14 baseline-only / 13 candidate-only | 4 / 4 | 1 |
| Largest budget per depth/seed (80 pairs) | 76 | 4 / 4 | 0 / 0 | 0 |

- The assertion family actively evaluated `gold_nonnegative` and `ready_at_end`. Both strategies found the same two violations at every matrix point.
- At 100 states and depth 300, policy replay missed seven deep-chain knots found by the baseline for both seeds. It recovered at larger budgets; #118 tracks that gated-off replay still applied floor-only allocation while claiming no policy allocation was active.
- At 100 states and depth 100, policy replay found one additional visible storylet outcome for seed 1 and one additional exact terminal state for seed 7. Those gains disappeared as differences at larger budgets.
- Four deceptive-suffix pairs reported the same content-exhaustion failure with different approximate source lines. This is identity drift, not four lost and four new semantic errors, and remains tracked by #84.
- Every largest-budget difference came from Ink `RANDOM()` output. The search seed does not currently control the story runtime's random sequence, so those rows cannot establish a strategy advantage (#117).
- Fixed-source repeat checks passed for the seeded early-choice family. In the random/turn family, both baseline and candidate failed exact repeat equality in 10 of 12 pairs.

Resource measurements are observational and machine-specific. In this run, candidate/baseline elapsed-time ratios were 1.08 at median and 1.19 at p95. Peak-RSS ratios were 1.005 at median and 1.087 at p95.

## Gated-allocation correction (#118)

The initial deep-suffix loss exposed an honesty defect: cumulative floor grants changed the candidate schedule even though every policy decision reported `allocationApplied: false`. A 100-state fixed baseline gave random search 3 states; replay silently raised it to the 8-state floor and took seven states from the productive deep DFS, exactly matching the seven lost knots.

Replay now preserves the production plan during warm-up and whenever the policy gate is closed. Cumulative integer floor accounting begins only when a previously approved overlay controls a window. The complete matrix was rerun from fresh isolated workers:

| View | Neutral pairs | Authored differences | Critical differences | Other differences |
| --- | ---: | ---: | ---: | ---: |
| All 240 pairs | 228 | 12 baseline-only / 12 candidate-only | 0 / 0 | 0 |
| Non-random families (228 pairs) | 228 | 0 / 0 | 0 / 0 | 0 |

All remaining differences are from the uncontrolled Ink `RANDOM()` family tracked by #117. Both strategies still find the same configured assertion violations at every assertion matrix point. Deep suffix, early choice, sparse errors, approximate runtime locations, storylets, loops, gates, proof, and terminal identities are otherwise matched across all declared budgets, depths, and seeds.

On the follow-up machine run, elapsed-time ratios were 1.04 at median and 1.38 at p95; peak-RSS ratios were 1.003 at median and 1.038 at p95. These are observational measurements, not stable performance guarantees.

## Decision

Do not activate policy v2. #118 removes the deep-suffix regression and makes gated-off replay truthful, but the corrected matrix now shows no candidate evidence gain outside uncontrolled story randomness. The fixed production portfolio remains the default while #117 makes random comparisons reproducible, #119 expands the corpus to consent-safe medium/large stories, and future policy work demonstrates portfolio-new value rather than merely parity.

The executable protocol and output modes are documented in the [promotion benchmark](promotion-benchmark.md). Raw timing-bearing output is intentionally not checked in because it is machine-specific; the manifest and deterministic comparison mode make the experiment reproducible.
