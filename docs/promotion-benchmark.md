# Search promotion benchmark

Inkcheck freezes its default portfolio until a candidate passes a broad, predeclared comparison. The promotion harness runs matched fixed-portfolio and candidate-replay jobs from a consent-aware manifest:

```sh
npm run build
npm run --silent evaluate-promotion -- benchmarks/promotion-manifest.json
npm run --silent evaluate-promotion -- benchmarks/promotion-manifest.json --markdown
```

The authored-project tier is separate and manual. Its vendored, pinned sources and provenance live under `benchmarks/authored`; select one reproducible cell when a full matrix would be unnecessarily expensive:

```sh
npm run --silent evaluate-promotion -- benchmarks/authored-promotion-manifest.json --case the-intercept --budget 5000000 --markdown
```

The runner writes cell start/finish progress to stderr while preserving machine-readable stdout. `--worker-timeout-ms` gives a manual evaluation an explicit per-process envelope. The worker installs an internal time guard with serialization headroom and atomically persists one evidence snapshot per deterministic scheduler window, so an ordinary deadline returns a partial comparison with `truncatedBy.time` instead of losing the run. Only a worker killed before any usable snapshot remains `unavailable`; that cell is never interpreted as a search result, determinism failure, or evidence match. `--worker-max-memory-mb` optionally sets an explicit evaluation heap watermark; otherwise the worker uses the same 85%-of-V8-heap guard as the CLI and MCP server. The authored manifest predeclares 1M and 5M rungs; a genuinely unavailable cell must be reported as unavailable, not omitted or inferred from a smaller run.

The worker report keeps safety limits separate from efficiency observations. Memory and time caps are user/environment backstops, not automatic knee decisions. Matched rows record the configured caps, guard or hard-timeout exit, elapsed time, peak RSS, and serialized-frontier high-water counts/bytes. Future allocation policy may use marginal discovery yield, throughput, recovery gaps, and resource growth, but this harness does not stop merely because a run appears inefficient.

The first authored 5M-ceiling guard probes and the scheduler overshoot defect they exposed are recorded in the [resource-safe deep-run evaluation](resource-guard-evaluation.md).

The checked-in manifest declares 20 structurally named synthetic cases with source, license, consent, budgets, depths, search seeds, and an optional initial Ink runtime `storySeed` (default 1). Every matched baseline/candidate pair receives the same two seeds. Cases may also declare the same typed, non-executable assertion rules accepted by an Inkcheck project. It covers early choices, deep suffixes, finite locks and loops, storylets, gated endings, assertions, sparse runtime failures, random/turn state, and unavailable host externals. Depth matrices include an intentionally binding setting. The full command runs every declared point. `--ci` selects the cases marked `ci` and their smallest budget/search seed at the first and last declared depth.

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

For a resource-bounded authored cell:

```sh
npm run --silent evaluate-promotion -- benchmarks/authored-promotion-manifest.json \
  --case the-intercept --budget 5000000 \
  --worker-timeout-ms 900000 --worker-max-memory-mb 8192 --markdown
```

Cases marked `determinismCheck` repeat both strategies in fresh workers with the same declared story seed. The report distinguishes a candidate-only determinism regression from a defect affecting both strategies.

The report highlights baseline-only and candidate-only evidence and groups regressions by structural family. Critical, authored-coverage, proof, and terminal-only differences remain distinct. It deliberately does not calculate a winner or treat a larger bounded run as an oracle.

Authored-project reports put a worst-project table before matched runs and aggregate family results. Project labels use the documented multi-measure thresholds in `benchmarks/authored/README.md`; they are corpus workload tiers, not universal community size claims.

Mixed evidence keeps a candidate experimental. Promotion requires a separate proposal satisfying the [search strategy policy](search-strategy-policy.md), including no lost critical evidence at the largest comparable budget, no severe family blind spot, deterministic fixed-seed behavior, and equal or better limit honesty.
