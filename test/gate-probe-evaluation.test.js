"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { childRuntimeArgs, compareArms, markdown, selectedCells } = require("../scripts/gate-probe-evaluation");

function arm(armName, targetStatus) {
  return {
    arm: armName,
    result: {
      storyFingerprint: "same-story",
      statesExplored: 100,
      elapsedMs: 10,
      target: { id: "gate-x", status: targetStatus, witness: targetStatus === "reached", closestDistance: 0 },
      evidence: { runtimeErrors: 0, assertionViolations: 0, endings: 1, visibleOutcomes: 1, visitedKnots: 2, unvisitedKnots: 0 },
    },
  };
}

test("gate probe evaluator compares target reach without coverage claims", () => {
  const comparison = compareArms(arm("baseline", "not_reached_within_limits"), arm("gate-probe", "reached"));
  assert.deepStrictEqual(comparison.targetReached, { baseline: false, gateProbe: true });
  assert.match(comparison.interpretation, /not coverage proof/);
  assert.match(markdown({ cells: [{ id: "control", status: "completed", baseline: arm("baseline", "not_reached_within_limits"), gateProbe: arm("gate-probe", "reached"), comparison }] }), /Gate reach is an intent signal/);
  assert.throws(() => compareArms(arm("baseline", "reached"), { ...arm("gate-probe", "reached"), result: { ...arm("gate-probe", "reached").result, storyFingerprint: "other" } }), /different compiled stories/);
});

test("gate probe manifest leaves expensive authored cells opt-in", () => {
  const manifest = {
    cells: [{ id: "smoke", tier: "smoke" }, { id: "authored-5m", tier: "required" }],
  };
  assert.deepStrictEqual(selectedCells(manifest, []).map((cell) => cell.id), ["smoke"]);
  assert.deepStrictEqual(selectedCells(manifest, ["--include-required"]).map((cell) => cell.id), ["smoke", "authored-5m"]);
});

test("gate probe evaluator preserves an explicit heap ceiling for isolated arms", () => {
  assert.deepStrictEqual(
    childRuntimeArgs(["--trace-warnings", "--max-old-space-size=6144", "--enable-source-maps"]),
    ["--max-old-space-size=6144"]
  );
});

test("gate probe smoke cell runs in isolated baseline and candidate processes", () => {
  const script = path.join(__dirname, "..", "scripts", "gate-probe-evaluation.js");
  const result = spawnSync(process.execPath, [script, "--case", "early-choice-grid-combination-lock", "--budget", "100"], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.cells.length, 1);
  assert.strictEqual(output.cells[0].configuration.maxStates, 100);
  assert.strictEqual(output.cells[0].configuration.maxMemoryMb, undefined);
  assert.strictEqual(output.cells[0].baseline.arm, "baseline");
  assert.strictEqual(output.cells[0].gateProbe.arm, "gate-probe");
  assert.match(output.disclosure, /fresh process/);
});
