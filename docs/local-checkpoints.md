# Local resumable checkpoints

Inkcheck can preserve an unfinished base-shared search and continue it in a later process without replaying prior states.

```sh
inkcheck story.ink \
  --search=shared \
  --no-min-repro \
  --max-states 100000 \
  --save-checkpoint \
  --json

inkcheck resume checkpoint-0123456789abcdef01234567 \
  --max-states 1000000 \
  --json
```

The resumed `--max-states` value is the new **total grant**. It must be greater than the checkpoint's prior grant. Resume automatically saves the next generation when work remains; exhausted searches and memory-, time-, or frontier-stopped searches keep their report but do not claim a resumable checkpoint exists.

## Supported scope

Exact persistence currently supports only base `--search=shared` with `--no-min-repro`. Assertions, goals, `shared-variable`, the default portfolio, `--auto`, `--next`, hosted jobs, and MCP are rejected rather than restarted or resumed approximately. `inkcheck capabilities --json` reports `resumableSearchSurfaces: ["cli"]` so agents can distinguish this local workflow from unsupported surfaces.

## Inspect and reopen

```sh
inkcheck checkpoints list --json
inkcheck checkpoints show checkpoint-0123456789abcdef01234567 --json
```

These commands return bounded metadata, not the frontier payload. `show` recompiles the project and reports:

- `current`: compiled story and knot/source map match the saved checkpoint.
- `stale`: source exists but no longer matches or compiles.
- `path_changed`: the project-relative entrypoint no longer exists.

Resume requires `current`, the supported artifact and checkpoint schema versions, and every engine binding to match: story and knot hashes, depth, both seeds, hidden turn/random sensitivity, randomness detection, frontier envelopes, and external bindings. Corrupt content, metadata mismatch, unsupported versions, and a non-increasing grant fail closed.

## Atomicity and retention

Checkpoints live under `.inkcheck/checkpoints/checkpoint-<hash>.json`. Their stable ID derives from exact checkpoint content plus the project-relative entrypoint, so repeating the same deterministic boundary reuses one artifact.

Inkcheck writes a same-directory temporary file with mode `0600`, flushes it, atomically renames it, and removes temporary files on failure. Only after the new file is durable does retention remove older artifacts. Defaults are hard safety ceilings:

- 512 MiB for one checkpoint;
- 1 GiB across checkpoint artifacts in one project;
- three generations per entrypoint.

An individually oversized checkpoint is rejected. Once a new generation is durable, oldest generations for that entrypoint are removed first, then the oldest project checkpoints if needed to satisfy the project byte ceiling. The saved generation is protected from that cleanup.

## Privacy

Checkpoint artifacts are executable search state. They can contain authored choice and ending text, variable values, serialized Ink runtime state, findings, and exact witness paths. They are never uploaded by this workflow, but anyone who can read the file may recover story material.

`inkcheck agent-kit` ignores `.inkcheck/checkpoints/` by default. Keep that rule, do not attach checkpoint files to public issues, and delete them when the continuation is no longer needed. Completed report artifacts have a separate contract in [local report artifacts](local-artifacts.md).
