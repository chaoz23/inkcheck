# InkJam story QA with inkcheck

inkcheck mechanically checks an ink story. It does not generate, rewrite, upload, or judge the prose. Before using it for a particular jam, confirm that external QA tools are permitted by that jam's organizers.

## Fastest local check

Install Node.js 18 or newer, open a terminal in the folder containing the story, and run:

```sh
npx -y inkcheck path/to/main.ink
```

Use `--strict` for a release candidate:

```sh
npx -y inkcheck path/to/main.ink --strict
```

The first run downloads the pinned official `inklecate` compiler into the local inkcheck cache and verifies its SHA-256 hash. Story text is processed on the same machine.

## What to do with the report

- **Compile error:** fix this first; the story could not be explored.
- **Runtime error:** replay the printed choice path, then fix the failing expression, divert, or external integration.
- **Unvisited knot:** review it. It may be dead content, intentionally dormant, or entered by the host game rather than another ink knot.
- **Truncated:** raise `--max-depth` or `--max-states`, or record that the check was partial.
- **EXTERNAL stub:** test the real host-game behavior too. inkcheck used zero because it cannot know what the engine returns.
- **Randomness detected:** inkcheck follows deterministic runtime states, but it does not try every possible seed. Keep human or repeated randomized playtesting in the loop.

## GitHub Actions

Create `.github/workflows/inkcheck.yml` in the game repository:

```yaml
name: Ink story QA
on: [push, pull_request]

jobs:
  inkcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Check story
        shell: bash
        run: |
          set -o pipefail
          npx -y inkcheck path/to/main.ink --strict --markdown | tee -a "$GITHUB_STEP_SUMMARY"
```

Replace `path/to/main.ink` with the root story file. The job fails when strict coverage is incomplete, while the run page retains a readable report.

## A useful bug report

If inkcheck misses a failure or reports one incorrectly, reduce it to the smallest `.ink` file you can share and include:

- the inkcheck command;
- the report;
- what you expected;
- whether the story uses `EXTERNAL` functions, randomness, or host-engine entry points.

False positives are bugs too.

Use the repository's focused issue forms to report an incorrect result, offer a small licensed fixture, or request an opt-in QA clinic check. GitHub issues are public: never attach unpublished or jam-restricted story material. Opening an issue does not grant permission to quote, name, retain, or publish a participant's story.
