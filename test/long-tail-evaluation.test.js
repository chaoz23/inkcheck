const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

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
});
