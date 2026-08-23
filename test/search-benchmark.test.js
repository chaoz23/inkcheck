const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const { compile, scanKnots } = require("../dist/inklecate");
const {
  MAX_SHARED_OBSERVABILITY_SAMPLES,
  SHARED_OBSERVABILITY_REASON_ORDER_V2,
  SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION,
  explore,
  explorePortfolio,
  exploreRandom,
  exploreShared,
  exploreSharedResumable,
} = require("../dist/explore");
const { createResourceGuards } = require("../dist/resource-guards");
const {
  runSearchBenchmark,
  summarizeSearchResult,
  terminalStateKey,
  variableChanges,
  variableStateKey,
  variableTransitionKey,
  visibleEndingKey,
  rarityWeight,
} = require("../dist/search-benchmark");
const {
  evaluateShadowBudgetLadder,
  renderShadowEvaluationMarkdown,
} = require("../dist/shadow-evaluation");
const {
  comparePromotionPair,
  deterministicPromotionView,
  renderPromotionMarkdown,
  summarizePromotionFamilies,
  summarizePromotionProjects,
  validatePromotionManifest,
} = require("../dist/promotion-benchmark");

const FIXTURES = path.join(__dirname, "fixtures", "search");
const LOCK = path.join(FIXTURES, "combination-lock.ink");
const PLATEAU = path.join(FIXTURES, "deceptive-plateau.ink");
const STORYLETS = path.join(FIXTURES, "storylet-machine.ink");
const EARLY_GRID = path.join(FIXTURES, "early-variable-grid.ink");
const FINITE_LOOP = path.join(FIXTURES, "finite-counter-loop.ink");
const GATED_ENDING = path.join(FIXTURES, "gated-ending.ink");
const LOW_DEDUP_WIDE = path.join(FIXTURES, "low-dedup-wide.ink");
const DEEP_BRANCHING = path.join(FIXTURES, "deep-branching.ink");
const AUTHORED_DOG = path.join(__dirname, "..", "benchmarks", "authored", "dog-ink-adventure", "root.ink");
const PROMOTION_CLI = path.join(__dirname, "..", "dist", "promotion-benchmark-cli.js");

const EMPTY_TRUNCATION = {
  maxDepth: false,
  maxStates: false,
  beamWidth: false,
  frontier: false,
  memory: false,
  time: false,
};

const SHARED_OBSERVABILITY_REASON_ORDER = [...SHARED_OBSERVABILITY_REASON_ORDER_V2];
const SHARED_OBSERVABILITY_REASON_RANK = new Map(
  SHARED_OBSERVABILITY_REASON_ORDER.map((reason, index) => [reason, index])
);
const SHARED_OBSERVABILITY_TRIGGER_YIELD_REASONS = SHARED_OBSERVABILITY_REASON_ORDER.slice(1, 9);
const SHARED_OBSERVABILITY_CHECKPOINT_V2_INTEGRITY_DOMAIN =
  "inkcheck:shared-observability-checkpoint:v2\0";

function sharedObservabilityTriggerMask(reasons) {
  return reasons.reduce(
    (mask, reason) => mask | (1 << SHARED_OBSERVABILITY_REASON_RANK.get(reason)),
    0
  );
}

function sharedObservabilityCheckpointIntegrity(observability) {
  const { integritySha256: _integritySha256, ...body } = observability;
  return createHash("sha256")
    .update(SHARED_OBSERVABILITY_CHECKPOINT_V2_INTEGRITY_DOMAIN)
    .update(JSON.stringify(body))
    .digest("hex");
}

function refreshSharedObservabilityCheckpointIntegrity(observability) {
  observability.integritySha256 = sharedObservabilityCheckpointIntegrity(observability);
}

function assertSharedObservabilityCheckpointIntegrity(observability) {
  assert.match(observability.integritySha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(
    observability.integritySha256,
    sharedObservabilityCheckpointIntegrity(observability)
  );
}

function assertCanonicalSharedSamples(samples) {
  let previousSequence = -1;
  let previousState = -1;
  for (const [index, sample] of samples.entries()) {
    assert.strictEqual(sample.schemaVersion, 2);
    assert.ok(Number.isSafeInteger(sample.sequence));
    if (index === 0) assert.strictEqual(sample.sequence, 1, "the first retained sequence must survive compaction");
    assert.ok(sample.sequence > previousSequence, "sample sequences must increase");
    assert.ok(sample.state > previousState, "coalesced sample states must increase");
    assert.ok(sample.reasons.length > 0);
    assert.strictEqual(new Set(sample.reasons).size, sample.reasons.length, "sample reasons must be unique");
    assert.ok(sample.reasons.every((reason) => SHARED_OBSERVABILITY_REASON_RANK.has(reason)));
    assert.deepStrictEqual(
      sample.reasons,
      [...sample.reasons].sort(
        (left, right) => SHARED_OBSERVABILITY_REASON_RANK.get(left)
          - SHARED_OBSERVABILITY_REASON_RANK.get(right)
      ),
      "sample reasons must use canonical order"
    );
    assert.strictEqual(
      sample.triggerMask,
      sharedObservabilityTriggerMask(sample.reasons),
      "the per-boundary trigger mask must match the exact retained reasons"
    );
    assert.ok(Array.isArray(sample.triggerYield));
    assert.strictEqual(sample.triggerYield.length, SHARED_OBSERVABILITY_TRIGGER_YIELD_REASONS.length);
    assert.ok(sample.triggerYield.every((count) => Number.isSafeInteger(count) && count >= 0));
    assert.deepStrictEqual(
      sample.reasons.filter((reason) => SHARED_OBSERVABILITY_TRIGGER_YIELD_REASONS.includes(reason)),
      SHARED_OBSERVABILITY_TRIGGER_YIELD_REASONS.filter((_, triggerIndex) => (
        sample.triggerYield[triggerIndex] > 0
      )),
      "yield reason bits must match the exact-at-boundary trigger tuple"
    );
    previousSequence = sample.sequence;
    previousState = sample.state;
  }
}

function withoutSharedObservability(report) {
  const copy = structuredClone(report);
  for (const pass of copy.passes) delete pass.sharedObservability;
  return copy;
}

function subtractSharedYieldForV1(current, previous) {
  return {
    critical: {
      runtimeErrors: current.critical.runtimeErrors - previous.critical.runtimeErrors,
      assertionViolations: current.critical.assertionViolations - previous.critical.assertionViolations,
    },
    intent: {
      goalsReached: current.intent.goalsReached - previous.intent.goalsReached,
      stagesReached: current.intent.stagesReached - previous.intent.stagesReached,
    },
    authoredCoverage: {
      knotsVisited: current.authoredCoverage.knotsVisited - previous.authoredCoverage.knotsVisited,
    },
    visibleOutcomes: current.visibleOutcomes - previous.visibleOutcomes,
    semanticTransitions: current.semanticTransitions - previous.semanticTransitions,
    terminalVariants: current.terminalVariants - previous.terminalVariants,
    rawTerritory: {
      transitions: current.rawTerritory.transitions - previous.rawTerritory.transitions,
      uniqueStates: current.rawTerritory.uniqueStates - previous.rawTerritory.uniqueStates,
      dedupeHits: current.rawTerritory.dedupeHits - previous.rawTerritory.dedupeHits,
    },
  };
}

function withV1SharedObservability(checkpoint) {
  const migrated = structuredClone(checkpoint);
  const v2 = migrated.state.sharedObservability;
  const cadenceSamples = v2.samples.filter((sample) => sample.reasons.includes("cadence"));
  let previousState = v2.baseState;
  let previousYield = v2.baseYield;
  const samples = cadenceSamples.map((sample) => {
    const cumulative = structuredClone(sample.yield.cumulative);
    const converted = {
      schemaVersion: 1,
      boundary: "interval",
      state: sample.state,
      retention: structuredClone(sample.retention),
      yield: {
        schemaVersion: 1,
        fromStateExclusive: previousState,
        throughState: sample.state,
        delta: subtractSharedYieldForV1(cumulative, previousYield),
        cumulative,
      },
    };
    previousState = sample.state;
    previousYield = cumulative;
    return converted;
  });
  migrated.state.sharedObservability = {
    schemaVersion: 1,
    sampleIntervalStates: v2.sampleIntervalStates,
    samplesRecorded: v2.cadenceSamplesRecorded,
    samples,
    baseState: v2.baseState,
    baseYield: structuredClone(v2.baseYield),
    previousSampleState: previousState,
    previousYield: structuredClone(previousYield),
    nextSampleState: v2.nextSampleState,
    firstUsefulAtState: v2.firstUsefulAtState,
    firstCriticalAtState: v2.firstCriticalAtState,
    throughFirstUseful: structuredClone(v2.throughFirstUseful),
    historyComplete: v2.historyComplete,
  };
  return migrated;
}

function ending(variables) {
  return {
    path: ["Finish"],
    finalText: "Same authored outcome.\n",
    variables,
    foundBy: "fixture",
  };
}

test("terminal-state identity stays exact while visible outcomes ignore final variables", () => {
  const a = ending({ gold: 1 });
  const b = ending({ gold: 2 });
  assert.notStrictEqual(terminalStateKey(a), terminalStateKey(b));
  assert.strictEqual(visibleEndingKey(a), visibleEndingKey(b));
});

test("benchmark summary separates useful outcomes from terminal-state multiplicity", () => {
  const report = {
    statesExplored: 2,
    endingsFound: [ending({ gold: 1 }), ending({ gold: 2 })],
    runtimeErrors: [],
    runtimeWarnings: [],
    unvisitedKnots: [],
    visitedKnots: ["ending"],
    externalFunctionsStubbed: [],
    randomnessDetected: false,
    truncated: false,
    truncatedBy: EMPTY_TRUNCATION,
    exhaustive: true,
    limits: { maxDepth: 30, maxStates: 2, storySeed: 1 },
    passes: [],
  };
  const summary = summarizeSearchResult("fixture", report);
  assert.strictEqual(summary.stateSpace.terminalStates, 2);
  assert.strictEqual(summary.stateSpace.terminalVariableStates, 2);
  assert.deepStrictEqual(summary.findings.visibleEndings, ["Same authored outcome."]);
  assert.deepStrictEqual(summary.findings.visitedKnots, ["ending"]);
  assert.strictEqual(summary.findings.terminalStates.length, 2);
  assert.deepStrictEqual(summary.findings.assertionViolations, []);
  assert.deepStrictEqual(summary.configuration, { storySeed: 1 });
});

test("promotion manifest declares twenty consent-safe structural cases", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "benchmarks", "promotion-manifest.json"), "utf8"));
  validatePromotionManifest(manifest);
  assert.strictEqual(manifest.cases.length, 20);
  assert.ok(manifest.cases.filter((entry) => entry.ci).length >= 8);
  assert.ok(manifest.cases.some((entry) => entry.family === "host-externals"));
  assert.ok(manifest.cases.some((entry) => entry.family === "random-and-turn-state"));
  assert.strictEqual(manifest.cases.find((entry) => entry.family === "random-and-turn-state").storySeed, 1);
  assert.ok(manifest.cases.some((entry) => entry.assertions?.length));
});

test("authored promotion manifest pins consent-safe small, medium, and large projects", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "benchmarks", "authored-promotion-manifest.json"), "utf8"));
  validatePromotionManifest(manifest);
  assert.strictEqual(manifest.tier, "authored-project");
  assert.strictEqual(manifest.cases.length, 3);
  assert.deepStrictEqual(new Set(manifest.cases.map((entry) => entry.projectSize)), new Set(["small", "medium", "large"]));
  for (const entry of manifest.cases) {
    assert.ok(entry.budgets.includes(5_000_000));
    assert.match(entry.source.commit, /^[0-9a-f]{40}$/);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "benchmarks", entry.story)));
    assert.ok(fs.existsSync(path.join(__dirname, "..", "benchmarks", entry.source.licenseFile)));
  }
});

test("promotion comparison keeps critical losses separate and timing observational", () => {
  const report = shadowReport(100);
  const baselineSummary = summarizeSearchResult("fixed-portfolio", {
    ...report,
    runtimeErrors: [{
      message: "baseline-only failure",
      path: [],
      choiceIndices: [],
      foundBy: "fixture",
      firstDiscoveredAtState: 1,
      sourceLocation: { file: "story.ink", line: 3, approximate: false },
    }],
  });
  const candidateSummary = summarizeSearchResult("policy-v2-replay", report);
  const pair = comparePromotionPair({
    caseId: "critical",
    family: "sparse-runtime-failure",
    source: { name: "fixture", license: "MIT", consent: "repository fixture" },
    budget: 100,
    depth: 30,
    seed: 7,
    storySeed: 1,
    baseline: {
      elapsedMs: 12,
      peakRssBytes: 1000,
      resourceLimits: { memoryCapBytes: 1024, timeLimitMs: null },
      workerExit: "completed",
      summary: baselineSummary,
    },
    candidate: {
      elapsedMs: 15,
      peakRssBytes: 1200,
      resourceLimits: { memoryCapBytes: 2048, timeLimitMs: 60_000 },
      workerExit: "completed",
      summary: candidateSummary,
    },
  });
  assert.strictEqual(pair.comparison.regressionRisk, "critical");
  assert.strictEqual(pair.comparison.baselineOnly.runtimeErrors.length, 1);

  const promotion = {
    schemaVersion: 1,
    generatedAt: "unstable",
    candidate: "policy-v2-replay",
    baseline: "fixed-portfolio",
    caveat: "bounded",
    pairs: [pair],
    families: summarizePromotionFamilies([pair]),
    projects: summarizePromotionProjects([pair]),
    unavailable: [{
      caseId: "critical",
      family: "sparse-runtime-failure",
      budget: 5_000_000,
      depth: 30,
      seed: 7,
      storySeed: 1,
      stage: "candidate",
      reason: "worker-timeout",
      timeoutMs: 600_000,
    }],
  };
  const deterministic = JSON.stringify(deterministicPromotionView(promotion));
  assert.doesNotMatch(deterministic, /elapsedMs|peakRssBytes|generatedAt/);
  assert.match(renderPromotionMarkdown(promotion), /Worst-family view/);
  const markdown = renderPromotionMarkdown(promotion);
  assert.match(markdown, /Baseline: `fixed-portfolio`/);
  assert.match(markdown, /Candidate: `policy-v2-replay`/);
  assert.ok(markdown.indexOf("Resource-unavailable cells") < markdown.indexOf("Worst-project view"));
  assert.ok(markdown.indexOf("Worst-project view") < markdown.indexOf("Matched runs"));
  assert.match(deterministic, /worker-timeout/);
  assert.match(deterministic, /memoryCapBytes/);
});

test("promotion comparison separates semantic runtime retention from approximate metadata drift", () => {
  const report = shadowReport(100);
  const runtime = {
    message: "RUNTIME ERROR: ran out of content. Do you need a '-> DONE' or '-> END'?",
    path: ["Left"],
    choiceIndices: [0],
    foundBy: "dfs:first",
    firstDiscoveredAtState: 7,
    sourceLocation: { file: "story.ink", line: 21, approximate: true },
  };
  const summary = (strategy, line) => summarizeSearchResult(strategy, {
    ...report,
    runtimeErrors: [{ ...runtime, sourceLocation: { ...runtime.sourceLocation, line } }],
  });
  const pair = comparePromotionPair({
    caseId: "approximate-location-drift",
    family: "sparse-runtime-failure",
    source: { name: "fixture", license: "MIT", consent: "repository fixture" },
    budget: 100,
    depth: 30,
    seed: 7,
    storySeed: 1,
    baseline: {
      elapsedMs: 1,
      peakRssBytes: 1,
      resourceLimits: { memoryCapBytes: 1024, timeLimitMs: null },
      workerExit: "completed",
      summary: summary("fixed-portfolio", 21),
    },
    candidate: {
      elapsedMs: 1,
      peakRssBytes: 1,
      resourceLimits: { memoryCapBytes: 1024, timeLimitMs: null },
      workerExit: "completed",
      summary: summary("candidate", 27),
    },
  });
  assert.deepStrictEqual(pair.comparison.baselineOnly.runtimeErrors, []);
  assert.deepStrictEqual(pair.comparison.candidateOnly.runtimeErrors, []);
  assert.strictEqual(pair.comparison.regressionRisk, "none");
  assert.strictEqual(pair.comparison.gainClass, "none");
  assert.strictEqual(pair.comparison.runtimeMetadataDrift.drift, true);
  assert.strictEqual(pair.comparison.runtimeMetadataDrift.baselineOnly.length, 1);
  assert.strictEqual(pair.comparison.runtimeMetadataDrift.candidateOnly.length, 1);
});

test("resource guards expose explicit caps without choosing an efficiency stop", () => {
  const guards = createResourceGuards({ maxMemoryMb: 512, maxTimeMs: 10_000, startedAtMs: 1_000 });
  assert.strictEqual(guards.memoryCapBytes, 512 * 1024 * 1024);
  assert.strictEqual(guards.memorySearchLimitBytes, 512 * 1024 * 1024);
  assert.strictEqual(guards.deadlineMs, 11_000);
  assert.strictEqual(typeof guards.memoryGuard, "function");
  assert.strictEqual(typeof guards.timeGuard, "function");

  const reserved = createResourceGuards({
    maxMemoryMb: 512,
    maxTimeMs: 10_000,
    startedAtMs: 1_000,
    finalizationMemoryReserveMb: 128,
    finalizationTimeReserveMs: 500,
  });
  assert.strictEqual(reserved.memoryCapBytes, 512 * 1024 * 1024);
  assert.strictEqual(reserved.memorySearchLimitBytes, 384 * 1024 * 1024);
  assert.strictEqual(reserved.deadlineMs, 10_500);
});

test("shared benchmark summaries retain serialized-frontier high-water evidence", async () => {
  const compiled = await compile(EARLY_GRID);
  const report = exploreShared(compiled.storyJson, scanKnots(EARLY_GRID), [], { maxStates: 100 });
  const summary = summarizeSearchResult("shared", report);
  assert.ok(summary.stateSpace.peakPendingStates >= 1);
  assert.ok(summary.stateSpace.peakPendingBytes >= 1);
  assert.ok(summary.passes.some((pass) => pass.peakPendingBytes >= 1));
});

test("promotion harness can measure shared-checkpoint resource evidence", () => {
  const proc = spawnSync(process.execPath, [
    PROMOTION_CLI,
    path.join(__dirname, "..", "benchmarks", "promotion-manifest.json"),
    "--ci",
    "--case", "combination-lock",
    "--budget", "100",
    "--candidate-strategy", "shared-checkpoint",
    "--worker-max-memory-mb", "256",
    "--worker-timeout-ms", "30000",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.strictEqual(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.strictEqual(report.baseline, "fixed-portfolio");
  assert.strictEqual(report.candidate, "shared-checkpoint");
  assert.ok(report.pairs.length > 0);
  for (const pair of report.pairs) {
    assert.strictEqual(pair.candidate.summary.strategy, "shared-checkpoint");
    assert.ok(pair.candidate.summary.passes.some((pass) => pass.sharedMemory));
    assert.ok(Number.isFinite(pair.candidate.elapsedMs));
    assert.ok(pair.candidate.peakRssBytes > 0);
    assert.strictEqual(pair.candidate.resourceLimits.memoryCapBytes, 256 * 1024 * 1024);
    assert.strictEqual(pair.candidate.resourceLimits.timeLimitMs, 27_000);
  }
});

test("promotion harness measures concurrent time-to-meaningful result windows", () => {
  const proc = spawnSync(process.execPath, [
    PROMOTION_CLI,
    path.join(__dirname, "..", "benchmarks", "promotion-manifest.json"),
    "--ci",
    "--case", "combination-lock",
    "--budget", "100",
    "--candidate-strategy", "concurrent-portfolio",
    "--candidate-concurrency", "2",
    "--worker-max-memory-mb", "512",
    "--worker-timeout-ms", "30000",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.strictEqual(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.strictEqual(report.candidate, "concurrent-portfolio");
  assert.deepStrictEqual(report.candidateConfiguration, { concurrency: 2 });
  assert.ok(report.pairs.length > 0);
  for (const pair of report.pairs) {
    assert.strictEqual(pair.candidate.summary.strategy, "concurrent-portfolio");
    for (const side of ["baseline", "candidate"]) {
      assert.strictEqual(pair[side].discoveryTiming.definition, "runtime_assertion_knot_visible_ending");
      assert.deepStrictEqual(pair[side].discoveryTiming.milestones.map((entry) => entry.count), [1, 5, 10]);
      assert.ok(pair[side].discoveryTiming.finalMeaningfulEvidence >= 1);
      assert.ok(Number.isFinite(pair[side].discoveryTiming.milestones[0].elapsedMs));
    }
  }
});

test("promotion harness records the research-only concurrency activation pilot", () => {
  const proc = spawnSync(process.execPath, [
    PROMOTION_CLI,
    path.join(__dirname, "..", "benchmarks", "promotion-manifest.json"),
    "--ci",
    "--case", "early-choice-grid",
    "--budget", "100",
    "--candidate-strategy", "pilot-concurrent-portfolio",
    "--candidate-concurrency", "2",
    "--worker-max-memory-mb", "512",
    "--worker-timeout-ms", "30000",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.strictEqual(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.strictEqual(report.candidate, "pilot-concurrent-portfolio");
  assert.deepStrictEqual(report.candidateConfiguration, { concurrency: 2, pilotStates: 1_024 });
  assert.ok(report.pairs.length > 0);
  for (const pair of report.pairs) {
    assert.strictEqual(pair.candidate.summary.activation.decision, "stay_sequential");
    assert.strictEqual(pair.candidate.summary.activation.duplicateStateEvaluations, 0);
    assert.strictEqual(pair.candidate.summary.activation.productionEligible, false);
    assert.strictEqual(pair.comparison.regressionRisk, "none");
  }
});

test("promotion harness measures exact-budget live pilot handoff", () => {
  const proc = spawnSync(process.execPath, [
    PROMOTION_CLI,
    path.join(__dirname, "..", "benchmarks", "promotion-manifest.json"),
    "--ci",
    "--case", "early-choice-grid",
    "--budget", "100",
    "--candidate-strategy", "handoff-concurrent-portfolio",
    "--candidate-concurrency", "2",
    "--worker-max-memory-mb", "512",
    "--worker-timeout-ms", "30000",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.strictEqual(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.strictEqual(report.candidate, "handoff-concurrent-portfolio");
  assert.deepStrictEqual(report.candidateConfiguration, { concurrency: 2, pilotStates: 1_024 });
  for (const pair of report.pairs) {
    assert.strictEqual(pair.candidate.summary.activation.productionEligible, true);
    assert.strictEqual(pair.candidate.summary.activation.reason, "budget_below_pilot");
    assert.strictEqual(pair.candidate.summary.activation.duplicateStateEvaluations, 0);
    assert.strictEqual(pair.candidate.summary.statesExplored, pair.baseline.summary.statesExplored);
    assert.strictEqual(pair.comparison.regressionRisk, "none");
  }
});

test("promotion workers return guarded partial comparisons instead of crashing", () => {
  const proc = spawnSync(process.execPath, [
    PROMOTION_CLI,
    path.join(__dirname, "..", "benchmarks", "promotion-manifest.json"),
    "--case", "deep-chain",
    "--budget", "100",
    "--worker-max-memory-mb", "1",
    "--worker-timeout-ms", "30000",
    "--deterministic",
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.strictEqual(proc.status, 0, proc.stderr);
  const report = JSON.parse(proc.stdout);
  assert.ok(report.pairs.length > 0);
  for (const pair of report.pairs) {
    for (const side of ["baseline", "candidate"]) {
      assert.strictEqual(pair.resources[side].workerExit, "completed");
      assert.strictEqual(pair.resources[side].resourceLimits.memoryCapBytes, 1024 * 1024);
      assert.strictEqual(pair.resources[side].resourceLimits.timeLimitMs, 27_000);
      assert.strictEqual(pair[side].result.truncatedBy.memory, true);
      assert.strictEqual(pair[side].result.truncatedBy.maxStates, false);
    }
  }
  assert.strictEqual(report.unavailable, undefined);
});

test("pre-snapshot worker requests remain compatible without leaking undefined.tmp", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-old-worker-"));
  try {
    const request = path.join(tmp, "request.json");
    fs.writeFileSync(request, JSON.stringify({
      story: EARLY_GRID,
      budget: 100,
      depth: 30,
      seed: 1,
      storySeed: 1,
      candidate: false,
    }));
    const proc = spawnSync(process.execPath, [PROMOTION_CLI, "--worker", request], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.strictEqual(proc.status, 0, proc.stderr);
    assert.strictEqual(JSON.parse(proc.stdout).workerExit, "completed");
    assert.strictEqual(fs.existsSync(path.join(tmp, "undefined.tmp")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("variable vocabulary isolates rare causal changes without key-order noise", () => {
  assert.strictEqual(
    variableStateKey({ success: false, gold: 3 }),
    variableStateKey({ gold: 3, success: false })
  );
  const changes = variableChanges(
    { success: false, gold: 3 },
    { gold: 3, success: true }
  );
  assert.deepStrictEqual(changes, [{ name: "success", before: false, after: true }]);
  assert.strictEqual(variableTransitionKey(changes[0]), "success:false->true");
  assert.strictEqual(rarityWeight(0), 1);
  assert.ok(rarityWeight(9) < rarityWeight(1));
  assert.throws(() => rarityWeight(-1), /non-negative integer/);
});

test("all adversarial search fixtures compile", async () => {
  for (const fixture of [LOCK, PLATEAU, STORYLETS, EARLY_GRID, FINITE_LOOP, GATED_ENDING, LOW_DEDUP_WIDE, DEEP_BRANCHING]) {
    const compiled = await compile(fixture);
    assert.strictEqual(compiled.success, true, path.basename(fixture));
  }
});

test("shared retained-memory ladders characterize low-dedup and deep-branching growth", async () => {
  for (const fixture of [LOW_DEDUP_WIDE, DEEP_BRANCHING]) {
    const compiled = await compile(fixture);
    const knots = scanKnots(fixture);
    const observations = [500, 2_000].map((maxStates) => {
      const report = exploreShared(compiled.storyJson, knots, [], {
        maxDepth: 150,
        maxStates,
        seed: 7,
      });
      const pass = report.passes[0];
      assert.strictEqual(pass.dedupeHits, 0, path.basename(fixture));
      assert.strictEqual(report.truncatedBy.maxStates, true, path.basename(fixture));
      assert.ok(pass.sharedMemory.releasedNodes > 0, path.basename(fixture));
      return {
        uniqueStates: pass.uniqueStates,
        peakPendingStates: pass.peakPendingStates,
        peakAccountedBytes: pass.sharedMemory.peak.totalAccountedBytes,
      };
    });
    assert.ok(observations[1].uniqueStates > observations[0].uniqueStates, path.basename(fixture));
    assert.ok(observations[1].peakPendingStates > observations[0].peakPendingStates, path.basename(fixture));
    assert.ok(observations[1].peakAccountedBytes > observations[0].peakAccountedBytes, path.basename(fixture));
  }
});

test("shared checkpoint envelopes bind cleanly on adversarial growth shapes", async () => {
  const wideCompiled = await compile(LOW_DEDUP_WIDE);
  const countBound = exploreShared(wideCompiled.storyJson, scanKnots(LOW_DEDUP_WIDE), [], {
    maxDepth: 150,
    maxStates: 5_000,
    seed: 7,
    sharedMaxPendingStates: 64,
  });
  const countMemory = countBound.passes[0].sharedMemory;
  assert.strictEqual(countBound.truncatedBy.frontier, true);
  assert.strictEqual(countBound.truncatedBy.maxStates, false);
  assert.ok(countBound.statesExplored < 5_000);
  assert.ok(countBound.endingsFound.length > 0);
  assert.ok(countMemory.peak.pendingStates <= 64);
  assert.strictEqual(countMemory.limits.maxPendingStates, 64);

  const deepCompiled = await compile(DEEP_BRANCHING);
  const byteLimit = 128 * 1024;
  const byteBound = exploreShared(deepCompiled.storyJson, scanKnots(DEEP_BRANCHING), [], {
    maxDepth: 150,
    maxStates: 5_000,
    seed: 7,
    sharedMaxPendingBytes: byteLimit,
  });
  const byteMemory = byteBound.passes[0].sharedMemory;
  assert.strictEqual(byteBound.truncatedBy.frontier, true);
  assert.strictEqual(byteBound.truncatedBy.maxStates, false);
  assert.ok(byteBound.statesExplored < 5_000);
  assert.ok(byteMemory.peak.pendingStateBytes + byteMemory.peak.pendingVariableBytes <= byteLimit);
  assert.strictEqual(byteMemory.limits.maxPendingBytes, byteLimit);
});

test("shared observability keeps deterministic retention and yield separate from live process memory", async () => {
  const compiled = await compile(LOW_DEDUP_WIDE);
  const observations = [];
  const report = exploreShared(compiled.storyJson, scanKnots(LOW_DEDUP_WIDE), [], {
    maxDepth: 150,
    maxStates: 300,
    seed: 7,
    sharedObservabilityIntervalStates: 1,
    onSharedObservability: (observation) => observations.push(observation),
  });
  const sparseCadenceReport = exploreShared(compiled.storyJson, scanKnots(LOW_DEDUP_WIDE), [], {
    maxDepth: 150,
    maxStates: 300,
    seed: 7,
    sharedObservabilityIntervalStates: 10_000_000,
  });
  assert.deepStrictEqual(
    withoutSharedObservability(report),
    withoutSharedObservability(sparseCadenceReport),
    "observability cadence must not change findings or their order"
  );
  const telemetry = report.passes[0].sharedObservability;
  assert.strictEqual(telemetry.schemaVersion, 2);
  assert.strictEqual(telemetry.sampleIntervalStates, 1);
  assert.strictEqual(telemetry.cadenceSamplesRecorded, report.statesExplored);
  assert.ok(telemetry.samplesRecorded >= telemetry.cadenceSamplesRecorded);
  assert.ok(telemetry.samplesRetained <= MAX_SHARED_OBSERVABILITY_SAMPLES);
  assert.strictEqual(telemetry.samplesCompacted, telemetry.samplesRecorded - telemetry.samplesRetained);
  assert.ok(telemetry.samplesCompacted > 0);
  assert.strictEqual(telemetry.samples.at(-1).state, report.statesExplored);
  assert.deepStrictEqual(
    telemetry.samples.at(-1).reasons.filter((reason) => reason === "cadence" || reason === "termination"),
    ["cadence", "termination"]
  );
  assert.strictEqual(telemetry.historyComplete, true);
  assert.strictEqual(telemetry.eventHistoryComplete, true);
  assert.strictEqual(telemetry.timing.schemaVersion, 2);
  assertCanonicalSharedSamples(telemetry.samples);
  assert.deepStrictEqual(
    telemetry.samples.at(-1).yield.cumulative,
    telemetry.yieldSummary.cumulative
  );
  assert.strictEqual(telemetry.yieldSummary.firstUsefulAtState, 0);
  assert.ok(telemetry.yieldSummary.throughFirstUseful.authoredCoverage.knotsVisited > 0);
  assert.ok(telemetry.yieldSummary.afterFirstUseful.rawTerritory.transitions > 0);
  assert.ok(telemetry.yieldSummary.cumulative.semanticTransitions < report.passes[0].variableTransitionsObserved);
  assert.strictEqual("score" in telemetry.yieldSummary, false);
  assert.strictEqual(observations.length, report.statesExplored);
  assert.strictEqual(
    new Set(observations.map((observation) => `${observation.sample.sequence}:${observation.sample.state}`)).size,
    observations.length,
    "live cadence observations must be final one-per-state values, not same-state revisions"
  );

  for (let index = 1; index < telemetry.samples.length; index++) {
    assert.strictEqual(
      telemetry.samples[index].yield.fromStateExclusive,
      telemetry.samples[index - 1].state
    );
  }
  const latest = observations.at(-1);
  assert.strictEqual(latest.schemaVersion, 2);
  assert.strictEqual(latest.runWideState, latest.sample.state);
  assert.strictEqual(latest.process.schemaVersion, 1);
  assert.strictEqual(latest.process.scope, "process");
  assert.ok(latest.process.heapUsedBytes > 0);
  assert.ok(latest.process.rssBytes > 0);
  assert.strictEqual(
    latest.process.comparedLogicalAccountedBytes,
    latest.sample.retention.current.totalAccountedBytes
  );
  assert.ok(Number.isInteger(latest.process.unattributedBytes));
  assert.doesNotMatch(JSON.stringify(observations), /path_code|wide tree leaf|"Left"|"Center"|"Right"/i);
  assert.doesNotMatch(JSON.stringify(report), /heapUsedBytes|heapTotalBytes|rssBytes|unattributedBytes/);

  const sparseLive = [];
  const eventHeavy = exploreShared(compiled.storyJson, scanKnots(LOW_DEDUP_WIDE), [], {
    maxDepth: 150,
    maxStates: 1_000,
    seed: 7,
    onSharedObservability: (observation) => sparseLive.push(observation),
  });
  assert.ok(eventHeavy.passes[0].sharedObservability.samplesRecorded > sparseLive.length);
  assert.strictEqual(sparseLive.length, 1, "off-cadence category events must not amplify live output");
  assert.deepStrictEqual(sparseLive[0].sample.reasons.at(-1), "termination");
});

test("shared observability records every supported event reason off cadence", async () => {
  const interval = 10_000_000;
  const reports = [];
  const lock = await compile(LOCK);
  const lockKnots = scanKnots(LOCK);
  reports.push(exploreShared(lock.storyJson, lockKnots, [], {
    maxDepth: 150,
    maxStates: 1_000,
    seed: 7,
    sharedObservabilityIntervalStates: interval,
    assertions: [{
      id: "a_stays_zero",
      when: "always",
      condition: { left: { variable: "a" }, operator: "==", right: { literal: 0 } },
    }],
    goals: [{
      id: "a_chosen",
      condition: { left: { variable: "a" }, operator: ">", right: { literal: 0 } },
    }, {
      id: "a_then_b",
      stages: [{
        id: "choose_a",
        condition: { left: { variable: "a" }, operator: ">", right: { literal: 0 } },
      }, {
        id: "choose_b",
        condition: { left: { variable: "b" }, operator: ">", right: { literal: 0 } },
      }],
    }],
  }));

  const plateau = await compile(PLATEAU);
  reports.push(exploreShared(plateau.storyJson, scanKnots(PLATEAU), [], {
    maxDepth: 150,
    maxStates: 500,
    seed: 7,
    sharedObservabilityIntervalStates: interval,
  }));

  const wide = await compile(LOW_DEDUP_WIDE);
  const wideKnots = scanKnots(LOW_DEDUP_WIDE);
  reports.push(exploreShared(wide.storyJson, wideKnots, [], {
    maxDepth: 150,
    maxStates: 1_500,
    seed: 7,
    sharedObservabilityIntervalStates: interval,
  }));
  reports.push(exploreShared(wide.storyJson, wideKnots, [], {
    maxDepth: 150,
    maxStates: 100,
    seed: 7,
    sharedMaxPendingStates: 1,
    sharedObservabilityIntervalStates: interval,
  }));

  for (const report of reports) {
    const telemetry = report.passes[0].sharedObservability;
    assert.strictEqual(telemetry.cadenceSamplesRecorded, 0);
    assertCanonicalSharedSamples(telemetry.samples);
  }
  const supportedOffCadenceReasons = [
    "runtime_error",
    "assertion_violation",
    "goal_reached",
    "stage_reached",
    "authored_knot",
    "visible_outcome",
    "semantic_transition",
    "terminal_variant",
    "frontier_compaction",
    "frontier_ceiling",
    "termination",
  ];
  const recorded = reports.flatMap((report) => report.passes[0].sharedObservability.samples);
  for (const reason of supportedOffCadenceReasons) {
    const sample = recorded.find((candidate) =>
      candidate.reasons.includes(reason) && candidate.state % interval !== 0
    );
    assert.ok(sample, `expected an independently triggered ${reason} boundary`);
    assert.strictEqual(sample.reasons.includes("cadence"), false);
  }
});

test("shared observability coalesces cadence, events, and termination deterministically", async () => {
  const compiled = await compile(LOCK);
  const knots = scanKnots(LOCK);
  const options = {
    maxDepth: 150,
    maxStates: 1,
    seed: 7,
    sharedObservabilityIntervalStates: 1,
    assertions: [{
      id: "a_stays_zero",
      when: "always",
      condition: { left: { variable: "a" }, operator: "==", right: { literal: 0 } },
    }],
    goals: [{
      id: "a_chosen",
      condition: { left: { variable: "a" }, operator: ">", right: { literal: 0 } },
    }],
  };
  const first = exploreShared(compiled.storyJson, knots, [], options);
  const second = exploreShared(compiled.storyJson, knots, [], options);
  const firstTelemetry = first.passes[0].sharedObservability;
  const secondTelemetry = second.passes[0].sharedObservability;
  assert.deepStrictEqual(firstTelemetry, secondTelemetry);
  assertCanonicalSharedSamples(firstTelemetry.samples);

  const coincident = firstTelemetry.samples.filter((sample) => sample.state === 1);
  assert.strictEqual(coincident.length, 1, "one state must retain one coalesced sample");
  for (const reason of [
    "cadence",
    "assertion_violation",
    "goal_reached",
    "semantic_transition",
    "termination",
  ]) {
    assert.ok(coincident[0].reasons.includes(reason), `coincident sample should include ${reason}`);
  }
  assert.strictEqual(firstTelemetry.samplesRecorded, firstTelemetry.samplesRetained);
  assert.strictEqual(firstTelemetry.cadenceSamplesRecorded, 1);
});

test("complete adjacent V2 boundaries require exact semantic trigger yield", async () => {
  const compiled = await compile(LOCK);
  const knots = scanKnots(LOCK);
  const options = {
    maxDepth: 150,
    maxStates: 10,
    seed: 7,
    sharedObservabilityIntervalStates: 1,
  };
  const checkpoint = exploreSharedResumable(
    compiled.storyJson,
    knots,
    [],
    options
  ).checkpoint;
  const observability = checkpoint.state.sharedObservability;
  assert.strictEqual(observability.eventHistoryComplete, true);
  const adjacent = observability.samples.find((sample) => sample.sequence === 7);
  assert.ok(adjacent);
  assert.strictEqual(adjacent.triggerYield[4], 2);
  assert.strictEqual(adjacent.yield.delta.authoredCoverage.knotsVisited, 2);

  const rehashedUndercount = structuredClone(checkpoint);
  rehashedUndercount.state.sharedObservability.samples
    .find((sample) => sample.sequence === 7).triggerYield[4] = 1;
  refreshSharedObservabilityCheckpointIntegrity(
    rehashedUndercount.state.sharedObservability
  );
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...options,
      maxStates: 11,
    }, rehashedUndercount),
    /shared observability v2 samples are malformed or out of order/
  );
});

test("base shared search resumes from JSON with the exact uninterrupted result", async () => {
  const compiled = await compile(LOW_DEDUP_WIDE);
  const knots = scanKnots(LOW_DEDUP_WIDE);
  const options = {
    maxDepth: 150,
    maxStates: 500,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
    sharedObservabilityIntervalStates: 25,
  };
  const uninterrupted = exploreSharedResumable(compiled.storyJson, knots, [], options);
  const direct = exploreShared(compiled.storyJson, knots, [], options);
  assert.deepStrictEqual(uninterrupted.result, direct);
  const first = exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 73,
  });

  assert.strictEqual(first.checkpoint.schemaVersion, SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION);
  assert.strictEqual(first.checkpoint.state.totalGranted, 73);
  assert.ok(first.checkpoint.state.current.cursor > 0, "fixture should pause partway through a choice list");
  assert.strictEqual(first.checkpoint.state.truncatedBy.maxStates, false);
  assert.strictEqual(first.result.truncatedBy.maxStates, true);
  assert.strictEqual(first.checkpoint.state.sharedObservability.schemaVersion, 2);
  assert.deepStrictEqual(
    first.checkpoint.state.sharedObservability.samples
      .filter((sample) => sample.reasons.includes("cadence"))
      .map((sample) => sample.state),
    [25, 50]
  );
  assert.ok(first.checkpoint.state.sharedObservability.samples
    .every((sample) => !sample.reasons.includes("checkpoint")));
  assert.doesNotMatch(JSON.stringify(first.checkpoint), /heapUsedBytes|heapTotalBytes|rssBytes|unattributedBytes/);
  assertSharedObservabilityCheckpointIntegrity(first.checkpoint.state.sharedObservability);
  const firstReplay = exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 73,
  });
  assert.deepStrictEqual(firstReplay.checkpoint, first.checkpoint);
  assert.strictEqual(
    firstReplay.checkpoint.state.sharedObservability.integritySha256,
    first.checkpoint.state.sharedObservability.integritySha256,
    "the same logical checkpoint must have one stable integrity identity"
  );

  const reordered = structuredClone(first.checkpoint);
  const reorderedObservability = reordered.state.sharedObservability;
  reorderedObservability.samples[0] = Object.fromEntries(
    Object.entries(reorderedObservability.samples[0]).reverse()
  );
  reordered.state.sharedObservability = Object.fromEntries(
    Object.entries(reorderedObservability).reverse()
  );
  const reorderedResume = exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 74,
  }, reordered);
  const reemittedObservability = reorderedResume.checkpoint.state.sharedObservability;
  assertSharedObservabilityCheckpointIntegrity(reemittedObservability);
  assert.deepStrictEqual(
    Object.keys(reemittedObservability),
    Object.keys(first.checkpoint.state.sharedObservability),
    "resuming reordered raw objects must re-emit the canonical envelope order"
  );
  assert.deepStrictEqual(
    Object.keys(reemittedObservability.samples[0]),
    Object.keys(first.checkpoint.state.sharedObservability.samples[0]),
    "resuming reordered raw objects must re-emit canonical sample order"
  );

  const serialized = JSON.parse(JSON.stringify(first.checkpoint));
  const resumed = exploreSharedResumable(compiled.storyJson, knots, [], options, serialized);
  assert.deepStrictEqual(resumed, uninterrupted);
  const uninterruptedTelemetry = uninterrupted.result.passes[0].sharedObservability;
  const resumedTelemetry = resumed.result.passes[0].sharedObservability;
  assert.ok(uninterruptedTelemetry.samplesCompacted > 0);
  assert.ok(resumedTelemetry.samplesCompacted > 0);
  assert.deepStrictEqual(resumedTelemetry.timing, uninterruptedTelemetry.timing);
  assert.deepStrictEqual(resumedTelemetry.yieldSummary, uninterruptedTelemetry.yieldSummary);
  assertCanonicalSharedSamples(resumedTelemetry.samples);
  assert.strictEqual(resumed.checkpoint.state.totalGranted, 500);
});

test("V1 observability migrates once and remains deterministic across V2 split resumes", async () => {
  const compiled = await compile(LOW_DEDUP_WIDE);
  const knots = scanKnots(LOW_DEDUP_WIDE);
  const options = {
    maxDepth: 150,
    maxStates: 500,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
    sharedObservabilityIntervalStates: 25,
  };
  const native = exploreSharedResumable(compiled.storyJson, knots, [], options);
  const initial = exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 73,
  });
  const v1Checkpoint = withV1SharedObservability(initial.checkpoint);
  assert.strictEqual(v1Checkpoint.state.sharedObservability.schemaVersion, 1);
  assert.strictEqual("integritySha256" in v1Checkpoint.state.sharedObservability, false);
  assert.deepStrictEqual(
    v1Checkpoint.state.sharedObservability.samples.map((sample) => sample.state),
    [25, 50]
  );

  const migrated = exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 73,
  }, JSON.parse(JSON.stringify(v1Checkpoint)));
  const migratedObservability = migrated.checkpoint.state.sharedObservability;
  assert.strictEqual(migratedObservability.schemaVersion, 2);
  assertSharedObservabilityCheckpointIntegrity(migratedObservability);
  assert.strictEqual(migratedObservability.eventHistoryComplete, false);
  assertCanonicalSharedSamples(migratedObservability.samples);
  assert.ok(migratedObservability.samples.every((sample) => (
    sample.triggerYield.every((count) => count === 0)
  )), "V1 cadence migration records no invented event trigger evidence");
  assert.strictEqual(migratedObservability.nextSampleState, v1Checkpoint.state.sharedObservability.nextSampleState);
  assert.strictEqual(
    migratedObservability.cadenceSamplesRecorded,
    v1Checkpoint.state.sharedObservability.samplesRecorded
  );
  for (const state of [25, 50]) {
    assert.deepStrictEqual(
      migratedObservability.samples.find((sample) => sample.state === state).reasons,
      ["cadence"]
    );
  }

  const runSplit = () => {
    const middle = exploreSharedResumable(compiled.storyJson, knots, [], {
      ...options,
      maxStates: 211,
    }, structuredClone(migrated.checkpoint));
    assertSharedObservabilityCheckpointIntegrity(middle.checkpoint.state.sharedObservability);
    assert.ok(middle.checkpoint.state.sharedObservability.samples
      .every((sample) => !sample.reasons.includes("checkpoint")));
    return exploreSharedResumable(compiled.storyJson, knots, [], options,
      JSON.parse(JSON.stringify(middle.checkpoint)));
  };
  const splitA = runSplit();
  const splitB = runSplit();
  assert.deepStrictEqual(splitA, splitB);
  assert.deepStrictEqual(
    withoutSharedObservability(splitA.result),
    withoutSharedObservability(native.result)
  );
  const splitTelemetry = splitA.result.passes[0].sharedObservability;
  assert.strictEqual(splitTelemetry.eventHistoryComplete, false);
  assert.ok(splitTelemetry.samplesCompacted > 0);
  assert.deepStrictEqual(splitTelemetry.timing, splitA.checkpoint.state.sharedObservability.timing);
  assertCanonicalSharedSamples(splitTelemetry.samples);
});

test("shared observability sequence ordinals stay bounded across compaction and V1 two-hop migration", async () => {
  const compiled = await compile(LOW_DEDUP_WIDE);
  const knots = scanKnots(LOW_DEDUP_WIDE);
  const options = {
    maxDepth: 150,
    maxStates: 300,
    seed: 7,
    sharedObservabilityIntervalStates: 1,
  };
  const native = exploreSharedResumable(compiled.storyJson, knots, [], options);
  const checkpoint = native.checkpoint;
  const observability = checkpoint.state.sharedObservability;
  assert.strictEqual(checkpoint.state.statesExplored, 300);
  assert.strictEqual(observability.samplesRecorded, 300);
  assert.strictEqual(observability.cadenceSamplesRecorded, 300);
  assert.ok(observability.samples.length <= MAX_SHARED_OBSERVABILITY_SAMPLES);
  assert.ok(observability.samples.length < observability.samplesRecorded);
  assertCanonicalSharedSamples(observability.samples);
  assert.ok(observability.samples.every((sample) => sample.sequence === sample.state));

  const rejectOrdinalTamper = (mutate) => {
    const tampered = structuredClone(checkpoint);
    mutate(tampered.state.sharedObservability);
    assert.throws(
      () => exploreSharedResumable(compiled.storyJson, knots, [], {
        ...options,
        maxStates: 350,
      }, tampered),
      /shared observability/
    );
  };
  rejectOrdinalTamper((value) => {
    value.samplesRecorded = 301;
    value.samples.at(-1).sequence = 301;
  });
  rejectOrdinalTamper((value) => {
    const interior = value.samples.find((sample) => sample.sequence === 9);
    assert.ok(interior, "interval-one compaction fixture must retain ordinal 9");
    interior.sequence = 8;
  });

  const preCompaction = exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 20,
  }).checkpoint;
  const preCompactionObservability = preCompaction.state.sharedObservability;
  assert.strictEqual(preCompactionObservability.samplesRecorded, 20);
  assert.strictEqual(preCompactionObservability.samples.length, 20);
  const missingInterior = structuredClone(preCompaction);
  missingInterior.state.sharedObservability.samples.splice(8, 1);
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...options,
      maxStates: 30,
    }, missingInterior),
    /shared observability/
  );

  const compactedV1 = withV1SharedObservability(checkpoint);
  assert.strictEqual(compactedV1.state.sharedObservability.schemaVersion, 1);
  assert.strictEqual(compactedV1.state.sharedObservability.samplesRecorded, 300);
  assert.ok(compactedV1.state.sharedObservability.samples.length < 300);
  const runTwoHop = () => {
    const firstHop = exploreSharedResumable(compiled.storyJson, knots, [], {
      ...options,
      maxStates: 350,
    }, structuredClone(compactedV1));
    const firstHopObservability = firstHop.checkpoint.state.sharedObservability;
    assert.strictEqual(firstHopObservability.eventHistoryComplete, false);
    assertCanonicalSharedSamples(firstHopObservability.samples);
    assert.ok(firstHopObservability.samples.every((sample) => sample.sequence === sample.state));
    assert.ok(firstHopObservability.samples
      .filter((sample) => sample.state <= 300)
      .every((sample) => sample.triggerYield.every((count) => count === 0)));
    const secondHop = exploreSharedResumable(compiled.storyJson, knots, [], {
      ...options,
      maxStates: 400,
    }, JSON.parse(JSON.stringify(firstHop.checkpoint)));
    assertCanonicalSharedSamples(secondHop.checkpoint.state.sharedObservability.samples);
    assert.ok(secondHop.checkpoint.state.sharedObservability.samples
      .every((sample) => sample.sequence === sample.state));
    return secondHop;
  };
  const first = runTwoHop();
  const second = runTwoHop();
  assert.deepStrictEqual(first, second);
  const direct = exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 400,
  });
  assert.deepStrictEqual(withoutSharedObservability(first.result), withoutSharedObservability(direct.result));
});

test("shared checkpoints preserve useful milestones before the first cadence sample", async () => {
  const compiled = await compile(AUTHORED_DOG);
  const knots = scanKnots(AUTHORED_DOG);
  const options = {
    maxDepth: 30,
    maxStates: 100,
    seed: 7,
    storySeed: 1,
    sharedObservabilityIntervalStates: 10,
  };
  const first = exploreSharedResumable(compiled.storyJson, knots, [], options);
  const observability = first.checkpoint.state.sharedObservability;
  assert.strictEqual(first.checkpoint.state.statesExplored, 100);
  assert.strictEqual(observability.baseState, 0);
  assert.strictEqual(observability.sampleIntervalStates, 10);
  assert.strictEqual(observability.firstUsefulAtState, 1);
  const firstEvent = observability.samples[0];
  const firstCadence = observability.samples.find((sample) => sample.reasons.includes("cadence"));
  assert.strictEqual(firstEvent.state, 1);
  assert.strictEqual(firstEvent.reasons.includes("cadence"), false);
  assert.strictEqual(firstCadence.state, 10);
  assert.ok(firstCadence.yield.cumulative.authoredCoverage.knotsVisited > 0);
  assert.strictEqual(observability.firstUsefulAtState, firstEvent.state);
  assert.ok(observability.firstUsefulAtState < firstCadence.state);
  assert.deepStrictEqual(observability.throughFirstUseful, firstEvent.yield.cumulative);

  const resumed = exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 200,
  }, JSON.parse(JSON.stringify(first.checkpoint)));
  assert.ok(resumed.result.statesExplored >= first.result.statesExplored);

  const atFirstSample = structuredClone(first.checkpoint);
  assert.doesNotThrow(() => exploreSharedResumable(compiled.storyJson, knots, [], {
    ...options,
    maxStates: 200,
  }, atFirstSample));

  const exceedsFirstSample = structuredClone(first.checkpoint);
  const firstCadenceUniqueStates = exceedsFirstSample.state.sharedObservability
    .samples.find((sample) => sample.reasons.includes("cadence"))
    .yield.cumulative.rawTerritory.uniqueStates;
  assert.ok(
    firstCadenceUniqueStates
      < exceedsFirstSample.state.sharedObservability.previousYield.rawTerritory.uniqueStates
  );
  const firstEventUniqueStates = exceedsFirstSample.state.sharedObservability.samples
    .find((sample) => sample.state === exceedsFirstSample.state.sharedObservability.firstUsefulAtState)
    .yield.cumulative.rawTerritory.uniqueStates;
  exceedsFirstSample.state.sharedObservability.throughFirstUseful.rawTerritory.uniqueStates
    = firstEventUniqueStates + 1;
  refreshSharedObservabilityCheckpointIntegrity(exceedsFirstSample.state.sharedObservability);
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...options,
      maxStates: 200,
    }, exceedsFirstSample),
    /useful milestone exceeds retained cumulative yield/
  );

  for (const lateMilestone of [2, 50]) {
    const tampered = structuredClone(first.checkpoint);
    tampered.state.sharedObservability.firstUsefulAtState = lateMilestone;
    tampered.state.sharedObservability.throughFirstUseful.rawTerritory.transitions = lateMilestone;
    refreshSharedObservabilityCheckpointIntegrity(tampered.state.sharedObservability);
    assert.throws(
      () => exploreSharedResumable(compiled.storyJson, knots, [], {
        ...options,
        maxStates: 200,
      }, tampered),
      /useful milestone is later than retained useful yield/
    );
  }
});

test("shared checkpoints fail closed on incompatible source, options, budget, and state", async () => {
  const compiled = await compile(LOW_DEDUP_WIDE);
  const knots = scanKnots(LOW_DEDUP_WIDE);
  const options = { maxDepth: 150, maxStates: 73, seed: 7 };
  const first = exploreSharedResumable(compiled.storyJson, knots, [], options);
  const checkpoint = first.checkpoint;
  const clone = () => structuredClone(checkpoint);

  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], { ...options, maxStates: 72 }, checkpoint),
    /cannot be lower than the checkpoint's total grant/
  );
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], { ...options, maxStates: 100, seed: 8 }, checkpoint),
    /source, strategy, limits, seeds/
  );
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...options,
      maxStates: 100,
      sharedObservabilityIntervalStates: 1,
    }, checkpoint),
    /observability interval changed/
  );
  for (const [changedOptions, changedExternals] of [
    [{ maxDepth: 149 }, []],
    [{ storySeed: 2 }, []],
    [{ preserveTurnState: false }, []],
    [{ preserveRandomState: false }, []],
    [{ randomnessDetected: true }, []],
    [{ sharedMaxPendingStates: 1_000 }, []],
    [{}, ["HOST_FUNCTION"]],
  ]) {
    assert.throws(
      () => exploreSharedResumable(
        compiled.storyJson,
        knots,
        changedExternals,
        { ...options, maxStates: 100, ...changedOptions },
        checkpoint
      ),
      /source, strategy, limits, seeds/
    );
  }
  const other = await compile(DEEP_BRANCHING);
  assert.throws(
    () => exploreSharedResumable(other.storyJson, scanKnots(DEEP_BRANCHING), [], { ...options, maxStates: 100 }, checkpoint),
    /source, strategy, limits, seeds/
  );

  const wrongSchema = clone();
  wrongSchema.schemaVersion = 999;
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], { ...options, maxStates: 100 }, wrongSchema),
    /unsupported schema 999/
  );
  const badFrontier = clone();
  badFrontier.state.deep.push(badFrontier.state.nodes.length);
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], { ...options, maxStates: 100 }, badFrontier),
    /deep frontier contains an invalid node reference/
  );
  const badParent = clone();
  const child = badParent.state.nodes.find((node) => node && node.parent !== null);
  child.parent = badParent.state.nodes.length;
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], { ...options, maxStates: 100 }, badParent),
    /invalid parent reference/
  );
  const badObservability = clone();
  badObservability.state.sharedObservability.baseYield.rawTerritory.transitions = -1;
  refreshSharedObservabilityCheckpointIntegrity(badObservability.state.sharedObservability);
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], { ...options, maxStates: 100 }, badObservability),
    /shared observability(?: v2)? ledger is malformed/
  );
  const observedOptions = { ...options, sharedObservabilityIntervalStates: 10 };
  const observedCheckpoint = exploreSharedResumable(
    compiled.storyJson,
    knots,
    [],
    observedOptions
  ).checkpoint;
  assert.ok(observedCheckpoint.state.sharedObservability.samples.length >= 2);
  assert.strictEqual(observedCheckpoint.state.runtimeErrors.length, 0);
  assert.ok(observedCheckpoint.state.sharedObservability.firstUsefulAtState !== null);
  assertSharedObservabilityCheckpointIntegrity(observedCheckpoint.state.sharedObservability);
  for (const mutate of [
    (observability) => { delete observability.integritySha256; },
    (observability) => { observability.integritySha256 = "0".repeat(63); },
    (observability) => { observability.integritySha256 = "G".repeat(64); },
    (observability) => { observability.unrecognized = true; },
  ]) {
    const malformedIntegrity = structuredClone(observedCheckpoint);
    mutate(malformedIntegrity.state.sharedObservability);
    assert.throws(
      () => exploreSharedResumable(compiled.storyJson, knots, [], {
        ...observedOptions,
        maxStates: 100,
      }, malformedIntegrity),
      /integrity checksum is missing or malformed/
    );
  }
  const staleValidLookingIntegrity = structuredClone(observedCheckpoint);
  staleValidLookingIntegrity.state.sharedObservability.integritySha256 = "0".repeat(64);
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...observedOptions,
      maxStates: 100,
    }, staleValidLookingIntegrity),
    /integrity checksum mismatch/
  );
  const malformedCanonicalShape = structuredClone(observedCheckpoint);
  malformedCanonicalShape.state.sharedObservability.samples[0].yield.unrecognized = true;
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...observedOptions,
      maxStates: 100,
    }, malformedCanonicalShape),
    /canonical shape is malformed/
  );
  const rejectObservedTamper = (mutate) => {
    const tampered = structuredClone(observedCheckpoint);
    mutate(tampered.state.sharedObservability, tampered.state);
    refreshSharedObservabilityCheckpointIntegrity(tampered.state.sharedObservability);
    assert.throws(
      () => exploreSharedResumable(compiled.storyJson, knots, [], {
        ...observedOptions,
        maxStates: 100,
      }, tampered),
      /shared observability/
    );
  };
  rejectObservedTamper((observability) => {
    observability.samples[0].yield.delta.rawTerritory.transitions++;
  });
  rejectObservedTamper((observability) => {
    observability.samples[0].retention.current.totalAccountedBytes++;
  });
  rejectObservedTamper((observability) => {
    const sample = observability.samples[0];
    sample.retention.current.pendingStates = sample.retention.peak.pendingStates + 1;
  });
  rejectObservedTamper((observability) => {
    const [firstSample, secondSample] = observability.samples;
    const high = Math.max(
      firstSample.retention.current.findingBytes,
      secondSample.retention.current.findingBytes,
      firstSample.retention.peak.findingBytes,
      secondSample.retention.peak.findingBytes
    ) + 2;
    firstSample.retention.peak.findingBytes = high;
    secondSample.retention.peak.findingBytes = high - 1;
  });
  rejectObservedTamper((observability, state) => {
    const [firstSample, secondSample] = observability.samples;
    assert.ok(state.releasedNodes > 0);
    firstSample.retention.releasedNodes = state.releasedNodes;
    secondSample.retention.releasedNodes = state.releasedNodes - 1;
  });
  rejectObservedTamper((observability, state) => {
    const [firstSample, secondSample] = observability.samples;
    state.frontierCompactions = 1;
    firstSample.retention.frontierCompactions = 1;
    secondSample.retention.frontierCompactions = 0;
  });
  rejectObservedTamper((observability) => {
    observability.nextSampleState++;
  });
  rejectObservedTamper((observability) => {
    observability.firstCriticalAtState = 1;
  });
  rejectObservedTamper((observability) => {
    observability.samples[0].reasons = ["unknown_reason"];
  });
  rejectObservedTamper((observability) => {
    observability.samples[0].reasons = ["termination", "cadence"];
  });
  rejectObservedTamper((observability) => {
    observability.samples[0].reasons = ["cadence", "cadence"];
  });
  rejectObservedTamper((observability) => {
    const first = observability.samples.find((sample) => sample.sequence === 1);
    assert.ok(first);
    const reason = first.reasons.find((candidate) => [
      "runtime_error", "assertion_violation", "goal_reached", "stage_reached",
      "authored_knot", "visible_outcome", "semantic_transition", "terminal_variant",
    ].includes(candidate));
    assert.ok(reason);
    first.reasons = first.reasons.filter((candidate) => candidate !== reason);
  });
  for (const reservedReason of ["checkpoint", "epoch", "pressure"]) {
    rejectObservedTamper((observability) => {
      observability.samples[0].reasons = [
        ...observability.samples[0].reasons,
        reservedReason,
      ].sort((left, right) => SHARED_OBSERVABILITY_REASON_RANK.get(left)
        - SHARED_OBSERVABILITY_REASON_RANK.get(right));
    });
  }

  const compactedOptions = { ...observedOptions, maxStates: 500 };
  const compactedCheckpoint = exploreSharedResumable(
    compiled.storyJson,
    knots,
    [],
    compactedOptions
  ).checkpoint;
  const compactedObservability = compactedCheckpoint.state.sharedObservability;
  assert.ok(compactedObservability.samplesRecorded > compactedObservability.samples.length);
  assertCanonicalSharedSamples(compactedObservability.samples);
  const hasSequenceGapBefore = (samples, index) => (
    index > 0 && samples[index].sequence > samples[index - 1].sequence + 1
  );
  const removalIndex = compactedObservability.samples.findIndex((sample, index, samples) => (
    hasSequenceGapBefore(samples, index)
    && sample.reasons.filter((reason) => [
      "runtime_error", "assertion_violation", "goal_reached", "stage_reached",
      "authored_knot", "visible_outcome", "semantic_transition", "terminal_variant",
    ].includes(reason)).length >= 2
  ));
  const additionIndex = compactedObservability.samples.findIndex((sample, index, samples) => (
    hasSequenceGapBefore(samples, index)
    && !sample.reasons.includes("terminal_variant")
    && sample.yield.delta.terminalVariants > 0
  ));
  assert.ok(removalIndex > 0, "fixture must retain a multi-reason boundary after a compaction gap");
  assert.ok(additionIndex > 0, "fixture must aggregate a removed terminal trigger before a retained boundary");
  const removeCompactedBoundaryTrigger = (observability) => {
    const sample = observability.samples[removalIndex];
    const removedReason = sample.reasons.find((reason) => (
      SHARED_OBSERVABILITY_TRIGGER_YIELD_REASONS.includes(reason)
    ));
    assert.ok(removedReason);
    const triggerIndex = SHARED_OBSERVABILITY_TRIGGER_YIELD_REASONS.indexOf(removedReason);
    sample.reasons = sample.reasons.filter((reason) => reason !== removedReason);
    sample.triggerMask = sharedObservabilityTriggerMask(sample.reasons);
    sample.triggerYield[triggerIndex] = 0;
  };
  const coordinatedStaleIntegrity = structuredClone(compactedCheckpoint);
  removeCompactedBoundaryTrigger(coordinatedStaleIntegrity.state.sharedObservability);
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...compactedOptions,
      maxStates: 550,
    }, coordinatedStaleIntegrity),
    /integrity checksum mismatch/,
    "a stale digest must reject a structurally self-consistent compacted reason, mask, and tuple edit"
  );
  const coordinatedRehashedIntegrity = structuredClone(compactedCheckpoint);
  removeCompactedBoundaryTrigger(coordinatedRehashedIntegrity.state.sharedObservability);
  refreshSharedObservabilityCheckpointIntegrity(
    coordinatedRehashedIntegrity.state.sharedObservability
  );
  assert.doesNotThrow(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...compactedOptions,
      maxStates: 550,
    }, coordinatedRehashedIntegrity),
    "the self-check is integrity, not authentication: a structurally valid writer can recompute it"
  );
  const staleCursorIntegrity = structuredClone(compactedCheckpoint);
  const staleCursorObservability = staleCursorIntegrity.state.sharedObservability;
  staleCursorObservability.samples[removalIndex].sequence++;
  staleCursorObservability.samples[removalIndex].state++;
  staleCursorObservability.samplesRecorded++;
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...compactedOptions,
      maxStates: 550,
    }, staleCursorIntegrity),
    /integrity checksum mismatch/,
    "sequence, state, and aggregate counters are independently bound"
  );
  const rehashedInvalidTrigger = structuredClone(compactedCheckpoint);
  rehashedInvalidTrigger.state.sharedObservability.samples[removalIndex].triggerYield[0] = -1;
  refreshSharedObservabilityCheckpointIntegrity(
    rehashedInvalidTrigger.state.sharedObservability
  );
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], {
      ...compactedOptions,
      maxStates: 550,
    }, rehashedInvalidTrigger),
    /shared observability v2 samples are malformed or out of order/,
    "a recomputed checksum must never substitute for semantic validation"
  );
  const rejectCompactedTamper = (mutate) => {
    const tampered = structuredClone(compactedCheckpoint);
    mutate(tampered.state.sharedObservability);
    refreshSharedObservabilityCheckpointIntegrity(tampered.state.sharedObservability);
    assert.throws(
      () => exploreSharedResumable(compiled.storyJson, knots, [], {
        ...compactedOptions,
        maxStates: 550,
      }, tampered),
      /shared observability/
    );
  };
  rejectCompactedTamper((observability) => {
    observability.samplesRecorded++;
    for (const sample of observability.samples) sample.sequence++;
  });
  rejectCompactedTamper((observability) => {
    const sample = observability.samples[removalIndex];
    const removed = sample.reasons.find((reason) => reason !== "terminal_variant");
    assert.ok(removed);
    sample.reasons = sample.reasons.filter((reason) => reason !== removed);
  });
  rejectCompactedTamper((observability) => {
    const sample = observability.samples[additionIndex];
    sample.reasons = [...sample.reasons, "terminal_variant"].sort(
      (left, right) => SHARED_OBSERVABILITY_REASON_RANK.get(left)
        - SHARED_OBSERVABILITY_REASON_RANK.get(right)
    );
  });
  rejectCompactedTamper((observability) => {
    const sample = observability.samples[removalIndex];
    const removed = sample.reasons.find((reason) => reason !== "terminal_variant");
    assert.ok(removed);
    sample.reasons = sample.reasons.filter((reason) => reason !== removed);
    sample.triggerMask = sharedObservabilityTriggerMask(sample.reasons);
  });
  rejectCompactedTamper((observability) => {
    const sample = observability.samples[additionIndex];
    sample.reasons = [...sample.reasons, "terminal_variant"].sort(
      (left, right) => SHARED_OBSERVABILITY_REASON_RANK.get(left)
        - SHARED_OBSERVABILITY_REASON_RANK.get(right)
    );
    sample.triggerMask = sharedObservabilityTriggerMask(sample.reasons);
  });
  rejectCompactedTamper((observability) => {
    const sample = observability.samples[removalIndex];
    sample.triggerYield[7] = sample.yield.delta.terminalVariants + 1;
  });
  const originalMask = compactedObservability.samples[removalIndex].triggerMask;
  for (const invalidMask of [originalMask ^ 1, 1.5, 2 ** SHARED_OBSERVABILITY_REASON_ORDER.length]) {
    rejectCompactedTamper((observability) => {
      observability.samples[removalIndex].triggerMask = invalidMask;
    });
  }
  rejectObservedTamper((observability) => {
    observability.eventHistoryComplete = false;
    observability.timing.critical.longestDryStates = 1;
  });
  rejectObservedTamper((observability) => {
    observability.samplesRecorded = 1_000_000;
  });
  rejectObservedTamper((observability) => {
    observability.firstUsefulAtState = null;
  });
  rejectObservedTamper((observability, state) => {
    const latestPeak = observability.samples.at(-1).retention.peak;
    assert.ok(latestPeak.pendingStates > 0);
    state.peakRetainedMemory.pendingStates = latestPeak.pendingStates - 1;
  });
  const legacyCheckpoint = clone();
  delete legacyCheckpoint.state.sharedObservability;
  delete legacyCheckpoint.state.meaningfulVariableTransitions;
  delete legacyCheckpoint.state.discoveryCurve.countedVisibleOutcomes;
  const legacyResume = exploreSharedResumable(
    compiled.storyJson,
    knots,
    [],
    { ...options, maxStates: 74 },
    legacyCheckpoint
  );
  assert.strictEqual(legacyResume.result.passes[0].sharedObservability.historyComplete, false);
  assert.strictEqual(legacyResume.result.passes[0].sharedObservability.eventHistoryComplete, false);
  assert.strictEqual(legacyResume.result.statesExplored, 74);
  const migrated = legacyResume.checkpoint.state.sharedObservability;
  assertSharedObservabilityCheckpointIntegrity(migrated);
  for (const [category, reason] of [
    ["authoredCoverage", "authored_knot"],
    ["visibleOutcomes", "visible_outcome"],
    ["terminalVariants", "terminal_variant"],
  ]) {
    assert.ok(migrated.timing[category].identities > 0);
    assert.strictEqual(migrated.timing[category].firstAtState, null);
    assert.strictEqual(migrated.timing[category].lastAtState, null);
    assert.ok(migrated.samples.every((sample) => !sample.reasons.includes(reason)));
  }
  const secondLegacyResume = exploreSharedResumable(
    compiled.storyJson,
    knots,
    [],
    { ...options, maxStates: 100 },
    structuredClone(legacyResume.checkpoint)
  );
  assert.strictEqual(secondLegacyResume.result.statesExplored, 100);
  assertSharedObservabilityCheckpointIntegrity(
    secondLegacyResume.checkpoint.state.sharedObservability
  );
  assert.throws(
    () => exploreSharedResumable(compiled.storyJson, knots, [], { ...options, assertions: [{}] }),
    /only the base shared strategy/
  );
});

test("shared resumable runs export only live frontiers", async () => {
  const wide = await compile(LOW_DEDUP_WIDE);
  const stopped = exploreSharedResumable(wide.storyJson, scanKnots(LOW_DEDUP_WIDE), [], {
    maxDepth: 150,
    maxStates: 2_000,
    memoryGuard: () => false,
  });
  assert.strictEqual(stopped.checkpoint, undefined);
  assert.strictEqual(stopped.result.truncatedBy.memory, true);
  assert.strictEqual(stopped.result.truncatedBy.maxStates, false);

  const finite = await compile(LOCK);
  const complete = exploreSharedResumable(finite.storyJson, scanKnots(LOCK), [], {
    maxDepth: 20,
    maxStates: 1_000,
  });
  assert.strictEqual(complete.checkpoint, undefined);
  assert.strictEqual(complete.result.exhaustive, true);
  assert.strictEqual(complete.result.truncated, false);
});

test("finite lock benchmark preserves exact states and proves the graph exhaustive", async () => {
  const compiled = await compile(LOCK);
  const knots = scanKnots(LOCK);
  const run = runSearchBenchmark("dfs:last", () =>
    explore(compiled.storyJson, knots, [], { maxStates: 1_000 })
  );
  assert.ok(run.elapsedMs >= 0);
  assert.strictEqual(run.summary.result.exhaustive, true);
  assert.strictEqual(run.summary.stateSpace.terminalStates, 27);
  assert.deepStrictEqual(run.summary.findings.visibleEndings, [
    "Still locked.",
    "Vault opened.",
  ]);
  assert.ok(run.summary.findings.visitedKnots.includes("vault"));
  assert.deepStrictEqual(run.summary.stateSpace.terminalVariableValues.success, {
    false: 26,
    true: 1,
  });
});

test("deceptive suffix benchmark records the runtime failure as useful evidence", async () => {
  const compiled = await compile(PLATEAU);
  const summary = summarizeSearchResult(
    "dfs:first",
    explore(compiled.storyJson, scanKnots(PLATEAU), [], {
      maxStates: 500,
      dfsChoicePriority: "first",
    })
  );
  assert.strictEqual(summary.result.exhaustive, true);
  assert.strictEqual(summary.findings.runtimeErrors.length, 1);
  assert.match(summary.findings.runtimeErrors[0], /ran out of content/);
  assert.ok(summary.findings.visitedKnots.includes("hidden_error"));
});

test("storylet benchmark covers gated and timeout outcomes", async () => {
  const compiled = await compile(STORYLETS);
  const summary = summarizeSearchResult(
    "dfs:last",
    explore(compiled.storyJson, scanKnots(STORYLETS), [], { maxStates: 5_000 })
  );
  assert.strictEqual(summary.result.exhaustive, true);
  assert.deepStrictEqual(summary.findings.visibleEndings, [
    "The proof collapses.",
    "The proof holds.",
    "Time runs out.",
  ]);
});

test("early-variable benchmark exposes strategy differences deterministically", async () => {
  const compiled = await compile(EARLY_GRID);
  const knots = scanKnots(EARLY_GRID);
  const options = { maxStates: 200, seed: 7 };
  const randomA = summarizeSearchResult(
    "random:seed=7",
    exploreRandom(compiled.storyJson, knots, [], options)
  );
  const randomB = summarizeSearchResult(
    "random:seed=7",
    exploreRandom(compiled.storyJson, knots, [], options)
  );
  assert.deepStrictEqual(randomA, randomB);

  const portfolio = summarizeSearchResult(
    "portfolio",
    explorePortfolio(compiled.storyJson, knots, [], { maxStates: 2_000, seed: 7 })
  );
  assert.deepStrictEqual(portfolio.findings.visibleEndings, [
    "North scout ending.",
    "Ordinary ending.",
    "South scholar ending.",
    "West smith ending.",
  ]);
});

function shadowReport(budget, { runtimeErrors = [], knots = ["start"], endings = [], dry = 0 } = {}) {
  const last = Math.max(1, budget - dry);
  const summary = {
    discoveryEvents: 5,
    firstDiscoveryAtState: 1,
    lastDiscoveryAtState: last,
    statesSinceLastDiscovery: dry,
    latestDiscoveryGap: 100,
    longestObservedDiscoveryGap: 1_000,
  };
  const sample = {
    state: last,
    endingsFound: endings.length,
    runtimeErrorsFound: runtimeErrors.length,
    knotsVisited: knots.length,
    visibleOutcomes: endings.length,
    assertionViolations: 0,
    goalsReached: 0,
    stagesReached: 0,
    uniqueStatesObserved: last,
    newEndings: endings.length,
    newRuntimeErrors: runtimeErrors.length,
    newKnots: knots.length,
    newVisibleOutcomes: endings.length,
    newAssertionViolations: 0,
    newGoalsReached: 0,
    newStagesReached: 0,
    newUniqueStates: last,
    statesSincePreviousDiscovery: 100,
  };
  return {
    statesExplored: budget,
    endingsFound: endings,
    runtimeErrors,
    assertionResults: [],
    runtimeWarnings: [],
    unvisitedKnots: [],
    visitedKnots: knots,
    externalFunctionsStubbed: [],
    randomnessDetected: false,
    truncated: true,
    truncatedBy: { ...EMPTY_TRUNCATION, maxStates: true },
    exhaustive: false,
    limits: { maxDepth: 100, maxStates: budget },
    discoveryCurve: [sample],
    discoverySummary: summary,
    passes: [{
      pass: "dfs:last",
      systematic: true,
      statesExplored: budget,
      granted: budget,
      endingsFound: endings.length,
      runtimeErrorsFound: runtimeErrors.length,
      knotsVisited: knots.length,
      newEndings: endings.length,
      newKnots: knots.length,
      newRuntimeErrors: runtimeErrors.length,
      dedupeHits: 0,
      maxDepthReached: 10,
      lastDiscoveryAtState: last,
      discoveryCurve: [sample],
      discoverySummary: summary,
      truncatedBy: { ...EMPTY_TRUNCATION, maxStates: true },
      exhaustive: false,
    }],
  };
}

test("shadow budget ladder flags critical evidence beyond a knee without calling high-water proof", () => {
  const endingReport = ending({ route: "late" });
  const runtimeError = {
    message: "late failure",
    path: ["Wait"],
    choiceIndices: [0],
    foundBy: "dfs:last",
    firstDiscoveredAtState: 20_000,
    sourceLocation: { file: "story.ink", line: 8, approximate: false },
  };
  const earlyRuntimeError = { ...runtimeError, message: "early-only failure", firstDiscoveredAtState: 100 };
  const result = evaluateShadowBudgetLadder({
    id: "late-recovery",
    family: "sparse-runtime-failure",
    source: { name: "synthetic late recovery", license: "MIT", consent: "repository fixture" },
    runs: [
      { budget: 10_000, report: shadowReport(10_000, { dry: 5_000, runtimeErrors: [earlyRuntimeError] }) },
      { budget: 50_000, report: shadowReport(50_000, { runtimeErrors: [runtimeError], knots: ["start", "late"], endings: [endingReport] }) },
    ],
  });
  assert.strictEqual(result.checkpoints[0].decision.action, "stop_at_knee");
  assert.strictEqual(result.checkpoints[0].stopRisk, "critical");
  assert.strictEqual(result.checkpoints[0].highWaterRegressionRisk, "critical");
  assert.strictEqual(result.checkpoints[0].highWaterOnly.runtimeErrors.count, 1);
  assert.strictEqual(result.checkpoints[0].checkpointOnly.runtimeErrors.count, 1);
  assert.strictEqual(result.highWater.bounded, true);
  assert.match(result.caveat, /not an oracle or coverage proof/);
  assert.match(renderShadowEvaluationMarkdown([result]), /critical/);
  assert.throws(() => evaluateShadowBudgetLadder({
    id: "bad",
    family: "bad",
    source: { name: "bad", license: "MIT", consent: "fixture" },
    runs: [
      { budget: 9_999, report: shadowReport(10_000) },
      { budget: 50_000, report: shadowReport(50_000) },
    ],
  }), /does not match report maxStates/);
});
