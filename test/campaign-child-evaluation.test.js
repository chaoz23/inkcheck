"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "dist", "campaign-child-evaluation-cli.js");
const MANIFEST = path.join(ROOT, "benchmarks", "campaign-child-evaluation-v1.json");

test("campaign-child evaluator proves the finite control and preserves base evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-campaign-child-eval-"));
  const output = path.join(root, "result.json");
  try {
    const run = spawnSync(process.execPath, [
      CLI,
      MANIFEST,
      "--output",
      output,
      "--case",
      "exhaustive-control",
    ], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
    assert.strictEqual(run.status, 0, run.stderr);

    const result = JSON.parse(fs.readFileSync(output, "utf8"));
    assert.strictEqual(result.cases.length, 1);
    const control = result.cases[0];
    assert.strictEqual(control.goalCampaign.base.summary.result.exhaustive, true);
    assert.strictEqual(control.goalCampaign.base.consumed, 2);
    assert.strictEqual(control.goalCampaign.child.goal.status, "reached");
    assert.strictEqual(control.assertionCampaign.child.assertions[0].status, "violated");
    assert.strictEqual(control.goalCampaign.child.ledger.purpose, "approved_goal");
    assert.strictEqual(control.assertionCampaign.child.ledger.purpose, "assertion");
    assert.deepStrictEqual(control.goalCampaign.invariants, {
      baseReportPreserved: true,
      baseCheckpointPreserved: true,
      protectedBaseGrantPreserved: true,
      specialistClaimsNoBroadYield: true,
    });
    assert.deepStrictEqual(control.assertionCampaign.invariants, control.goalCampaign.invariants);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
