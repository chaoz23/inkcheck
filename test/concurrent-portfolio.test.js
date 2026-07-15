const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { explorePortfolioConcurrent } = require("../dist/concurrent-portfolio");
const { explorePortfolio } = require("../dist/explore");
const { bindingLimit } = require("../dist/report-contract");
const { compile, scanKnots } = require("../dist/inklecate");

const ROOT = path.join(__dirname, "fixtures", "search");
const GRID = path.join(ROOT, "early-variable-grid.ink");
const PLATEAU = path.join(ROOT, "deceptive-plateau.ink");
const LOW_DEDUP = path.join(ROOT, "low-dedup-wide.ink");
const CLI = path.join(__dirname, "..", "dist", "cli.js");
const ONE_GIB = 1024 * 1024 * 1024;

async function story(file) {
  const compiled = await compile(file);
  assert.strictEqual(compiled.success, true, compiled.issues.map((issue) => issue.raw).join("\n"));
  return { storyJson: compiled.storyJson, knots: scanKnots(file) };
}

function stableEvidence(result) {
  return {
    statesExplored: result.statesExplored,
    endings: result.endingsFound,
    runtimeErrors: result.runtimeErrors,
    assertions: result.assertionResults,
    visitedKnots: result.visitedKnots,
    truncated: result.truncated,
    truncatedBy: result.truncatedBy,
    exhaustive: result.exhaustive,
    schedule: result.schedule,
    passes: result.passes,
    discoveryCurve: result.discoveryCurve,
    discoverySummary: result.discoverySummary,
  };
}

function canonical(value) {
  return JSON.parse(JSON.stringify(value));
}

test("concurrent portfolio grants and final evidence are deterministic across worker ceilings", async () => {
  const compiled = await story(GRID);
  const options = { maxStates: 1_000, seed: 7, storySeed: 1, memoryCapBytes: ONE_GIB };
  const two = explorePortfolioConcurrent(compiled.storyJson, compiled.knots, [], { ...options, concurrency: 2 });
  const four = explorePortfolioConcurrent(compiled.storyJson, compiled.knots, [], { ...options, concurrency: 4 });
  assert.deepStrictEqual(stableEvidence(two), stableEvidence(four));
  assert.strictEqual(two.execution.mode, "concurrent");
  assert.strictEqual(two.execution.effectiveConcurrency, 2);
  const issued = two.schedule.flatMap((round) => round.entries).reduce((total, entry) => total + entry.granted, 0);
  assert.strictEqual(two.execution.workers.reduce((total, worker) => total + worker.granted, 0), issued);
  assert.ok(issued <= 1_000);
  assert.ok(two.execution.workers.every((worker) => worker.consumed <= worker.granted));
  assert.strictEqual(
    two.execution.resources.parentReserveBytes + two.execution.resources.totalWorkerHeapLimitBytes,
    two.execution.resources.heapEnvelopeBytes
  );
  assert.strictEqual(
    two.execution.resources.totalWorkerHeapLimitBytes,
    two.execution.resources.perWorkerHeapLimitBytes * two.execution.effectiveConcurrency
  );
  assert.ok(two.execution.resources.peakTrackedHeapBytes > 0);
  assert.strictEqual(two.execution.resources.aggregateMemoryStopped, false);
  assert.ok(two.discoverySummary.discoveryEvents > 0);

  const sequential = explorePortfolio(compiled.storyJson, compiled.knots, [], options);
  assert.deepStrictEqual({
    endings: two.endingsFound,
    runtimeErrors: two.runtimeErrors,
    assertions: two.assertionResults,
    visitedKnots: two.visitedKnots,
    exhaustive: two.exhaustive,
  }, {
    endings: sequential.endingsFound,
    runtimeErrors: sequential.runtimeErrors,
    assertions: sequential.assertionResults,
    visitedKnots: sequential.visitedKnots,
    exhaustive: sequential.exhaustive,
  });
});

test("concurrent worker failure retains surviving evidence with a distinct binding reason", async () => {
  const compiled = await story(PLATEAU);
  const result = explorePortfolioConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 100,
    seed: 7,
    storySeed: 1,
    concurrency: 2,
    memoryCapBytes: ONE_GIB,
    failPassForTest: "random",
  });
  assert.strictEqual(result.execution.mode, "concurrent");
  assert.strictEqual(result.execution.workers.find((worker) => worker.pass === "random").status, "failed");
  assert.ok(result.statesExplored > 0);
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.truncatedBy.worker, true);
  assert.strictEqual(bindingLimit(result), "worker");
});

test("persistent workers preserve the complete adaptive bounded report", async () => {
  const compiled = await story(GRID);
  const options = { maxStates: 100, seed: 7, storySeed: 1, memoryCapBytes: ONE_GIB };
  const sequential = explorePortfolio(compiled.storyJson, compiled.knots, [], options);
  const concurrent = explorePortfolioConcurrent(compiled.storyJson, compiled.knots, [], { ...options, concurrency: 4 });
  assert.strictEqual(sequential.exhaustive, false);
  assert.deepStrictEqual(canonical(stableEvidence(concurrent)), canonical(stableEvidence(sequential)));
});

test("concurrent workers stream monotonic aggregate budget progress before the final report", async () => {
  const compiled = await story(GRID);
  const updates = [];
  const result = explorePortfolioConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 100,
    concurrency: 2,
    memoryCapBytes: ONE_GIB,
    progressIntervalStates: 1,
    progressIntervalMs: 0,
    onProgress: (progress) => updates.push(progress),
  });
  assert.ok(updates.length > 1);
  assert.ok(updates.every((progress, index) => index === 0 || progress.statesExplored >= updates[index - 1].statesExplored));
  assert.strictEqual(updates.at(-1).statesExplored, result.statesExplored);
  assert.strictEqual(updates.at(-1).endingsFound, result.endingsFound.length);
  assert.strictEqual(updates.at(-1).runtimeErrorsFound, result.runtimeErrors.length);
});

test("concurrent portfolio falls back before spawning when global memory cannot safely fund two workers", async () => {
  const compiled = await story(GRID);
  const result = explorePortfolioConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 100,
    concurrency: 4,
    memoryCapBytes: 128 * 1024 * 1024,
  });
  assert.strictEqual(result.execution.mode, "sequential");
  assert.strictEqual(result.execution.effectiveConcurrency, 1);
  assert.strictEqual(result.execution.fallbackReason, "memory_headroom");
});

test("aggregate worker heap contention stops cooperatively with partial evidence", async () => {
  const compiled = await story(LOW_DEDUP);
  const result = explorePortfolioConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 100_000,
    concurrency: 2,
    memoryCapBytes: ONE_GIB,
    aggregateMemoryUsedForTest: () => ONE_GIB,
  });
  assert.strictEqual(result.execution.mode, "concurrent");
  assert.strictEqual(result.execution.resources.aggregateMemoryStopped, true);
  assert.strictEqual(result.execution.resources.peakTrackedHeapBytes, ONE_GIB);
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.truncatedBy.memory, true);
  assert.strictEqual(result.truncatedBy.maxStates, false);
  assert.ok(result.execution.workers.every((worker) => worker.status === "memory"));
  assert.ok(result.statesExplored < 100_000);
});

test("CLI exposes explicit experimental concurrency and records the effective contract", () => {
  const run = spawnSync(process.execPath, [
    CLI,
    GRID,
    "--max-states", "1000",
    "--concurrency", "2",
    "--no-min-repro",
    "--json",
    "--progress=off",
  ], { encoding: "utf8" });
  assert.strictEqual(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.strictEqual(report.effectiveConfiguration.concurrency, 2);
  assert.strictEqual(report.explore.execution.mode, "concurrent");
  assert.strictEqual(report.explore.execution.requestedConcurrency, 2);
});
