# Campaign-directed child evaluation

## Preregistered protocol

This evaluation tests the mechanics shipped by #151. It does not test whether a fresh agent can author good rules, because the evaluator has extensive prior context about Inkcheck and *The Intercept*.

The manifest is `benchmarks/campaign-child-evaluation-v1.json`. Its authored-story cell is pinned before execution:

- Story: inkle's MIT-licensed *The Intercept* at commit `2a816b56e61ce4bf02bec1c638074645bdd871e3`.
- Base campaign: 5,000,000 states, depth 100, search seed 7, story seed 1.
- Goal child: 5,000,000 additional states for one source-derived staged target.
- Assertion child: a separate 5,000,000-state campaign plus 5,000,000 additional states for two source-derived consistency hypotheses.
- Control: a repository-owned finite story with a known negative-gold state. Its declared ceilings are also 5M + 5M, but correct exhaustive early exit should consume only the finite reachable space.

The two Intercept base runs are intentionally independent. They test deterministic evidence and prevent one value preference from inheriting another campaign's private state.

## Metrics and failure criteria

The evaluator records base and child grants/consumption, elapsed time, peak heap, exact goal/stage status, assertion observations and violations, immutable report/checkpoint preservation, ledger purpose/yield, and base-versus-child runtime, assertion, knot, outcome, and terminal-state identity-set counts/digests with bounded examples.

The change fails its trust contract if any child mutates the base report or checkpoint, reduces the protected base grant, receives duplicate evidence credit, loses base evidence in the additive union, claims authored or terminal yield for a specialist, or changes an exhaustive base proof into a specialist proof.

The mechanics study is useful but does not establish product value merely because a goal is reached or an assertion fires. The report must separate:

- Target value: whether the selected goal or rule produced reviewable evidence.
- Broad evidence: exact new runtime, knot, outcome, and terminal identities found by the child.
- Cost: additional states, elapsed time, and peak heap.
- Proof: exhaustion applies only to the run that earned it.
- Agent utility: not measured in this phase.

## Reproduction

```sh
npm run build
npm run --silent evaluate-campaign-children -- benchmarks/campaign-child-evaluation-v1.json --output benchmarks/results/campaign-child-evaluation-v1.json
```

The command writes an atomic machine-readable result. Timing and memory are observations from the named machine, not portable performance promises.

## Results

Evaluated 2026-07-14 on an 8 GiB Apple Silicon machine with Inkcheck's default 1,996,488,704-byte campaign memory ceiling. Full machine output is checked in under `benchmarks/results/`.

### Preregistered cells

| Cell | Grant | Consumed | Time | Peak heap | Broad evidence | Result |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Intercept goal base | 5M | 1,213,503 | 366.9 s | 1.67 GiB | 29 knots; 2,165 terminal states | memory stop; goal child blocked |
| Intercept assertion base | 5M | 1,484,991 | 516.7 s | 1.68 GiB | 29 knots; 2,483 terminal states | memory stop; assertion child blocked |
| Finite control goal base + child | 5M + 5M | 2 + 2 | 0.6 s | 0.20 GiB | exhaustive two-state proof | `gold < 0` reached |
| Finite control assertion base + child | 5M + 5M | 2 + 2 | 0.7 s | 0.20 GiB | exhaustive two-state proof | `gold_nonnegative` violated |

The authored-story comparison was unavailable as designed: both independent 5M bases hit the hard memory boundary before a child could be allocated. The evaluator records those children as blocked rather than as goal or assertion misses. The control proves that large ceilings still early-exit and that children remain valid after a real exhaustive proof.

### Post-hoc envelope recovery

A 500K base completed the search window twice with identical broad evidence (29 knots and 1,174 terminal states), but its checkpoint exceeded the 512 MiB single-artifact limit. Both campaigns stopped at `disk_ceiling`, so their specialists remained blocked. This is evidence that nominal state budgets do not describe campaign feasibility without retained-frontier and checkpoint costs.

A final exploratory cell used a 100K durable seed base and retained the full 5M grant for each specialist:

| Specialist | Base | Child consumed | Child time | Peak heap | Intent or critical result | Broad delta, not credited as specialist yield |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Approved goal | 100K; 29 knots; 417 terminals | 1,871,679 | 666.9 s | 1.68 GiB | target not reached; memory stop | 1,566 terminal identities |
| Assertions | 100K; 29 knots; 417 terminals | 1,472,319 | 521.8 s | 1.68 GiB | two assertion violations; memory stop | 2,055 terminal identities |

The goal child reached the `breakout` and `frame` stages separately at states 614 and 697, but did not reach the cumulative final stage. Its closest state had `smashedglass=true`, `piecereturned=true`, and `framedhooper=false`. This is a bounded miss, not evidence that the target is unreachable.

The assertion child observed both rules 1,472,320 times and produced one witness for each:

- `component_disposition_exclusive` found `gotcomponent=true`, `piecereturned=true`, and `throwncomponentaway=false` at state 190,773. Source review found a credible bookkeeping lead: `someone_threw_component` says Harris takes the component and sets `piecereturned=true` at line 1281, but does not clear `gotcomponent` as other disposal paths do.
- `culprit_modes_exclusive` found `framedhooper=true` and `revealedhooperasculprit=true` at state 46,462. Source review rejected the rule as a likely false hypothesis: the variables can record two historical actions rather than mutually exclusive current modes.

Both 100K bases produced the same checkpoint and report evidence. All child invariants passed: the base report and checkpoint remained byte-identical, protected base grants were unchanged, and specialists received zero authored-coverage or terminal-variant ledger credit. The child reports still expose broad deltas for review; they simply cannot use those deltas to justify specialist value.

### Conclusions

1. Additive assertion children demonstrated real product value on one authored story by surfacing a credible state-bookkeeping defect with an exact path. One simultaneous false hypothesis demonstrates why agent-authored rules require author review and must not be silently promoted to truth.
2. The staged goal child did not establish advantage on this target. It consumed 1.87M states and eleven minutes before memory stopped it, with no intent credit. Goal quality, cumulative-stage semantics, and bounded expansion need stronger evaluation.
3. Campaign child accounting and immutability held. Specialist economics did not: both high-budget children ran until memory, and neither had a marginal knee or probe-to-expansion policy.
4. Shared checkpoint size is a first-order product constraint. A 500K Intercept window could not retain a checkpoint under the 512 MiB artifact cap, while a 100K window could. Compact durable replay is required before large campaigns can routinely seed specialists.
5. This mechanics study does not measure fresh-agent rule authoring, cross-story generalization, or a human's ability to validate a proposed rule. Those require separate preregistered studies.
