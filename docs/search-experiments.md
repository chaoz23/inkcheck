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
