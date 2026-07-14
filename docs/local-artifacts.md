# Local report artifacts

Inkcheck can persist a completed CLI report without uploading story source:

```sh
inkcheck story.ink --save-report --json
```

Saving is explicit. Without `--save-report`, Inkcheck creates no report artifact and its existing stdout contract is unchanged. With the flag, the JSON report adds an `artifact` reference and stderr confirms the same stable ID. The report is stored under `.inkcheck/reports/report-<hash>.json` using a same-directory temporary file and atomic rename.

The stable ID is derived from canonical report content plus its project-relative entrypoint binding. Repeating the same deterministic check on the same entrypoint reuses the same artifact instead of creating timestamp duplicates; identical reports from two different files cannot alias each other. Each versioned envelope records its creation time, Inkcheck and report schema versions, project-relative entrypoint, source fingerprint, effective configuration, and complete report.

## Reopening safely

From the project directory:

```sh
inkcheck artifacts list --json
inkcheck artifacts show report-0123456789abcdef01234567 --json
```

`show` recompiles the current entrypoint when the saved report used a compiled-story fingerprint. Its `artifact.freshness` is:

- `current`: the current fingerprint matches the saved run.
- `stale`: the entrypoint exists, but its current compiled/source fingerprint differs or it no longer compiles.
- `path_changed`: the saved project-relative entrypoint no longer exists.

Only `current` evidence describes the current source. Stale reports remain useful historical evidence, but are never presented as current proof. Corrupt JSON, metadata/content mismatches, and unsupported artifact/report schemas fail closed with regeneration or migration guidance.

## Version control and privacy

`inkcheck agent-kit` places `reports/` and `checkpoints/` in `.inkcheck/.gitignore`. Reports may contain authored choice text, ending text, variable snapshots, and exact witnesses. Keep them ignored by default. Commit a report only when the project explicitly wants a reviewable regression fixture and its repository privacy policy permits that content.

This artifact slice stores reports, not executable runtime state. The experimental base shared engine now has a separate source-bound checkpoint schema and resume-equivalence tests, but durable artifacts still require atomic persistence, bounded retention/cleanup, and a supported CLI/MCP lifecycle before Inkcheck advertises `resumableSearch: true`. See [shared checkpoint schema v1](shared-checkpoint-schema-v1.md).
