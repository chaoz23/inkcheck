const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const checkpointV2Codec = require("../dist/checkpoint-artifact-v2");
const {
  CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER,
  CHECKPOINT_ARTIFACT_V2_MAGIC,
  CheckpointArtifactV2Error,
  DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS,
  readCheckpointArtifactV2,
  writeCheckpointArtifactV2,
} = checkpointV2Codec;

const { compile, scanKnots } = require("../dist/inklecate");
const { exploreSharedResumable } = require("../dist/explore");
const {
  CheckpointReadError,
  listCheckpointArtifacts,
  loadCheckpointForResume,
  openCheckpointArtifact,
  saveCheckpointArtifact,
} = require("../dist/checkpoints");

const FIXTURE = path.join(__dirname, "fixtures", "search", "low-dedup-wide.ink");
const CLI = path.join(__dirname, "..", "dist", "cli.js");

async function projectCheckpoint(maxStates = 73) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-checkpoint-v2-"));
  const story = path.join(root, "story.ink");
  fs.copyFileSync(FIXTURE, story);
  const compiled = await compile(story);
  assert.strictEqual(compiled.success, true);
  const knots = scanKnots(story);
  const options = {
    maxDepth: 150,
    maxStates,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
    sharedObservabilityIntervalStates: 25,
  };
  const checkpoint = exploreSharedResumable(compiled.storyJson, knots, [], options).checkpoint;
  assert.ok(checkpoint);
  return { root, story, compiled, knots, options, checkpoint };
}

function checkpointDirectory(root) {
  return path.join(root, ".inkcheck", "checkpoints");
}

function publicLayouts(root, id) {
  const directory = checkpointDirectory(root);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => new RegExp(
    `^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:inkcp|json|json\\.gz)$`
  ).test(name));
}

function assertPublicFramedSummary(summary) {
  assert.deepStrictEqual(Object.keys(summary), [
    "schemaVersion", "componentOrder", "artifactBytes", "artifactOverheadBytes",
    "data", "components", "index",
  ]);
  assert.strictEqual(summary.schemaVersion, 2);
  assert.deepStrictEqual(summary.componentOrder, CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER);
  for (const value of [summary.artifactBytes, summary.artifactOverheadBytes]) {
    assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  assert.deepStrictEqual(Object.keys(summary.data), [
    "frameCount", "recordCount", "decodedBytes", "storedBytes", "maxRecordBytes",
  ]);
  assert.deepStrictEqual(summary.components.map((component) => component.component),
    CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER);
  for (const component of summary.components) {
    assert.deepStrictEqual(Object.keys(component), [
      "component", "frameCount", "recordCount", "decodedBytes", "storedBytes", "maxRecordBytes",
    ]);
    for (const value of Object.values(component).slice(1)) {
      assert.ok(Number.isSafeInteger(value) && value >= 0);
    }
  }
  assert.deepStrictEqual(Object.keys(summary.index), [
    "sequence", "headerBytes", "decodedBytes", "storedBytes", "maxRecordBytes",
  ]);
  for (const value of [...Object.values(summary.data), ...Object.values(summary.index)]) {
    assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
}

function runSaveWorker(root, format, extraEnv = {}) {
  const source = String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const { compile, scanKnots } = require(${JSON.stringify(path.join(__dirname, "..", "dist", "inklecate.js"))});
    const { exploreSharedResumable } = require(${JSON.stringify(path.join(__dirname, "..", "dist", "explore.js"))});
    const { saveCheckpointArtifact } = require(${JSON.stringify(path.join(__dirname, "..", "dist", "checkpoints.js"))});
    (async () => {
      const root = process.argv[1];
      const story = path.join(root, "story.ink");
      const compiled = await compile(story);
      const checkpoint = exploreSharedResumable(compiled.storyJson, scanKnots(story), [], {
        maxDepth: 150, maxStates: 73, seed: 7,
        preserveTurnState: false, preserveRandomState: false,
        sharedObservabilityIntervalStates: 25,
      }).checkpoint;
      if (process.env.INKCHECK_TEST_FIXED_TIME) {
        const NativeDate = Date;
        const fixedTime = NativeDate.parse(process.env.INKCHECK_TEST_FIXED_TIME);
        global.Date = class extends NativeDate {
          constructor(...values) {
            if (values.length > 0) super(...values);
            else super(fixedTime);
          }
          static now() { return fixedTime; }
        };
      }
      const options = { format: process.argv[2] };
      if (process.env.INKCHECK_TEST_MAX_CHECKPOINT_BYTES) {
        options.maxCheckpointBytes = Number(process.env.INKCHECK_TEST_MAX_CHECKPOINT_BYTES);
      }
      if (process.env.INKCHECK_TEST_MAX_PROJECT_BYTES) {
        options.maxProjectBytes = Number(process.env.INKCHECK_TEST_MAX_PROJECT_BYTES);
      }
      if (process.env.INKCHECK_TEST_V2_MAX_TOTAL_RECORDS) {
        options.framedV2Limits = {
          ...options.framedV2Limits,
          maxTotalRecords: Number(process.env.INKCHECK_TEST_V2_MAX_TOTAL_RECORDS),
        };
      }
      const abortFile = process.env.INKCHECK_TEST_ABORT_FILE;
      if (abortFile) {
        options.signal = {
          get aborted() { return fs.existsSync(abortFile); },
          throwIfAborted() {
            if (!this.aborted) return;
            const error = new Error("checkpoint test request aborted");
            error.name = "AbortError";
            throw error;
          },
          addEventListener() {},
          removeEventListener() {},
        };
      }
      const reference = await saveCheckpointArtifact(root, story, checkpoint, options);
      process.stdout.write(JSON.stringify(reference));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ["-e", source, root, format], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    completed: new Promise((resolve) => child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    })),
  };
}

async function waitFor(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("framed v2 preserves the schema-v1 stable ID, logical checkpoint, and exact split resume", async () => {
  const legacy = await projectCheckpoint();
  const framed = await projectCheckpoint();
  try {
    const v1 = await saveCheckpointArtifact(legacy.root, legacy.story, legacy.checkpoint);
    const v2 = await saveCheckpointArtifact(framed.root, framed.story, framed.checkpoint, {
      format: "framed-v2",
    });
    const expectedId = `checkpoint-${crypto.createHash("sha256")
      .update("story.ink").update("\0").update(JSON.stringify(framed.checkpoint))
      .digest("hex").slice(0, 24)}`;
    assert.strictEqual(v1.id, expectedId);
    assert.strictEqual(v2.id, expectedId);
    assert.match(v1.path, /\.json\.gz$/);
    assert.match(v2.path, /\.inkcp$/);
    assert.strictEqual("framedV2" in v1.accounting, false);
    assert.strictEqual(v1.accounting.serialization.status, "applied");
    assert.strictEqual(v1.accounting.compression.status, "applied");
    assert.strictEqual(v2.accounting.serialization.status, "not_applied");
    assert.strictEqual(v2.accounting.compression.status, "not_applied");
    assert.strictEqual(v2.accounting.framedV2.status, "applied");

    const loaded = await loadCheckpointForResume(framed.root, v2.id);
    assert.deepStrictEqual(loaded.checkpoint, framed.checkpoint);
    const resumed = exploreSharedResumable(
      framed.compiled.storyJson,
      framed.knots,
      [],
      { ...framed.options, maxStates: 500 },
      loaded.checkpoint
    );
    const uninterrupted = exploreSharedResumable(
      framed.compiled.storyJson,
      framed.knots,
      [],
      { ...framed.options, maxStates: 500 }
    );
    assert.deepStrictEqual(resumed, uninterrupted);

    const listed = listCheckpointArtifacts(framed.root);
    assert.strictEqual(listCheckpointArtifacts(legacy.root)[0].artifactSchemaVersion, 1);
    assert.strictEqual(listed[0].artifactSchemaVersion, 2);
    assert.strictEqual(listed[0].storageEncoding, "framed-v2");
    assert.strictEqual(listed[0].framedV2.components.length, 8);
    assert.doesNotMatch(JSON.stringify(listed[0].framedV2), /sha256/i,
      "public metadata projects numeric component totals without private checksums");
    const manifest = JSON.parse(fs.readFileSync(
      path.join(checkpointDirectory(framed.root), `${v2.id}.meta.json`),
      "utf8"
    ));
    assert.match(manifest.framedV2.components[0].decodedSha256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(legacy.root, { recursive: true, force: true });
    fs.rmSync(framed.root, { recursive: true, force: true });
  }
});

test("CLI list/show distinguish their response schema from a framed artifact schema", async () => {
  const fixture = await projectCheckpoint();
  try {
    const checkpoint = structuredClone(fixture.checkpoint);
    checkpoint.state.runtimeWarnings.push("PRIVATE_AUTHORED_WARNING_7f3a");
    const retainedNode = checkpoint.state.nodes.find((node) => node !== null
      && node.stateJson !== undefined && node.choiceText !== undefined);
    assert.ok(retainedNode);
    retainedNode.stateJson = JSON.stringify({ privateMarker: "PRIVATE_STATE_7f3a" });
    retainedNode.choiceText = "PRIVATE_CHOICE_7f3a";
    const saved = await saveCheckpointArtifact(fixture.root, fixture.story, checkpoint, {
      format: "framed-v2",
    });
    const listed = spawnSync(process.execPath, [CLI, "checkpoints", "list", "--json"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    assert.strictEqual(listed.status, 0, listed.stderr);
    const listOutput = JSON.parse(listed.stdout);
    assert.strictEqual(listOutput.checkpointArtifactSchemaVersion, 1,
      "the compatibility top-level field versions the list response");
    assert.strictEqual(listOutput.checkpoints[0].id, saved.id);
    assert.strictEqual(listOutput.checkpoints[0].artifactSchemaVersion, 2);
    assert.strictEqual(listOutput.checkpoints[0].storageEncoding, "framed-v2");
    assertPublicFramedSummary(listOutput.checkpoints[0].framedV2);

    const shown = spawnSync(process.execPath, [CLI, "checkpoints", "show", saved.id, "--json"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    assert.strictEqual(shown.status, 0, shown.stderr);
    const showOutput = JSON.parse(shown.stdout);
    assert.strictEqual(showOutput.artifact.id, saved.id);
    assert.strictEqual(showOutput.artifact.artifactSchemaVersion, 2);
    assert.strictEqual(showOutput.artifact.storageEncoding, "framed-v2");
    assert.strictEqual(showOutput.artifact.freshness, "current");
    assertPublicFramedSummary(showOutput.artifact.framedV2);
    assert.deepStrictEqual(showOutput.artifact.framedV2, listOutput.checkpoints[0].framedV2);
    for (const raw of [listed.stdout, shown.stdout]) {
      assert.doesNotMatch(raw, /PRIVATE_(?:AUTHORED_WARNING|STATE|CHOICE)_7f3a/);
      assert.doesNotMatch(raw,
        /"(?:frames|field|decodedSha256|storedSha256|stateJson|variables|choiceText|runtimeWarnings)"\s*:/);
      assert.doesNotMatch(raw, /sha256/i);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("outer byte caps do not silently raise framed codec defaults", async () => {
  const fixture = await projectCheckpoint();
  const originalWrite = checkpointV2Codec.writeCheckpointArtifactV2;
  const originalRead = checkpointV2Codec.readCheckpointArtifactV2;
  let writeLimits;
  let readLimits;
  checkpointV2Codec.writeCheckpointArtifactV2 = (destination, inputs, options) => {
    writeLimits = options?.limits;
    return originalWrite(destination, inputs, options);
  };
  checkpointV2Codec.readCheckpointArtifactV2 = (source, options) => {
    readLimits = options?.limits;
    return originalRead(source, options);
  };
  try {
    const raisedOuterCap = DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalStoredBytes + 1024;
    const saved = await saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
      maxCheckpointBytes: raisedOuterCap,
      maxProjectBytes: raisedOuterCap,
    });
    await openCheckpointArtifact(fixture.root, saved.id, {
      maxStoredBytes: raisedOuterCap,
      maxDecompressedBytes: raisedOuterCap,
    });
    assert.strictEqual(
      writeLimits.maxTotalStoredBytes,
      DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalStoredBytes
    );
    assert.strictEqual(
      readLimits.maxTotalStoredBytes,
      DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalStoredBytes
    );
    assert.ok(
      readLimits.maxTotalDecodedBytes <= DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalDecodedBytes
    );
  } finally {
    checkpointV2Codec.writeCheckpointArtifactV2 = originalWrite;
    checkpointV2Codec.readCheckpointArtifactV2 = originalRead;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("opposite format requests reuse one verified layout and mixed generations retain deterministically", async () => {
  const first = await projectCheckpoint(10);
  const second = await projectCheckpoint(10);
  try {
    const legacy = await saveCheckpointArtifact(first.root, first.story, first.checkpoint);
    const requestedV2 = await saveCheckpointArtifact(first.root, first.story, first.checkpoint, {
      format: "framed-v2",
    });
    assert.strictEqual(requestedV2.path, legacy.path);
    assert.strictEqual(requestedV2.accounting.outcome, "reused");
    assert.deepStrictEqual(publicLayouts(first.root, legacy.id), [`${legacy.id}.json.gz`]);

    const framed = await saveCheckpointArtifact(second.root, second.story, second.checkpoint, {
      format: "framed-v2",
    });
    const requestedLegacy = await saveCheckpointArtifact(second.root, second.story, second.checkpoint);
    assert.strictEqual(requestedLegacy.path, framed.path);
    assert.strictEqual(requestedLegacy.accounting.outcome, "reused");
    assert.deepStrictEqual(publicLayouts(second.root, framed.id), [`${framed.id}.inkcp`]);

    for (const [budget, format] of [[20, "legacy-v1"], [30, "framed-v2"], [40, "legacy-v1"]]) {
      const checkpoint = exploreSharedResumable(second.compiled.storyJson, second.knots, [], {
        ...second.options,
        maxStates: budget,
      }).checkpoint;
      await saveCheckpointArtifact(second.root, second.story, checkpoint, { format });
    }
    const retained = listCheckpointArtifacts(second.root);
    assert.strictEqual(retained.length, 3);
    assert.ok(retained.some((item) => item.storageEncoding === "framed-v2"));
    assert.ok(retained.some((item) => item.storageEncoding === "gzip"));
  } finally {
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});

test("a real cross-process mixed-format race joins the winner published between visible check and link", async () => {
  const fixture = await projectCheckpoint();
  const gate = path.join(fixture.root, "neutral-gate");
  try {
    const v2 = runSaveWorker(fixture.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: gate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "before-publication-link",
    });
    await waitFor(`${gate}.${v2.child.pid}.ready`);
    const v1 = runSaveWorker(fixture.root, "legacy-v1", { NODE_ENV: "test" });
    const v1Result = await v1.completed;
    assert.strictEqual(v1Result.status, 0, v1Result.stderr);
    fs.writeFileSync(gate, "release");
    const v2Result = await v2.completed;
    assert.strictEqual(v2Result.status, 0, v2Result.stderr);
    const left = JSON.parse(v1Result.stdout);
    const right = JSON.parse(v2Result.stdout);
    assert.strictEqual(left.id, right.id);
    assert.strictEqual(left.accounting.outcome, "reused");
    assert.strictEqual("framedV2" in left.accounting, false);
    assert.strictEqual(right.accounting.outcome, "created");
    assert.strictEqual(right.accounting.framedV2.status, "applied");
    assert.strictEqual(right.accounting.framedV2.codec.artifactBytes,
      fs.statSync(path.join(checkpointDirectory(fixture.root), `${right.id}.inkcp`)).size);
    assert.deepStrictEqual(publicLayouts(fixture.root, left.id), [`${left.id}.inkcp`]);
    assert.strictEqual(listCheckpointArtifacts(fixture.root).length, 1);
    assert.strictEqual(fs.readdirSync(checkpointDirectory(fixture.root))
      .some((name) => name.includes(left.id) && name.startsWith(".")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("helper recovery preserves the neutral owner's created framed receipt", async () => {
  const fixture = await projectCheckpoint();
  const ownerGate = path.join(fixture.root, "helper-recovery-owner-gate");
  const helperGate = path.join(fixture.root, "helper-recovery-helper-gate");
  try {
    const owner = runSaveWorker(fixture.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: ownerGate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "after-neutral-publication",
    });
    await waitFor(`${ownerGate}.${owner.child.pid}.ready`);
    const helper = runSaveWorker(fixture.root, "legacy-v1", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: helperGate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "after-recovery-publication-link",
    });
    await waitFor(`${helperGate}.${helper.child.pid}.ready`);
    assert.strictEqual(fs.readdirSync(checkpointDirectory(fixture.root))
      .some((name) => name.endsWith(".payload.commit")), true,
    "the neutral relink path remains while helper verification is paused");
    fs.writeFileSync(ownerGate, "release");
    const ownerResult = await owner.completed;
    assert.strictEqual(ownerResult.status, 0, ownerResult.stderr);
    fs.writeFileSync(helperGate, "release");
    const helperResult = await helper.completed;
    assert.strictEqual(helperResult.status, 0, helperResult.stderr);

    const created = JSON.parse(ownerResult.stdout);
    const reused = JSON.parse(helperResult.stdout);
    assert.strictEqual(created.id, reused.id);
    assert.match(created.path, /\.inkcp$/);
    assert.strictEqual(created.accounting.outcome, "created");
    assert.strictEqual(created.accounting.serialization.status, "not_applied");
    assert.strictEqual(created.accounting.compression.status, "not_applied");
    assert.strictEqual(created.accounting.framedV2.status, "applied");
    assert.strictEqual(created.accounting.framedV2.codec.artifactBytes,
      fs.statSync(path.join(checkpointDirectory(fixture.root), `${created.id}.inkcp`)).size);
    assert.strictEqual(reused.accounting.outcome, "reused");
    assert.strictEqual("framedV2" in reused.accounting, false);
    assert.deepStrictEqual(publicLayouts(fixture.root, created.id), [`${created.id}.inkcp`]);

    const later = await saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint);
    assert.strictEqual(later.accounting.outcome, "reused");
    assert.strictEqual(later.path, created.path);
    assert.strictEqual(fs.readdirSync(checkpointDirectory(fixture.root))
      .some((name) => name.startsWith(`.${created.id}.`)), false,
    "helper and owner cleanup leave no winner slot that can be mistaken for a loser");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("public recovery stays authoritative while a third writer reuses the neutral link", async () => {
  const fixture = await projectCheckpoint();
  const contenderManifestGate = path.join(fixture.root, "three-writer-contender-manifest-gate");
  const contenderNeutralGate = path.join(fixture.root, "three-writer-contender-neutral-gate");
  const ownerNeutralGate = path.join(fixture.root, "three-writer-owner-neutral-gate");
  let contender;
  let owner;
  try {
    contender = runSaveWorker(fixture.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: contenderManifestGate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "after-recovery-manifest",
      INKCHECK_TEST_CHECKPOINT_GATE_2: contenderNeutralGate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE_2: "after-neutral-publication",
    });
    await waitFor(`${contenderManifestGate}.${contender.child.pid}.ready`);

    owner = runSaveWorker(fixture.root, "legacy-v1", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: ownerNeutralGate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "after-neutral-publication",
      // The canonical legacy pair fits this cap, while the later framed
      // neutral does not. Public recovery must reject the foreign inode by
      // stat before attempting a checksum under the owner's lower limit.
      INKCHECK_TEST_MAX_CHECKPOINT_BYTES: "20000",
      INKCHECK_TEST_MAX_PROJECT_BYTES: "1000000",
    });
    await waitFor(`${ownerNeutralGate}.${owner.child.pid}.ready`);

    // This helper publishes the legacy owner's neutral inode and removes that
    // link after verifying the canonical pair. The framed contender can then
    // occupy the same neutral pathname with a different inode.
    const helper = runSaveWorker(fixture.root, "framed-v2", { NODE_ENV: "test" });
    const helperResult = await helper.completed;
    assert.strictEqual(helperResult.status, 0, helperResult.stderr);
    const reusedByHelper = JSON.parse(helperResult.stdout);
    assert.match(reusedByHelper.path, /\.json\.gz$/);
    assert.strictEqual(reusedByHelper.accounting.outcome, "reused");

    fs.writeFileSync(contenderManifestGate, "release");
    await waitFor(`${contenderNeutralGate}.${contender.child.pid}.ready`);

    const directory = checkpointDirectory(fixture.root);
    const neutral = path.join(directory, `.${reusedByHelper.id}.payload.commit`);
    const publicPayload = path.join(directory, `${reusedByHelper.id}.json.gz`);
    const neutralStat = fs.statSync(neutral);
    const publicStat = fs.statSync(publicPayload);
    assert.notDeepStrictEqual(
      [neutralStat.dev, neutralStat.ino],
      [publicStat.dev, publicStat.ino],
      "the later contender owns a distinct neutral inode"
    );
    const contenderTemporary = fs.readdirSync(directory)
      .filter((name) => name.startsWith(`.${reusedByHelper.id}.recovery-`)
        && name.endsWith(".payload.tmp"))
      .map((name) => path.join(directory, name))
      .find((candidate) => {
        const stat = fs.statSync(candidate);
        return stat.dev === neutralStat.dev && stat.ino === neutralStat.ino;
      });
    assert.ok(contenderTemporary, "the later neutral remains bound to its protected candidate");

    fs.writeFileSync(ownerNeutralGate, "release");
    const ownerResult = await owner.completed;
    assert.strictEqual(ownerResult.status, 0, ownerResult.stderr);
    const created = JSON.parse(ownerResult.stdout);
    assert.strictEqual(created.accounting.outcome, "created");
    assert.strictEqual(created.accounting.serialization.status, "applied");
    assert.strictEqual(created.accounting.compression.status, "applied");

    const neutralAfterOwner = fs.statSync(neutral);
    assert.deepStrictEqual(
      [neutralAfterOwner.dev, neutralAfterOwner.ino],
      [neutralStat.dev, neutralStat.ino],
      "the legacy owner leaves the later writer's foreign neutral intact"
    );

    fs.writeFileSync(contenderNeutralGate, "release");
    const contenderResult = await contender.completed;
    assert.strictEqual(contenderResult.status, 0, contenderResult.stderr);
    const reusedByContender = JSON.parse(contenderResult.stdout);
    assert.strictEqual(reusedByContender.accounting.outcome, "reused");
    assert.strictEqual(reusedByContender.accounting.framedV2.status, "applied");

    const results = [created, reusedByHelper, reusedByContender];
    assert.strictEqual(results.filter((result) => result.accounting.outcome === "created").length, 1);
    assert.ok(results.every((result) => result.id === created.id && result.path === created.path));
    assert.deepStrictEqual(publicLayouts(fixture.root, created.id), [`${created.id}.json.gz`]);
    assert.strictEqual(listCheckpointArtifacts(fixture.root).length, 1);
    assert.strictEqual(fs.readdirSync(directory)
      .some((name) => name.startsWith(`.${created.id}.`)), false,
    "all three transactions leave no hidden same-ID state");
  } finally {
    if (fs.existsSync(fixture.root)) {
      for (const gate of [contenderManifestGate, contenderNeutralGate, ownerNeutralGate]) {
        try { fs.writeFileSync(gate, "release"); } catch {}
      }
    }
    await Promise.allSettled([
      contender?.completed ?? Promise.resolve(),
      owner?.completed ?? Promise.resolve(),
    ]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("byte-identical v2 writers use inode identity to join the distinct public winner", async () => {
  const fixture = await projectCheckpoint();
  const preflightGate = path.join(fixture.root, "identical-v2-preflight-gate");
  const writtenGate = path.join(fixture.root, "identical-v2-written-gate");
  const fixedTime = "2030-01-02T03:04:05.000Z";
  try {
    const loser = runSaveWorker(fixture.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: preflightGate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "during-candidate-preflight",
      INKCHECK_TEST_CHECKPOINT_GATE_2: writtenGate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE_2: "after-recovery-manifest",
      INKCHECK_TEST_FIXED_TIME: fixedTime,
    });
    await waitFor(`${preflightGate}.${loser.child.pid}.ready`);
    const winner = runSaveWorker(fixture.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_FIXED_TIME: fixedTime,
    });
    const winnerResult = await winner.completed;
    assert.strictEqual(winnerResult.status, 0, winnerResult.stderr);
    const created = JSON.parse(winnerResult.stdout);
    fs.writeFileSync(preflightGate, "release");
    await waitFor(`${writtenGate}.${loser.child.pid}.ready`);

    const directory = checkpointDirectory(fixture.root);
    const privateCandidates = fs.readdirSync(directory)
      .filter((name) => name.startsWith(`.${created.id}.recovery-`)
        && name.endsWith(".payload.tmp"));
    assert.strictEqual(privateCandidates.length, 1);
    const privateCandidate = path.join(directory, privateCandidates[0]);
    const publicPayload = path.join(directory, `${created.id}.inkcp`);
    assert.strictEqual(
      crypto.createHash("sha256").update(fs.readFileSync(privateCandidate)).digest("hex"),
      crypto.createHash("sha256").update(fs.readFileSync(publicPayload)).digest("hex"),
      "fixed createdAt makes the two independently encoded payloads byte-identical"
    );
    const privateStat = fs.statSync(privateCandidate);
    const publicStat = fs.statSync(publicPayload);
    assert.notDeepStrictEqual(
      [privateStat.dev, privateStat.ino],
      [publicStat.dev, publicStat.ino],
      "byte-identical candidates are still distinct publication identities"
    );

    fs.writeFileSync(writtenGate, "release");
    const loserResult = await loser.completed;
    assert.strictEqual(loserResult.status, 0, loserResult.stderr);

    const reused = JSON.parse(loserResult.stdout);
    assert.strictEqual(created.id, reused.id);
    assert.strictEqual(created.path, reused.path);
    assert.match(created.path, /\.inkcp$/);
    assert.strictEqual(created.accounting.outcome, "created");
    assert.strictEqual(reused.accounting.outcome, "reused");
    assert.strictEqual(created.accounting.framedV2.status, "applied");
    assert.strictEqual(reused.accounting.framedV2.status, "applied",
      "the byte-identical loser truthfully reports its completed private encode");
    assert.strictEqual(created.accounting.framedV2.codec.artifactBytes,
      reused.accounting.framedV2.codec.artifactBytes);
    assert.deepStrictEqual(publicLayouts(fixture.root, created.id), [`${created.id}.inkcp`]);
    assert.strictEqual(listCheckpointArtifacts(fixture.root).length, 1);
    assert.strictEqual(fs.readdirSync(checkpointDirectory(fixture.root))
      .some((name) => name.startsWith(`.${created.id}.`)), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("restrictive v2 preflight joins a committed legacy winner with truthful not-applied accounting", async () => {
  const fixture = await projectCheckpoint();
  const gate = path.join(fixture.root, "preflight-gate");
  try {
    const loser = runSaveWorker(fixture.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: gate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "during-candidate-preflight",
      INKCHECK_TEST_V2_MAX_TOTAL_RECORDS: "1",
    });
    await waitFor(`${gate}.${loser.child.pid}.ready`);
    const winner = runSaveWorker(fixture.root, "legacy-v1", { NODE_ENV: "test" });
    const winnerResult = await winner.completed;
    assert.strictEqual(winnerResult.status, 0, winnerResult.stderr);
    fs.writeFileSync(gate, "release");
    const loserResult = await loser.completed;
    assert.strictEqual(loserResult.status, 0, loserResult.stderr);

    const created = JSON.parse(winnerResult.stdout);
    const reused = JSON.parse(loserResult.stdout);
    assert.strictEqual(created.id, reused.id);
    assert.match(reused.path, /\.json\.gz$/);
    assert.strictEqual(reused.accounting.outcome, "reused");
    assert.strictEqual(reused.accounting.serialization.status, "not_applied");
    assert.strictEqual(reused.accounting.compression.status, "not_applied");
    assert.strictEqual("framedV2" in reused.accounting, false);
    assert.deepStrictEqual(publicLayouts(fixture.root, reused.id), [`${reused.id}.json.gz`]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an aborted loser cannot reuse a winner committed while candidate work is gated", async () => {
  const fixture = await projectCheckpoint();
  const gate = path.join(fixture.root, "abort-winner-gate");
  const abortFile = path.join(fixture.root, "abort-request");
  try {
    const loser = runSaveWorker(fixture.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: gate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "before-candidate-write",
      INKCHECK_TEST_ABORT_FILE: abortFile,
    });
    await waitFor(`${gate}.${loser.child.pid}.ready`);
    const winner = runSaveWorker(fixture.root, "legacy-v1", { NODE_ENV: "test" });
    const winnerResult = await winner.completed;
    assert.strictEqual(winnerResult.status, 0, winnerResult.stderr);
    fs.writeFileSync(abortFile, "abort");
    fs.writeFileSync(gate, "release");
    const loserResult = await loser.completed;
    assert.strictEqual(loserResult.status, 1, loserResult.stderr);
    assert.match(loserResult.stderr, /AbortError/);

    const created = JSON.parse(winnerResult.stdout);
    assert.deepStrictEqual(publicLayouts(fixture.root, created.id), [`${created.id}.json.gz`]);
    assert.deepStrictEqual(
      (await loadCheckpointForResume(fixture.root, created.id)).checkpoint,
      fixture.checkpoint
    );
    assert.strictEqual(fs.readdirSync(checkpointDirectory(fixture.root))
      .some((name) => name.startsWith(`.${created.id}.`)), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an outer ENOENT winner fallback preserves cancellation before neutral publication", async () => {
  const fixture = await projectCheckpoint();
  const originalCodecWrite = checkpointV2Codec.writeCheckpointArtifactV2;
  const originalWriteFileSync = fs.writeFileSync;
  let encodedResolve;
  let releaseResolve;
  const encoded = new Promise((resolve) => { encodedResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let armAbort = false;
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    throwIfAborted() {
      if (armAbort) {
        armAbort = false;
        aborted = true;
        return;
      }
      if (!aborted) return;
      const error = new Error("checkpoint test request aborted");
      error.name = "AbortError";
      throw error;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  checkpointV2Codec.writeCheckpointArtifactV2 = async (...args) => {
    const result = await originalCodecWrite(...args);
    encodedResolve();
    await release;
    return result;
  };
  try {
    const losingSave = saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
      signal,
    });
    await encoded;
    const winner = runSaveWorker(fixture.root, "legacy-v1", { NODE_ENV: "test" });
    const winnerResult = await winner.completed;
    assert.strictEqual(winnerResult.status, 0, winnerResult.stderr);
    fs.writeFileSync = (file, ...args) => {
      if (aborted && typeof file === "string" && /\.recovery-\d+\.meta\.json$/.test(file)) {
        const error = new Error("simulated recovery-manifest path loss");
        error.code = "ENOENT";
        throw error;
      }
      return originalWriteFileSync(file, ...args);
    };
    armAbort = true;
    releaseResolve();
    await assert.rejects(losingSave, (error) => error?.name === "AbortError");

    const created = JSON.parse(winnerResult.stdout);
    assert.deepStrictEqual(publicLayouts(fixture.root, created.id), [`${created.id}.json.gz`]);
    assert.strictEqual((await saveCheckpointArtifact(
      fixture.root,
      fixture.story,
      fixture.checkpoint,
      { format: "framed-v2" }
    )).accounting.outcome, "reused");
  } finally {
    checkpointV2Codec.writeCheckpointArtifactV2 = originalCodecWrite;
    fs.writeFileSync = originalWriteFileSync;
    releaseResolve?.();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a committed winner supersedes a losing recovery-slot reservation failure", async () => {
  const fixture = await projectCheckpoint();
  const gate = path.join(fixture.root, "reserve-gate");
  try {
    const loser = runSaveWorker(fixture.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_GATE: gate,
      INKCHECK_TEST_CHECKPOINT_GATE_STAGE: "before-reserve-transaction",
    });
    await waitFor(`${gate}.${loser.child.pid}.ready`);
    const winner = runSaveWorker(fixture.root, "legacy-v1", { NODE_ENV: "test" });
    const winnerResult = await winner.completed;
    assert.strictEqual(winnerResult.status, 0, winnerResult.stderr);
    const created = JSON.parse(winnerResult.stdout);
    const directory = checkpointDirectory(fixture.root);
    for (let slot = 0; slot < 32; slot++) {
      fs.writeFileSync(path.join(
        directory,
        `.${created.id}.recovery-${String(slot).padStart(2, "0")}.meta.json.claim`
      ), JSON.stringify({ schemaVersion: 1, pid: process.pid }), { flag: "wx", mode: 0o600 });
    }
    fs.writeFileSync(gate, "release");
    const loserResult = await loser.completed;
    assert.strictEqual(loserResult.status, 0, loserResult.stderr);
    const reused = JSON.parse(loserResult.stdout);
    assert.strictEqual(reused.id, created.id);
    assert.strictEqual(reused.accounting.outcome, "reused");
    assert.strictEqual(reused.accounting.serialization.status, "not_applied");
    assert.strictEqual(reused.accounting.compression.status, "not_applied");
    assert.strictEqual("framedV2" in reused.accounting, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a partial private candidate failure is not converted into winner reuse", async () => {
  const fixture = await projectCheckpoint();
  const originalWrite = checkpointV2Codec.writeCheckpointArtifactV2;
  const partialFailure = new Error("intentional partial candidate failure");
  let emittedResolve;
  let releaseReject;
  const emitted = new Promise((resolve) => { emittedResolve = resolve; });
  const release = new Promise((resolve) => { releaseReject = resolve; });
  checkpointV2Codec.writeCheckpointArtifactV2 = async (destination) => {
    await new Promise((resolve, reject) => {
      destination.write(Buffer.from("partial-framed-candidate"), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    emittedResolve();
    await release;
    destination.destroy(partialFailure);
    throw partialFailure;
  };
  try {
    const losingSave = saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
    });
    await emitted;
    const deadline = Date.now() + 10_000;
    while (true) {
      const candidate = fs.readdirSync(checkpointDirectory(fixture.root))
        .find((name) => name.endsWith(".payload.tmp"));
      if (candidate && fs.statSync(path.join(checkpointDirectory(fixture.root), candidate)).size > 0) break;
      if (Date.now() >= deadline) throw new Error("timed out waiting for partial checkpoint bytes");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const winner = runSaveWorker(fixture.root, "legacy-v1", { NODE_ENV: "test" });
    const winnerResult = await winner.completed;
    assert.strictEqual(winnerResult.status, 0, winnerResult.stderr);
    releaseReject();
    await assert.rejects(losingSave, (error) => error === partialFailure);

    const created = JSON.parse(winnerResult.stdout);
    assert.deepStrictEqual(publicLayouts(fixture.root, created.id), [`${created.id}.json.gz`]);
    const retry = await saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
    });
    assert.strictEqual(retry.accounting.outcome, "reused");
    assert.strictEqual(retry.path, created.path);
  } finally {
    checkpointV2Codec.writeCheckpointArtifactV2 = originalWrite;
    releaseReject();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("framed corruption, resource bounds, cancellation, duplicates, and future schemas fail closed", async () => {
  const fixture = await projectCheckpoint();
  try {
    const saved = await saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
    });
    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id, {
        framedV2Limits: { maxRecordBytes: 1 },
      }),
      (error) => error instanceof CheckpointReadError && error.kind === "resource_limit"
    );
    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id, {
        maxStoredBytes: fs.statSync(path.join(checkpointDirectory(fixture.root), `${saved.id}.inkcp`)).size - 1,
      }),
      (error) => error instanceof CheckpointReadError && error.kind === "resource_limit"
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => loadCheckpointForResume(fixture.root, saved.id, { signal: controller.signal }),
      (error) => error?.name === "AbortError"
    );

    const payload = path.join(checkpointDirectory(fixture.root), `${saved.id}.inkcp`);
    const original = fs.readFileSync(payload);
    const corruptPayload = Buffer.from(original);
    corruptPayload[Math.floor(corruptPayload.length / 2)] ^= 0xff;
    fs.writeFileSync(payload, corruptPayload);
    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id),
      (error) => error instanceof CheckpointReadError && error.kind === "corrupt"
    );
    fs.writeFileSync(payload, original);

    fs.copyFileSync(payload, path.join(checkpointDirectory(fixture.root), `${saved.id}.json.gz`));
    assert.throws(() => listCheckpointArtifacts(fixture.root), /duplicate artifact layouts/);
    fs.rmSync(path.join(checkpointDirectory(fixture.root), `${saved.id}.json.gz`));

    const manifestFile = path.join(checkpointDirectory(fixture.root), `${saved.id}.meta.json`);
    const originalManifest = fs.readFileSync(manifestFile, "utf8");
    fs.rmSync(manifestFile);
    assert.throws(() => listCheckpointArtifacts(fixture.root), /missing its required versioned metadata manifest/);
    fs.writeFileSync(manifestFile, originalManifest);

    const malformed = JSON.parse(originalManifest);
    malformed.framedV2.components[0].frameCount = -1;
    fs.writeFileSync(manifestFile, JSON.stringify(malformed));
    assert.throws(
      () => listCheckpointArtifacts(fixture.root),
      (error) => error instanceof CheckpointReadError && error.kind === "corrupt"
    );

    const manifest = JSON.parse(originalManifest);
    manifest.manifestSchemaVersion = 3;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(
      () => listCheckpointArtifacts(fixture.root),
      (error) => error instanceof CheckpointReadError && error.kind === "unsupported"
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("framed typed failures retain enclosing accounting without unverified partial component totals", async () => {
  const fixture = await projectCheckpoint();
  try {
    const saved = await saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
    });
    const payload = path.join(checkpointDirectory(fixture.root), `${saved.id}.inkcp`);
    const payloadBytes = fs.statSync(payload).size;
    const assertPartialReceipt = (error, kind, stage) => {
      assert.ok(error instanceof CheckpointReadError);
      assert.strictEqual(error.kind, kind);
      assert.strictEqual(error.stage, stage);
      assert.strictEqual(error.accounting.status, "failed");
      assert.deepStrictEqual(error.accounting.failure, { kind, stage });
      assert.strictEqual(error.accounting.manifest.status, "applied");
      assert.strictEqual("framedV2" in error.accounting, false,
        "verified aggregate totals are omitted until the codec reaches its terminal index and EOF");
      assert.strictEqual(error.accounting.storedPayload.status, "not_applied");
      assert.strictEqual(error.accounting.decompressedPayload.status, "not_applied");
      assert.strictEqual(error.accounting.rawArtifactString.status, "not_applied");
      assert.strictEqual(error.accounting.parsedArtifactGraph.status, "not_applied");
      return true;
    };

    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id, { maxStoredBytes: payloadBytes - 1 }),
      (error) => {
        assertPartialReceipt(error, "resource_limit", "storage");
        assert.strictEqual(error.unit, "bytes");
        assert.strictEqual(error.observed, payloadBytes);
        assert.strictEqual(error.limit, payloadBytes - 1);
        assert.strictEqual(error.observedBytes, payloadBytes);
        assert.strictEqual(error.limitBytes, payloadBytes - 1);
        return true;
      }
    );
    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id, {
        framedV2Limits: { maxTotalRecords: 1 },
      }),
      (error) => {
        assertPartialReceipt(error, "resource_limit", "storage");
        assert.strictEqual(error.unit, "count");
        assert.strictEqual(error.observed, 2);
        assert.strictEqual(error.limit, 1);
        assert.strictEqual(error.observedBytes, undefined);
        assert.strictEqual(error.limitBytes, undefined);
        return true;
      }
    );
    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id, {
        framedV2Limits: { maxJsonDepth: 1 },
      }),
      (error) => {
        assertPartialReceipt(error, "resource_limit", "json");
        assert.strictEqual(error.unit, "depth");
        assert.ok(error.observed > error.limit);
        assert.strictEqual(error.limit, 1);
        assert.strictEqual(error.observedBytes, undefined);
        assert.strictEqual(error.limitBytes, undefined);
        return true;
      }
    );

    const original = fs.readFileSync(payload);
    const corruptCount = Buffer.from(original);
    const firstHeaderBytes = corruptCount.readUInt32BE(CHECKPOINT_ARTIFACT_V2_MAGIC.length);
    const firstHeaderOffset = CHECKPOINT_ARTIFACT_V2_MAGIC.length + 8;
    const firstHeader = JSON.parse(corruptCount.subarray(
      firstHeaderOffset,
      firstHeaderOffset + firstHeaderBytes
    ).toString("utf8"));
    const observedRecordCount = firstHeader.recordCount;
    firstHeader.recordCount += firstHeader.recordCount % 10 === 9 ? -1 : 1;
    const corruptCountHeader = Buffer.from(JSON.stringify(firstHeader), "utf8");
    assert.strictEqual(corruptCountHeader.length, firstHeaderBytes,
      "record-count tampering must retain the framed header width");
    corruptCountHeader.copy(corruptCount, firstHeaderOffset);
    fs.writeFileSync(payload, corruptCount);
    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id),
      (error) => {
        assertPartialReceipt(error, "corrupt", "json");
        assert.strictEqual(error.unit, "count");
        assert.strictEqual(error.observed, observedRecordCount);
        assert.strictEqual(error.limit, firstHeader.recordCount);
        assert.strictEqual(error.observedBytes, undefined);
        assert.strictEqual(error.limitBytes, undefined);
        return true;
      }
    );
    fs.writeFileSync(payload, original);

    const corrupt = Buffer.from(original);
    let offset = CHECKPOINT_ARTIFACT_V2_MAGIC.length;
    for (let frame = 0; frame < 2; frame++) {
      const headerBytes = corrupt.readUInt32BE(offset);
      const storedBytes = corrupt.readUInt32BE(offset + 4);
      const storedOffset = offset + 8 + headerBytes;
      if (frame === 1) corrupt[storedOffset + Math.floor(storedBytes / 2)] ^= 0xff;
      offset = storedOffset + storedBytes;
    }
    fs.writeFileSync(payload, corrupt);
    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id),
      (error) => assertPartialReceipt(error, "corrupt", "decompression")
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("framed reads hash and decode one opened payload identity and reject path replacement", async () => {
  const fixture = await projectCheckpoint();
  try {
    const saved = await saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
    });
    const payload = path.join(checkpointDirectory(fixture.root), `${saved.id}.inkcp`);
    const originalOpen = fs.openSync;
    let payloadOpens = 0;
    fs.openSync = (candidate, ...args) => {
      if (path.resolve(String(candidate)) === path.resolve(payload)) payloadOpens += 1;
      return originalOpen(candidate, ...args);
    };
    try {
      await loadCheckpointForResume(fixture.root, saved.id);
    } finally {
      fs.openSync = originalOpen;
    }
    assert.strictEqual(payloadOpens, 1, "framed decode hashes the exact stream instead of making a digest pass");

    const held = `${payload}.held`;
    const originalCreateReadStream = fs.createReadStream;
    let replaced = false;
    fs.createReadStream = (candidate, options) => {
      const stream = originalCreateReadStream(candidate, options);
      if (!replaced && path.resolve(String(candidate)) === path.resolve(payload)) {
        replaced = true;
        fs.renameSync(payload, held);
        fs.copyFileSync(held, payload);
      }
      return stream;
    };
    try {
      await assert.rejects(
        () => openCheckpointArtifact(fixture.root, saved.id),
        (error) => error instanceof CheckpointReadError
          && error.kind === "corrupt" && error.stage === "storage"
      );
    } finally {
      fs.createReadStream = originalCreateReadStream;
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a stalled framed public read aborts promptly with AbortError", async () => {
  const fixture = await projectCheckpoint();
  try {
    const saved = await saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
    });
    const payload = path.join(checkpointDirectory(fixture.root), `${saved.id}.inkcp`);
    const prefix = fs.readFileSync(payload).subarray(0, 16);
    const controller = new AbortController();
    const originalCreateReadStream = fs.createReadStream;
    let stalled;
    fs.createReadStream = (candidate, options) => {
      if (path.resolve(String(candidate)) !== path.resolve(payload)) {
        return originalCreateReadStream(candidate, options);
      }
      let emitted = false;
      stalled = new Readable({
        read() {
          if (emitted) return;
          emitted = true;
          this.push(prefix);
          setImmediate(() => controller.abort());
        },
      });
      return stalled;
    };
    try {
      await assert.rejects(
        () => openCheckpointArtifact(fixture.root, saved.id, { signal: controller.signal }),
        (error) => error?.name === "AbortError"
      );
      assert.strictEqual(stalled.destroyed, true, "abort tears down the stalled payload stream");
    } finally {
      fs.createReadStream = originalCreateReadStream;
      stalled?.destroy();
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("deep ancestry and large semantic/finding components split into bounded frames", async () => {
  const fixture = await projectCheckpoint(10);
  try {
    const checkpoint = structuredClone(fixture.checkpoint);
    checkpoint.state.nodes = Array.from({ length: 400 }, (_, index) => ({
      stateJson: JSON.stringify({ index }),
      variables: { index },
      parent: index === 0 ? null : index - 1,
      choiceText: `choice-${index}`,
      choiceIndex: 0,
      depth: index,
      active: true,
      childRefs: index === 399 ? 0 : 1,
      stateBytes: Buffer.byteLength(JSON.stringify({ index })),
      variableBytes: Buffer.byteLength(JSON.stringify({ index })),
      ancestryBytes: 64 + Buffer.byteLength(`choice-${index}`),
    }));
    checkpoint.state.seenStates = Array.from({ length: 2_000 }, (_, index) => `state-${index}`);
    checkpoint.state.runtimeWarnings = Array.from({ length: 1_000 }, (_, index) => `warning-${index}`);
    const saved = await saveCheckpointArtifact(fixture.root, fixture.story, checkpoint, {
      format: "framed-v2",
      framedV2Limits: {
        maxRecordsPerFrame: 11,
        maxDecodedFrameBytes: 512 * 1024,
        maxRecordBytes: 256 * 1024,
      },
    });
    const loaded = await loadCheckpointForResume(fixture.root, saved.id, {
      framedV2Limits: {
        maxRecordsPerFrame: 11,
        maxDecodedFrameBytes: 512 * 1024,
        maxRecordBytes: 256 * 1024,
      },
    });
    assert.deepStrictEqual(loaded.checkpoint, checkpoint);
    const components = Object.fromEntries(
      loaded.artifact.framedV2.components.map((component) => [component.component, component])
    );
    assert.ok(components.frontier.frameCount > 10);
    assert.ok(components.witnessAncestry.frameCount > 10);
    assert.ok(components.dedupe.frameCount > 10);
    assert.ok(components.findings.frameCount > 10);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a tiny framed nodeSlots claim is bounded before allocation and writers cannot emit it", async () => {
  const fixture = await projectCheckpoint();
  try {
    const saved = await saveCheckpointArtifact(fixture.root, fixture.story, fixture.checkpoint, {
      format: "framed-v2",
    });
    const directory = checkpointDirectory(fixture.root);
    const payload = path.join(directory, `${saved.id}.inkcp`);
    const manifestFile = path.join(directory, `${saved.id}.meta.json`);
    const inputs = [];
    let current;
    await readCheckpointArtifactV2(fs.createReadStream(payload), {
      onRecord(record) {
        const key = `${record.component}\0${record.field}`;
        if (!current || current.key !== key) {
          current = {
            key,
            component: record.component,
            field: record.field,
            start: 0,
            records: [],
          };
          inputs.push(current);
        }
        current.records.push(record.component === "witnessAncestry" && record.field === "nodeSlots"
          ? 1_001
          : record.value);
      },
    });
    const replacement = `${payload}.replacement`;
    const codec = await writeCheckpointArtifactV2(fs.createWriteStream(replacement, {
      flags: "wx",
      mode: 0o600,
    }), inputs.map(({ key: _key, ...input }) => input));
    fs.renameSync(replacement, payload);

    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const bytes = fs.readFileSync(payload);
    manifest.artifactSizeBytes = bytes.length;
    manifest.artifactSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    manifest.framedV2 = {
      schemaVersion: 2,
      componentOrder: CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER,
      artifactBytes: codec.artifactBytes,
      artifactOverheadBytes: codec.artifactBytes - codec.data.storedBytes - codec.index.storedBytes,
      data: codec.data,
      components: codec.components,
      index: codec.index,
    };
    const body = {
      manifestSchemaVersion: manifest.manifestSchemaVersion,
      artifactSchemaVersion: manifest.artifactSchemaVersion,
      artifactType: manifest.artifactType,
      id: manifest.id,
      createdAt: manifest.createdAt,
      inkcheckVersion: manifest.inkcheckVersion,
      checkpointSchemaVersion: manifest.checkpointSchemaVersion,
      entrypoint: manifest.entrypoint,
      engine: manifest.engine,
      totalGranted: manifest.totalGranted,
      statesExplored: manifest.statesExplored,
      storageEncoding: manifest.storageEncoding,
      artifactSizeBytes: manifest.artifactSizeBytes,
      artifactSha256: manifest.artifactSha256,
      framedV2: manifest.framedV2,
    };
    manifest.manifestSha256 = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    await assert.rejects(
      () => openCheckpointArtifact(fixture.root, saved.id, {
        framedV2Limits: { maxTotalRecords: 1_000 },
      }),
      (error) => error instanceof CheckpointReadError
        && error.kind === "resource_limit" && error.stage === "envelope"
        && error.unit === "count" && error.observed === 1_001 && error.limit === 1_000
        && error.observedBytes === undefined && error.limitBytes === undefined
    );

    const writerRoot = await projectCheckpoint();
    try {
      const oversized = structuredClone(writerRoot.checkpoint);
      oversized.state.nodes = Array(1_001).fill(null);
      const originalCreateWriteStream = fs.createWriteStream;
      let writeStreams = 0;
      fs.createWriteStream = (...args) => {
        writeStreams += 1;
        return originalCreateWriteStream(...args);
      };
      try {
        await assert.rejects(
          () => saveCheckpointArtifact(writerRoot.root, writerRoot.story, oversized, {
            format: "framed-v2",
            framedV2Limits: { maxTotalRecords: 1_000 },
          }),
          (error) => error instanceof CheckpointArtifactV2Error
            && error.kind === "resource_limit" && error.metric === "count"
            && error.observed === 1_001 && error.limit === 1_000
        );
      } finally {
        fs.createWriteStream = originalCreateWriteStream;
      }
      assert.strictEqual(writeStreams, 0, "node-slot preflight rejects before opening a destination stream");
    } finally {
      fs.rmSync(writerRoot.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("pre-publication cancellation cleans private state and a v2 crash recovers one complete pair", async () => {
  const cancelled = await projectCheckpoint(500);
  const crashed = await projectCheckpoint();
  const neutralCrashed = await projectCheckpoint();
  const legacyNeutralCrashed = await projectCheckpoint();
  try {
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await assert.rejects(
      () => saveCheckpointArtifact(cancelled.root, cancelled.story, cancelled.checkpoint, {
        format: "framed-v2",
        signal: controller.signal,
      }),
      (error) => error?.name === "AbortError"
    );
    const cancelledNames = fs.existsSync(checkpointDirectory(cancelled.root))
      ? fs.readdirSync(checkpointDirectory(cancelled.root))
      : [];
    assert.strictEqual(cancelledNames.some((name) => /\.(?:inkcp|json|json\.gz|meta\.json)$/.test(name)), false);
    assert.strictEqual(cancelledNames.some((name) => name.endsWith(".payload.commit")), false);

    const worker = runSaveWorker(crashed.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_CRASH_STAGE: "after-payload-publication",
    });
    const result = await worker.completed;
    assert.strictEqual(result.status, 86, result.stderr);
    const recovered = await saveCheckpointArtifact(crashed.root, crashed.story, crashed.checkpoint);
    assert.match(recovered.path, /\.inkcp$/);
    assert.deepStrictEqual(
      (await loadCheckpointForResume(crashed.root, recovered.id)).checkpoint,
      crashed.checkpoint
    );
    assert.deepStrictEqual(publicLayouts(crashed.root, recovered.id), [`${recovered.id}.inkcp`]);

    const neutralWorker = runSaveWorker(neutralCrashed.root, "framed-v2", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_CRASH_STAGE: "after-neutral-publication",
    });
    const neutralResult = await neutralWorker.completed;
    assert.strictEqual(neutralResult.status, 86, neutralResult.stderr);
    assert.strictEqual(fs.readdirSync(checkpointDirectory(neutralCrashed.root))
      .some((name) => /^checkpoint-.*\.(?:inkcp|json|json\.gz)$/.test(name)), false);
    const neutralRecovered = await saveCheckpointArtifact(
      neutralCrashed.root,
      neutralCrashed.story,
      neutralCrashed.checkpoint
    );
    assert.match(neutralRecovered.path, /\.inkcp$/,
      "a legacy-v1 retry completes the manifest-selected v2 neutral payload");
    assert.deepStrictEqual(
      (await loadCheckpointForResume(neutralCrashed.root, neutralRecovered.id)).checkpoint,
      neutralCrashed.checkpoint
    );

    const legacyNeutralWorker = runSaveWorker(legacyNeutralCrashed.root, "legacy-v1", {
      NODE_ENV: "test",
      INKCHECK_TEST_CHECKPOINT_CRASH_STAGE: "after-neutral-publication",
    });
    const legacyNeutralResult = await legacyNeutralWorker.completed;
    assert.strictEqual(legacyNeutralResult.status, 86, legacyNeutralResult.stderr);
    assert.strictEqual(fs.readdirSync(checkpointDirectory(legacyNeutralCrashed.root))
      .some((name) => /^checkpoint-.*\.(?:inkcp|json|json\.gz)$/.test(name)), false);
    const legacyNeutralRecovered = await saveCheckpointArtifact(
      legacyNeutralCrashed.root,
      legacyNeutralCrashed.story,
      legacyNeutralCrashed.checkpoint,
      { format: "framed-v2", framedV2Limits: { maxRecordBytes: 1 } }
    );
    assert.match(legacyNeutralRecovered.path, /\.json\.gz$/,
      "restrictive v2 preflight cannot supersede a manifest-selected legacy neutral payload");
    assert.strictEqual(legacyNeutralRecovered.accounting.outcome, "reused");
    assert.strictEqual(legacyNeutralRecovered.accounting.serialization.status, "not_applied");
    assert.strictEqual(legacyNeutralRecovered.accounting.compression.status, "not_applied");
    assert.strictEqual("framedV2" in legacyNeutralRecovered.accounting, false);
    assert.deepStrictEqual(
      (await loadCheckpointForResume(
        legacyNeutralCrashed.root,
        legacyNeutralRecovered.id
      )).checkpoint,
      legacyNeutralCrashed.checkpoint
    );
  } finally {
    fs.rmSync(cancelled.root, { recursive: true, force: true });
    fs.rmSync(crashed.root, { recursive: true, force: true });
    fs.rmSync(neutralCrashed.root, { recursive: true, force: true });
    fs.rmSync(legacyNeutralCrashed.root, { recursive: true, force: true });
  }
});
