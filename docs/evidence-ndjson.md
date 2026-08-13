# Bounded evidence NDJSON contract

`inkcheck story.ink --json-stream --concurrency 1` writes one JSON object per stdout line. It is an opt-in large-run transport for wrappers that need replayable evidence before a process reaches its final reporting phase. Ordinary `--json`, human, Markdown, progress, and saved-report contracts are unchanged.

Current events use `schemaVersion: 1`:

- `run_start` records the Inkcheck version, effective configuration, and state budget.
- `ending` records a stable event ID, global `elapsedMs`, pass-local `firstDiscoveredAtState`, numeric `choiceIndices`, and optional `foundBy` pass. It omits choice prose, final text, and variables.
- `runtime_error` records the same replay coordinates plus the error message and optional source location.
- `benchmark_signal` is reserved for InkBench's oracle-neutral fixtures. A root `INKBENCH_SIGNAL_MODE` tag suppresses ordinary finding records, and an exact `INKBENCH_SIGNAL:<non-negative integer>` tag emits only that numeric signal, its numeric replay path, and timing. No story prose, variables, or arbitrary tags are copied.
- `run_end` is the authoritative bounded summary. It records compile status, states explored, finding counts, limits, execution mode, truncation causes, resource envelopes/deadlines, and emitted-evidence counts. It does not contain the full ending, pass, schedule, or discovery-curve arrays.

Events are flushed as newline-delimited records during the run. A consumer may retain and replay complete finding lines even if an outer process guard later interrupts the CLI. Absence of `run_end` means the run was interrupted; it must not be relabeled as clean completion.

The stream deduplicates endings by numeric replay path and runtime errors by message plus numeric path across portfolio passes. A fixed story seed makes a numeric path deterministic. The `elapsedMs` value is measured from the CLI run start and is globally comparable within that process; `firstDiscoveredAtState` remains pass-local and must not be treated as a portfolio-global work position.

The reserved InkBench tags are a scoring transport, not a search input. The portfolio does not score, prioritize, hash, or retain tags in ending identity. InkBench removes planted oracle variables and assignments before invoking Inkcheck, replaces a triggering assignment with one numeric signal tag, and replays only those signaled paths against its separately pinned instrumented story. Ordinary stories should not use the reserved `INKBENCH_SIGNAL_` prefix.

`--json-stream` currently requires `--concurrency 1`, supports one bounded run (no `--next`), and cannot be combined with `--save-report`. These constraints prevent a function callback from crossing worker isolates and prevent a supposedly bounded transport from invoking the monolithic artifact writer.

For a declared `--max-time`, exploration retains 10% of the total grant, capped at 60 seconds, to merge the already-retained internal evidence and flush `run_end`. This reserve is part of the total wall budget, not extra search time.

For operational counters without finding content, keep using [`--progress=ndjson`](progress-ndjson.md) on stderr. Evidence output can contain runtime error text and replay paths, so store it with the same privacy controls as an ordinary report.
