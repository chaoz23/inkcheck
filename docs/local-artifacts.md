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
inkcheck artifacts findings report-0123456789abcdef01234567 --limit 20 --json
inkcheck artifacts finding report-0123456789abcdef01234567 runtime.content_exhaustion:0123456789abcdef --json
inkcheck artifacts replay report-0123456789abcdef01234567 runtime.content_exhaustion:0123456789abcdef --json
inkcheck artifacts delete report-0123456789abcdef01234567 --json
inkcheck artifacts delete report-0123456789abcdef01234567 --apply --json
inkcheck artifacts prune --keep 10 --json
inkcheck artifacts prune --keep 10 --apply --json
```

`show` recompiles the current entrypoint when the saved report used a compiled-story fingerprint. Its `artifact.freshness` is:

- `current`: the current fingerprint matches the saved run.
- `stale`: the entrypoint exists, but its current compiled/source fingerprint differs or it no longer compiles.
- `path_changed`: the saved project-relative entrypoint no longer exists.

Only `current` evidence describes the current source. Stale reports remain useful historical evidence, but are never presented as current proof. Corrupt JSON, metadata/content mismatches, and unsupported artifact/report schemas fail closed with regeneration or migration guidance.

## Finding drill-down and replay

`artifacts findings` indexes compile issues, runtime errors, endings, assertion violations, and goal/stage witnesses. It returns 20 summaries by default and accepts `--limit` from 1 through 100. `page.nextCursor` continues through the immutable report; cursors are bound to one report ID and foreign, malformed, or out-of-range cursors fail closed.

Collection summaries contain stable ID, normalized kind, report section, replay/witness availability, and a source location when available. They deliberately omit messages, story prose, choice labels and indices, variable values, ending text, and complete witnesses. Use `artifacts finding` to request one complete finding explicitly.

`artifacts replay` is an execution boundary. It requires a `current` report, recompiles the current project entrypoint, then passes the saved zero-based choices and `storySeed` to Inkcheck's playtest engine. It returns the replay transcript, variables, runtime errors, and `completed`, `runtime_error`, or `path_changed` status. Findings without an indexed replay, stale/path-changed reports, compile failures, missing IDs, and ambiguous duplicate IDs are rejected rather than approximated.

## Storage limits and cleanup

Report files are private mode `0600` inside a `0700` report directory on POSIX. A write uses a private same-directory temporary file, syncs it, atomically renames it, syncs the directory where supported, and cleans up the temporary path on success or failure.

One report may use at most 256 MiB. All report artifacts under one project may use at most 1 GiB. The limits are deliberately hard refusal boundaries: if a new report would cross either one, the save fails before writing and does not silently remove an existing stable ID. Re-saving an already-present content-addressed report remains idempotent because it adds no storage.

Cleanup is explicit and preview-first. `artifacts delete <id>` selects one report. `artifacts prune --keep N` keeps the newest N reports independently for every project-relative entrypoint, with timestamp ties ordered by stable ID. Both commands require `--apply` to delete anything. A prune invocation selects at most 100 reports and reports remaining candidates so cleanup output and mutation stay bounded. Corrupt or incompatible artifacts stop cleanup before any deletion.

`capabilities --json` publishes `maxReportBytes`, `maxProjectReportBytes`, and `maxReportPrunePerRun`; automation should read those fields rather than scraping human documentation.

## Version control and privacy

`inkcheck agent-kit` places `reports/` and `checkpoints/` in `.inkcheck/.gitignore`. Reports may contain authored choice text, ending text, variable snapshots, and exact witnesses. Keep them ignored by default. Commit a report only when the project explicitly wants a reviewable regression fixture and its repository privacy policy permits that content.

Report artifacts store completed evidence, not executable runtime state. Exact base-shared continuation uses a separate, more sensitive artifact and CLI lifecycle documented in [local resumable checkpoints](local-checkpoints.md).
