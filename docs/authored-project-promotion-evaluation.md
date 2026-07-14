# Authored-project promotion evaluation

Evaluated 2026-07-13 from the pinned `benchmarks/authored-promotion-manifest.json` corpus. Policy v2 remains inactive.

## Decision

The authored tier does not justify promoting policy v2. Completed fixed-portfolio and candidate-replay cells were evidence-identical, deterministic where repeated, and equally honest about binding limits. They showed no critical, authored-coverage, proof, or terminal-state gain. Two structurally different projects could not complete the predeclared 5M baseline inside the declared worker envelope, so those cells are resource-unavailable rather than evidence matches.

The result strengthens the benchmark and weakens broad runtime assumptions. It does not strengthen the candidate.

## Worst-project results

| Project | Size tier | Budget | Result | Runtime/assertions | Knots/outcomes/terminals | Proof and limits | Determinism | Elapsed B/C | Peak RSS B/C |
| --- | --- | ---: | --- | --- | --- | --- | --- | ---: | ---: |
| Dog Ink Adventure | small, function/loop-heavy | 1M | baseline unavailable at 5 min | unavailable / no assertions configured | unavailable | unavailable | unavailable | >300s / n/a | n/a |
| Dog Ink Adventure | small, function/loop-heavy | 5M | baseline unavailable at 5 min | unavailable / no assertions configured | unavailable | unavailable | unavailable | >300s / n/a | n/a |
| Heresy II | large, stitch-heavy, runtime-random | 1M | evidence parity | 0/0 vs 0/0 | 11/1/1 vs 11/1/1 | partial; depth, states, beam | true/true | 213.9s/215.5s | 469/443 MiB |
| Heresy II | large, stitch-heavy, runtime-random | 5M | baseline unavailable at 5 min | unavailable / no assertions configured | unavailable | unavailable | unavailable | >300s / n/a | n/a |
| The Intercept | medium corpus tier, choice-dense | 1M | evidence parity | 0/0 vs 0/0 | 25/1/700 vs 25/1/700 | partial; depth, states, beam | true/true | 119.6s/122.7s | 368/364 MiB |
| The Intercept | medium corpus tier, choice-dense | 5M | evidence parity | 0/0 vs 0/0 | 25/1/828 vs 25/1/828 | partial; depth, states, beam | not repeated | 648.5s/671.1s | 465/420 MiB |

Counts are `visited authored knots / visible ending outcomes / exact terminal identities`. Timing and RSS are observations from one local Apple Silicon evaluation machine, not portable performance promises. A timeout stops before a matched comparison and therefore cannot be interpreted as "no regression," "no findings," or deterministic behavior.

## Corpus contract

| Project | Pinned source | License and basis | Entrypoint and setup | Host/random behavior | Structural measures |
| --- | --- | --- | --- | --- | --- |
| Dog Ink Adventure | `earok/dog_ink_adventure@402b47c004c40c599877ae9dc75cc0aad7db887c` | MIT; complete source published with license | `source/root.ink`; direct compile with seven includes | no externals; no randomness detected | 456 lines, 148 words, 36 knots, 26 functions, 15 choices, 148 diverts |
| The Intercept | `inkle/the-intercept@2a816b56e61ce4bf02bec1c638074645bdd871e3` | MIT; repository README explicitly releases the story | `Assets/Ink/TheIntercept.ink`; direct compile | no externals; no randomness detected | 1,686 lines, 14,728 words, 32 knots, 30 stitches, 343 choices |
| Heresy II | `randall-frank/heresy2-assets@37b8a7804217bb40a9f69f6fd9c173f2017d550e` | CC-BY-4.0; vendored with attribution/license | `src/heresy2.ink`; pinned generated `item_globals.ink` included | no externals; runtime randomness pinned with `storySeed=1` | 2,675 lines, 22,630 words, 38 knots, 189 stitches, 393 choices, 541 diverts |

The tiers are workload labels defined before evaluation from multiple measures. They are not universal community size claims. *The Intercept* remains a relatively small community project even though it is the middle rung here.

Sky Caravan was screened as a stronger 90k-word scale case. Its MIT-licensed source is valuable evidence of a real integration boundary, but the author explicitly says it cannot run outside its unavailable Unity host, and current inklecate rejects its custom localization syntax. Inkcheck records that gap instead of preprocessing the project into a favorable benchmark.

## Reproducibility and limits

The first whole-manifest attempt was stopped at a predeclared 2.5-hour manual envelope because the original harness emitted only one atomic final report. The tables above come from the superseding isolated cells, not estimates recovered from the aborted process. They also preserve the evaluation-time meaning of `unavailable`: those workers were hard-killed without a report. The current runner adds guarded partial results and atomic scheduler-window snapshots; a future rerun may therefore turn the same wall-clock boundary into measured partial evidence without retroactively changing this table.

```sh
npm run build
npm run --silent evaluate-promotion -- benchmarks/authored-promotion-manifest.json --case the-intercept --budget 5000000 --worker-timeout-ms 900000 --markdown
```

No project assertions were configured, so the assertion column demonstrates absence of configured violations, not assertion-quality coverage. Heresy uses a fixed Ink runtime seed; this tests repeatability for that random sequence, not all possible random sequences. All completed runs remained partial, and none prove story completeness.

## Scorecard effect

Demonstrated generalization remains **4/10**. The project now has a reproducible public corpus tier and real medium/large-source evidence, but only three authored projects are declared, only two produced matched 1M cells, and only *The Intercept* produced a matched 5M cell. Robust unknown-shape exploration and anytime value also remain flat: parity is not a candidate advantage, while the resource-unavailable cells expose a stronger need for shape-aware throughput and stopping behavior.
