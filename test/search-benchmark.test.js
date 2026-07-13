const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { compile, scanKnots } = require("../dist/inklecate");
const { explore, explorePortfolio, exploreRandom } = require("../dist/explore");
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
  validatePromotionManifest,
} = require("../dist/promotion-benchmark");

const FIXTURES = path.join(__dirname, "fixtures", "search");
const LOCK = path.join(FIXTURES, "combination-lock.ink");
const PLATEAU = path.join(FIXTURES, "deceptive-plateau.ink");
const STORYLETS = path.join(FIXTURES, "storylet-machine.ink");
const EARLY_GRID = path.join(FIXTURES, "early-variable-grid.ink");
const FINITE_LOOP = path.join(FIXTURES, "finite-counter-loop.ink");
const GATED_ENDING = path.join(FIXTURES, "gated-ending.ink");

const EMPTY_TRUNCATION = {
  maxDepth: false,
  maxStates: false,
  beamWidth: false,
  memory: false,
};

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
    baseline: { elapsedMs: 12, peakRssBytes: 1000, summary: baselineSummary },
    candidate: { elapsedMs: 15, peakRssBytes: 1200, summary: candidateSummary },
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
  };
  const deterministic = JSON.stringify(deterministicPromotionView(promotion));
  assert.doesNotMatch(deterministic, /elapsedMs|peakRssBytes|generatedAt/);
  assert.match(renderPromotionMarkdown(promotion), /Worst-family view/);
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
  for (const fixture of [LOCK, PLATEAU, STORYLETS, EARLY_GRID, FINITE_LOOP, GATED_ENDING]) {
    const compiled = await compile(fixture);
    assert.strictEqual(compiled.success, true, path.basename(fixture));
  }
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
