const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gunzipSync, gzipSync } = require("node:zlib");

const { compile, scanKnots } = require("../dist/inklecate");
const { exploreSharedResumable } = require("../dist/explore");
const {
  CheckpointReadError,
  loadCheckpointForResume,
  openCheckpointArtifact,
  saveCheckpointArtifact,
} = require("../dist/checkpoints");

const FIXTURE = path.join(__dirname, "fixtures", "search", "low-dedup-wide.ink");

async function savedCheckpoint() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-checkpoint-read-accounting-"));
  const entrypoint = path.join(projectRoot, "story.ink");
  fs.copyFileSync(FIXTURE, entrypoint);
  const compiled = await compile(entrypoint);
  assert.strictEqual(compiled.success, true);
  const checkpoint = exploreSharedResumable(compiled.storyJson, scanKnots(entrypoint), [], {
    maxDepth: 150,
    maxStates: 10,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  }).checkpoint;
  assert.ok(checkpoint);
  const reference = await saveCheckpointArtifact(projectRoot, entrypoint, checkpoint);
  const payloadFile = path.join(projectRoot, ...reference.path.split("/"));
  const manifestFile = payloadFile.replace(/\.json(?:\.gz)?$/, ".meta.json");
  return { projectRoot, entrypoint, checkpoint, reference, payloadFile, manifestFile };
}

function potentialTotal(accounting) {
  return accounting.manifest.storedBuffer.bytes
    + accounting.manifest.rawString.logicalUtf8Bytes
    + accounting.manifest.parsedGraph.sourceLogicalUtf8Bytes
    + accounting.manifest.validationString.logicalUtf8Bytes
    + accounting.storedPayload.bytes
    + accounting.decompressedPayload.bytes
    + accounting.rawArtifactString.logicalUtf8Bytes
    + accounting.parsedArtifactGraph.sourceLogicalUtf8Bytes
    + accounting.validationTraversal.peakSourceChunkUtf8Bytes
    + accounting.validationTraversal.configurationStrings.logicalUtf8Bytes;
}

async function countPayloadOpensAndParses(payloadFile, rawArtifact, operation) {
  const originalOpenSync = fs.openSync;
  const originalParse = JSON.parse;
  let payloadOpens = 0;
  let artifactParses = 0;
  fs.openSync = (candidate, ...args) => {
    if (path.resolve(String(candidate)) === path.resolve(payloadFile)) payloadOpens += 1;
    return originalOpenSync(candidate, ...args);
  };
  JSON.parse = (raw, ...args) => {
    if (raw === rawArtifact) artifactParses += 1;
    return originalParse(raw, ...args);
  };
  try {
    return { result: await operation(), payloadOpens, artifactParses };
  } finally {
    fs.openSync = originalOpenSync;
    JSON.parse = originalParse;
  }
}

test("gzip checkpoint reopen accounts existing owners without an extra payload read or parse", async () => {
  const fixture = await savedCheckpoint();
  try {
    const compressed = fs.readFileSync(fixture.payloadFile);
    const rawArtifact = gunzipSync(compressed).toString("utf8");
    const manifestBytes = fs.statSync(fixture.manifestFile).size;
    const checkpointBytes = Buffer.byteLength(JSON.stringify(fixture.checkpoint), "utf8");
    const expectedId = `checkpoint-${crypto.createHash("sha256")
      .update("story.ink").update("\0").update(JSON.stringify(fixture.checkpoint))
      .digest("hex").slice(0, 24)}`;
    assert.strictEqual(fixture.reference.id, expectedId);

    const openedProbe = await countPayloadOpensAndParses(
      fixture.payloadFile,
      rawArtifact,
      () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id)
    );
    assert.strictEqual(openedProbe.payloadOpens, 1, "open reads and hashes the payload from one existing buffer");
    assert.strictEqual(openedProbe.artifactParses, 1, "open parses the artifact once");
    const opened = openedProbe.result;
    const accounting = opened.accounting;
    assert.strictEqual(accounting.schemaVersion, 1);
    assert.strictEqual(accounting.status, "completed");
    assert.strictEqual(accounting.storageEncoding, "gzip");
    assert.strictEqual(accounting.configuredLimits.basis, "configured_limits_not_allocated_capacity");
    assert.ok(accounting.configuredLimits.maxManifestBytes >= manifestBytes);
    assert.deepStrictEqual(accounting.manifest.storedBuffer, { count: 1, bytes: manifestBytes });
    assert.deepStrictEqual(accounting.manifest.rawString, {
      count: 1,
      logicalUtf8Bytes: manifestBytes,
    });
    assert.deepStrictEqual(accounting.manifest.parsedGraph, {
      count: 1,
      sourceLogicalUtf8Bytes: manifestBytes,
    });
    assert.strictEqual(accounting.manifest.validationString.count, 1);
    assert.ok(accounting.manifest.validationString.logicalUtf8Bytes > 0);
    assert.deepStrictEqual(accounting.storedPayload, {
      status: "applied",
      count: 1,
      bytes: compressed.length,
    });
    assert.deepStrictEqual(accounting.decompressedPayload, {
      status: "applied",
      count: 1,
      bytes: Buffer.byteLength(rawArtifact, "utf8"),
    });
    assert.deepStrictEqual(accounting.rawArtifactString, {
      status: "applied",
      count: 1,
      logicalUtf8Bytes: Buffer.byteLength(rawArtifact, "utf8"),
    });
    assert.deepStrictEqual(accounting.parsedArtifactGraph, {
      status: "applied",
      count: 1,
      sourceLogicalUtf8Bytes: Buffer.byteLength(rawArtifact, "utf8"),
    });
    assert.strictEqual(accounting.validationTraversal.status, "applied");
    assert.strictEqual(accounting.validationTraversal.count, 1);
    assert.strictEqual(accounting.validationTraversal.logicalCheckpointUtf8BytesVisited, checkpointBytes);
    assert.ok(accounting.validationTraversal.peakSourceChunkUtf8Bytes > 0);
    assert.ok(accounting.validationTraversal.peakSourceChunkUtf8Bytes <= checkpointBytes);
    assert.strictEqual(accounting.validationTraversal.configurationStrings.count, 2);
    assert.ok(accounting.validationTraversal.configurationStrings.logicalUtf8Bytes > 0);
    assert.ok(
      accounting.validationTraversal.configurationStrings.peakStringUtf8Bytes
        <= accounting.validationTraversal.configurationStrings.logicalUtf8Bytes
    );
    assert.strictEqual(accounting.conservativePotential.totalBytes, potentialTotal(accounting));
    assert.deepStrictEqual(accounting.currentReturnedGraph, {
      status: "not_applied",
      count: 0,
      logicalUtf8Bytes: 0,
    });

    const resumedProbe = await countPayloadOpensAndParses(
      fixture.payloadFile,
      rawArtifact,
      () => loadCheckpointForResume(fixture.projectRoot, fixture.reference.id)
    );
    assert.strictEqual(resumedProbe.payloadOpens, 1);
    assert.strictEqual(resumedProbe.artifactParses, 1);
    assert.deepStrictEqual(resumedProbe.result.checkpoint, fixture.checkpoint);
    assert.deepStrictEqual(resumedProbe.result.accounting.currentReturnedGraph, {
      status: "applied",
      count: 1,
      logicalUtf8Bytes: checkpointBytes,
    });
    assert.strictEqual(
      resumedProbe.result.accounting.conservativePotential.totalBytes,
      accounting.conservativePotential.totalBytes,
      "transferring the already-parsed checkpoint graph does not count a second owner"
    );
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("sidecar-free legacy JSON uses the stored buffer directly and preserves stable identity", async () => {
  const fixture = await savedCheckpoint();
  try {
    const rawArtifact = gunzipSync(fs.readFileSync(fixture.payloadFile)).toString("utf8");
    const legacyFile = fixture.payloadFile.slice(0, -3);
    fs.writeFileSync(legacyFile, rawArtifact, { mode: 0o600 });
    fs.rmSync(fixture.payloadFile);
    fs.rmSync(fixture.manifestFile);

    const probe = await countPayloadOpensAndParses(
      legacyFile,
      rawArtifact,
      () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id)
    );
    assert.strictEqual(probe.payloadOpens, 1);
    assert.strictEqual(probe.artifactParses, 1);
    assert.strictEqual(probe.result.artifact.id, fixture.reference.id);
    assert.strictEqual(probe.result.artifact.storageEncoding, "json");
    const accounting = probe.result.accounting;
    assert.strictEqual(accounting.storageEncoding, "json");
    assert.strictEqual(accounting.manifest.status, "not_present");
    assert.deepStrictEqual(accounting.manifest.storedBuffer, { count: 0, bytes: 0 });
    assert.deepStrictEqual(accounting.manifest.validationString, { count: 0, logicalUtf8Bytes: 0 });
    assert.deepStrictEqual(accounting.storedPayload, {
      status: "applied",
      count: 1,
      bytes: Buffer.byteLength(rawArtifact, "utf8"),
    });
    assert.deepStrictEqual(accounting.decompressedPayload, {
      status: "not_applied",
      count: 0,
      bytes: 0,
    });
    assert.strictEqual(
      accounting.validationTraversal.logicalCheckpointUtf8BytesVisited,
      fixture.reference.accounting.checkpointGraph.logicalUtf8Bytes,
      "read validation reuses the same canonical checkpoint traversal as the stable write identity"
    );
    assert.strictEqual(accounting.conservativePotential.totalBytes, potentialTotal(accounting));
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("stored and decompressed read limits attach truthful partial receipts", async () => {
  const fixture = await savedCheckpoint();
  try {
    await assert.rejects(
      () => loadCheckpointForResume(fixture.projectRoot, fixture.reference.id, { maxStoredBytes: 1 }),
      (error) => {
        assert.ok(error instanceof CheckpointReadError);
        assert.strictEqual(error.kind, "resource_limit");
        assert.strictEqual(error.stage, "storage");
        assert.strictEqual(error.accounting.status, "failed");
        assert.deepStrictEqual(error.accounting.failure, { kind: "resource_limit", stage: "storage" });
        assert.strictEqual(error.accounting.configuredLimits.maxStoredBytes, 1);
        assert.strictEqual(error.accounting.manifest.status, "applied");
        assert.deepStrictEqual(error.accounting.storedPayload, {
          status: "not_completed",
          count: 0,
          bytes: 0,
        });
        assert.strictEqual(error.accounting.conservativePotential.totalBytes, potentialTotal(error.accounting));
        return true;
      }
    );

    await assert.rejects(
      () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id, { maxDecompressedBytes: 1 }),
      (error) => {
        assert.ok(error instanceof CheckpointReadError);
        assert.strictEqual(error.kind, "resource_limit");
        assert.strictEqual(error.stage, "decompression");
        assert.strictEqual(error.payloadVerified, true);
        assert.strictEqual(error.accounting.configuredLimits.maxDecompressedBytes, 1);
        assert.strictEqual(error.accounting.storedPayload.status, "applied");
        assert.deepStrictEqual(error.accounting.decompressedPayload, {
          status: "not_completed",
          count: 0,
          bytes: 0,
        });
        assert.strictEqual(error.accounting.rawArtifactString.status, "not_completed");
        assert.strictEqual(error.accounting.conservativePotential.totalBytes, potentialTotal(error.accounting));
        return true;
      }
    );
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("corrupt and unsupported artifacts retain the owners reached before failure", async () => {
  const fixture = await savedCheckpoint();
  try {
    const original = gunzipSync(fs.readFileSync(fixture.payloadFile)).toString("utf8");
    fs.rmSync(fixture.manifestFile);

    fs.writeFileSync(fixture.payloadFile, gzipSync("{"));
    await assert.rejects(
      () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id),
      (error) => {
        assert.ok(error instanceof CheckpointReadError);
        assert.deepStrictEqual(error.accounting.failure, { kind: "corrupt", stage: "json" });
        assert.strictEqual(error.accounting.storedPayload.status, "applied");
        assert.strictEqual(error.accounting.decompressedPayload.status, "applied");
        assert.strictEqual(error.accounting.rawArtifactString.status, "applied");
        assert.strictEqual(error.accounting.parsedArtifactGraph.status, "not_completed");
        assert.strictEqual(error.accounting.validationTraversal.status, "not_completed");
        assert.strictEqual(error.accounting.conservativePotential.totalBytes, potentialTotal(error.accounting));
        return true;
      }
    );

    const unsupported = JSON.parse(original);
    unsupported.artifactSchemaVersion = 999;
    fs.writeFileSync(fixture.payloadFile, gzipSync(JSON.stringify(unsupported)));
    await assert.rejects(
      () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id),
      (error) => {
        assert.ok(error instanceof CheckpointReadError);
        assert.deepStrictEqual(error.accounting.failure, { kind: "unsupported", stage: "envelope" });
        assert.strictEqual(error.accounting.parsedArtifactGraph.status, "applied");
        assert.strictEqual(error.accounting.validationTraversal.status, "not_completed");
        assert.strictEqual(error.accounting.currentReturnedGraph.status, "not_applied");
        return true;
      }
    );

    const wrongIdentity = JSON.parse(original);
    wrongIdentity.checkpoint.state.totalGranted += 1;
    fs.writeFileSync(fixture.payloadFile, gzipSync(JSON.stringify(wrongIdentity)));
    await assert.rejects(
      () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id),
      (error) => {
        assert.ok(error instanceof CheckpointReadError);
        assert.deepStrictEqual(error.accounting.failure, { kind: "corrupt", stage: "envelope" });
        assert.strictEqual(error.accounting.validationTraversal.status, "applied");
        assert.ok(error.accounting.validationTraversal.logicalCheckpointUtf8BytesVisited > 0);
        assert.strictEqual(error.accounting.currentReturnedGraph.count, 0);
        return true;
      }
    );
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("a manifest appearing after the initial check is included by final validation accounting", async () => {
  const fixture = await savedCheckpoint();
  try {
    const originalExistsSync = fs.existsSync;
    const originalOpenSync = fs.openSync;
    let manifestExistenceChecks = 0;
    let manifestOpens = 0;
    let payloadOpens = 0;
    fs.existsSync = (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(fixture.manifestFile)) {
        manifestExistenceChecks += 1;
        if (manifestExistenceChecks === 1) return false;
      }
      return originalExistsSync(candidate);
    };
    fs.openSync = (candidate, ...args) => {
      const resolved = path.resolve(String(candidate));
      if (resolved === path.resolve(fixture.manifestFile)) manifestOpens += 1;
      if (resolved === path.resolve(fixture.payloadFile)) payloadOpens += 1;
      return originalOpenSync(candidate, ...args);
    };
    let opened;
    try {
      opened = await openCheckpointArtifact(fixture.projectRoot, fixture.reference.id);
    } finally {
      fs.existsSync = originalExistsSync;
      fs.openSync = originalOpenSync;
    }
    assert.ok(manifestExistenceChecks >= 2);
    assert.strictEqual(manifestOpens, 1);
    assert.strictEqual(payloadOpens, 1);
    assert.strictEqual(opened.accounting.manifest.status, "applied");
    assert.strictEqual(opened.accounting.manifest.storedBuffer.count, 1);
    assert.strictEqual(opened.accounting.manifest.rawString.count, 1);
    assert.strictEqual(opened.accounting.manifest.parsedGraph.count, 1);
    assert.strictEqual(opened.accounting.manifest.validationString.count, 1);
    assert.strictEqual(opened.accounting.conservativePotential.totalBytes, potentialTotal(opened.accounting));
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("manifest failures attach a receipt before the payload is opened", async () => {
  const fixture = await savedCheckpoint();
  try {
    const originalManifest = JSON.parse(fs.readFileSync(fixture.manifestFile, "utf8"));
    const unsupportedManifest = { ...originalManifest, manifestSchemaVersion: 999 };
    fs.writeFileSync(fixture.manifestFile, JSON.stringify(unsupportedManifest));
    const originalOpenSync = fs.openSync;
    let payloadOpens = 0;
    fs.openSync = (candidate, ...args) => {
      if (path.resolve(String(candidate)) === path.resolve(fixture.payloadFile)) payloadOpens += 1;
      return originalOpenSync(candidate, ...args);
    };
    try {
      await assert.rejects(
        () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id),
        (error) => {
          assert.ok(error instanceof CheckpointReadError);
          assert.deepStrictEqual(error.accounting.failure, { kind: "unsupported", stage: "manifest" });
          assert.strictEqual(error.accounting.manifest.status, "not_completed");
          assert.strictEqual(error.accounting.manifest.storedBuffer.count, 1);
          assert.strictEqual(error.accounting.manifest.rawString.count, 1);
          assert.strictEqual(error.accounting.manifest.parsedGraph.count, 1);
          assert.strictEqual(error.accounting.manifest.validationString.count, 0);
          assert.deepStrictEqual(error.accounting.storedPayload, {
            status: "not_completed",
            count: 0,
            bytes: 0,
          });
          return true;
        }
      );

      const missingFieldManifest = { ...originalManifest };
      delete missingFieldManifest.entrypoint;
      fs.writeFileSync(fixture.manifestFile, JSON.stringify(missingFieldManifest));
      await assert.rejects(
        () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id),
        (error) => {
          assert.ok(error instanceof CheckpointReadError);
          assert.deepStrictEqual(error.accounting.failure, { kind: "corrupt", stage: "manifest" });
          assert.strictEqual(error.accounting.manifest.status, "not_completed");
          assert.strictEqual(error.accounting.manifest.parsedGraph.count, 1);
          assert.strictEqual(error.accounting.manifest.validationString.count, 0);
          assert.strictEqual(error.accounting.conservativePotential.totalBytes, potentialTotal(error.accounting));
          return true;
        }
      );

      const badChecksumManifest = { ...originalManifest, manifestSha256: "0".repeat(64) };
      fs.writeFileSync(fixture.manifestFile, JSON.stringify(badChecksumManifest));
      await assert.rejects(
        () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id),
        (error) => {
          assert.ok(error instanceof CheckpointReadError);
          assert.deepStrictEqual(error.accounting.failure, { kind: "corrupt", stage: "manifest" });
          assert.strictEqual(error.accounting.manifest.status, "not_completed");
          assert.strictEqual(error.accounting.manifest.parsedGraph.count, 1);
          assert.strictEqual(error.accounting.manifest.validationString.count, 1);
          assert.strictEqual(error.accounting.conservativePotential.totalBytes, potentialTotal(error.accounting));
          return true;
        }
      );
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.strictEqual(payloadOpens, 0);
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});

test("post-allocation storage races retain allocated payload capacity in the partial receipt", async () => {
  const fixture = await savedCheckpoint();
  try {
    const payloadBytes = fs.statSync(fixture.payloadFile).size;
    const originalOpenSync = fs.openSync;
    const originalCloseSync = fs.closeSync;
    const originalReadSync = fs.readSync;
    const payloadFds = new Set();
    fs.openSync = (candidate, ...args) => {
      const fd = originalOpenSync(candidate, ...args);
      if (path.resolve(String(candidate)) === path.resolve(fixture.payloadFile)) payloadFds.add(fd);
      return fd;
    };
    fs.closeSync = (fd) => {
      payloadFds.delete(fd);
      return originalCloseSync(fd);
    };
    fs.readSync = (fd, buffer, offset, length, position) => {
      if (payloadFds.has(fd) && position === payloadBytes && length === 1) {
        buffer[offset] = 0;
        return 1;
      }
      return originalReadSync(fd, buffer, offset, length, position);
    };
    try {
      await assert.rejects(
        () => openCheckpointArtifact(fixture.projectRoot, fixture.reference.id),
        (error) => {
          assert.ok(error instanceof CheckpointReadError);
          assert.deepStrictEqual(error.accounting.failure, { kind: "corrupt", stage: "storage" });
          assert.deepStrictEqual(error.accounting.storedPayload, {
            status: "not_completed",
            count: 1,
            bytes: payloadBytes,
          });
          assert.strictEqual(error.accounting.decompressedPayload.status, "not_completed");
          assert.strictEqual(error.accounting.conservativePotential.totalBytes, potentialTotal(error.accounting));
          return true;
        }
      );
    } finally {
      fs.openSync = originalOpenSync;
      fs.closeSync = originalCloseSync;
      fs.readSync = originalReadSync;
    }
  } finally {
    fs.rmSync(fixture.projectRoot, { recursive: true, force: true });
  }
});
