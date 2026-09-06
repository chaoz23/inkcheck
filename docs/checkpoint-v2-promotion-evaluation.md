# Checkpoint-v2 promotion evaluation

This evaluation is the checked, preregistered proof for the engine-native
framed-v2 checkpoint path. It asks two narrow questions under matched search
controls:

1. Does a framed checkpoint written directly from the paused shared engine
   resume to the byte-identical canonical result of an uninterrupted run?
2. At the previously observed *The Intercept* schema-v1 readback boundary,
   does framed v2 reopen and resume while the legacy reader returns its typed,
   non-destructive resource limit?

It does not make framed v2 the default, change search allocation, claim story
coverage, or establish an InkBench or portable performance improvement.

## Preregistered matrix

`benchmarks/checkpoint-v2-promotion-v1.json` fixes six serial cells in mirrored
order:

| Order | Cell | Base | Target | Expected observation |
| ---: | --- | ---: | ---: | --- |
| 1 | Heresy II legacy split | 100,000 | 150,000 | reopen and exact resume |
| 2 | Heresy II framed split | 100,000 | 150,000 | engine-native write, reopen, exact resume |
| 3 | Heresy II uninterrupted | — | 150,000 | matched endpoint |
| 4 | The Intercept uninterrupted | — | 650,000 | matched endpoint |
| 5 | The Intercept framed split | 600,000 | 650,000 | engine-native write, reopen, exact resume |
| 6 | The Intercept legacy split | 600,000 | 650,000 | typed schema-v1 readback resource limit |

All cells use maximum depth 100, search seed 7, story seed 1, one shared-search
lane, no repro minimization, a 4 GiB search guard, a 14-minute graceful time
guard, and a 15-minute hard worker boundary. Turn and random state sensitivity
comes from `scanStorySemantics`. Forced-loop detection is enabled only when
the source uses no turns, randomness, visit counts, or externals.

Every cell runs in a fresh temporary project and a fresh child process. On
Unix, the worker starts a process group. A hard boundary first terminates that
group, then retains a referenced escalation timer and sends `SIGKILL` to the
group even if its leader already exited; a resistant descendant therefore
cannot evade cleanup by outliving the leader. Windows force-terminates the
captured process tree while its leader still exists and repeats that tree
cleanup at the escalation boundary as a best effort. Cells execute serially so
one story's retained frontier cannot overlap another cell's resource
observation.

The complete checkpoint pair is capped at 512 MiB, and checkpoint storage in
the isolated project is capped at 2 GiB. Framed v2 changes only its cumulative
decoded-record ceiling to 2 GiB; the ordinary per-frame, record, count,
checksum, and durable-byte limits remain in force.

## Source and compiler pins

The runner inventories each entrypoint with `inspectProject`, rejects a
truncated INCLUDE list, adds the entrypoint to that closure, and hashes sorted
project-relative path, NUL, raw bytes, NUL tuples. It validates the entrypoint,
complete closure, and license/provenance file before starting a worker. Each
worker repeats the closure check after its isolated copy and validates the
compiled story JSON after normalizing the compiler artifact to exactly one
final LF, matching the pinned InkBench corpus packaging.

| Story | Upstream pin | Source files | Bundle SHA-256 | Compiled JSON SHA-256 |
| --- | --- | ---: | --- | --- |
| Heresy II | `randall-frank/heresy2-assets@37b8a7804217bb40a9f69f6fd9c173f2017d550e` | 21 | `2991d13fbf2d036c9bfb5cf4207c16509dfdf77dae24fa410ace1a0d3a36b626` | `5c65cf077478ad70985341e564695cb8ab35af20ec574d12b517d1e18f9a4bb7` |
| The Intercept | `inkle/the-intercept@2a816b56e61ce4bf02bec1c638074645bdd871e3` | 1 | `c9865a7d2d334e39b68f788f790d202a7c1fbd9acb2bf2fc54fa1a4d549db6c9` | `2a441a97a345cfc7d3c944e758949d6c3b37ccfe88a75ddad06cf3ac83a637c6` |

The compiler contract is inklecate 1.2.1. The report records the resolved
executable's SHA-256 and whether it came from `INKLECATE_PATH`, Inkcheck's
managed cache, or `PATH`; it never emits the executable's local path.

## Run

Build and run the full matrix from a clean candidate checkout:

```sh
npm run --silent evaluate-checkpoint-v2 -- \
  benchmarks/checkpoint-v2-promotion-v1.json \
  --output benchmarks/results/checkpoint-v2-promotion-v1.json
```

The package script runs a fresh TypeScript build immediately before starting
the coordinator with `--max-old-space-size=6144`. This is the supported proof
entrypoint: it binds the otherwise ignored `dist` executable to the candidate
source immediately before the runner fingerprints and executes it. Invoking
the compiled JavaScript directly is not a qualifying proof procedure.

The report freezes the raw manifest hash, Git commit and tree, clean/dirty
count, package and lockfile hashes, compiled `dist` bundle hash,
Node/V8/platform/CPU/RAM facts, compiler fingerprint, selection, controls,
cases, progress, and verdict. With `--output`, the coordinator writes a private,
fsynced, atomically renamed `in_progress` snapshot after initialization, before
every cell, and after every cell. The pre-cell snapshot names the active cell;
the post-cell snapshot retains every recorded terminal case. A coordinator
crash or cancellation therefore leaves all completed evidence and the exact
unfinished boundary in the output file. In-progress snapshots are always
inconclusive with no allowed claims, including the narrow interval after the
sixth case is recorded but before the explicit `completed` snapshot. Omitting
`--output` emits only the final stdout report and does not provide this durable
interruption record. Progress on stderr contains only cell IDs and statuses.

`--case ID` may be repeated for a diagnostic rerun. A filtered run always has
`completeMatrix: false` and an `inconclusive` verdict; it cannot become
promotion evidence by itself.

Exit status 0 means every complete-matrix gate passed and the final snapshot is
`completed`. Status 1 means a
completed gate contradicted the contract. Status 2 means the matrix was
inconclusive, unavailable, filtered, or could not safely start. A timeout,
hard-killed worker, dirty candidate, missing 6 GiB coordinator flag, source or
compiler drift, or unexpected legacy-readback success is never converted into
a pass.

## Exactness and resource-limit rules

The framed base uses `exploreSharedResumableWithCheckpointSource` and writes
with `saveCheckpointArtifactFromSource`. Its receipt must say that zero full
checkpoint graphs were materialized, one identity traversal and one frame
traversal ran, and legacy whole-artifact serialization/compression did not run.
The legacy base deliberately omits `format`, proving that the public library
default remains legacy v1.

Successful split cells reopen their artifact and resume with the same
source-scoped engine API to the declared target. The evaluator computes the
SHA-256 and UTF-8 byte count of the exact `JSON.stringify` token stream without
building a report-sized string. It requires:

- matched legacy/framed base result digests;
- identical stable checkpoint IDs and logical checkpoint byte counts;
- identical loaded checkpoint digests where both formats can reopen;
- split/resumed target digests equal to the uninterrupted target digest; and
- exact state horizons with `maxStates` true and memory, time, frontier, beam,
  loop, and worker stops false. `maxDepth` may also be true.

The Intercept legacy cell passes its narrow boundary gate only when reopening
returns `CheckpointReadError` with kind `resource_limit`, stage
`decompression`, and unit `bytes`. The runner hashes the stored payload before
and after the failed read and compares the public listing before and after, but
does not publish the private payload hash. If legacy readback succeeds on a
different runtime, the observation is retained as `inconclusive`; it is not
silently redefined as a pass.

## Privacy and interpretation

The machine report contains numeric counts, booleans, stable IDs, public source
and candidate hashes, and canonical result/checkpoint digests. It excludes
absolute paths, story prose, choices, variables, witnesses, serialized runtime
state, private framed-component digests, and checkpoint payload hashes.
Checkpoint files stay inside their isolated temporary cell and are deleted
after that worker; do not publish or attach them.

A passing report permits claims only about exact resume in these declared
cells, the observed zero-materialized-graph framed write receipt, the typed
legacy boundary, and non-destructive failure. It forbids universal or portable
performance claims, coverage or defect-absence claims, allocation-policy
promotion, a default-format change, and any InkBench improvement claim. Timing
and peak RSS are single-machine observations retained for audit, not promises.
