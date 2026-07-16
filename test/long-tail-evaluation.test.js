const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { recommendLongTailShadow } = require("../dist/campaign-controls");
const { createCampaignLedger, createCampaignPolicy } = require("../dist/campaign-policy");
const { runIsolatedArm } = require("../dist/long-tail-evaluation-cli");

const ROOT = path.resolve(__dirname, "..");
const manifestFile = path.join(ROOT, "benchmarks", "long-tail-partition-evaluation-v1.json");

function json(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

test("long-tail evaluation pins a finite control and a matched 5M authored campaign", () => {
  const manifest = json("benchmarks/long-tail-partition-evaluation-v1.json");
  const synthetic = json("benchmarks/results/long-tail-partition-synthetic-control-v1.json");
  const intercept = json("benchmarks/results/long-tail-partition-intercept-5m-v1.json");
  const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

  assert.deepStrictEqual(manifest.cases.map((entry) => entry.id), [
    "synthetic-early-gate-control",
    "the-intercept-5m",
  ]);
  assert.strictEqual(synthetic.manifestSha256, manifestSha256);
  assert.strictEqual(intercept.manifestSha256, manifestSha256);

  const control = synthetic.cases[0];
  assert.strictEqual(control.independent.additional.windows[0].marginalYield.critical, 0);
  assert.ok(control.independent.additional.newEvidence.terminalVariants.count
    > control.sameFrontier.additional.newEvidence.terminalVariants.count);
  assert.deepStrictEqual(control.independent.invariants, {
    baseReportPreserved: true,
    baseCheckpointPreserved: true,
    campaignStatesWithinCeiling: true,
    reportReopens: true,
  });

  const authored = intercept.cases[0];
  assert.strictEqual(authored.configuration.baseStates + authored.configuration.additionalStates, 5_000_000);
  assert.strictEqual(authored.sameFrontier.additional.ledger.latest.stopReason, "memory");
  assert.ok(authored.sameFrontier.additional.ledger.spend.states < 5_000_000);
  assert.strictEqual(authored.independent.additional.ledger.spend.states, 5_000_000);
  assert.strictEqual(authored.independent.additional.windows.length, 9);
  assert.strictEqual(new Set(authored.independent.additional.windows.map((window) => window.partition.seed)).size, 9);
  assert.deepStrictEqual(authored.independent.additional.windows.map((window) => window.marginalYield.terminalVariants), [
    1030, 508, 400, 340, 300, 293, 239, 229, 219,
  ]);
  assert.strictEqual(authored.independent.additional.newEvidence.runtimeErrors.count, 0);
  assert.strictEqual(authored.independent.additional.newEvidence.visitedKnots.count, 0);
  assert.strictEqual(authored.independent.additional.newEvidence.visibleOutcomes.count, 0);
  assert.strictEqual(authored.independent.invariants.baseCheckpointPreserved, true);

  const policy = createCampaignPolicy({
    intent: "balanced",
    mode: "fixed",
    valuePreference: "outcomes",
    stopPolicy: "ceilings",
    totalStates: 5_000_000,
    maxElapsedMs: 7_200_000,
    maxMemoryBytes: 4 * 1024 * 1024 * 1024,
    maxDiskBytes: 2 * 1024 * 1024 * 1024,
    maxConcurrency: 1,
    typicalWindowStates: 500_000,
    longTailShare: 0.9,
    minLongTailProbes: 1,
    regressionReserveStates: 0,
  });
  const ledger = createCampaignLedger(policy, "evaluation-replay-0123456789", "2026-07-16T00:00:00.000Z");
  ledger.spend.states = 500_000;
  const shadowActions = [];
  authored.independent.additional.windows.forEach((window, index) => {
    ledger.allocations.push({
      sequence: index + 1,
      id: `run-${String(index + 1).padStart(24, "0")}`,
      purpose: "long_tail",
      grantedStates: window.consumedStates,
      consumedStates: window.consumedStates,
      createdAt: `2026-07-16T00:00:${String(index * 2).padStart(2, "0")}.000Z`,
      completedAt: `2026-07-16T00:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`,
      reason: "protected minimum long-tail probe is due",
      partition: window.partition,
      status: "completed",
      stopReason: window.stopReason,
      yield: window.marginalYield,
      provenance: {
        reportId: window.reportId,
        elapsedMs: window.elapsedMs,
        peakMemoryBytes: 0,
        diskBytes: 0,
      },
    });
    ledger.spend.states += window.consumedStates;
    shadowActions.push(recommendLongTailShadow(ledger).action);
  });
  assert.deepStrictEqual(shadowActions, [
    "rotate_partition", "rotate_partition", "rotate_partition", "rotate_partition", "rotate_partition",
    "rotate_partition", "rotate_partition", "rotate_partition", "stop_after_floor",
  ]);
});

test("long-tail promotion manifest predeclares three guarded authored 5M families", () => {
  const manifest = json("benchmarks/long-tail-promotion-v2.json");
  assert.strictEqual(manifest.schemaVersion, 2);
  assert.strictEqual(manifest.workerTimeoutMs, 900_000);
  assert.deepStrictEqual(manifest.cases.map((entry) => entry.id), [
    "dog-ink-adventure-5m",
    "the-intercept-5m",
    "heresy2-5m",
  ]);
  for (const entry of manifest.cases) {
    assert.strictEqual(entry.baseStates + entry.additionalStates, 5_000_000);
    assert.strictEqual(entry.maxDepth, 100);
    assert.ok(entry.maxElapsedSeconds * 1_000 < manifest.workerTimeoutMs);
    assert.ok(fs.existsSync(path.join(ROOT, "benchmarks", entry.story)));
    assert.ok(fs.existsSync(path.join(ROOT, "benchmarks", entry.source.licenseFile)));
  }
});

function timeoutWorker(root, name, snapshot) {
  const worker = path.join(root, `${name}.js`);
  fs.writeFileSync(worker, [
    'const fs = require("node:fs");',
    'const outputIndex = process.argv.indexOf("--output");',
    ...(snapshot ? ['fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ armResult: { marker: "saved" } }));'] : []),
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  return worker;
}

test("long-tail evaluator records pre-snapshot hard timeouts instead of losing the matrix", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-long-tail-timeout-test-"));
  try {
    const result = await runIsolatedArm(
      manifestFile,
      "forced-timeout",
      "same-frontier",
      100,
      timeoutWorker(root, "no-snapshot-worker", false)
    );
    assert.strictEqual(result.unavailable, true);
    assert.strictEqual(result.reason, "worker_timeout_before_snapshot");
    assert.strictEqual(result.timeoutMs, 100);
    assert.strictEqual(result.hardTerminationScope, process.platform === "win32" ? "coordinator_process" : "process_group");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("long-tail evaluator recovers atomic partial evidence after a hard timeout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-long-tail-snapshot-test-"));
  try {
    const result = await runIsolatedArm(
      manifestFile,
      "forced-partial",
      "independent",
      100,
      timeoutWorker(root, "snapshot-worker", true)
    );
    assert.strictEqual(result.marker, "saved");
    assert.deepStrictEqual(result.worker, {
      status: "hard_timeout_snapshot",
      timeoutMs: 100,
      hardTerminationScope: process.platform === "win32" ? "coordinator_process" : "process_group",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
