# Shared checkpoint artifact v2

Artifact v2 is an opt-in, framed storage codec for the existing logical
`SharedSearchCheckpoint` schema v1. It changes neither the logical checkpoint,
the stable checkpoint-ID algorithm, deterministic frontier order, nor resume
semantics. The public CLI, MCP/search-session persistence, and
`saveCheckpointArtifact(...)` calls that omit `format` continue to write the
existing streamed-gzip `.json.gz` artifact.

Library callers can request the codec explicitly:

```ts
await saveCheckpointArtifact(projectRoot, entrypoint, checkpoint, {
  format: "framed-v2",
});
```

The resulting payload is `.inkcheck/checkpoints/checkpoint-<hash>.inkcp`, with
a schema-v2 canonical `.meta.json` sidecar. Readers dispatch from that verified
sidecar and continue to accept manifested and legacy sidecar-free schema-v1
`.json`/`.json.gz` artifacts. A stable ID may have exactly one verified public
layout. A request for either format reuses an already verified artifact with the
same ID; it never creates a second layout.

## Wire contract

The artifact begins with the fixed ASCII magic `INKCHECKCP2\r\n`. Every frame
then has an eight-byte big-endian prefix containing bounded header and stored
payload lengths, an exact-key canonical JSON header, and an independently
gzip-compressed payload. Data-frame payloads contain length-prefixed compact
JSON records. A terminal index binds every frame and component summary, and no
bytes may follow it.

The fixed component order is:

1. `configuration`
2. `scheduler`
3. `frontier`
4. `witnessAncestry`
5. `dedupe`
6. `semanticIndexes`
7. `findings`
8. `metadata`

Within a component, fields, record starts, and record indexes are strictly
ordered. The writer deterministically splits a field before its record-count,
decoded-byte, or compressed-byte bound would be exceeded. The reader validates
magic, prefix lengths, exact header fields, component/field order, record
lengths and indexes, frame and component summaries, the terminal index, and
exact EOF before accepting the reconstructed logical checkpoint.

Default codec ceilings are 64 KiB per header, 16 MiB stored and 32 MiB decoded
per frame, 8 MiB and 512 JSON nesting levels per record, 100,000 records per
frame, 65,536 frames, ten million records, and 512 MiB each for total stored and
decoded frame payloads. Runtime Buffer/string ceilings remain authoritative.
`framedV2Limits` may only narrow or deliberately replace those explicit library
bounds; the enclosing checkpoint and project durable-byte ceilings still apply
to the complete payload-plus-sidecar pair. Counts and byte sums use checked safe
integer arithmetic.

Each data frame, the terminal index, and each aggregate component summary bind
decoded and stored content with SHA-256. The canonical sidecar also binds the
complete stored payload digest and exact private component/index summaries.
These are integrity checks, not authentication: a writer that can replace the
checkpoint files can recompute them. The public list/show projection contains
only the fixed component names and bounded numeric counts/byte totals; it omits
the private digests and all checkpoint content.

## Bounded readback and accounting

The v2 reader holds one bounded frame's stored bytes, decoded bytes, and record
at a time and incrementally delivers records to the logical checkpoint
assembler. It does not materialize a whole stored-artifact Buffer, a whole
decompressed Buffer, or a whole raw artifact string. The reconstructed resume
graph is still retained, and bounded frame/runtime/parser workspace can overlap;
the codec is not a claim about total V8 heap.

At the low-level codec API, `onRecord` deliveries are provisional until
`readCheckpointArtifactV2` resolves after validating the terminal index and
exact EOF. A caller must not publish callback effects early. The high-level
checkpoint reader keeps assembly private and discards it on any later frame,
index, checksum, bound, cancellation, or EOF failure.

The existing additive checkpoint read/write receipts remain outside checkpoint
bytes and IDs. For v2, legacy monolithic serialization, gzip, stored-buffer,
decompressed-buffer, raw-string, and parsed-artifact owners are marked
`not_applied`; the optional `framedV2` section reports the codec's fixed numeric
component/frame/index totals. The canonical logical checkpoint traversal still
validates the unchanged stable ID after assembly. Typed corruption,
resource-limit, and unsupported failures retain the manifest and failure-stage
receipt reached by the enclosing checkpoint reader. A mid-stream failure
currently omits `framedV2`: aggregate component/frame totals are reported only
after the terminal index and exact EOF verify them, rather than exposing an
unverified partial aggregate.

At the low-level codec surface, cancellation is a
`CheckpointArtifactV2Error` with `kind: "cancelled"`; it can interrupt a
stalled source or record iterator during I/O as well as stop at framed
boundaries. High-level checkpoint save/open/load operations map that condition
to `AbortError`. Publication alone becomes non-cancellable after the neutral
no-clobber commit point, so a successful writer or later retry can finish one
durable payload/sidecar pair rather than expose an ambiguous partial result.

## Same-ID publication and recovery

All new v1 and v2 writers for one stable ID compete for the same hidden neutral
hard-link pathname. The winning inode's already durable recovery manifest
selects the only public extension that may be linked. A concurrent loser—or a
retry after a process exit—verifies and reuses that winner regardless of which
format it requested when it observes committed bytes before candidate work,
fails format preflight without emitting candidate bytes, or successfully
encodes a candidate but loses no-clobber publication. A private candidate that
has already emitted bytes and then fails retains its own error; a later retry
reuses the winner. Only after the public payload and canonical sidecar have been
reread and matched are the bounded recovery records and neutral link removed.

This extends the existing same-ID crash-recovery protocol; it is not a global
transaction journal. Hidden abrupt-process debris remains outside listed
artifact quotas, and cross-ID publication/retention retains the documented
limitations in [local resumable checkpoints](local-checkpoints.md).

## Deliberate scope

This is a codec foundation, not format promotion. It does not make framed v2 the
default, add an engine-native streaming checkpoint producer, change allocation,
compaction, eviction, stopping, or epoch policy, publish a release, or establish
an InkBench improvement claim. Promotion still requires exact split-versus-
uninterrupted resume evidence, the observed Intercept schema-v1 readback-limit
cell under identical ceilings, and a second public story family such as Heresy
II, together with the adversarial truncation, checksum, bounds, cancellation,
crash, and mixed-layout gates.

Checkpoint records can contain authored text, variables, serialized runtime
state, findings, and witness paths. Treat `.inkcp` files as sensitive project
data just like `.json` and `.json.gz` checkpoints.
