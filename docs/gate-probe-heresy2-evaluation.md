# Heresy II Compound-Gate Evaluation

This predeclared matched observation uses the pinned CC-BY 4.0 Heresy II corpus and a real source gate at `apollo.ink:28`:

```ink
{exo_power > 10 and sunbeam_plate == 0}
```

The goal translation is lossless: `all(exo_power > 10, sunbeam_plate == 0)`. Both arms ran through the public CLI from a fresh process with the same 5,000,000-state ceiling, depth 100, search seed 7, story seed 1, and a 1,536 MiB memory guard. The complete artifact is [recorded here](../benchmarks/results/gate-probe-heresy2-apollo-5m-v1.json).

| Arm | States | Time | Target | Outcomes | Visited knots | Binding limit |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| Broad shared | 211,455 | 86.1s | reached | 1 | 14 | max depth |
| Goal-only probe | 333,311 | 167.8s | reached | 1 | 14 | max depth |

Both arms reached the selected condition and found the same broad-QA evidence: no runtime errors or assertion violations, one visible outcome, 14 visited knots, and 16 unvisited knots. The goal-only arm spent more work before the same depth boundary. This is negative evidence for making automatic gate-directed allocation the default.

The decisive constraint was `maxDepth`, not the 5M state ceiling or the memory guard. A follow-up should vary depth with the same source, seeds, and reporting contract before drawing any conclusion about state-budget allocation. This one cell also cannot establish a general claim about all story shapes.
