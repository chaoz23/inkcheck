# Independent long-tail campaign evaluation

This evaluation tests one narrow Inkcheck 0.6 claim: after an exact shared base window, can deterministic root-started portfolio partitions spend protected long-tail budget more usefully than continuing to grow that one frontier? It does not estimate story coverage or claim that terminal-state diversity equals a defect.

## Reproducible design

The checked manifest is `benchmarks/long-tail-partition-evaluation-v1.json`. Each arm runs in a fresh process from a fresh source copy with the same depth, search seed, story seed, state ceiling, 4 GiB campaign heap ceiling, and 2 GiB disk ceiling. The control uses a finite repository-owned early-gate story. The authored cell pins inkle's MIT-licensed *The Intercept* at commit `2a816b56e61ce4bf02bec1c638074645bdd871e3`.

The *Intercept* arms each authorize 5,000,000 total states: a 500,000-state exact shared base followed by 4,500,000 additional states in 500,000-state windows. The baseline resumes one shared checkpoint. The candidate launches a new deterministic auto-concurrency portfolio child for each protected window and retains the original base checkpoint. A 600,000-state preflight was rejected before comparison because its compressed checkpoint could not be decoded by the current readback path; the successful matched design uses the previously qualified 500,000-state bootstrap boundary. That remains #156 work, not candidate evidence.

```sh
npm run build
node --max-old-space-size=6144 dist/long-tail-evaluation-cli.js \
  benchmarks/long-tail-partition-evaluation-v1.json \
  --output benchmarks/results/long-tail-partition-evaluation-v1.json
```

The evaluator records source and manifest hashes, environment, stable report/checkpoint IDs, every partition seed, execution activation, campaign-new identity digests, elapsed time, peak heap, disk spend, stop reason, and base-preservation invariants. The two checked case files may also be reproduced independently.

## Results

| Case and additional work | States consumed | Additional time | Peak campaign heap | New critical | New knots | New visible outcomes | New terminal variants | Stop |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Synthetic: shared +5K | 5,000 | 5.28s | 169 MiB | 0 | 0 | 0 | 1,812 | state window |
| Synthetic: independent +5K | 5,000 | 1.22s | 108 MiB | 0 | 0 | 0 | 2,321 | state window |
| Intercept: shared, up to +4.5M | 286,559 | 106.81s | 3.70 GiB | 0 | 0 | 0 | 407 | memory |
| Intercept: independent +4.5M | 4,500,000 | 522.19s | 1.41 GiB | 0 | 0 | 0 | 3,558 | state ceiling |

The exact *Intercept* arm stopped at 786,559 total campaign states. The independent arm completed the full 5,000,000-state campaign while preserving and byte-matching the base checkpoint. All nine children activated three workers after the production live pilot.

At approximately the baseline's 107-second additional wall clock, the first two independent children had credited 1,538 campaign-new terminal variants versus the baseline's 407. Across all nine 500K children, marginal terminal credit declined:

| Child | New terminal variants | Elapsed |
| ---: | ---: | ---: |
| 1 | 1,030 | 47.62s |
| 2 | 508 | 60.59s |
| 3 | 400 | 60.10s |
| 4 | 340 | 54.20s |
| 5 | 300 | 60.90s |
| 6 | 293 | 64.27s |
| 7 | 239 | 62.67s |
| 8 | 229 | 52.20s |
| 9 | 219 | 59.39s |

The decreasing but nonzero sequence is direct evidence that Inkcheck can instrument a long-tail yield curve. It supports a future marginal-stop or reallocation policy; it does not establish an asymptote, because a later independent seed could still find another peak.

The first #180 shadow policy replays this sequence as rotate recommendations while authorization remains, then stops when the protected reserve is exhausted. Under a runtime/assertion preference, the same terminal-only windows become dry preferred-value evidence; scarce/balanced/abundant postures require three/four/five dry independent probes before a shadow stop. This replay remains observational and is not included in the measured execution comparison above.

## Interpretation

This slice solves a real resource trap. A monolithic retained frontier can bind on memory long before its state authorization, while independent bounded children keep memory roughly flat and continue producing diverse terminal states. It also fixes duplicate critical accounting discovered by the control: the same runtime defect reached through another path now uses Inkcheck's canonical runtime identity and earns zero new critical credit.

The authored cell did **not** find a new runtime error, authored knot, or visible ending. Its measured advantage is resource feasibility, wall-clock-left-shifted terminal diversity, and deterministic campaign-new accounting. More terminal variable combinations may expose future assertions or regressions, but they are not automatically actionable findings. Promotion of a dynamic long-tail default still needs multiple public story families and value-weighted stopping evidence.

Machine results:

- `benchmarks/results/long-tail-partition-synthetic-control-v1.json`
- `benchmarks/results/long-tail-partition-intercept-5m-v1.json`
