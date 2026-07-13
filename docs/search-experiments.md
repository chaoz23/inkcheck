# Search experiment comparisons

These tables compare the experimental shared engines at equal state budgets. They are regression evidence, not a claim that one strategy dominates every story shape. Runs used seed 7, depth 100, and `--no-min-repro`; public-corpus measurements were made locally on 2026-07-11.

`shared-variable` gives one of every eight frontier selections to states reached through uncommon observed variable snapshots or transitions. It does not interpret variable names or values.

## Synthetic fixtures

| Fixture | Budget | Mode | Terminal states | Runtime errors | Knots visited |
| --- | ---: | --- | ---: | ---: | ---: |
| Finite combination lock | 50 | shared | 27 | 0 | 6 |
| Finite combination lock | 50 | shared-variable | 27 | 0 | 6 |
| Deceptive plateau | 50 | shared | 1 | 1 | 7 |
| Deceptive plateau | 50 | shared-variable | 1 | 1 | 7 |
| Early-variable grid | 100 | shared | 9 | 0 | 9 |
| Early-variable grid | 100 | shared-variable | 8 | 0 | 9 |
| Storylet machine | 100 | shared | 6 | 0 | 2 |
| Storylet machine | 100 | shared-variable | 11 | 0 | 2 |
| Storylet machine | 500 | shared | 28 | 0 | 5 |
| Storylet machine | 500 | shared-variable | 28 | 0 | 5 |

The variable frontier helps the mechanically driven storylet fixture at a tight budget and converges with baseline shared search at 500 states. It is slightly worse on the early-variable grid at 100 states, which is why this mode remains opt-in.

## Public stories

| Story | Budget | Mode | Terminal states | Runtime errors | Knots visited |
| --- | ---: | --- | ---: | ---: | ---: |
| The Intercept | 2,000 | shared | 16 | 1 | 29/30 |
| The Intercept | 2,000 | shared-variable | 18 | 1 | 29/30 |
| The Intercept | 10,000 | shared | 76 | 1 | 29/30 |
| The Intercept | 10,000 | shared-variable | 62 | 1 | 29/30 |
| LD41 Emoji | 2,000 | shared | 0 | 1 | 3/4 |
| LD41 Emoji | 2,000 | shared-variable | 0 | 1 | 3/4 |
| LD41 Emoji | 10,000 | shared | 0 | 2 | 3/4 |
| LD41 Emoji | 10,000 | shared-variable | 0 | 2 | 3/4 |

At 2,000 states the variable frontier finds two additional terminal states in *The Intercept*. At 10,000 it finds fewer terminal states, while preserving the same knot and runtime-error evidence. This is useful evidence for future dynamic allocation, not justification for changing the default search.

## Explicit goal steering

Configured goals are a different experiment from name-agnostic `shared-variable`. An early zero-sum prototype reserved 75% of a fixed budget for general search and 25% for goal steering. The table below records that historical experiment; it exposed the unacceptable possibility that steering could remove unrelated baseline findings.

| Fixture | Budget | Baseline target reached | Goal target reached | Baseline / goal terminal states | Baseline / goal runtime errors |
| --- | ---: | --- | --- | ---: | ---: |
| Early-variable grid (`origin == 3 && role == 3`) | 25 | no | yes | 1 / 1 | 0 / 0 |
| Early-variable grid | 100 | yes | yes | 9 / 8 | 0 / 0 |
| Storylet machine (`insight >= 3 && trust >= 3`) | 100 | no | no | 10 / 10 | 0 / 0 |
| Storylet machine | 250 | yes | yes | 24 / 26 | 0 / 0 |
| Deceptive plateau (`key == true`) | 50 | yes | yes | 1 / 1 | 1 / 1 |

This first slice demonstrates a narrow gain, a neutral result, and a regression in unrelated terminal-state count. At only 25 states on the deceptive plateau, allocating work to the goal loses the baseline runtime error; at 50 states both retain it.

The shipped contract therefore uses an **additive** budget: `maxStates` remains the complete baseline and `goalMaxStates` buys extra directed work. It defaults to zero. Across 504 synthetic baseline/additive comparisons, additive steering preserved baseline findings while adding target discoveries; on 18 *The Intercept* comparisons it produced no losses, improved terminal-state counts in 11, knot coverage in 9, and reached one goal the matching baseline missed. These are encouraging bounded-run results, not proof that every goal or story benefits. Broader corpus and agent-authored-goal evaluation remains required.

## Staged goal probe

The first ordered-stage implementation seeks cumulative milestones within the same explicit additional budget. At depth 100, seed 7, and 100,000 directed states on *The Intercept*, both the flat `framedhooper && piecereturned` goal and the staged `framedhooper` then `piecereturned` goal missed the final compound state. The staged run reached the first milestone at state 684 with an exact witness and found 344 terminal states versus 313 for flat steering; both found 10 visible outcomes, 29/30 knots, and no runtime errors. Wall time was 27.8 seconds staged versus 27.0 seconds flat on the same machine.

This is a reporting and search-order foundation, not evidence that cumulative ordering solves late dependencies. The next research step is a bounded diverse checkpoint frontier: retain several stage-1 witnesses and continue from each, rather than restarting every attempt from the root. That work remains part of issue #86.

## Shadow policy budget ladder

The first #92/#56 shadow-policy evaluation used current portfolio search on *The Intercept* at depth 100, seed 1, and `--no-min-repro`. Runs were independent configured reruns, not prefixes of one continued search. The 5M run is a bounded high-water comparison, not an oracle.

| Budget | Time | Exact terminal states | Visible outcomes | Knots | Runtime errors | Shadow action | High-water-only E/A/K/O/T |
| ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 100K | 14.4s | 749 | 11 | 29/30 | 0 | reallocate | 0/0/0/1/3,735 |
| 1M | 128.3s | 2,168 | 12 | 29/30 | 0 | reallocate | 0/0/0/0/2,316 |
| 5M | 678.5s | 4,484 | 12 | 29/30 | 0 | reallocate | 0/0/0/0/0 |

At 100K, the high-water run adds one author-visible outcome. At 1M, all author-visible outcomes and knots in the 5M run are already present, while exact terminal variants continue to grow substantially. This demonstrates why terminal multiplicity must not dominate the value model.

The policy did not recommend stopping at any rung: discoveries were still arriving, so its suggested shares retained 8% fractional floors and moved discretionary work. At 100K and 1M it favored seeded random search; at 5M it favored first-choice DFS based on the most recent lexicographic value window. Because shadow mode never applied those allocations, this result validates reportability and avoids a false knee on one real story; it does **not** show that the proposed reallocation would improve yield or that fractional shares become cumulative integer service (#106).

No runtime error or assertion evidence occurred in this case, so it cannot satisfy the critical-evidence promotion gate. The next evaluation must replay shadow allocations on predeclared late-recovery and sparse-error families, while retaining the fixed portfolio as the paired baseline.

## First policy-applied replay

The first #103 execution slice keeps the same engines, ten deterministic windows, state/depth limits, and seed as the fixed portfolio. It changes only next-window allocation: a `reallocate` shadow action applies its recorded shares; `continue`, `probe`, and every stop action remain non-operative. This is an exported research function, not a CLI mode or default.

The paired sparse-error fixture has one quick ending and one ten-choice route to a content-exhaustion runtime error:

| Budget | Fixed portfolio | Policy candidate | Baseline-only risk |
| ---: | --- | --- | --- |
| 25 | error observed, partial | error observed, partial | none |
| 50 | error observed, exhaustive | error missed, partial | **critical** |
| 75 | error observed, exhaustive | error observed, exhaustive | none |
| 100 | error observed, exhaustive | error observed, exhaustive | none |

At 50 states the candidate loses critical evidence and an exhaustive proof at the matched budget. It recovers at 75 states, so the route is reachable; the loss is caused by budget allocation. The late-recovery ending fixture similarly loses one authored outcome at 50 states before recovering by 100.

The replay also reveals two design defects to resolve before promotion: pass-local curves can credit multiple explorers for rediscovering the same evidence instead of portfolio-marginal value, and an 8% conceptual floor can round to zero repeatedly when a deterministic window is smaller than the number of passes. Current shadow policy v1 therefore fails the #56 promotion gate and must remain inactive.

### Portfolio-marginal credit follow-up

Issue #105 adds a second bounded curve to each portfolio pass: own discoveries remain available for diagnosis, while allocation reads only portfolio-first exact endings, visible outcomes, knots, critical identities, and explicit intent progress. Approximate runtime locations are conservatively normalized for allocation credit so different witness-dependent fallback lines do not pay twice for one semantic error.

At the same matched boundaries, the 50-state sparse runtime error and late-ending regressions disappear: candidate and baseline both retain their critical/authored evidence and exhaustive proof. Deceptive-plateau runs retain the same semantic runtime error, while the evaluator still exposes the separate approximate-location identity drift tracked by #84.

This does not promote policy v1. The early-choice grid still loses authored coverage at 500 and 2,000 states. Its first portfolio discovery remains eligible for the policy's absolute 1,000-state recency floor for too long, concentrating 68% on one systematic pass while broad random work stays at 8%. Recency normalization/first-discovery lock-in (#113) therefore remains a separate blocker.

### Cumulative integer floor replay (#106)

Policy replay now pools fractional 8% promises across deterministic windows and issues whole floor states to the active pass with the largest cumulative debt. This makes the floor an auditable service guarantee even when a window has fewer states than passes. Synthetic tests rotate five passes through 100 one-state windows, reconcile a 5,000,000-state allocation exactly, and stop accruing service when a pass completes. The fixed production scheduler is unchanged.

Paired results below use depth 100 and seed 7. Cells are `runtime errors / endings / visited knots / exhaustive (E) or partial (P)`:

| Fixture | Budget | Fixed portfolio | Floor-ledger replay |
|---|---:|---:|---:|
| Sparse runtime error | 25 | 1 / 1 / 1 / P | 1 / 1 / 1 / P |
| Sparse runtime error | 50 | 1 / 1 / 1 / E | 1 / 1 / 1 / E |
| Late recovery | 50 | 0 / 2 / 0 / E | 0 / 2 / 0 / E |
| Early-choice grid | 100 | 0 / 3 / 16 / P | 0 / 1 / 16 / P |
| Early-choice grid | 500 | 0 / 15 / 20 / P | 0 / 13 / 18 / P |
| Early-choice grid | 2,000 | 0 / 32 / 22 / P | 0 / 13 / 18 / P |
| Deceptive plateau | 100 | 1 / 1 / 7 / E | 1 / 1 / 7 / E |

The floor defect is fixed: no explorer can silently lose its promised cumulative probe service to repeated rounding. The policy still fails the promotion gate because floor protection alone cannot counter first-discovery recency lock-in on the early-choice family. #113 must be resolved and the full predeclared matrix rerun before activation.

### Scale-normalized recency replay (#113)

Policy v2 removes the global 1,000-state grace period. For each pass it derives recent grant and consumption scales from up to three execution windows, converts marginal value into yield per thousand consumed states, and retains a signal for one grant window plus at most one measured recovery window. A first discovery therefore buys a bounded experiment, not indefinite ownership. Replay waits for three observed windows and applies a 10% policy overlay only when renewed runtime/assertion evidence or explicit goal progress passes the lexicographic gate; authored and terminal coverage signals remain advisory and broad allocation stays with the established scheduler. Cumulative integer floors operate independently.

The allocator was also corrected to preserve the requested deterministic integer plan whenever that plan already satisfies cumulative floor debt. Transfers occur only for a genuinely under-served floor recipient. This matters on tiny exhaustive stories where a one-state rounding change can lose a proof despite finding the same visible evidence.

Depth 100, seed 7 paired results:

| Fixture | Budget | Fixed portfolio | Policy v2 replay |
|---|---:|---:|---:|
| Early-choice grid | 100 | 0 / 3 / 16 / P | 0 / 3 / 16 / P |
| Early-choice grid | 500 | 0 / 15 / 20 / P | 0 / 15 / 20 / P |
| Early-choice grid | 2,000 | 0 / 32 / 22 / P | 0 / 32 / 22 / P |
| Early-choice grid | 100K | 0 / 45 / 22 / P (7.3s) | 0 / 45 / 22 / P (7.2s) |
| Early-choice grid | 1M | 0 / 45 / 22 / P (81.1s) | 0 / 45 / 22 / P (82.1s) |
| Early-choice grid | 5M | 0 / 45 / 22 / P (419.8s) | 0 / 45 / 22 / P (412.7s) |
| Combination lock | 100 | 0 / 27 / 6 / E | 0 / 27 / 6 / E |
| Storylet machine | 100 | 0 / 10 / 2 / P | 0 / 11 / 2 / P |
| Storylet machine | 500 | 0 / 25 / 5 / P | 0 / 25 / 5 / P |
| Deceptive plateau | 100 | 1 / 1 / 7 / E | 1 / 1 / 7 / E |

Cells without timing are `runtime errors / endings / visited knots / exhaustive (E) or partial (P)`. Sparse-runtime and late-recovery fixtures also match at 25/50/75/100 states, including their exhaustive proofs. The 5M runs are independent high-water reruns, not continuation prefixes or proof of completeness. This closes the known first-discovery lock-in defect, but it does not activate policy v2: the broader predeclared #56 corpus and promotion gates still apply.

### Full policy v2 promotion matrix (#56)

The executable promotion harness completed 240 isolated matched pairs across 20 synthetic structural families, three budgets, two depths, and two seeds. Assertion rules were active rather than inferred from story shape: baseline and candidate found the same two configured violations in all 12 assertion-family pairs.

Of 240 pairs, 222 had no evidence difference. Policy replay gained authored evidence in two low-budget storylet pairs, but lost seven deep-chain knots in two 100-state/depth-300 pairs. Four apparent critical losses and gains were the same content-exhaustion error receiving different approximate source-line identities (#84). All 80 largest-budget pairs were neutral except the random/turn family, where the Ink story RNG is not controlled by the search seed and both strategies failed repeat equality in 10 of 12 matrix points.

Candidate runtime was 1.08x baseline at median and 1.19x at p95 on the evaluation machine; median peak RSS was essentially neutral. These results keep policy v2 inactive: it has corrected known defects but has not demonstrated a broad portfolio-new advantage. See the concise [policy v2 evaluation](promotion-policy-v2-evaluation.md) for the decision and caveats.

### Gated replay parity correction (#118)

The deep-suffix regression was not caused by an approved policy overlay. Every decision reported `allocationApplied: false`, but cumulative floors were still changing the schedule: random search rose from the baseline's 3 states to its 8-state floor, taking exactly seven transitions and seven knots from deep DFS. Replay now preserves baseline allocation until a prior decision actually approves policy control; floor promises and exact integer service begin with the controlled window.

The full 240-pair matrix was rerun. All 228 non-random pairs are evidence-identical across critical findings, assertions, authored knots/outcomes, terminal identities, proof, and limits. The 12 remaining symmetric authored differences all come from uncontrolled Ink `RANDOM()` sequences (#117). This resolves #118 without promoting policy v2: corrected parity removes false behavior but does not demonstrate a dynamic-allocation gain.
