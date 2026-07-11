# Search strategy policy

Inkcheck's default search must be robust for an unknown story shape, not merely best on the fixtures most recently examined.

## Current default

The adaptive portfolio remains the default. Its independent DFS, diversity-beam, and seeded-random passes have different failure modes, retain guaranteed budget floors, and adapt only surplus budget from observed findings. Experimental `shared` and `shared-variable` modes are explicit opt-ins and must not change portfolio weights or behavior indirectly.

Default allocation is frozen until an alternative passes the promotion gate below. A compelling result on one story, one budget, or one metric is insufficient.

## Promotion gate

A proposed default must be evaluated against the current default using a predeclared matrix containing:

- At least 20 consent-safe public stories or structurally distinct synthetic families.
- Small, medium, and large state budgets.
- Multiple depth limits, including one that is intentionally binding.
- Multiple seeds for every strategy with a sampling component.
- Early-choice grids, deep suffixes, finite locks, loops, storylet machines, gated endings, sparse runtime failures, random behavior, and host-external limitations.
- Time and peak-memory measurements in addition to search findings.

The scorecard reports runtime errors, authored knots, visible ending outcomes, exact terminal states, assertion violations, deduplication, truncation cause, and exhaustive proofs separately. No single aggregate count may hide a regression in a user-important category.

## Decision rule

Promotion requires all of the following:

1. No loss of a uniquely discovered runtime error or assertion violation in the benchmark matrix at the largest comparable budget.
2. No severe regression within any major structural family; aggregate gains cannot compensate for a blind spot.
3. A broad improvement across stories and budgets, not a total dominated by one large story.
4. Deterministic reproduction for fixed source, configuration, limits, and seed.
5. Equal or better honesty about truncation, exhaustiveness, memory, and time limits.
6. A migration note explaining the behavioral change and a retained explicit mode for the previous default during evaluation.

If evidence is mixed, the strategy remains opt-in. This is a feature, not a failure: specialized modes can be valuable without becoming the safest default.

## Assertions and agent goals

Assertions are evaluated on every visited state and remain independent of search strategy. Agent-authored goals may steer an explicit goal-directed slice, but they must not suppress general exploration or convert a bounded non-finding into proof. Known assertion failures should retain exact witness paths for deterministic regression checks.
