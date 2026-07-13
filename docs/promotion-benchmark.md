# Search promotion benchmark

Inkcheck freezes its default portfolio until a candidate passes a broad, predeclared comparison. The promotion harness runs matched fixed-portfolio and candidate-replay jobs from a consent-aware manifest:

```sh
npm run build
npm run --silent evaluate-promotion -- benchmarks/promotion-manifest.json
npm run --silent evaluate-promotion -- benchmarks/promotion-manifest.json --markdown
```

The checked-in manifest declares 20 structurally named synthetic cases with source, license, consent, budgets, depths, and seeds. Cases may also declare the same typed, non-executable assertion rules accepted by an Inkcheck project. It covers early choices, deep suffixes, finite locks and loops, storylets, gated endings, assertions, sparse runtime failures, random/turn state, and unavailable host externals. Depth matrices include an intentionally binding setting. The full command runs every declared point. `--ci` selects the cases marked `ci` and their smallest budget/seed at the first and last declared depth.

Each baseline and candidate runs in an isolated child process. Reports keep these evidence classes separate:

- Stable runtime-error and assertion-violation identities
- Authored knots and visible ending outcomes
- Hashed exact terminal-state identities
- Exhaustive proof, truncation causes, external stubs, and pass telemetry
- Deduplication, maximum depth, and frontier telemetry
- Observational elapsed time and peak process RSS

Regular JSON and Markdown include resource observations. `--deterministic` emits the stable comparison view without timestamps, elapsed time, or peak RSS, suitable for fixed-source/config/seed equality checks:

```sh
npm run --silent evaluate-promotion -- benchmarks/promotion-manifest.json --ci --deterministic
```

Cases marked `determinismCheck` repeat both strategies in fresh workers. The report distinguishes a candidate-only determinism regression from source-level nondeterminism that affects both strategies.

The report highlights baseline-only and candidate-only evidence and groups regressions by structural family. Critical, authored-coverage, proof, and terminal-only differences remain distinct. It deliberately does not calculate a winner or treat a larger bounded run as an oracle.

Mixed evidence keeps a candidate experimental. Promotion requires a separate proposal satisfying the [search strategy policy](search-strategy-policy.md), including no lost critical evidence at the largest comparable budget, no severe family blind spot, deterministic fixed-seed behavior, and equal or better limit honesty.
