const { test } = require("node:test");
const assert = require("node:assert");
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

const FIXTURES = path.join(__dirname, "fixtures", "search");
const LOCK = path.join(FIXTURES, "combination-lock.ink");
const PLATEAU = path.join(FIXTURES, "deceptive-plateau.ink");
const STORYLETS = path.join(FIXTURES, "storylet-machine.ink");
const EARLY_GRID = path.join(FIXTURES, "early-variable-grid.ink");

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
    limits: { maxDepth: 30, maxStates: 2 },
    passes: [],
  };
  const summary = summarizeSearchResult("fixture", report);
  assert.strictEqual(summary.stateSpace.terminalStates, 2);
  assert.strictEqual(summary.stateSpace.terminalVariableStates, 2);
  assert.deepStrictEqual(summary.findings.visibleEndings, ["Same authored outcome."]);
  assert.deepStrictEqual(summary.findings.visitedKnots, ["ending"]);
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
  for (const fixture of [LOCK, PLATEAU, STORYLETS, EARLY_GRID]) {
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
