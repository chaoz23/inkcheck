const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { compile } = require("../dist/inklecate");
const {
  digestJson,
  evaluationProgressSnapshot,
  evaluationSnapshotVerdict,
  evaluateCheckpointV2Verdict,
  runBoundedProcess,
  runCheckpointV2EvaluationCell,
  validateCheckpointV2EvaluationManifest,
  validateEvaluationSource,
  writeEvaluationOutputAtomic,
} = require("../dist/checkpoint-v2-evaluation-cli");

const REPOSITORY = path.join(__dirname, "..");
const MANIFEST_FILE = path.join(REPOSITORY, "benchmarks", "checkpoint-v2-promotion-v1.json");
const SYNTHETIC_STORY = path.join(REPOSITORY, "test", "fixtures", "search", "low-dedup-wide.ink");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
}

async function syntheticSource() {
  const story = fs.readFileSync(SYNTHETIC_STORY);
  const compiled = await compile(SYNTHETIC_STORY);
  assert.strictEqual(compiled.success, true);
  const relative = path.relative(REPOSITORY, SYNTHETIC_STORY).split(path.sep).join("/");
  const name = path.basename(SYNTHETIC_STORY);
  return {
    id: "synthetic-wide",
    story: relative,
    entrypointSha256: sha256(story),
    compiledStorySha256: sha256(`${compiled.storyJson.replace(/\r?\n$/, "")}\n`),
    closure: {
      includeCount: 0,
      fileCount: 1,
      bundleSha256: sha256(Buffer.concat([Buffer.from(`${name}\0`), story, Buffer.from("\0")])),
    },
    provenance: {
      license: "MIT",
      licenseFile: "LICENSE",
      licenseSha256: sha256(fs.readFileSync(path.join(REPOSITORY, "LICENSE"))),
      upstream: "fixture/inkcheck",
      commit: "0000000000000000000000000000000000000000",
    },
  };
}

function syntheticControls(cellOrder) {
  return {
    cellOrder,
    maxDepth: 150,
    searchSeed: 7,
    storySeed: 1,
    concurrency: 1,
    minimizeRepros: false,
    stateSensitivity: "source_semantics",
    loopRiskDetection: "only_without_turns_randomness_visit_counts_or_externals",
    maxMemoryMb: 512,
    maxTimeMs: 30_000,
    workerTimeoutMs: 40_000,
    coordinatorMaxOldSpaceMb: 256,
    storage: {
      maxCheckpointBytes: 64 * 1024 * 1024,
      maxProjectBytes: 128 * 1024 * 1024,
      framedV2: { maxTotalDecodedBytes: 128 * 1024 * 1024 },
    },
  };
}

function cell(id, mode, expected = mode === "uninterrupted" ? "endpoint" : "resume_exact") {
  return {
    id,
    sourceId: "synthetic-wide",
    mode,
    baseStates: 73,
    targetStates: 100,
    expected,
  };
}

async function runSynthetic(source, spec, controls) {
  return runCheckpointV2EvaluationCell({
    schemaVersion: 1,
    manifestRoot: REPOSITORY,
    cellRoot: fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-checkpoint-v2-eval-test-")),
    source,
    cell: spec,
    controls,
  });
}

function resultObservation(digest = "a") {
  return { digest: { sha256: digest.repeat(64).slice(0, 64), utf8Bytes: 10 } };
}

function completedCase(id, mode) {
  const sourceId = id.startsWith("heresy2") ? "heresy2" : "intercept";
  const expected = id === "intercept-legacy-split"
    ? "legacy_readback_resource_limit"
    : mode === "uninterrupted" ? "endpoint" : "resume_exact";
  const result = {
    schemaVersion: 1,
    id,
    sourceId,
    mode,
    expected,
    status: "completed",
    configuration: {},
    compiler: {},
    source: {},
    elapsedMs: 1,
    peakRssBytes: 1,
  };
  if (mode === "uninterrupted") return { ...result, uninterrupted: resultObservation("b") };
  const legacyBoundary = id === "intercept-legacy-split";
  return {
    ...result,
    base: resultObservation("a"),
    ...(!legacyBoundary ? { resumed: resultObservation("b") } : {}),
    checkpoint: {
      id: `checkpoint-${sourceId}`,
      logicalCheckpointUtf8Bytes: 100,
      logicalCheckpoint: resultObservation("c").digest,
      write: {
        materializedCheckpointGraphs: mode === "framed-split" ? 0 : 1,
        engineSourceMaterializedGraphs: mode === "framed-split" ? 0 : null,
        legacySerializationApplied: mode !== "framed-split",
        legacyCompressionApplied: mode !== "framed-split",
      },
      readback: legacyBoundary
        ? { status: "resource_limit", kind: "resource_limit", stage: "decompression", unit: "bytes" }
        : { status: "completed" },
      preservation: { payloadBytesUnchanged: true, listingUnchanged: true },
    },
  };
}

test("checkpoint-v2 promotion manifest freezes the mirrored six-cell order and vendored source provenance", async () => {
  const value = manifest();
  validateCheckpointV2EvaluationManifest(value);
  assert.deepStrictEqual(value.controls.cellOrder, value.cells.map((entry) => entry.id));
  assert.deepStrictEqual(value.cells.map((entry) => entry.mode), [
    "legacy-split", "framed-split", "uninterrupted",
    "uninterrupted", "framed-split", "legacy-split",
  ]);
  const validated = await Promise.all(value.sources.map((source) => validateEvaluationSource(
    path.dirname(MANIFEST_FILE),
    source
  )));
  assert.deepStrictEqual(validated.map((source) => source.relativeFiles.length), [21, 1]);
  for (const source of value.sources) {
    const compiled = await compile(path.resolve(path.dirname(MANIFEST_FILE), source.story));
    assert.strictEqual(compiled.success, true);
    assert.strictEqual(
      sha256(`${compiled.storyJson.replace(/\r?\n$/, "")}\n`),
      source.compiledStorySha256
    );
  }

  const drifted = structuredClone(value.sources[0]);
  drifted.entrypointSha256 = "0".repeat(64);
  await assert.rejects(
    () => validateEvaluationSource(path.dirname(MANIFEST_FILE), drifted),
    /source_entrypoint_sha256_drift/
  );
});

test("streaming JSON digests exactly match JSON.stringify without constructing a report-sized string", () => {
  const value = {
    finite: 1.25,
    nonFinite: Number.POSITIVE_INFINITY,
    text: "quote: \" and newline\n",
    array: [1, undefined, true, null],
    nested: { kept: "yes", omitted: undefined },
  };
  const serialized = JSON.stringify(value);
  assert.deepStrictEqual(digestJson(value), {
    sha256: sha256(serialized),
    utf8Bytes: Buffer.byteLength(serialized),
  });
});

test("fast synthetic legacy, engine-native framed, and uninterrupted cells retain exact endpoints", async () => {
  const source = await syntheticSource();
  const specs = [
    cell("synthetic-legacy", "legacy-split"),
    cell("synthetic-framed", "framed-split"),
    cell("synthetic-uninterrupted", "uninterrupted"),
  ];
  const controls = syntheticControls(specs.map((entry) => entry.id));
  const legacy = await runSynthetic(source, specs[0], controls);
  const framed = await runSynthetic(source, specs[1], controls);
  const uninterrupted = await runSynthetic(source, specs[2], controls);

  assert.strictEqual(legacy.checkpoint.storageEncoding, "gzip", "omitting format retains the legacy default");
  assert.strictEqual(legacy.checkpoint.write.legacySerializationApplied, true);
  assert.deepStrictEqual(framed.checkpoint.write, {
    outcome: "created",
    materializedCheckpointGraphs: 0,
    engineSourceMaterializedGraphs: 0,
    engineSourceIdentityPasses: 1,
    engineSourceFramePasses: 1,
    legacySerializationApplied: false,
    legacyCompressionApplied: false,
    framedV2Applied: true,
  });
  assert.deepStrictEqual(legacy.base.digest, framed.base.digest);
  assert.strictEqual(legacy.checkpoint.id, framed.checkpoint.id);
  assert.strictEqual(legacy.checkpoint.logicalCheckpointUtf8Bytes, framed.checkpoint.logicalCheckpointUtf8Bytes);
  assert.deepStrictEqual(legacy.checkpoint.logicalCheckpoint, framed.checkpoint.logicalCheckpoint);
  assert.deepStrictEqual(legacy.resumed.digest, uninterrupted.uninterrupted.digest);
  assert.deepStrictEqual(framed.resumed.digest, uninterrupted.uninterrupted.digest);

  const output = JSON.stringify({ legacy, framed, uninterrupted });
  assert.strictEqual(output.includes(REPOSITORY), false);
  assert.strictEqual(output.includes("Wide tree leaf."), false);
  assert.strictEqual(output.includes("[Left]"), false);
});

test("hard timeout kills the isolated Unix process group and returns typed cleanup scope", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix process-group assertion has a separate process-tree implementation on Windows");
    return;
  }
  const script = [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'])",
    "process.stdout.write(String(child.pid)+'\\n')",
    "setInterval(()=>{},1000)",
  ].join(";");
  const result = await runBoundedProcess(process.execPath, ["-e", script], {
    cwd: REPOSITORY,
    timeoutMs: 150,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
    killGraceMs: 50,
  });
  assert.strictEqual(result.status, "timeout");
  assert.strictEqual(result.cleanupScope, "process_group");
  const descendant = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(descendant));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(descendant, 0), /ESRCH/);
});

test("hard timeout still force-kills a SIGTERM-resistant descendant after its leader exits", async () => {
  const descendantScript = [
    "process.on('SIGTERM',()=>{})",
    "process.stdout.write('ready')",
    "setInterval(()=>{},1000)",
  ].join(";");
  const leaderScript = [
    "const {spawn}=require('node:child_process')",
    "process.on('SIGTERM',()=>process.exit(0))",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:['ignore','pipe','ignore']})`,
    "child.stdout.once('data',()=>process.stdout.write(String(child.pid)+'\\n'))",
    "setInterval(()=>{},1000)",
  ].join(";");
  const result = await runBoundedProcess(process.execPath, ["-e", leaderScript], {
    cwd: REPOSITORY,
    timeoutMs: 250,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
    killGraceMs: 75,
  });
  assert.strictEqual(result.status, "timeout");
  assert.strictEqual(result.cleanupScope, process.platform === "win32" ? "process_tree" : "process_group");
  const descendant = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(descendant));
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      process.kill(descendant, 0);
    } catch (error) {
      assert.match(String(error), /ESRCH/);
      break;
    }
    if (Date.now() >= deadline) assert.fail(`descendant ${descendant} survived forced cleanup`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});

test("filtered and unexpectedly successful legacy boundary evidence can never pass", () => {
  const value = manifest();
  validateCheckpointV2EvaluationManifest(value);
  const all = [
    completedCase("heresy2-legacy-split", "legacy-split"),
    completedCase("heresy2-framed-split", "framed-split"),
    completedCase("heresy2-uninterrupted", "uninterrupted"),
    completedCase("intercept-uninterrupted", "uninterrupted"),
    completedCase("intercept-framed-split", "framed-split"),
    completedCase("intercept-legacy-split", "legacy-split"),
  ];
  assert.strictEqual(
    evaluateCheckpointV2Verdict(value, all, value.controls.cellOrder, true, true).status,
    "passed"
  );
  const filtered = evaluateCheckpointV2Verdict(value, [all[0]], [all[0].id], true, true);
  assert.strictEqual(filtered.completeMatrix, false);
  assert.strictEqual(filtered.status, "inconclusive");
  assert.deepStrictEqual(filtered.allowedClaims, []);

  all[5] = { ...all[5], status: "inconclusive", reason: "legacy_readback_succeeded" };
  const unexpected = evaluateCheckpointV2Verdict(value, all, value.controls.cellOrder, true, true);
  assert.strictEqual(unexpected.status, "inconclusive");
  assert.deepStrictEqual(unexpected.allowedClaims, []);
  assert.ok(unexpected.uncertainties.includes("intercept-legacy-split:legacy_readback_succeeded"));
});

test("evaluation output replacement is atomic and leaves no private temporary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-checkpoint-v2-output-"));
  const output = path.join(root, "result.json");
  try {
    fs.writeFileSync(output, "old\n");
    writeEvaluationOutputAtomic(output, "new\n");
    assert.strictEqual(fs.readFileSync(output, "utf8"), "new\n");
    assert.deepStrictEqual(fs.readdirSync(root), ["result.json"]);
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(output).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("atomic progress snapshots retain prior cases and never authorize an in-progress proof", () => {
  const selected = ["cell-a", "cell-b"];
  assert.deepStrictEqual(evaluationProgressSnapshot(selected, [], undefined, "in_progress"), {
    status: "in_progress",
    selectedCellCount: 2,
    recordedCellCount: 0,
    recordedCellIds: [],
  });
  assert.deepStrictEqual(evaluationProgressSnapshot(selected, [], "cell-a", "in_progress"), {
    status: "in_progress",
    selectedCellCount: 2,
    recordedCellCount: 0,
    recordedCellIds: [],
    activeCellId: "cell-a",
  });
  assert.deepStrictEqual(evaluationProgressSnapshot(selected, ["cell-a"], "cell-b", "in_progress"), {
    status: "in_progress",
    selectedCellCount: 2,
    recordedCellCount: 1,
    recordedCellIds: ["cell-a"],
    activeCellId: "cell-b",
  });
  assert.deepStrictEqual(evaluationProgressSnapshot(selected, selected, undefined, "completed"), {
    status: "completed",
    selectedCellCount: 2,
    recordedCellCount: 2,
    recordedCellIds: selected,
  });
  assert.throws(
    () => evaluationProgressSnapshot(selected, ["cell-b"], undefined, "in_progress"),
    /evaluation_progress_order/
  );
  assert.throws(
    () => evaluationProgressSnapshot(selected, ["cell-a"], undefined, "completed"),
    /evaluation_progress_incomplete/
  );
  const passing = {
    status: "passed",
    completeMatrix: true,
    gates: [],
    violations: [],
    uncertainties: [],
    allowedClaims: ["would_be_terminal_only"],
    forbiddenClaims: [],
  };
  const partial = evaluationSnapshotVerdict(passing, "in_progress");
  assert.strictEqual(partial.status, "inconclusive");
  assert.deepStrictEqual(partial.allowedClaims, []);
  assert.ok(partial.uncertainties.includes("evaluation_in_progress"));
});

test("the proof package entrypoint rebuilds ignored dist and ships its frozen contract", () => {
  const packageValue = JSON.parse(fs.readFileSync(path.join(REPOSITORY, "package.json"), "utf8"));
  assert.strictEqual(
    packageValue.scripts["evaluate-checkpoint-v2"],
    "npm run --silent build && node --max-old-space-size=6144 dist/checkpoint-v2-evaluation-cli.js"
  );
  assert.ok(packageValue.files.includes("benchmarks/checkpoint-v2-promotion-v1.json"));
  assert.ok(packageValue.files.includes("benchmarks/results/checkpoint-v2-promotion-v1.json"));
  assert.ok(packageValue.files.includes("docs/checkpoint-v2-promotion-evaluation.md"));
});
