# Local report artifacts

Inkcheck can persist a completed CLI report without uploading story source:

```sh
inkcheck story.ink --save-report --json
```

Saving is explicit. Without `--save-report`, Inkcheck creates no report artifact, emits no artifact reference, and prints no saved-artifact confirmation. Successful monolithic `--json` output may still add numeric `resources.ownerAccounting` and `resources.longRunTelemetry` lifecycle records outside the report payload; bounded `--json-stream` deliberately does not build the full enriched report graph. With `--save-report`, the JSON report additionally carries an `artifact` reference and stderr confirms the same stable ID. The reference carries a schema-v1 finalization `accounting` receipt. It reports canonical report-ID input bytes, whether artifact serialization was applied, pretty-printed artifact UTF-8 bytes, reuse readback and validation-identity bytes, a conservative total for those strings, zero current string ownership after return, durable file bytes, and separately discriminated graph-materialization proxies. The report is stored under `.inkcheck/reports/report-<hash>.json` using a same-directory temporary file and atomic rename. Neither outer lifecycle record is passed to the artifact writer or included in the saved report ID.

The stable ID is derived from canonical report content plus its project-relative entrypoint binding. Repeating the same deterministic check on the same entrypoint reuses the same artifact instead of creating timestamp duplicates; identical reports from two different files cannot alias each other. Each versioned envelope records its creation time, Inkcheck and report schema versions, project-relative entrypoint, source fingerprint, effective configuration, and complete report.

The accounting receipt is deliberately outside the saved report and its content-derived ID. Full report lifecycles may attach `reportEnrichment.status: "applied"`, containing numeric schema-v1 accounting for the source `ExploreResult` compact-JSON view, stable finding-ID input strings materialized during enrichment, the returned report compact-JSON view, their conservative potential sum, and the returned view still owned by the caller. Legacy callers that did not opt into the accounted builder receive the explicit `{ status: "not_applied", reason: "unavailable" }` variant; absence is not reported as a measured zero. The saver projects the numeric whitelist rather than copying arbitrary caller keys, so accounting does not duplicate authored prose, witness text, variables, or finding messages.

`graphMaterialization.createdEnvelope` accounts the compact-JSON view of the artifact envelope constructed by an accounted create. On an accounted reuse, `graphMaterialization.reuseParsedArtifact` instead accounts the artifact graph returned by the existing validation parse. Exactly one graph is `applied`; the other is `not_applied`. A legacy direct save without an enrichment receipt performs no new graph walk on either create or reuse and reports the outcome graph and `conservativePotential` as `not_applied`/`unavailable` rather than inventing zero bytes or changing pre-accounting behavior. Applied conservative potential stays separate from string materialization totals, and current saver-owned graph bytes are zero after the API returns. These deterministic serialized-view proxies are not observed heap/RSS peaks, exclusive retained-owner bytes, or proof of reclamation.

A reuse materializes the caller's schema-v1 canonical identity, reads the existing artifact into one raw UTF-8 string, and materializes a second canonical identity while validating the parsed report. It does not create a new pretty-printed artifact string: `serialization.status` is `not_applied` while `readback.status` is `applied`. `readback.rawArtifactString` reports that one string's count and logical UTF-8 bytes, and `readback.validationIdentity` reports the second canonical identity's count and bytes. A created artifact has `readback.status: "not_applied"` and zero-valued readback string owners. When reuse graph accounting is applied, its proxy is derived from that same read and parse rather than reading, parsing, or serializing the artifact again. Its conservative string total includes both identities and the raw artifact string; it does not include either graph proxy.

Graph byte counting streams JSON tokens without materializing a whole compact artifact string and accepts Inkcheck's schema-owned plain JSON containers only. It fails closed on cycles, `BigInt`, boxed/exotic or proxy containers, accessors, and inherited or own `toJSON` hooks rather than invoking active user code. Shared subgraphs are serialized once per reference, just as JSON would serialize them, so source-plus-returned potential deliberately double-counts shared DAG backing under a conservative no-sharing assumption. Do not add these proxies to shared-search retained-current or peak totals: charge-once backing attribution remains partial under issue #216.

MCP search-session persistence deliberately remains on the legacy unaccounted builder/saver path in this slice. That keeps enrichment and artifact graph walks out of memory-guard sampling before checkpoint suppression and `bindingLimit` decisions. The additive receipt stays out of saved session reports and checkpoint/report identity inputs and payloads. Campaign decision functions do not read the telemetry, but collecting it has bounded overhead and can shift an execution already beside a memory or time guard. The exposed accounted report lifecycle is opt-in, and its receipt remains outside the saved payload.

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
