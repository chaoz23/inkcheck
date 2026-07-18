const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  CONCURRENCY_ACTIVATION_PILOT_STATES,
  explorePortfolioConcurrent,
  explorePortfolioPilotActivatedConcurrent,
  explorePortfolioPilotHandoffConcurrent,
} = require("../dist/concurrent-portfolio");
const {
  createPortfolioPassEngine,
  explorePortfolio,
  explorePortfolioFromPilot,
} = require("../dist/explore");
const { bindingLimit } = require("../dist/report-contract");
const {
  DEFAULT_AUTO_CONCURRENCY_CEILING,
  resolvePortfolioConcurrency,
} = require("../dist/concurrency-policy");
const { compile, scanKnots } = require("../dist/inklecate");

const ROOT = path.join(__dirname, "fixtures", "search");
const GRID = path.join(ROOT, "early-variable-grid.ink");
const SUSTAINED_GRID = path.join(__dirname, "..", "examples", "early-choice-grid.ink");
const CLEAN_BRANCH = path.join(__dirname, "..", "examples", "clean-branch.ink");
const PLATEAU = path.join(ROOT, "deceptive-plateau.ink");
const LOW_DEDUP = path.join(ROOT, "low-dedup-wide.ink");
const EXACT_REPEAT_LOOP = path.join(__dirname, "fixtures", "loops", "exact-repeat.ink");
const CLI = path.join(__dirname, "..", "dist", "cli.js");

test("handoff pilot declines workers for a proven forced root cycle", async () => {
  const compiled = await compile(EXACT_REPEAT_LOOP);
  assert.strictEqual(compiled.success, true);
  const result = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, scanKnots(EXACT_REPEAT_LOOP), [], {
    maxStates: 10_000,
    maxDepth: 20,
    concurrency: 2,
    memoryCapBytes: 512 * 1024 * 1024,
    activationPilotStatesForTest: 100,
    preserveTurnState: false,
    preserveRandomState: false,
    detectLoopRisks: true,
  });
  assert.strictEqual(result.statesExplored, 1);
  assert.strictEqual(result.execution.effectiveConcurrency, 1);
  assert.strictEqual(result.execution.fallbackReason, "pilot_forced_cycle");
});
const ONE_GIB = 1024 * 1024 * 1024;
const TEST_HANDOFF_PILOT = 32;

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

test("auto concurrency resolves only eligible portfolio work to the handoff executor", () => {
  assert.deepStrictEqual(resolvePortfolioConcurrency(undefined, "portfolio", 0), {
    mode: "auto",
    ceiling: DEFAULT_AUTO_CONCURRENCY_CEILING,
    executor: "auto-handoff",
  });
  assert.deepStrictEqual(resolvePortfolioConcurrency("auto", "shared", 0), {
    mode: "auto",
    ceiling: 1,
    executor: "sequential",
    fallbackReason: "search_mode",
  });
  assert.deepStrictEqual(resolvePortfolioConcurrency("auto", "portfolio", 100), {
    mode: "auto",
    ceiling: 1,
    executor: "sequential",
    fallbackReason: "additive_goals",
  });
  assert.throws(() => resolvePortfolioConcurrency(2, "shared", 0), /requires portfolio search/);
  assert.throws(() => resolvePortfolioConcurrency(2, "portfolio", 100), /does not yet support additive goal states/);
});

test("CLI defaults to workload-aware auto concurrency with an explicit decision", () => {
  const run = spawnSync(process.execPath, [
    CLI,
    path.join(__dirname, "..", "examples", "clean-branch.ink"),
    "--max-states", "100",
    "--no-min-repro",
    "--json",
    "--progress=off",
  ], { encoding: "utf8" });
  assert.strictEqual(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.strictEqual(report.effectiveConfiguration.concurrencyMode, "auto");
  assert.strictEqual(report.effectiveConfiguration.concurrency, 4);
  assert.strictEqual(report.explore.execution.mode, "sequential");
  assert.strictEqual(report.explore.execution.activation.policyVersion, "single-pass-frontier-v3");
  assert.strictEqual(report.explore.execution.activation.reason, "budget_below_pilot");
  assert.strictEqual(report.explore.execution.activation.duplicateStateEvaluations, 0);
});

test("CLI preserves explicit fixed concurrency and the hard single-worker opt-out", () => {
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
  assert.strictEqual(report.effectiveConfiguration.concurrencyMode, "fixed");
  assert.strictEqual(report.explore.execution.mode, "concurrent");
  assert.strictEqual(report.explore.execution.requestedConcurrency, 2);

  const single = spawnSync(process.execPath, [
    CLI,
    GRID,
    "--max-states", "100",
    "--concurrency=1",
    "--no-min-repro",
    "--json",
    "--progress=off",
  ], { encoding: "utf8" });
  assert.strictEqual(single.status, 0, single.stderr);
  const singleReport = JSON.parse(single.stdout);
  assert.strictEqual(singleReport.effectiveConfiguration.concurrencyMode, "fixed");
  assert.strictEqual(singleReport.effectiveConfiguration.concurrency, 1);
  assert.strictEqual(singleReport.explore.execution, undefined);
});

test("1,024-state activation pilot stays sequential at a consumed ceiling", async () => {
  const compiled = await story(GRID);
  const result = explorePortfolioPilotActivatedConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 100,
    concurrency: 4,
    memoryCapBytes: ONE_GIB,
  });
  assert.strictEqual(CONCURRENCY_ACTIVATION_PILOT_STATES, 1_024);
  assert.strictEqual(result.execution.mode, "sequential");
  assert.deepStrictEqual(result.execution.activation, {
    policyVersion: "pilot-frontier-v2",
    decision: "stay_sequential",
    reason: "pilot_consumed_budget",
    pilotBudget: 100,
    pilotStatesExplored: result.statesExplored,
    pilotExhaustive: false,
    duplicateStateEvaluations: 0,
    uncertainty: "high",
    productionEligible: false,
  });
});

test("1,024-state activation pilot reports duplicate work before concurrency", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const result = explorePortfolioPilotActivatedConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 2_000,
    concurrency: 2,
    memoryCapBytes: ONE_GIB,
  });
  assert.strictEqual(result.execution.mode, "concurrent");
  assert.deepStrictEqual(result.execution.activation, {
    policyVersion: "pilot-frontier-v2",
    decision: "activate_concurrent",
    reason: "pilot_open_frontier",
    pilotBudget: 1_024,
    pilotStatesExplored: 1_024,
    pilotExhaustive: false,
    duplicateStateEvaluations: 1_024,
    uncertainty: "high",
    productionEligible: false,
  });
  assert.strictEqual(result.statesExplored, 2_000);
});

test("activation pilot rejects a depth-bound workload that concurrency cannot repair", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const result = explorePortfolioPilotActivatedConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 2_000,
    maxDepth: 5,
    concurrency: 2,
    memoryCapBytes: ONE_GIB,
  });
  assert.strictEqual(result.execution.mode, "sequential");
  assert.strictEqual(result.execution.activation.reason, "pilot_depth_bound");
  assert.strictEqual(result.execution.activation.duplicateStateEvaluations, 1_024);
  assert.strictEqual(result.execution.activation.productionEligible, false);
});

test("activation pilot rejects a saturated authored frontier", async () => {
  const compiled = await story(path.join(ROOT, "storylet-machine.ink"));
  const result = explorePortfolioPilotActivatedConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 2_000,
    maxDepth: 100,
    concurrency: 2,
    memoryCapBytes: ONE_GIB,
  });
  assert.strictEqual(result.execution.mode, "sequential");
  assert.strictEqual(result.execution.activation.reason, "pilot_authored_frontier_saturated");
  assert.strictEqual(result.execution.activation.duplicateStateEvaluations, 1_024);
});

test("a live pilot continues inside the sequential adaptive ceiling", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const options = { maxStates: 2_000, maxDepth: 100, seed: 7, storySeed: 1 };
  const engine = createPortfolioPassEngine(
    "dfs:inside-out",
    compiled.storyJson,
    compiled.knots,
    [],
    options
  );
  const consumed = engine.run(TEST_HANDOFF_PILOT);
  const result = explorePortfolioFromPilot(compiled.storyJson, compiled.knots, [], options, {
    pass: "dfs:inside-out",
    engine,
    granted: TEST_HANDOFF_PILOT,
    consumed,
  });
  const scheduled = result.schedule.flatMap((round) => round.entries)
    .reduce((total, entry) => total + entry.consumed, 0);
  assert.strictEqual(consumed, TEST_HANDOFF_PILOT);
  assert.strictEqual(result.statesExplored, 2_000);
  assert.strictEqual(scheduled, 2_000);
  assert.deepStrictEqual(result.schedule[0].entries.map((entry) => entry.pass), [
    "dfs:last", "dfs:first", "dfs:inside-out", "beam:w=64", "random:seed=7",
  ]);
  assert.ok(result.schedule[0].entries.find((entry) => entry.pass === "dfs:inside-out").consumed >= TEST_HANDOFF_PILOT);
  assert.ok(result.passes.find((pass) => pass.pass === "dfs:inside-out").statesExplored >= TEST_HANDOFF_PILOT);
});

test("single-pass handoff activates without duplicate work or budget drift", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const progress = [];
  const result = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 2_000,
    maxDepth: 100,
    seed: 7,
    storySeed: 1,
    concurrency: 4,
    memoryCapBytes: ONE_GIB,
    activationPilotStatesForTest: TEST_HANDOFF_PILOT,
    onProgress: (event) => progress.push(event),
  });
  const scheduled = result.schedule.flatMap((round) => round.entries)
    .reduce((total, entry) => total + entry.consumed, 0);
  assert.strictEqual(result.execution.mode, "concurrent");
  assert.strictEqual(result.execution.activation.policyVersion, "single-pass-frontier-v3");
  assert.strictEqual(result.execution.activation.productionEligible, true);
  assert.strictEqual(result.execution.activation.decision, "activate_concurrent");
  assert.strictEqual(result.execution.activation.pilotPass, "dfs:inside-out");
  assert.strictEqual(result.execution.activation.duplicateStateEvaluations, 0);
  assert.strictEqual(result.statesExplored, 2_000);
  assert.strictEqual(scheduled, 2_000);
  assert.ok(result.schedule[0].entries.find((entry) => entry.pass === "dfs:inside-out").consumed >= TEST_HANDOFF_PILOT);
  assert.strictEqual(result.execution.workers.find((worker) => worker.location === "parent").pass, "dfs:inside-out");
  assert.strictEqual(
    result.execution.resources.parentReserveBytes + result.execution.resources.totalWorkerHeapLimitBytes,
    result.execution.resources.heapEnvelopeBytes
  );
  assert.ok(progress.length > 1);
  assert.strictEqual(progress[0].statesExplored, TEST_HANDOFF_PILOT);
  assert.ok(progress.every((event, index) => index === 0 || event.statesExplored >= progress[index - 1].statesExplored));
  assert.strictEqual(progress.at(-1).statesExplored, 2_000);
});

test("single-pass handoff preserves the portfolio below the pilot threshold", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const options = { maxStates: 100, maxDepth: 100, seed: 7, storySeed: 1 };
  const baseline = explorePortfolio(compiled.storyJson, compiled.knots, [], options);
  const result = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, compiled.knots, [], {
    ...options,
    concurrency: 4,
    memoryCapBytes: ONE_GIB,
    activationPilotStatesForTest: TEST_HANDOFF_PILOT,
  });
  assert.deepStrictEqual(canonical(stableEvidence(result)), canonical(stableEvidence(baseline)));
  assert.strictEqual(result.execution.mode, "sequential");
  assert.strictEqual(result.execution.activation.reason, "budget_below_pilot");
  assert.strictEqual(result.execution.activation.pilotStatesExplored, 0);
});

test("an exhaustive live pilot retains pass telemetry and its executed schedule", async () => {
  const compiled = await story(CLEAN_BRANCH);
  const result = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 100_000,
    maxDepth: 100,
    concurrency: 4,
    memoryCapBytes: ONE_GIB,
  });
  assert.strictEqual(result.execution.activation.reason, "pilot_exhaustive");
  assert.strictEqual(result.execution.activation.duplicateStateEvaluations, 0);
  assert.deepStrictEqual(result.passes.map((pass) => pass.pass), ["dfs:inside-out"]);
  assert.deepStrictEqual(result.schedule.map((round) => round.entries.map((entry) => entry.pass)), [["dfs:inside-out"]]);
  assert.strictEqual(result.schedule[0].entries[0].consumed, result.statesExplored);
  assert.strictEqual(result.exhaustive, true);
});

test("single-pass handoff rejects depth-bound work without restarting the pilot", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const result = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 2_000,
    maxDepth: 5,
    concurrency: 4,
    memoryCapBytes: ONE_GIB,
    activationPilotStatesForTest: TEST_HANDOFF_PILOT,
  });
  const scheduled = result.schedule.flatMap((round) => round.entries)
    .reduce((total, entry) => total + entry.consumed, 0);
  assert.strictEqual(result.execution.mode, "sequential");
  assert.strictEqual(result.execution.activation.reason, "pilot_depth_bound");
  assert.strictEqual(result.execution.activation.duplicateStateEvaluations, 0);
  assert.strictEqual(result.statesExplored, 2_000);
  assert.strictEqual(scheduled, 2_000);
  assert.ok(result.schedule[0].entries.find((entry) => entry.pass === "dfs:inside-out").consumed >= result.execution.activation.pilotStatesExplored);
  assert.strictEqual(result.execution.activation.pilotStatesExplored, TEST_HANDOFF_PILOT);
});

test("single-pass handoff retains pilot evidence when a worker fails", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const result = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 2_000,
    maxDepth: 100,
    concurrency: 4,
    memoryCapBytes: ONE_GIB,
    activationPilotStatesForTest: TEST_HANDOFF_PILOT,
    failPassForTest: "random",
  });
  assert.strictEqual(result.execution.activation.decision, "activate_concurrent");
  assert.strictEqual(result.execution.activation.duplicateStateEvaluations, 0);
  assert.strictEqual(result.truncatedBy.worker, true);
  assert.ok(result.statesExplored >= TEST_HANDOFF_PILOT);
  assert.ok(result.visitedKnots.length > 0);
  assert.strictEqual(result.execution.workers.find((worker) => worker.location === "parent").status, "completed");
});

test("single-pass handoff is deterministic across worker ceilings", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const options = { maxStates: 2_000, maxDepth: 100, seed: 7, storySeed: 1, memoryCapBytes: ONE_GIB, activationPilotStatesForTest: TEST_HANDOFF_PILOT };
  const two = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, compiled.knots, [], { ...options, concurrency: 2 });
  const four = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, compiled.knots, [], { ...options, concurrency: 4 });
  assert.deepStrictEqual(canonical(stableEvidence(two)), canonical(stableEvidence(four)));
  assert.strictEqual(two.execution.activation.duplicateStateEvaluations, 0);
  assert.strictEqual(four.execution.activation.duplicateStateEvaluations, 0);
});

test("single-pass handoff preserves its pilot under aggregate memory contention", async () => {
  const compiled = await story(SUSTAINED_GRID);
  const result = explorePortfolioPilotHandoffConcurrent(compiled.storyJson, compiled.knots, [], {
    maxStates: 100_000,
    maxDepth: 100,
    concurrency: 4,
    memoryCapBytes: ONE_GIB,
    aggregateMemoryUsedForTest: () => ONE_GIB,
  });
  assert.strictEqual(result.execution.activation.decision, "activate_concurrent");
  assert.strictEqual(result.execution.activation.duplicateStateEvaluations, 0);
  assert.strictEqual(result.execution.resources.aggregateMemoryStopped, true);
  assert.strictEqual(result.truncatedBy.memory, true);
  assert.strictEqual(result.truncatedBy.maxStates, false);
  assert.ok(result.statesExplored >= result.execution.activation.pilotStatesExplored);
  assert.ok(result.statesExplored < 100_000);
  assert.ok(result.visitedKnots.length > 0);
});
