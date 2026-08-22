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

These commands return metadata, not the frontier payload. New saves also write a private, at-most-64-KiB `checkpoint-<hash>.meta.json` sidecar. `list` and retention read only that canonical self-checksummed manifest plus the payload's file size; they never open, hash, inflate, or JSON-parse a manifested frontier. Earlier schema-v1 `.json` and `.json.gz` artifacts without a sidecar still work, using the bounded full reader as a compatibility fallback.

The manifest self-checksum binds every field, including the stored-payload digest, so an isolated edit to creation time, grant, state count, or another field fails before it can affect listing or retention. This detects accidental/local metadata corruption; it is not authentication against someone with write access who deliberately rewrites both the manifest and its checksum. `open` and resume are the full-integrity boundary: they validate the manifest, hash the complete stored payload and compare its digest, then decompress, parse, verify the stable logical ID/configuration, and check source freshness. `show` reports:

- `current`: compiled story and knot/source map match the saved checkpoint.
- `stale`: source exists but no longer matches or compiles.
- `path_changed`: the project-relative entrypoint no longer exists.

Resume requires `current`, the supported artifact and checkpoint schema versions, and every engine binding to match: story and knot hashes, depth, both seeds, hidden turn/random sensitivity, randomness detection, frontier envelopes, and external bindings. Corrupt content, metadata mismatch, unsupported versions, and a non-increasing grant fail closed.

Library callers can distinguish three `CheckpointReadError.kind` values instead of parsing messages:

- `corrupt`: invalid gzip/JSON, checksum or stable-ID mismatch, or malformed metadata;
- `unsupported`: an artifact, manifest, or shared-checkpoint schema this Inkcheck cannot interpret;
- `resource_limit`: stored or decompressed bytes exceed the bounded readback envelope. This does not label the checkpoint corrupt and never deletes or replaces it.

`listCheckpointArtifacts`, `openCheckpointArtifact`, and `loadCheckpointForResume` accept optional `maxStoredBytes` and `maxDecompressedBytes` read limits. Defaults cap stored input at 512 MiB and schema-v1 decompression at the smaller of 512 MiB and the runtime's maximum string length. Listing uses those limits only for a sidecar-free compatibility fallback.

## Atomicity and retention

New checkpoints live under `.inkcheck/checkpoints/checkpoint-<hash>.json.gz`, with the bounded metadata sidecar beside them. Their stable ID derives from the exact logical checkpoint content plus the project-relative entrypoint, not from compression or manifest bytes, so repeating the same deterministic boundary reuses one artifact. Existing schema-v1 `.json` artifacts remain readable and resumable.

The writer emits compact JSON through gzip directly into a private same-directory temporary file while computing the stored-byte digest in the same pass. It never constructs a second artifact-sized JSON string in memory, and it checks the final payload-plus-sidecar bytes before publication. The reader bounds stored input and gzip output before parsing and does not create a second decompressed string. Schema v1 is nevertheless still memory-heavy: the compressed buffer, decompressed buffer, one JSON string, and parsed frontier graph can overlap until garbage collection. A malformed gzip stream fails closed as storage corruption; a valid stream still passes the normal schema, stable-ID, source, and configuration checks after decompression.

Before exposing payload bytes, Inkcheck reserves one of 32 fixed, hidden recovery-manifest slots for that stable ID, writes the canonical at-most-64-KiB manifest there, flushes it, and directory-syncs the slot. A same-directory hard-link create is then the exclusive, no-clobber same-ID payload commit point on supported local filesystems, including ordinary NTFS/APFS/ext filesystems: concurrent losers reopen the winning bytes instead of overwriting them. The writer hashes the visible payload with a fixed-size buffer, selects only a recovery record whose size, digest, ID, and requested checkpoint summary match, and promotes that record to the canonical sidecar. Recovery therefore does not need to inflate or parse an artifact that exceeds the schema-v1 readback ceiling.

The canonical sidecar is never pre-quarantined. A matching recovery record replaces an older orphan/corrupt sidecar only after this writer sees the published payload; POSIX uses atomic rename-over-existing, while the portable fallback retains bounded promotion and displaced companions so a crash in the replace gap can restore or complete the pair. Each slot has a nonce-bearing owner claim. Reservation and cleanup must first acquire the same fixed per-slot cleaning claim, which is removed last; a delayed cleaner therefore cannot delete a pathname after another writer has reused the slot. A transaction that returns before cleanup durably records that exact nonce as released, allowing a same-process or cross-process retry to reclaim it without confusing another live transaction for debris. Recovery records remain hidden from listing and retention. They are deleted only after the canonical manifest has been reread and matched against a second fixed-memory hash of the same visible payload; a crash before payload publication leaves ignored recovery-only metadata, and a crash after publication leaves enough metadata to finish without decoding. Sidecar reconstruction for legacy schema-v1 JSON also uses this fixed transaction namespace. The claim, release marker, cleaning claim, payload temporary, manifest, promotion, and displaced filenames are fixed and bounded per stable ID. A process that dies while holding a cleaning claim consumes that one slot until an operator removes it while no checkpoint save is active; it cannot expose or overwrite checkpoint evidence.

This publication guarantee serializes writers for the same stable ID. Retention still validates the complete project set again after the pair is durable, but it is not a global transaction or recovery journal across simultaneous writers of different checkpoint IDs. Hidden files left by an abruptly terminated process are transaction debris, not listed checkpoint artifacts: they are excluded from retention and the project artifact byte ceiling, and the next successful save of that same stable ID cleans dead-owner slots. Repeated crashes across many distinct IDs can therefore leave additional hidden disk use; when no checkpoint save is active, an operator may remove those hidden recovery-slot files. Project-wide crash-debris accounting/recovery belongs with the framed checkpoint-v2 journal rather than this same-ID schema-v1 precursor. Only after the new pair is durable does retention remove older payloads and their sidecars. Defaults are hard safety ceilings for final checkpoint artifacts:

- 512 MiB for one checkpoint;
- 1 GiB across checkpoint artifacts in one project;
- three generations per entrypoint.

An individually oversized payload-plus-sidecar pair is rejected. Once a new generation is durable, oldest generations for that entrypoint are removed first, then the oldest project checkpoints if needed to satisfy the project byte ceiling. The saved generation is protected from that cleanup. `checkpoints list/show` reports `payloadSizeBytes`, `metadataSizeBytes`, and their sum as the actual durable `sizeBytes`; this is storage cost, not an estimate of process heap or future search value.

## Schema-v1 readback boundary

This is the safe foundation for the observed 600,000-state boundary, not a claim that every such checkpoint can now resume. A gzip payload can be within the durable disk quota while its single logical JSON value is larger than V8 can represent. Inkcheck now returns `resource_limit` at that boundary, keeps the known-good bytes intact, and can still list/prune a manifested artifact without inflation. It does not misreport the file as corrupt or retry an unsafe allocation. A repeated same-ID save may recognize such an artifact only after its canonical manifest matches the requested checkpoint summary and its full stored-byte digest verifies; that preserves known bytes but does not claim the logical payload was decoded or resumable.

Removing that format ceiling requires a framed artifact schema v2: independently bounded metadata and frontier frames, per-frame lengths/checksums, incremental decode into the resume structures, and a compatibility reader that leaves schema-v1 IDs and exact trajectories unchanged. Promotion should require split-run equality against uninterrupted search plus truncated-frame, oversized-frame, checksum, and mixed-v1/v2 retention tests.

## Privacy

Checkpoint artifacts are executable search state. They can contain authored choice and ending text, variable values, serialized Ink runtime state, findings, and exact witness paths. They are never uploaded by this workflow, but anyone who can read the file may recover story material.

`inkcheck agent-kit` ignores `.inkcheck/checkpoints/` by default. Keep that rule, do not attach checkpoint files to public issues, and delete them when the continuation is no longer needed. Completed report artifacts have a separate contract in [local report artifacts](local-artifacts.md).
