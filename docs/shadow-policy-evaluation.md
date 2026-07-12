# Shadow policy evaluation

Inkcheck's v0.6 policy remains observation-only. The budget-ladder evaluator tests whether its recommendations would have been trustworthy against evidence found by larger configured runs, without applying those recommendations to exploration.

Build Inkcheck, then run:

```sh
npm run build
npm run evaluate-shadow -- path/to/manifest.json
npm run evaluate-shadow -- path/to/manifest.json --markdown
```

The manifest records consent and licensing alongside independent report files:

```json
{
  "schemaVersion": 1,
  "cases": [
    {
      "id": "intercept-depth100-seed1",
      "family": "early-variables-and-deep-suffixes",
      "source": {
        "name": "The Intercept",
        "license": "MIT",
        "consent": "public repository and license"
      },
      "runs": [
        { "budget": 100000, "report": "reports/intercept-100k.json", "elapsedMs": 19000 },
        { "budget": 1000000, "report": "reports/intercept-1m.json", "elapsedMs": 190000 },
        { "budget": 5000000, "report": "reports/intercept-5m.json", "elapsedMs": 950000 }
      ]
    }
  ]
}
```

Each checkpoint keeps runtime errors, assertion violations, authored knots, visible outcomes, and exact terminal states separate. If the shadow policy recommends stopping, `stopRisk` reports whether the declared high-water run contains additional `critical`, `authored_coverage`, `terminal_only`, or no evidence. The reverse `checkpointOnly` delta and `highWaterRegressionRisk` prevent a larger independent run from silently losing earlier evidence. No aggregate score can hide a runtime or assertion regression. Every delta retains its exact count and up to 20 deterministic examples, with an explicit truncation flag; exact terminal examples use stable SHA-256 identities so a large variable snapshot cannot create an unbounded machine report.

## Interpretation boundary

A higher-budget run is a **high-water comparison**, not an oracle. Unless it reports `exhaustive: true`, it remains bounded and may miss later evidence itself. Runs at different budgets are independent deterministic reruns whose portfolio allocation can differ; they are not prefixes of one resumable trajectory. The evaluator therefore measures budget-ladder disagreement and false-knee risk, not the exact counterfactual result of stopping a single live run.

This command is one evidence input to the broader [search promotion gate](search-strategy-policy.md). It does not choose a winner, change default weights, activate dynamic stopping, or turn a bounded non-finding into proof.
