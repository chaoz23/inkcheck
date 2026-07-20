# Heresy II Compound-Gate Evaluation

This predeclared matched observation uses the pinned CC-BY 4.0 Heresy II corpus and a real source gate at `apollo.ink:28`:

```ink
{exo_power > 10 and sunbeam_plate == 0}
```

The goal translation is lossless: `all(exo_power > 10, sunbeam_plate == 0)`. Both arms ran through the public CLI from fresh processes with the same 5,000,000-state ceiling, search seed 7, story seed 1, and a 1,536 MiB memory guard. The initial depth-100 observation remains [recorded here](../benchmarks/results/gate-probe-heresy2-apollo-5m-v1.json).

| Arm | States | Time | Target | Outcomes | Visited knots | Binding limit |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| Broad shared | 211,455 | 86.1s | reached | 1 | 14 | max depth |
| Goal-only probe | 333,311 | 167.8s | reached | 1 | 14 | max depth |

Both arms reached the selected condition and found the same broad-QA evidence: no runtime errors or assertion violations, one visible outcome, 14 visited knots, and 16 unvisited knots. The goal-only arm spent more work before the same depth boundary. This is negative evidence for making automatic gate-directed allocation the default.

## Depth Sweep

The follow-up held everything constant and varied only `maxDepth`. Its compact, exact results are [recorded here](../benchmarks/results/gate-probe-heresy2-depth-sweep-5m-v1.json).

| Depth | Broad shared | Goal-only probe |
| ---: | --- | --- |
| 100 | 212K states, 83.0s, 1 outcome, 14 knots, depth-bound | 338K states, 168.5s, 1 outcome, 14 knots, depth-bound |
| 200 | 230K states, 108.5s, 7 outcomes, 15 knots, depth-bound | 327K states, 167.4s, 1 outcome, 14 knots, depth-bound |
| 300 | 226K states, 102.1s, 7 outcomes, 15 knots, memory-bound | 339K states, 168.3s, 3 outcomes, 15 knots, depth-bound |

Every arm reached the selected gate and found no runtime errors or assertion violations. At depths 200 and 300, broad shared search used less work while reaching more visible outcomes; goal-only used 97K-126K additional states and 59-86 additional seconds. The depth-300 broad arm also reached the 1,536 MiB memory guard, while the probe stopped on depth, so this remains a resource-bounded comparison rather than a completeness claim.

This is strong negative evidence for automatic gate-directed allocation as a default. Keep explicit goal-only probes for an author or agent that genuinely wants one declared witness. Do not send shared QA work into a goal-only probe automatically on the basis of static gate discovery. This one story cannot establish a universal result, but it clears the bar for pausing that default-allocation line of product work until a substantially different corpus demonstrates portfolio-new value.
