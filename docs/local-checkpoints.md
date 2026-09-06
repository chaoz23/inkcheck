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

The JSON list keeps its historical top-level `checkpointArtifactSchemaVersion: 1` as the list-response schema for compatibility; it is not the schema of every persisted payload. Each list item and the `show` artifact report `artifactSchemaVersion: 1 | 2` alongside `storageEncoding`, so callers can distinguish a legacy JSON/gzip envelope from an opt-in framed-v2 envelope.

The manifest self-checksum binds every field, including the stored-payload digest, so an isolated edit to creation time, grant, state count, or another field fails before it can affect listing or retention. This detects accidental/local metadata corruption; it is not authentication against someone with write access who deliberately rewrites both the manifest and its checksum. `open` and resume are the full-integrity boundary: they validate the manifest, hash the complete stored payload and compare its digest, then decompress, parse, verify the stable logical ID/configuration, and check source freshness. `show` reports:

- `current`: compiled story and knot/source map match the saved checkpoint.
- `stale`: source exists but no longer matches or compiles.
- `path_changed`: the project-relative entrypoint no longer exists.

Resume requires `current`, the supported artifact and checkpoint schema versions, and every engine binding to match: story and knot hashes, depth, both seeds, hidden turn/random sensitivity, randomness detection, frontier envelopes, and external bindings. Corrupt content, metadata mismatch, unsupported versions, and a non-increasing grant fail closed.

Library callers can distinguish three `CheckpointReadError.kind` values instead of parsing messages:

- `corrupt`: invalid gzip/JSON, checksum or stable-ID mismatch, or malformed metadata;
- `unsupported`: an artifact, manifest, or shared-checkpoint schema this Inkcheck cannot interpret;
- `resource_limit`: a stored/decompressed/frame/record byte bound, frame/record count bound, or JSON-depth bound is exceeded. This does not label the checkpoint corrupt and never deletes or replaces it.

Resource-limit errors add generic `observed`, `limit`, and `unit` (`bytes`, `count`, or `depth`) fields. The legacy `observedBytes` and `limitBytes` aliases remain populated only for byte limits; they are absent for frame/record counts and JSON depth.

The low-level `readCheckpointArtifactV2` / `writeCheckpointArtifactV2` codec API reports cancellation as `CheckpointArtifactV2Error` with `kind: "cancelled"` and can promptly interrupt a stalled source or record iterator mid-I/O. High-level `saveCheckpointArtifact`, `openCheckpointArtifact`, and `loadCheckpointForResume` normalize that condition to the ordinary `AbortError` contract. Only publication after the neutral no-clobber commit becomes non-cancellable so recovery can finish one unambiguous pair.

`listCheckpointArtifacts`, `openCheckpointArtifact`, and `loadCheckpointForResume` accept optional `maxStoredBytes` and `maxDecompressedBytes` read limits. Defaults cap stored input at 512 MiB and schema-v1 decompression at the smaller of 512 MiB and the runtime's maximum string length. Framed-v2 library reads also accept explicit per-header, frame, record, JSON-depth, count, total-stored, and total-decoded `framedV2Limits`. The enclosing `maxStoredBytes` bound remains authoritative for either layout. `maxDecompressedBytes` is the legacy schema-v1 whole-value/string ceiling; framed v2 instead applies its own `maxTotalDecodedBytes` cumulative ceiling plus per-frame, per-record, JSON-depth, and runtime Buffer/string bounds. Listing uses those limits only for a sidecar-free compatibility fallback.

Successful `openCheckpointArtifact` and `loadCheckpointForResume` calls also return an additive `CheckpointReadAccountingV1` receipt. Typed failures attach the partial receipt reached before failure as `CheckpointReadError.accounting`; constructing it does not retry the failed operation. The receipt records effective configured limits (which are bounds, not allocated capacity), the existing manifest buffer/string/parsed source graph and canonical checksum-validation string when present, the one stored payload buffer, the gzip output buffer or a legacy-JSON `not_applied` marker, the one raw artifact string, the parsed artifact source graph, and the exact logical checkpoint bytes, largest source chunk, and two configuration-comparison strings from the existing stable-ID/envelope validation. Framed reads add `configuredLimits.framedV2` with the actual effective header, frame, record, depth, count, total-stored, and total-decoded codec bounds; the outer legacy `maxDecompressedBytes` field remains visible for receipt compatibility but is not presented as the framed cumulative decoded bound. Plain legacy JSON and gzip therefore retain their existing configured-limit shape and have distinct truthful owner shapes without changing their accepted bytes.

`conservativePotential.totalBytes` sums the reported logical owners that were reached plus the largest validation chunk. It is deliberately not an observed simultaneous peak, V8 heap measurement, or claim about unreported runtime/library internals such as fixed race probes, hashing state, gzip/JSON-parser workspace, or source-freshness compilation. The parsed artifact already owns its nested checkpoint; `currentReturnedGraph` transfers that same graph rather than charging it twice. It is zero after metadata-only `openCheckpointArtifact` and one with the exact logical checkpoint bytes after a successful `loadCheckpointForResume`. For framed v2 the monolithic stored/decompressed/raw-string/parsed-artifact owners are `not_applied`; after a successful terminal-index/EOF validation, an additive `framedV2` section reports the fixed privacy-safe component/frame/index totals while the assembled returned graph remains explicit. A typed mid-stream v2 failure retains manifest and failure-stage accounting but currently omits `framedV2`, because the codec has not returned verified aggregate component totals; it does not present partial frames as a completed receipt. A stale or path-changed resume retains its existing plain source-binding error after the artifact read completed, so it is outside the typed read-failure receipt contract; callers that need accounting alongside stale/path-changed metadata can use `openCheckpointArtifact` first.

## Atomicity and retention

Default checkpoints live under `.inkcheck/checkpoints/checkpoint-<hash>.json.gz`, with the bounded metadata sidecar beside them. Library callers may explicitly request the opt-in framed-v2 codec, which writes `checkpoint-<hash>.inkcp` plus a schema-v2 sidecar. Their shared stable ID derives from the exact logical checkpoint content plus the project-relative entrypoint, not from compression, framing, or manifest bytes, so repeating the same deterministic boundary reuses one verified artifact in either layout. The writer never creates both layouts for one ID. Existing schema-v1 `.json` and `.json.gz` artifacts remain readable and resumable.

The default writer emits compact JSON through gzip directly into a private same-directory temporary file while computing the stored-byte digest in the same pass. It never constructs a second artifact-sized JSON string in memory, and it checks the final payload-plus-sidecar bytes before publication. Its reader bounds stored input and gzip output before parsing and does not create a second decompressed string. That schema-v1 storage layout is nevertheless memory-heavy: the compressed buffer, decompressed buffer, one JSON string, and parsed frontier graph can overlap until garbage collection.

The opt-in v2 writer instead emits ordered bounded records into independently compressed frames and a terminal index. Its reader incrementally validates and assembles those records without a whole artifact Buffer, whole decompressed Buffer, or whole raw JSON string. Resume structurally clones the validated flat graph without round-tripping it through another whole JSON string. It still retains the reconstructed logical resume graph, and that ownership clone plus one frame's stored/decoded/record data and runtime/parser workspace can overlap. Both layouts pass the same logical checkpoint schema, stable-ID, source, configuration, and freshness checks. See [shared checkpoint artifact v2](shared-checkpoint-artifact-v2.md) for the wire contract and deliberate limits.

Library callers that own the live shared-search engine can also avoid constructing and recursively cloning the complete logical checkpoint before a framed write:

```ts
const run = await exploreSharedResumableWithCheckpointSource(
  storyJson,
  knots,
  externals,
  options,
  (source) => saveCheckpointArtifactFromSource(projectRoot, entrypoint, source),
  priorCheckpoint,
);
```

This is an opt-in framed-v2 producer. The search engine is paused at the exact resumable boundary while the asynchronous callback runs. Its callback-scoped source is repeatable and read-only; each record yielded to the consumer is detached, and the source and any outstanding iterator become invalid as soon as the callback settles. The writer makes one streaming pass over the canonical logical schema-v1 bytes for the unchanged stable ID and, when it must encode a new candidate, one ordered framed-record pass. It never calls the complete-checkpoint materializer, builds the full checkpoint graph, or constructs a monolithic JSON string. Same-ID framed reuse validates and rehashes the canonical pair, then bounded-stream-decodes every record and compares its canonical value and position directly with the paused live source. This prevents a deliberately recomputed manifest/payload checksum pair from standing in for logical stable-ID validation without constructing the graph. Legacy same-ID reuse, whether manifested or sidecar-free, remains available through the graph API but is explicitly unsupported through the engine-native route. Source-native retention likewise requires manifests for every existing artifact and fails before publication when it encounters a sidecar-free legacy artifact, rather than inflating it behind a zero-graph receipt or omitting it from quota accounting. The existing synchronous resumable API, graph-based save API, and default legacy-v1 CLI/MCP writes are unchanged.

`saveCheckpointArtifact` returns an additive schema-v1 `accounting` receipt outside the checkpoint object and stable ID. It reports the logical checkpoint graph's canonical UTF-8 bytes and largest source chunk from the existing ID traversal; whether legacy artifact serialization/compression was applied; and the durable payload, manifest, and pair bytes. Configured compression capacity is explicitly not observed heap. A framed write marks those legacy monolithic stages `not_applied` and adds fixed component/frame/index totals under `framedV2`. A source-native write additionally reports `checkpointGraph.count: 0` and an `engineSource` receipt with zero materialized checkpoint graphs, one identity pass, `framePasses` for candidate encoding, and `reuseVerificationPasses` for the bounded live-source comparison. Each latter counter is zero or one: a created candidate reports `1/0`, an observed-before-work reuse reports `0/1`, and a no-clobber loser that encoded before verifying its winner reports `1/1`. A same-ID framed reuse reports serialization/compression encode work as `not_applied`, while a concurrent loser truthfully reports its applied candidate work with outcome `reused`. Receipt construction itself does not add another pass beyond the integrity work required by that operation.

Cross-format requests reuse committed same-ID bytes when they observe them before candidate work, when format preflight fails without emitting candidate bytes, or after a candidate encoded successfully but loses no-clobber publication. If a private candidate emits bytes and then fails, that request preserves its own error instead of returning an untruthful reuse receipt; a later retry can reuse the durable winner.

Neither lifecycle receipt can be embedded in the checkpoint bytes it measures without becoming self-referential. The write receipt is post-write evidence, while the read receipt is returned only by the library reopen APIs or a typed read error. They do not change the stable ID, payload, manifest, retention order, source-freshness behavior, or search policy. The read receipt is derived from the existing validation path and does not add a graph serialization. Framed v2 removes the schema-v1 whole-value materializations from that path; it does not claim that the final resume graph or all runtime workspace are absent.

Before exposing payload bytes, Inkcheck reserves one of 32 fixed, hidden recovery-manifest slots for that stable ID, writes the canonical at-most-64-KiB manifest there, flushes it, and directory-syncs the slot. New v1 and v2 writers then compete for the same deterministic neutral hard-link pathname, independent of public extension. The winning inode's recovery manifest selects the sole `.json.gz` or `.inkcp` destination; observed-before-work, preflight-without-output, and successfully encoded no-clobber losers reopen those winning bytes instead of overwriting or creating a second layout. A partial private write failure still surfaces its own error. The writer hashes the visible payload with a fixed-size buffer, selects only a recovery record whose size, digest, ID, requested checkpoint summary, storage encoding, and optional component summary match, and promotes that record to the canonical sidecar. Recovery therefore does not need to inflate or parse an artifact that exceeds the schema-v1 readback ceiling.

The canonical sidecar is never pre-quarantined. A matching recovery record replaces an older orphan/corrupt sidecar only after this writer sees the published payload; POSIX uses atomic rename-over-existing, while the portable fallback retains bounded promotion and displaced companions so a crash in the replace gap can restore or complete the pair. Each slot has a nonce-bearing owner claim. Reservation and cleanup must first acquire the same fixed per-slot cleaning claim, which is removed last; a delayed cleaner therefore cannot delete a pathname after another writer has reused the slot. A transaction that returns before cleanup durably records that exact nonce as released, allowing a same-process or cross-process retry to reclaim it without confusing another live transaction for debris. Recovery records remain hidden from listing and retention. They are deleted only after the canonical manifest has been reread and matched against a second fixed-memory hash of the same visible payload; a crash before payload publication leaves ignored recovery-only metadata, and a crash after publication leaves enough metadata to finish without decoding. Sidecar reconstruction for legacy schema-v1 JSON also uses this fixed transaction namespace. The claim, release marker, cleaning claim, payload temporary, manifest, promotion, and displaced filenames are fixed and bounded per stable ID. A process that dies while holding a cleaning claim consumes that one slot until an operator removes it while no checkpoint save is active; it cannot expose or overwrite checkpoint evidence.

This publication guarantee serializes writers and both storage layouts for the same stable ID. Retention still validates the complete project set again after the pair is durable, but it is not a global transaction or recovery journal across simultaneous writers of different checkpoint IDs. Hidden files left by an abruptly terminated process are transaction debris, not listed checkpoint artifacts: they are excluded from retention and the project artifact byte ceiling, and the next successful save of that same stable ID cleans dead-owner slots. Repeated crashes across many distinct IDs can therefore leave additional hidden disk use; when no checkpoint save is active, an operator may remove those hidden recovery-slot files. Project-wide crash-debris accounting/recovery remains follow-up work. Only after the new pair is durable does retention remove older payloads and their sidecars. Defaults are hard safety ceilings for final checkpoint artifacts:

- 512 MiB for one checkpoint;
- 1 GiB across checkpoint artifacts in one project;
- three generations per entrypoint.

An individually oversized payload-plus-sidecar pair is rejected. Once a new generation is durable, oldest generations for that entrypoint are removed first, then the oldest project checkpoints if needed to satisfy the project byte ceiling. The saved generation is protected from that cleanup. `checkpoints list/show` reports `payloadSizeBytes`, `metadataSizeBytes`, and their sum as the actual durable `sizeBytes`; this is storage cost, not an estimate of process heap or future search value.

## Schema-v1 readback boundary and v2 promotion gate

This is the safe foundation for the observed 600,000-state boundary, not a claim that every such checkpoint can now resume. A gzip payload can be within the durable disk quota while its single logical JSON value is larger than V8 can represent. Inkcheck now returns `resource_limit` at that boundary, keeps the known-good bytes intact, and can still list/prune a manifested artifact without inflation. It does not misreport the file as corrupt or retry an unsafe allocation. A repeated same-ID save may recognize such an artifact only after its canonical manifest matches the requested checkpoint summary and its full stored-byte digest verifies; that preserves known bytes but does not claim the logical payload was decoded or resumable.

The opt-in framed artifact v2 foundation supplies independently bounded records/frames, checksums, a terminal index, incremental assembly, mixed-layout compatibility, and stable schema-v1 IDs. The checked [checkpoint-v2 promotion evaluation](checkpoint-v2-promotion-evaluation.md) now records exact split-versus-uninterrupted equality on Heresy II and on the 600,000→650,000-state Intercept boundary, while the matched legacy Intercept artifact returns its typed decompression limit and remains unchanged. Both engine-native framed writes report zero materialized checkpoint graphs. That single-machine functional evidence does not establish a portable memory or performance improvement and does not make framed v2 the default. No allocation, compaction, eviction, epoch, or stopping policy is activated by selecting the storage codec.

## Privacy

Checkpoint artifacts are executable search state. They can contain authored choice and ending text, variable values, serialized Ink runtime state, findings, and exact witness paths. They are never uploaded by this workflow, but anyone who can read the file may recover story material.

`inkcheck agent-kit` ignores `.inkcheck/checkpoints/` by default. Keep that rule, do not attach checkpoint files to public issues, and delete them when the continuation is no longer needed. Completed report artifacts have a separate contract in [local report artifacts](local-artifacts.md).
