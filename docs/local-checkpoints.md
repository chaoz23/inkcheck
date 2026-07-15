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

Exact persistence currently supports only base `--search=shared` with `--no-min-repro`. Assertions, goals, `shared-variable`, the default portfolio, `--auto`, `--next`, and hosted jobs are rejected rather than restarted or resumed approximately. MCP exposes the same narrow engine contract as cooperative [result-window sessions](mcp-search-sessions.md), while one-shot `explore_story` remains non-resumable. `inkcheck capabilities --json` reports `resumableSearchSurfaces: ["cli", "mcp"]` so agents can discover both supported surfaces without inferring hosted support.

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

New checkpoints live under `.inkcheck/checkpoints/checkpoint-<hash>.json.gz`. Their stable ID derives from the exact logical checkpoint content plus the project-relative entrypoint, not from compression bytes, so repeating the same deterministic boundary reuses one artifact. Existing schema-v1 `.json` artifacts remain readable and resumable.

The writer emits compact JSON through gzip directly into the private same-directory temporary file. It never constructs a second artifact-sized JSON string in memory, and it enforces the single-artifact ceiling against bytes that would actually remain on disk. A malformed gzip stream fails closed as storage corruption; a valid stream still passes the normal schema, stable-ID, source, and configuration checks after decompression.

Inkcheck writes a same-directory temporary file with mode `0600`, flushes it, atomically renames it, and removes temporary files on failure. Only after the new file is durable does retention remove older artifacts. Defaults are hard safety ceilings:

- 512 MiB for one checkpoint;
- 1 GiB across checkpoint artifacts in one project;
- three generations per entrypoint.

An individually oversized compressed checkpoint is rejected. Once a new generation is durable, oldest generations for that entrypoint are removed first, then the oldest project checkpoints if needed to satisfy the project byte ceiling. The saved generation is protected from that cleanup. `checkpoints list/show` reports `storageEncoding` and the actual durable `sizeBytes`; this is storage cost, not an estimate of process heap or future search value.

## Privacy

Checkpoint artifacts are executable search state. They can contain authored choice and ending text, variable values, serialized Ink runtime state, findings, and exact witness paths. They are never uploaded by this workflow, but anyone who can read the file may recover story material.

`inkcheck agent-kit` ignores `.inkcheck/checkpoints/` by default. Keep that rule, do not attach checkpoint files to public issues, and delete them when the continuation is no longer needed. Completed report artifacts have a separate contract in [local report artifacts](local-artifacts.md).
