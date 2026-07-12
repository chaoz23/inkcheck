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

The policy did not recommend stopping at any rung: discoveries were still arriving, so it retained 8% floors and recommended moving discretionary work. At 100K and 1M it favored seeded random search; at 5M it favored first-choice DFS based on the most recent lexicographic value window. Because shadow mode never applied those allocations, this result validates reportability and avoids a false knee on one real story; it does **not** show that the proposed reallocation would improve yield.

No runtime error or assertion evidence occurred in this case, so it cannot satisfy the critical-evidence promotion gate. The next evaluation must replay shadow allocations on predeclared late-recovery and sparse-error families, while retaining the fixed portfolio as the paired baseline.
