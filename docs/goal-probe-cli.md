# Goal-Only CLI Probe

`--goal-only` is a public, bounded Inkcheck mode for testing an explicitly configured search goal from the story root. It uses the normal CLI compiler, source scan, resource guards, human progress renderer, NDJSON progress stream, and report schema.

It is useful when an author or agent wants an exact witness for a declared condition without spending an additional broad-QA slice first. It is not a coverage claim and does not replace a normal portfolio or shared check.

## Configure a goal

Place an `inkcheck.yml` beside the entrypoint:

```yaml
schemaVersion: 1
entrypoint: story.ink
goals:
  - id: teacup-available
    condition:
      left: { variable: teacup }
      op: equals
      right: { literal: true }
```

## Run

Run ordinary shared search, which observes the configured goal but does not allocate directed work:

```sh
inkcheck story.ink --search shared --max-states 5000000 --no-min-repro --json --progress=ndjson
```

Run only the directed root-started probe at the same work budget:

```sh
inkcheck story.ink --goal-only --max-states 5000000 --json --progress=ndjson
```

`--goal-only` requires at least one configured goal. It uses `--max-states` as its entire directed budget, disables min-repro work, and does not support checkpoints, `--next`, or `--auto`. Its report identifies `executionScope: "goal-probe"` and includes normal goal results and witnesses.

This surface is intentionally public while gate-directed research is underway. Keep it only if it proves useful to authors and agents; remove it rather than preserving it as a private benchmark convenience if it does not.
