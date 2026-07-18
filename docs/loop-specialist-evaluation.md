# Loop Specialist Evaluation

The forced-choice-cycle specialist is a conservative review aid, not a coverage claim. Before promoting another specialist, compare an archived baseline report to a candidate report from the same compiled story and fixed search configuration.

## Required Cell

Use Inkle's pinned MIT-licensed *The Intercept* source at `benchmarks/authored/the-intercept/TheIntercept.ink` with:

- `--concurrency 1`
- `--max-states 5000000`
- `--max-depth 100`
- `--seed 7 --story-seed 1`
- `--no-min-repro --json`

Run the baseline and candidate in separate clean directories, saving stdout to `baseline.json` and `candidate.json`. Then compare them:

```sh
npx -y inkcheck@0.7.0 benchmarks/authored/the-intercept/TheIntercept.ink \
  --concurrency 1 --max-states 5000000 --max-depth 100 \
  --seed 7 --story-seed 1 --no-min-repro --json > baseline.json

npx -y inkcheck@0.7.1 benchmarks/authored/the-intercept/TheIntercept.ink \
  --concurrency 1 --max-states 5000000 --max-depth 100 \
  --seed 7 --story-seed 1 --no-min-repro --json > candidate.json

npm run --silent evaluate-loop-specialist -- \
  --baseline baseline.json --candidate candidate.json --markdown
```

Record wall-clock time separately. The evaluator intentionally reports only observed bounded-run evidence: states, endings, runtime errors, loop warnings, unvisited knots, and binding limits.

## Checked Sanity Cell

The checked 100K-state The Intercept smoke cell is at `benchmarks/results/loop-specialist-intercept-100k-v1.json`. Under the required seeds, depth 100, sequential portfolio, and no minimization, 0.7.0 and 0.7.1 both found 757 endings, zero runtime errors, and one unvisited knot; 0.7.1 emitted no loop warning. This is a parser/regression sanity check only. The required 5M cell remains necessary for any resource or specialist-value conclusion.

## Promotion Boundary

Do not promote automatic specialist allocation from one cell. A candidate must first show reviewed actionable findings or a clear resource benefit without losing runtime evidence across multiple consent-safe authored stories and structural controls. A quiet run means only that no warning was observed within its limits.
