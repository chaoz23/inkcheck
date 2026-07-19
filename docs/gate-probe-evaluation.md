# Gate Probe Evaluation

This protocol asks a narrow question: under the same bounded state grant, does an explicit gate-derived goal probe reach its selected condition or produce an exact witness more often than ordinary shared search, without losing critical broad-QA evidence?

It does not estimate story coverage, prove that source assignment sites cause a gate to become reachable, count terminal variants as defects, or authorize a default allocation change.

## Cells

`benchmarks/gate-probe-evaluation-v1.json` predeclares two cells:

- `early-choice-grid-combination-lock`: the critic-provided early-choice combination-lock shape. It targets `one && four` and is the fast structural control.
- `the-intercept-teacup-5m`: the pinned MIT-licensed *The Intercept* source at a real supported gate, `teacup`, line 150. The current source contains no supported compound gate, so this is an authored gate-probe cell, not a compound-gate claim.

Each arm must run through the public CLI in a fresh process. Both receive the same file, temporary goal configuration, depth, search seed, Ink story seed, and state ceiling. The broad arm uses ordinary shared selection; the candidate uses [`--goal-only`](goal-probe-cli.md), the public root-started goal probe. Both retain the CLI's resource guards, reports, and progress contracts. Results record target status/witness, runtime and assertion evidence, endings/outcomes/knot counts, binding limits, and elapsed time. The evaluator deliberately does not report parent-process RSS as child memory use.

## Run

The smoke control is suitable for local verification:

```sh
npm run --silent evaluate-gate-probe -- --case early-choice-grid-combination-lock
```

On the pinned source and seeds, an exploratory 5/10/20/30/50-state sweep found both arms missed at 5 states; the gate probe reached `one && four` at 10, 20, and 30 while broad shared search did not; both reached it by 50. The checked [20-state artifact](../benchmarks/results/gate-probe-combination-lock-20-v1.json) records the selected smoke cell. It demonstrates a narrow target-reach distinction, with one fewer visited knot in the probe arm. It is a deliberately adversarial structural control, not evidence of general QA superiority.

The authored 5M cell is deliberately opt-in. Its manifest sets a 1,536 MiB CLI `--max-memory` envelope so a constrained machine returns a truthful `memory_limit` partial report rather than relying on a V8 out-of-memory failure. A 5M state ceiling remains a ceiling, not a promise that a given machine can retain that frontier.

```sh
node --max-old-space-size=6144 scripts/gate-probe-evaluation.js \
  --case the-intercept-teacup-5m --include-required \
  --output benchmarks/results/gate-probe-intercept-5m-v1.json
```

Use `--budget N` only for development smoke runs; it overrides the declared cell ceiling and must not be presented as the 5M result.

## Observed Result

The checked [The Intercept artifact](../benchmarks/results/gate-probe-intercept-5m-v1.json) used the declared 5,000,000-state ceiling with a 1,536 MiB product memory envelope. Both arms stopped cleanly on `memory_limit`, so this is a memory-bounded observation rather than a 5M-complete result.

| Arm | States | Target | Visible outcomes | Visited knots | Runtime errors |
| --- | ---: | --- | ---: | ---: | ---: |
| Broad shared | 514,559 | reached with witness | 12 | 29 | 0 |
| Goal-only probe | 388,095 | reached with witness | 12 | 29 | 0 |

The selected `teacup` goal was already reached by ordinary shared search. The goal-only probe consumed fewer states before its memory boundary and produced fewer terminal-state identities, but it did not add visible outcomes, visited knots, runtime errors, or assertions. This is neutral evidence for automatic gate ranking; retain explicit goal probes for author or agent intent, and gather more diverse cells before changing default budget allocation.

## Promotion Boundary

No default search allocation changes from this evaluation alone. Promotion needs reviewed portfolio-new value or a clear resource advantage across the combination-lock control and multiple consent-safe authored stories, with no lost runtime/assertion evidence and reproducible witnesses. A reached target only says the selected condition was observed within that run.
