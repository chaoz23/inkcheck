const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  parseIssue,
  compile,
  scanKnots,
  scanExternals,
  scanInboundDiverts,
  scanShapeProfile,
  scanStorySemantics,
} = require("../dist/inklecate");
const { buildHumanFindings } = require("../dist/human-report");
const {
  explore,
  explorePortfolio,
  exploreShared,
  exploreSharedVariableAware,
  exploreRandom,
  exploreBeam,
  classifyUnvisitedKnots,
  playtest,
  mergeMinRepro,
  stateKey,
  validateAssertionsForStory,
  validateGoalsForStory,
  exploreWithGoals,
} = require("../dist/explore");
const { recommendNextRun } = require("../dist/advice");
const { runSubmission, webConfigFromEnv } = require("../dist/web");
const { SubmissionError, validateSubmission } = require("../dist/web-validation");
const {
  capabilities,
  inspectProject,
  PROJECT_INSPECTION_SCHEMA_VERSION,
} = require("../dist/discovery");
const { CONFIG_SCHEMA_VERSION, parseProjectConfig, loadProjectConfig } = require("../dist/config");
const { initProject, createAgentKit } = require("../dist/scaffold");
const {
  evaluateCondition,
  observedValues,
  parseAssertionDefinitions,
  validateAssertions,
} = require("../dist/assertions");
const { parseGoalDefinitions } = require("../dist/goals");

const MANOR = path.join(__dirname, "..", "examples", "manor.ink");
const BROKEN = path.join(__dirname, "..", "examples", "broken.ink");
const LINEAR_RUNTIME_ERROR = path.join(
  __dirname,
  "..",
  "examples",
  "linear-runtime-error.ink"
);
const CLEAN_BRANCH = path.join(__dirname, "..", "examples", "clean-branch.ink");
const CONTENT_EXHAUSTION = path.join(__dirname, "..", "examples", "content-exhaustion.ink");
const EARLY_CHOICE_GRID = path.join(__dirname, "..", "examples", "early-choice-grid.ink");
const DEEP_CHAIN = path.join(__dirname, "..", "examples", "deep-chain.ink");
const EXTERNAL_STORY = path.join(__dirname, "..", "examples", "external-story.ink");
const CLI = path.join(__dirname, "..", "dist", "cli.js");
const ROOT = path.join(__dirname, "..");
const SEARCH_FIXTURES = path.join(__dirname, "fixtures", "search");
const INSPECT_PROJECT = path.join(__dirname, "fixtures", "inspect", "project.ink");
const DUPLICATE_CHOICE_TEXT = path.join(__dirname, "fixtures", "duplicate-choice-text.ink");
const ASSERTION_STORY = path.join(__dirname, "fixtures", "assertions.ink");
const STAGED_DISJOINT = path.join(__dirname, "fixtures", "staged-disjoint.ink");

const ASSERTION_RULES = [
  {
    id: "gold_nonnegative",
    description: "Gold never goes negative",
    when: "always",
    condition: { left: { variable: "gold" }, operator: ">=", right: { literal: 0 } },
  },
  {
    id: "health_bounded",
    when: "always",
    condition: { left: { variable: "health" }, operator: "<=", right: { variable: "max_health" } },
  },
  {
    id: "resources_valid",
    when: "always",
    condition: {
      all: [
        { left: { variable: "gold" }, operator: ">=", right: { literal: 0 } },
        { left: { variable: "health" }, operator: "<=", right: { variable: "max_health" } },
      ],
    },
  },
  {
    id: "ready_at_end",
    when: "terminal",
    condition: { left: { variable: "ready" }, operator: "==", right: { literal: true } },
  },
  {
    id: "key_at_gate",
    when: { knot: "locked_gate" },
    condition: { left: { variable: "key" }, operator: "==", right: { literal: true } },
  },
];

test("parseIssue extracts severity, file, line, message", () => {
  const i = parseIssue("ERROR: 'story.ink' line 42: Divert target not found: '-> nowhere'");
  assert.strictEqual(i.severity, "ERROR");
  assert.strictEqual(i.file, "story.ink");
  assert.strictEqual(i.line, 42);
  assert.match(i.message, /Divert target not found/);
});

test("parseIssue tolerates lines without file/line", () => {
  const i = parseIssue("WARNING: something general");
  assert.strictEqual(i.severity, "WARNING");
  assert.strictEqual(i.line, null);
});

test("scanKnots finds all knots with locations", () => {
  const knots = scanKnots(MANOR);
  const names = knots.map((k) => k.name);
  assert.ok(names.includes("entrance"));
  assert.ok(names.includes("treasure_vault"));
  assert.strictEqual(knots.length, 7);
  const vault = knots.find((k) => k.name === "treasure_vault");
  assert.strictEqual(vault.file, "manor.ink");
  assert.ok(vault.line > 30);
});

test("scanExternals returns empty for stories without EXTERNAL", () => {
  assert.deepStrictEqual(scanExternals(MANOR), []);
});

test("compile reports structured errors for a broken story", async () => {
  const result = await compile(BROKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.errors, 3);
  assert.strictEqual(result.warnings, 1);
  assert.ok(result.issues.every((i) => i.file === "broken.ink"));
});

test("compile succeeds and returns story JSON for a valid story", async () => {
  const result = await compile(MANOR);
  assert.strictEqual(result.success, true);
  assert.ok(result.storyJson.length > 100);
});

test("capabilities explicitly reports supported and unavailable features", () => {
  const value = capabilities();
  assert.strictEqual(value.schemaVersion, 1);
  assert.strictEqual(value.inkcheckVersion, "0.5.1");
  assert.deepStrictEqual(value.searchModes, ["portfolio", "shared", "shared-variable"]);
  assert.strictEqual(value.limits.maxStates, 100_000_000);
  assert.strictEqual(value.limits.maxGoalStates, 100_000_000);
  assert.strictEqual(value.limits.maxTotalStates, 100_000_000);
  assert.strictEqual(value.limits.defaultGoalMaxStates, 0);
  assert.strictEqual(value.features.projectInspection, true);
  assert.strictEqual(value.schemas.report, 1);
  assert.strictEqual(value.schemas.config, CONFIG_SCHEMA_VERSION);
  assert.strictEqual(value.limits.defaultMaxDepth, 100);
  assert.strictEqual(value.features.indexedWitnesses, true);
  assert.strictEqual(value.features.assertions, true);
  assert.strictEqual(value.features.goals, true);
  assert.strictEqual(value.features.stagedGoals, true);
  assert.strictEqual(value.features.resumableSearch, false);
});

test("config schema v1 validates bounded executable project defaults", () => {
  const parsed = parseProjectConfig(`
schemaVersion: 1
entrypoint: stories/main.ink
ci:
  maxDepth: 120
  maxStates: 50000
  seed: 7
  search: shared-variable
  maxMemoryMb: 512
  maxTimeSec: 60
  strict: true
  minRepro: false
`);
  assert.strictEqual(parsed.schemaVersion, 1);
  assert.strictEqual(parsed.entrypoint, "stories/main.ink");
  assert.deepStrictEqual(parsed.ci, {
    maxDepth: 120,
    maxStates: 50000,
    seed: 7,
    maxMemoryMb: 512,
    maxTimeSec: 60,
    search: "shared-variable",
    strict: true,
    minRepro: false,
  });
});

test("config rejects unknown keys, unsafe entrypoints, and invalid bounds", () => {
  assert.throws(
    () => parseProjectConfig("schemaVersion: 1\nentrypoint: ../story.ink\nfutureGoals: []\nci:\n  maxDepth: 0\n"),
    /root\.futureGoals: unknown key[\s\S]*entrypoint: must stay inside[\s\S]*ci\.maxDepth/
  );
  assert.throws(
    () => parseProjectConfig("schemaVersion: 2\nentrypoint: story.ink\nentrypoint: other.ink\n"),
    /Map keys must be unique/
  );
});

test("assertion grammar supports typed comparisons and all/any/not without expressions", () => {
  const issues = [];
  const rules = parseAssertionDefinitions(
    [
      {
        id: "resource_bounds",
        description: "Gold stays in its authored range",
        when: "always",
        condition: {
          all: [
            { left: { variable: "gold" }, operator: ">=", right: { literal: 0 } },
            {
              any: [
                { left: { variable: "gold" }, operator: "<=", right: { variable: "max_gold" } },
                { not: { left: { variable: "debug" }, operator: "==", right: { literal: false } } },
              ],
            },
          ],
        },
      },
    ],
    "assertions",
    issues
  );
  assert.deepStrictEqual(issues, []);
  assert.strictEqual(validateAssertions(rules, { gold: 5, max_gold: 10, debug: false }, ["start"]).length, 0);
  assert.strictEqual(evaluateCondition(rules[0].condition, { gold: 5, max_gold: 10, debug: false }), true);
  assert.strictEqual(evaluateCondition(rules[0].condition, { gold: -1, max_gold: 10, debug: true }), false);
  assert.deepStrictEqual(observedValues(rules[0].condition, { gold: -1, max_gold: 10, debug: true }), {
    gold: -1,
    max_gold: 10,
    debug: true,
  });
});

test("assertion validation rejects unknown variables, knots, type errors, and executable-looking keys", () => {
  const source = `
schemaVersion: 1
entrypoint: story.ink
assertions:
  - id: unsafe_rule
    when:
      knot: missing_knot
    condition:
      left:
        variable: gold
        expression: process.exit()
      operator: ">="
      right:
        variable: missing_variable
`;
  assert.throws(() => parseProjectConfig(source), /condition\.left\.expression: unknown key/);

  const issues = [];
  const rules = parseAssertionDefinitions(
    [
      {
        id: "bad_types",
        when: { knot: "missing_knot" },
        condition: { left: { variable: "gold" }, operator: ">", right: { literal: "zero" } },
      },
      {
        id: "unknown_var",
        when: "terminal",
        condition: { left: { variable: "missing" }, operator: "==", right: { literal: true } },
      },
    ],
    "assertions",
    issues
  );
  assert.deepStrictEqual(issues, []);
  assert.deepStrictEqual(validateAssertions(rules, { gold: 1 }, ["start"]), [
    "assertions.bad_types.when.knot: unknown knot missing_knot",
    "assertions.bad_types: cannot compare number with string",
    "assertions.unknown_var: unknown variable missing",
  ]);
});

test("assertion config rejects duplicate IDs and malformed compound conditions", () => {
  const issues = [];
  parseAssertionDefinitions(
    [
      { id: "same", when: "always", condition: { all: [] } },
      {
        id: "same",
        when: "terminal",
        condition: { left: { literal: 1 }, operator: "eval", right: { literal: 2 } },
      },
    ],
    "assertions",
    issues
  );
  assert.ok(issues.some((issue) => /non-empty list/.test(issue)));
  assert.ok(issues.some((issue) => /duplicate assertion id/.test(issue)));
  assert.ok(issues.some((issue) => /expected ==, !=, <, <=, >, >=/.test(issue)));
});

test("goal config reuses the safe typed condition grammar", () => {
  const parsed = parseProjectConfig(`
schemaVersion: 1
entrypoint: story.ink
goals:
  - id: depleted_gold
    description: Reach a depleted resource state
    condition:
      left: { variable: gold }
      operator: "<="
      right: { literal: 0 }
`);
  assert.strictEqual(parsed.goals[0].id, "depleted_gold");
  assert.throws(
    () => parseProjectConfig(`schemaVersion: 1\nentrypoint: story.ink\ngoals:\n  - id: unsafe\n    condition:\n      expression: process.exit()\n`),
    /expected exactly one condition form|unknown key/
  );
});

test("staged goal config accepts ordered typed milestones and rejects ambiguous forms", () => {
  const parsed = parseProjectConfig(`schemaVersion: 1
entrypoint: story.ink
goals:
  - id: prepared_finish
    stages:
      - id: prepare
        condition: { left: { variable: ready }, operator: "==", right: { literal: true } }
      - id: unlock
        condition: { left: { variable: key }, operator: "==", right: { literal: true } }
`);
  assert.strictEqual(parsed.goals[0].stages.length, 2);
  assert.strictEqual(parsed.goals[0].stages[1].id, "unlock");
  assert.throws(
    () => parseProjectConfig(`schemaVersion: 1
entrypoint: story.ink
goals:
  - id: ambiguous
    condition: { left: { variable: ready }, operator: "==", right: { literal: true } }
    stages:
      - { id: one, condition: { left: { variable: ready }, operator: "==", right: { literal: true } } }
      - { id: two, condition: { left: { variable: key }, operator: "==", right: { literal: true } } }
`),
    /exactly one of condition or stages/
  );
});

test("staged goals require one cumulative witness and block downstream stages", async () => {
  const compiled = await compile(STAGED_DISJOINT);
  const knots = scanKnots(STAGED_DISJOINT);
  const goals = [{
    id: "ordered",
    stages: [
      { id: "a_first", condition: { left: { variable: "a" }, operator: "==", right: { literal: true } } },
      { id: "then_b", condition: { left: { variable: "b" }, operator: "==", right: { literal: true } } },
    ],
  }];
  validateGoalsForStory(compiled.storyJson, knots, [], goals);
  const result = exploreWithGoals(compiled.storyJson, knots, [], { maxStates: 100, goalMaxStates: 50, goals });
  assert.strictEqual(result.goalResults[0].stages[0].status, "reached");
  assert.deepStrictEqual(result.goalResults[0].stages[0].witness.choiceIndices, [0]);
  assert.strictEqual(result.goalResults[0].stages[1].status, "proven_unreachable");
  assert.notStrictEqual(result.goalResults[0].status, "reached");

  const impossible = [{
    id: "blocked",
    stages: [
      { id: "never", condition: { all: [
        { left: { variable: "a" }, operator: "==", right: { literal: true } },
        { left: { variable: "b" }, operator: "==", right: { literal: true } },
      ] } },
      { id: "later", condition: { left: { variable: "b" }, operator: "==", right: { literal: true } } },
    ],
  }];
  const blocked = exploreWithGoals(compiled.storyJson, knots, [], { maxStates: 100, goalMaxStates: 50, goals: impossible });
  assert.strictEqual(blocked.goalResults[0].stages[0].status, "proven_unreachable");
  assert.strictEqual(blocked.goalResults[0].stages[1].status, "blocked_by_stage");
  assert.strictEqual(blocked.goalResults[0].stages[1].blockedBy, "never");
  assert.strictEqual(blocked.goalResults[0].status, "blocked_by_stage");
});

test("staged goals report exact witnesses for every cumulative milestone", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  const goals = [{
    id: "prepared_finish",
    stages: [
      { id: "prepare", condition: { left: { variable: "ready" }, operator: "==", right: { literal: true } } },
      { id: "unlock", condition: { left: { variable: "key" }, operator: "==", right: { literal: true } } },
    ],
  }];
  const result = exploreWithGoals(compiled.storyJson, knots, [], { maxStates: 100, goalMaxStates: 25, goals });
  assert.strictEqual(result.goalResults[0].status, "reached");
  assert.deepStrictEqual(result.goalResults[0].stages.map((stage) => stage.status), ["reached", "reached"]);
  assert.deepStrictEqual(result.goalResults[0].stages[1].witness.choiceIndices, [4]);
  assert.deepStrictEqual(result.goalResults[0].stages[1].witness.observedValues, { ready: true, key: true });
});

test("bounded goal search reaches targets with exact witnesses and protects general exploration", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  const issues = [];
  const goals = parseGoalDefinitions([{
    id: "negative_gold",
    condition: { left: { variable: "gold" }, operator: "<", right: { literal: 0 } },
  }], "goals", issues);
  assert.deepStrictEqual(issues, []);
  validateGoalsForStory(compiled.storyJson, knots, [], goals);
  const result = exploreWithGoals(compiled.storyJson, knots, [], {
    maxDepth: 10,
    maxStates: 100,
    goalMaxStates: 25,
    seed: 7,
    goals,
  });
  const goal = result.goalResults[0];
  assert.strictEqual(goal.status, "reached");
  assert.deepStrictEqual(goal.witness.choiceIndices, [0]);
  assert.deepStrictEqual(goal.witness.observedValues, { gold: -1 });
  assert.ok(goal.witness.foundBy);
  assert.ok(result.passes.some((pass) => pass.pass === "dfs:last"), "general portfolio remains active");
  assert.ok(result.passes.some((pass) => /^shared:goal-directed-v1/.test(pass.pass)), "goal slice is reported");
  assert.strictEqual(result.limits.maxStates, 100);
  assert.strictEqual(result.limits.goalMaxStates, 25);
  assert.strictEqual(result.limits.totalMaxStates, 125);
  assert.strictEqual(result.goalBudget.generalGranted, 100);
  assert.strictEqual(result.goalBudget.directedGranted, 25);
});

test("every exploration engine records goals reached during general exploration", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  const goals = [{
    id: "negative_gold",
    condition: { left: { variable: "gold" }, operator: "<", right: { literal: 0 } },
  }];
  const engines = [
    ["dfs", explore],
    ["shared", exploreShared],
    ["random", exploreRandom],
    ["beam", exploreBeam],
    ["portfolio", explorePortfolio],
  ];
  for (const [name, run] of engines) {
    const result = run(compiled.storyJson, knots, [], { maxDepth: 10, maxStates: 2_000, seed: 7, goals });
    assert.strictEqual(result.goalResults[0].status, "reached", name);
    assert.deepStrictEqual(result.goalResults[0].witness.choiceIndices, [0], name);
  }
});

test("goals do not reduce or alter the baseline when no extra goal budget is requested", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  const options = { maxDepth: 10, maxStates: 100, seed: 7 };
  const baseline = explorePortfolio(compiled.storyJson, knots, [], options);
  const observed = exploreWithGoals(compiled.storyJson, knots, [], {
    ...options,
    goals: [{
      id: "negative_gold",
      condition: { left: { variable: "gold" }, operator: "<", right: { literal: 0 } },
    }],
  });
  assert.strictEqual(observed.statesExplored, baseline.statesExplored);
  assert.deepStrictEqual(observed.endingsFound, baseline.endingsFound);
  assert.deepStrictEqual(observed.runtimeErrors, baseline.runtimeErrors);
  assert.strictEqual(observed.goalBudget, undefined);
  assert.strictEqual(observed.goalResults[0].status, "reached");
});

test("additional goal work requires goals and shares the 100M total ceiling", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  assert.throws(
    () => exploreWithGoals(compiled.storyJson, knots, [], { maxStates: 10, goalMaxStates: 1 }),
    /requires at least one goal/
  );
  assert.throws(
    () => exploreWithGoals(compiled.storyJson, knots, [], {
      maxStates: 100_000_000,
      goalMaxStates: 1,
      goals: [{ id: "x", condition: { left: { variable: "gold" }, operator: "==", right: { literal: 0 } } }],
    }),
    /must not exceed 100000000/
  );
});

test("goal-directed progress remains monotonic across the general and directed slices", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  const states = [];
  exploreWithGoals(compiled.storyJson, knots, [], {
    maxDepth: 10,
    maxStates: 100,
    goalMaxStates: 25,
    goals: [{
      id: "negative_gold",
      condition: { left: { variable: "gold" }, operator: "<", right: { literal: 0 } },
    }],
    progressIntervalStates: 1,
    onProgress: (progress) => states.push(progress.statesExplored),
  });
  assert.ok(states.length > 1);
  assert.deepStrictEqual(states, [...states].sort((a, b) => a - b));
});

test("bounded goal misses are not reported as proof", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  const issues = [];
  const goals = parseGoalDefinitions([{
    id: "impossible_gold",
    condition: { left: { variable: "gold" }, operator: "<", right: { literal: -100 } },
  }], "goals", issues);
  const result = exploreWithGoals(compiled.storyJson, knots, [], {
    maxDepth: 1,
    maxStates: 2,
    goalMaxStates: 1,
    goals,
  });
  assert.strictEqual(result.goalResults[0].status, "not_reached_within_limits");
  assert.ok(result.goalResults[0].closestObserved);
});

test("every exploration engine evaluates the same assertions on visited states", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  validateAssertionsForStory(compiled.storyJson, knots, [], ASSERTION_RULES);
  const engines = [
    ["dfs", (options) => explore(compiled.storyJson, knots, [], options)],
    ["shared", (options) => exploreShared(compiled.storyJson, knots, [], options)],
    ["random", (options) => exploreRandom(compiled.storyJson, knots, [], options)],
    ["beam", (options) => exploreBeam(compiled.storyJson, knots, [], options)],
  ];
  for (const [name, run] of engines) {
    const result = run({ maxDepth: 10, maxStates: 2_000, seed: 7, assertions: ASSERTION_RULES });
    const violated = result.assertionResults.filter((item) => item.status === "violated");
    assert.deepStrictEqual(
      violated.map((item) => item.id).sort(),
      ASSERTION_RULES.map((item) => item.id).sort(),
      `${name} assertion IDs`
    );
    for (const item of violated) {
      assert.strictEqual(item.violations.length, 1, `${name} deduplicates ${item.id}`);
      assert.strictEqual(item.violations[0].path.length, item.violations[0].choiceIndices.length);
      assert.ok(item.violations[0].firstDiscoveredAtState >= 1);
      assert.ok(item.violations[0].foundBy);
      if (item.id === "key_at_gate") {
        assert.strictEqual(item.violations[0].sourceLocation.approximate, false);
        assert.ok(item.violations[0].sourceLocation.line > 0);
      }
    }
  }
});

test("assertion status distinguishes bounded non-observation from exhaustive verification", async () => {
  const compiled = await compile(CLEAN_BRANCH);
  const knots = scanKnots(CLEAN_BRANCH);
  const rules = [{
    id: "safe",
    when: "always",
    condition: { left: { literal: 1 }, operator: "==", right: { literal: 1 } },
  }];
  const bounded = exploreRandom(compiled.storyJson, knots, [], { maxStates: 1, assertions: rules });
  assert.strictEqual(bounded.assertionResults[0].status, "not_observed");
  const exhaustive = explore(compiled.storyJson, knots, [], { maxStates: 100, assertions: rules });
  assert.strictEqual(exhaustive.exhaustive, true);
  assert.strictEqual(exhaustive.assertionResults[0].status, "exhaustively_verified");
});

test("CLI assertions fail CI and emit stable replayable counterexamples", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-assertions-cli-"));
  try {
    fs.copyFileSync(ASSERTION_STORY, path.join(tmp, "story.ink"));
    const config = require("yaml").stringify({
      schemaVersion: 1,
      entrypoint: "story.ink",
      ci: { maxDepth: 10, maxStates: 500 },
      assertions: ASSERTION_RULES,
    });
    fs.writeFileSync(path.join(tmp, "inkcheck.yml"), config);
    const checked = spawnSync(process.execPath, [CLI, "--json"], { cwd: tmp, encoding: "utf8" });
    assert.strictEqual(checked.status, 1, checked.stderr);
    const report = JSON.parse(checked.stdout);
    const violation = report.explore.assertionResults
      .find((item) => item.id === "gold_nonnegative").violations[0];
    assert.match(violation.id, /^assertion\.violation:/);
    assert.strictEqual(violation.kind, "assertion.violation");
    assert.deepStrictEqual(violation.replay.choices, violation.choiceIndices);
    assert.strictEqual(violation.observedValues.gold, -1);
    const repeated = spawnSync(process.execPath, [CLI, "--json"], { cwd: tmp, encoding: "utf8" });
    const repeatedViolation = JSON.parse(repeated.stdout).explore.assertionResults
      .find((item) => item.id === "gold_nonnegative").violations[0];
    assert.strictEqual(repeatedViolation.id, violation.id);

    const human = spawnSync(process.execPath, [CLI, "--human"], { cwd: tmp, encoding: "utf8" });
    assert.strictEqual(human.status, 1);
    assert.match(human.stdout, /Story assertion/);
    assert.match(human.stdout, /Gold never goes negative/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI project goals return bounded allocation and replayable witnesses without failing CI", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-goals-cli-"));
  try {
    fs.copyFileSync(ASSERTION_STORY, path.join(tmp, "story.ink"));
    fs.writeFileSync(path.join(tmp, "inkcheck.yml"), require("yaml").stringify({
      schemaVersion: 1,
      entrypoint: "story.ink",
      ci: { maxDepth: 10, maxStates: 100, goalMaxStates: 25, minRepro: false },
      goals: [{
        id: "negative_gold",
        condition: { left: { variable: "gold" }, operator: "<", right: { literal: 0 } },
      }],
    }));
    const checked = spawnSync(process.execPath, [CLI, "--json"], { cwd: tmp, encoding: "utf8" });
    assert.strictEqual(checked.status, 0, checked.stderr);
    const report = JSON.parse(checked.stdout);
    assert.strictEqual(report.explore.goalBudget.generalGranted, 100);
    assert.strictEqual(report.explore.goalBudget.directedGranted, 25);
    assert.ok(report.explore.goalBudget.generalConsumed <= 100);
    assert.ok(report.explore.goalBudget.directedConsumed <= 25);
    assert.strictEqual(report.effectiveConfiguration.goalMaxStates, 25);
    assert.strictEqual(report.explore.limits.totalMaxStates, 125);
    const goal = report.explore.goalResults[0];
    assert.strictEqual(goal.status, "reached");
    assert.deepStrictEqual(goal.witness.choiceIndices, [0]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("config loader resolves a project-local entrypoint and reports missing files", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-config-"));
  try {
    fs.mkdirSync(path.join(tmp, "stories"));
    fs.writeFileSync(path.join(tmp, "stories", "main.ink"), "Hello\n-> END\n");
    const configFile = path.join(tmp, "inkcheck.yml");
    fs.writeFileSync(configFile, "schemaVersion: 1\nentrypoint: stories/main.ink\n");
    const loaded = loadProjectConfig(configFile);
    assert.strictEqual(loaded.entrypoint, path.join(tmp, "stories", "main.ink"));
    fs.unlinkSync(loaded.entrypoint);
    assert.throws(() => loadProjectConfig(configFile), /entrypoint: file not found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI validates config and applies its defaults with explicit flags winning", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-config-cli-"));
  try {
    fs.copyFileSync(CLEAN_BRANCH, path.join(tmp, "story.ink"));
    fs.writeFileSync(
      path.join(tmp, "inkcheck.yml"),
      "schemaVersion: 1\nentrypoint: story.ink\nci:\n  maxDepth: 4\n  maxStates: 1\n  seed: 9\n"
    );
    const validated = spawnSync(process.execPath, [CLI, "validate-config", "--json"], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.strictEqual(validated.status, 0, validated.stderr);
    assert.strictEqual(JSON.parse(validated.stdout).valid, true);

    const configured = spawnSync(process.execPath, [CLI, "--json"], { cwd: tmp, encoding: "utf8" });
    assert.strictEqual(configured.status, 0, configured.stderr);
    assert.deepStrictEqual(JSON.parse(configured.stdout).explore.limits, {
      maxDepth: 4,
      maxStates: 1,
    });

    const overridden = spawnSync(process.execPath, [CLI, "--json", "--max-states", "2"], {
      cwd: tmp,
      encoding: "utf8",
    });
    assert.strictEqual(overridden.status, 0, overridden.stderr);
    assert.strictEqual(JSON.parse(overridden.stdout).explore.limits.maxStates, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("init creates one minimal config and is idempotent", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-init-"));
  try {
    fs.mkdirSync(path.join(tmp, "story"));
    fs.writeFileSync(path.join(tmp, "story", "main.ink"), "Hello\n-> END\n");
    const first = initProject(tmp);
    assert.strictEqual(first.entrypoint, "story/main.ink");
    assert.strictEqual(first.files[0].status, "created");
    const content = fs.readFileSync(path.join(tmp, "inkcheck.yml"), "utf8");
    const second = initProject(tmp);
    assert.strictEqual(second.files[0].status, "unchanged");
    assert.strictEqual(fs.readFileSync(path.join(tmp, "inkcheck.yml"), "utf8"), content);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("init requires an explicit entrypoint for multi-file projects", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-init-many-"));
  try {
    fs.writeFileSync(path.join(tmp, "one.ink"), "-> END\n");
    fs.writeFileSync(path.join(tmp, "two.ink"), "-> END\n");
    assert.throws(() => initProject(tmp), /Multiple \.ink files found/);
    const result = initProject(tmp, "two.ink");
    assert.strictEqual(result.entrypoint, "two.ink");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Codex agent kit creates synchronized config, CI, ignore rules, and instructions", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-agent-kit-"));
  try {
    fs.writeFileSync(path.join(tmp, "story.ink"), "-> END\n");
    const first = createAgentKit(tmp, "codex");
    assert.deepStrictEqual(first.files.map((file) => file.status), ["created", "created", "created", "created"]);
    assert.match(fs.readFileSync(path.join(tmp, ".inkcheck", "AGENTS.md"), "utf8"), /Inkcheck 0\.5\.1/);
    assert.match(fs.readFileSync(path.join(tmp, ".github", "workflows", "inkcheck.yml"), "utf8"), /inkcheck@0\.5\.1/);
    assert.match(fs.readFileSync(path.join(tmp, ".inkcheck", ".gitignore"), "utf8"), /checkpoints\//);
    const second = createAgentKit(tmp, "codex");
    assert.ok(second.files.every((file) => file.status === "unchanged"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("agent kit preflights conflicts and never partially overwrites a project", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-agent-conflict-"));
  try {
    fs.writeFileSync(path.join(tmp, "story.ink"), "-> END\n");
    fs.mkdirSync(path.join(tmp, ".github", "workflows"), { recursive: true });
    const workflow = path.join(tmp, ".github", "workflows", "inkcheck.yml");
    fs.writeFileSync(workflow, "custom workflow\n");
    assert.throws(() => createAgentKit(tmp, "codex"), /Refusing to overwrite existing file/);
    assert.strictEqual(fs.readFileSync(workflow, "utf8"), "custom workflow\n");
    assert.strictEqual(fs.existsSync(path.join(tmp, "inkcheck.yml")), false);
    assert.strictEqual(fs.existsSync(path.join(tmp, ".inkcheck", "AGENTS.md")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI init and agent-kit expose machine-readable idempotent results", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-scaffold-cli-"));
  try {
    fs.writeFileSync(path.join(tmp, "story.ink"), "-> END\n");
    const initialized = spawnSync(process.execPath, [CLI, "init", tmp, "--json"], { encoding: "utf8" });
    assert.strictEqual(initialized.status, 0, initialized.stderr);
    assert.strictEqual(JSON.parse(initialized.stdout).files[0].status, "created");
    const kit = spawnSync(process.execPath, [CLI, "agent-kit", "--format", "codex", tmp, "--json"], {
      encoding: "utf8",
    });
    assert.strictEqual(kit.status, 0, kit.stderr);
    assert.strictEqual(JSON.parse(kit.stdout).files.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("project inspection follows includes and returns a bounded deterministic map", () => {
  const first = inspectProject(INSPECT_PROJECT);
  const second = inspectProject(INSPECT_PROJECT);
  assert.deepStrictEqual(second, first);
  assert.strictEqual(first.schemaVersion, PROJECT_INSPECTION_SCHEMA_VERSION);
  assert.strictEqual(first.entrypoint, "project.ink");
  assert.deepStrictEqual(first.includes, ["chapters/market.ink"]);
  assert.strictEqual(first.semantics.usesTurns, true);
  assert.strictEqual(first.semantics.usesRandomness, true);
  assert.deepStrictEqual(first.externals, ["award_badge"]);
  assert.ok(first.knots.some((knot) => knot.name === "market" && knot.file === "chapters/market.ink"));
  const gold = first.variables.find((item) => item.name === "gold");
  assert.deepStrictEqual(gold.initialValue, 10);
  assert.ok(gold.readCount >= 1);
  assert.ok(gold.writeCount >= 1);
  assert.strictEqual(first.recommendedNextOperation, "compile_story");
});

test("project inspection rejects missing and outside-root includes", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-inspect-"));
  try {
    fs.writeFileSync(path.join(tmp, "missing.ink"), "INCLUDE nope.ink\n");
    assert.throws(() => inspectProject(path.join(tmp, "missing.ink")), /Included Ink file not found/);
    fs.writeFileSync(path.join(tmp, "outside.ink"), "-> END\n");
    const child = path.join(tmp, "child");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, "project.ink"), "INCLUDE ../outside.ink\n");
    assert.throws(() => inspectProject(path.join(child, "project.ink")), /Unsafe INCLUDE/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("project inspection caps large variable inventories explicitly", () => {
  const tmp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "inkcheck-inspect-large-"));
  try {
    const file = path.join(tmp, "large.ink");
    fs.writeFileSync(
      file,
      Array.from({ length: 205 }, (_, index) => `VAR value_${index} = ${index}`).join("\n") +
        "\n-> END\n"
    );
    const result = inspectProject(file);
    assert.strictEqual(result.variables.length, 200);
    assert.strictEqual(result.truncation.variables, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI capabilities and inspect provide concise human and JSON output", () => {
  const caps = spawnSync(process.execPath, [CLI, "capabilities", "--json"], { encoding: "utf8" });
  assert.strictEqual(caps.status, 0, caps.stderr);
  assert.strictEqual(JSON.parse(caps.stdout).features.projectInspection, true);

  const inspected = spawnSync(process.execPath, [CLI, "inspect", INSPECT_PROJECT, "--json"], {
    encoding: "utf8",
  });
  assert.strictEqual(inspected.status, 0, inspected.stderr);
  assert.strictEqual(JSON.parse(inspected.stdout).entrypoint, "project.ink");

  const human = spawnSync(process.execPath, [CLI, "inspect", INSPECT_PROJECT], { encoding: "utf8" });
  assert.strictEqual(human.status, 0, human.stderr);
  assert.match(human.stdout, /Next: compile the story before exploring it/);
});

test("indexed witnesses disambiguate duplicate choice text and replay exactly", async () => {
  const compiled = await compile(DUPLICATE_CHOICE_TEXT);
  const result = explore(compiled.storyJson, scanKnots(DUPLICATE_CHOICE_TEXT), [], {
    maxStates: 20,
    preserveTurnState: false,
    preserveRandomState: false,
  });
  assert.strictEqual(result.endingsFound.length, 1);
  assert.strictEqual(result.runtimeErrors.length, 1);
  assert.deepStrictEqual(result.endingsFound[0].path, ["Continue"]);
  assert.deepStrictEqual(result.runtimeErrors[0].path, ["Continue"]);
  assert.notDeepStrictEqual(
    result.endingsFound[0].choiceIndices,
    result.runtimeErrors[0].choiceIndices
  );
  const replay = playtest(compiled.storyJson, result.runtimeErrors[0].choiceIndices);
  assert.strictEqual(replay.replayStatus, "runtime_error");
  assert.match(replay.runtimeErrors.join("\n"), /ran out of content/);
  const changed = playtest(compiled.storyJson, [99]);
  assert.strictEqual(changed.replayStatus, "path_changed");
});

test("every exploration engine preserves aligned indexed witnesses", async () => {
  const compiled = await compile(DUPLICATE_CHOICE_TEXT);
  const knots = scanKnots(DUPLICATE_CHOICE_TEXT);
  const options = {
    maxStates: 100,
    seed: 3,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  for (const run of [
    () => explore(compiled.storyJson, knots, [], options),
    () => exploreRandom(compiled.storyJson, knots, [], options),
    () => exploreBeam(compiled.storyJson, knots, [], options),
    () => exploreShared(compiled.storyJson, knots, [], options),
    () => exploreSharedVariableAware(compiled.storyJson, knots, [], options),
    () => explorePortfolio(compiled.storyJson, knots, [], options),
  ]) {
    const result = run();
    const findings = [...result.endingsFound, ...result.runtimeErrors];
    assert.ok(findings.length > 0);
    for (const finding of findings) {
      assert.strictEqual(finding.choiceIndices.length, finding.path.length);
      assert.ok(finding.choiceIndices.every((index) => Number.isInteger(index) && index >= 0));
      assert.ok(Number.isInteger(finding.firstDiscoveredAtState));
    }
  }
});

test("versioned JSON reports have stable identities and exact replay instructions", () => {
  const run = (extra = []) => spawnSync(
    process.execPath,
    [CLI, CONTENT_EXHAUSTION, "--max-states", "100", "--json", ...extra],
    { encoding: "utf8" }
  );
  const first = JSON.parse(run().stdout);
  const second = JSON.parse(run().stdout);
  assert.strictEqual(first.schemaVersion, 1);
  assert.strictEqual(first.inkcheckVersion, "0.5.1");
  assert.strictEqual(first.storyFingerprint.value, second.storyFingerprint.value);
  assert.strictEqual(first.explore.runtimeErrors[0].id, second.explore.runtimeErrors[0].id);
  assert.strictEqual(first.explore.runtimeErrors[0].kind, "runtime.content_exhaustion");
  assert.deepStrictEqual(
    first.explore.runtimeErrors[0].replay.choices,
    first.explore.runtimeErrors[0].choiceIndices
  );
  assert.strictEqual(first.explore.runtimeErrors[0].replay.tool, "playtest_story");
  assert.strictEqual(first.effectiveConfiguration.search, "portfolio");

  const depthLimited = spawnSync(
    process.execPath,
    [CLI, DEEP_CHAIN, "--max-depth", "1", "--max-states", "100", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(JSON.parse(depthLimited.stdout).bindingLimit, "maxDepth");

  const broken = spawnSync(process.execPath, [CLI, BROKEN, "--json"], { encoding: "utf8" });
  const compileFailure = JSON.parse(broken.stdout);
  assert.strictEqual(compileFailure.schemaVersion, 1);
  assert.ok(compileFailure.compile.issues.every((issue) => issue.id && issue.kind));
});

test("shared search exhausts a finite variable-state lock with bounded telemetry", async () => {
  const file = path.join(SEARCH_FIXTURES, "combination-lock.ink");
  const compiled = await compile(file);
  const result = exploreShared(compiled.storyJson, scanKnots(file), [], {
    maxDepth: 20,
    maxStates: 1_000,
    seed: 7,
  });
  assert.strictEqual(result.exhaustive, true);
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.endingsFound.length, 27);
  assert.match(result.endingsFound[0].foundBy, /^shared:/);
  const telemetry = result.passes[0];
  assert.ok(telemetry.uniqueStates > 0);
  assert.ok(telemetry.peakPendingStates > 0);
  assert.ok(telemetry.peakPendingBytes > 0);
  assert.ok(telemetry.variableStatesObserved > 0);
  assert.ok(telemetry.variableTransitionsObserved > 0);
  assert.ok(telemetry.rareVariableTransitions > 0);
});

test("shared search finds the deceptive plateau failure reproducibly", async () => {
  const file = path.join(SEARCH_FIXTURES, "deceptive-plateau.ink");
  const compiled = await compile(file);
  const options = {
    maxDepth: 20,
    maxStates: 500,
    seed: 19,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  const first = exploreShared(compiled.storyJson, scanKnots(file), [], options);
  const second = exploreShared(compiled.storyJson, scanKnots(file), [], options);
  const withoutByteEstimate = (result) => {
    const copy = structuredClone(result);
    delete copy.passes[0].peakPendingBytes;
    return copy;
  };
  assert.deepStrictEqual(withoutByteEstimate(second), withoutByteEstimate(first));
  assert.strictEqual(first.runtimeErrors.length, 1);
  assert.ok(first.runtimeErrors[0].path.length > 0);
  assert.match(first.runtimeErrors[0].foundBy, /^shared:/);
});

test("shared search reports state, memory, and time limits honestly", async () => {
  const file = path.join(SEARCH_FIXTURES, "storylet-machine.ink");
  const compiled = await compile(file);
  const knots = scanKnots(file);
  const budget = exploreShared(compiled.storyJson, knots, [], { maxStates: 10 });
  assert.strictEqual(budget.truncatedBy.maxStates, true);
  assert.strictEqual(budget.exhaustive, false);

  const memory = exploreShared(compiled.storyJson, knots, [], {
    maxStates: 10_000,
    memoryGuard: () => false,
  });
  assert.strictEqual(memory.truncatedBy.memory, true);
  assert.strictEqual(memory.truncatedBy.maxStates, false);

  const time = exploreShared(compiled.storyJson, knots, [], {
    maxStates: 10_000,
    timeGuard: () => false,
  });
  assert.strictEqual(time.truncatedBy.time, true);
  assert.strictEqual(time.truncatedBy.maxStates, false);
});

test("variable-aware shared search prioritizes uncommon storylet states reproducibly", async () => {
  const file = path.join(SEARCH_FIXTURES, "storylet-machine.ink");
  const compiled = await compile(file);
  const knots = scanKnots(file);
  const options = {
    maxDepth: 100,
    maxStates: 100,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  const baseline = exploreShared(compiled.storyJson, knots, [], options);
  const first = exploreSharedVariableAware(compiled.storyJson, knots, [], options);
  const second = exploreSharedVariableAware(compiled.storyJson, knots, [], options);
  assert.ok(first.endingsFound.length > baseline.endingsFound.length);
  assert.deepStrictEqual(
    first.endingsFound.map((ending) => [ending.path, ending.finalText, ending.variables]),
    second.endingsFound.map((ending) => [ending.path, ending.finalText, ending.variables])
  );
  assert.match(first.passes[0].pass, /^shared:variable-aware-v1:/);
});

test("CLI shared search is opt-in and validates its mode", () => {
  const normal = spawnSync(
    process.execPath,
    [CLI, MANOR, "--max-states", "1000", "--no-min-repro", "--json"],
    { encoding: "utf8" }
  );
  assert.ok(normal.status === 0 || normal.status === 1, normal.stderr);
  assert.doesNotMatch(JSON.parse(normal.stdout).explore.passes[0].pass, /^shared:/);

  const shared = spawnSync(
    process.execPath,
    [CLI, MANOR, "--search=shared", "--max-states", "1000", "--no-min-repro", "--json"],
    { encoding: "utf8" }
  );
  assert.ok(shared.status === 0 || shared.status === 1, shared.stderr);
  const report = JSON.parse(shared.stdout);
  assert.match(report.explore.passes[0].pass, /^shared:/);

  const variable = spawnSync(
    process.execPath,
    [CLI, MANOR, "--search=shared-variable", "--max-states", "1000", "--no-min-repro", "--json"],
    { encoding: "utf8" }
  );
  assert.ok(variable.status === 0 || variable.status === 1, variable.stderr);
  assert.match(JSON.parse(variable.stdout).explore.passes[0].pass, /^shared:variable-aware-v1:/);

  const invalid = spawnSync(process.execPath, [CLI, MANOR, "--search", "nope"], {
    encoding: "utf8",
  });
  assert.strictEqual(invalid.status, 2);
  assert.match(invalid.stderr, /--search must be portfolio, shared, or shared-variable/);
});

test("explore finds endings, runtime errors with repro, and unvisited knots", async () => {
  const compiled = await compile(MANOR);
  const report = explore(compiled.storyJson, scanKnots(MANOR));
  assert.strictEqual(report.endingsFound.length, 5);
  assert.strictEqual(report.runtimeErrors.length, 1);
  assert.deepStrictEqual(report.runtimeErrors[0].path, [
    "Enter in darkness",
    "Descend to the cellar",
  ]);
  assert.deepStrictEqual(
    report.unvisitedKnots.map((k) => k.name),
    ["treasure_vault"]
  );
  assert.strictEqual(report.truncated, false);
});

test("portfolio progress counts move monotonically across interleaved passes", async () => {
  // A branchy story with a budget below its reachable space, so no pass proves
  // exhaustion early and the scheduler round-robins every pass — the exact
  // condition under which per-pass snapshot counts used to bounce.
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const externals = scanExternals(EARLY_CHOICE_GRID);
  const events = [];
  // progressIntervalMs: 0 emits on every chunk, so the interleaving of passes
  // is fully exercised.
  const report = explorePortfolio(compiled.storyJson, knots, externals, {
    maxStates: 400,
    progressIntervalMs: 0,
    onProgress: (p) => events.push(p),
  });
  assert.ok(events.length > 5, "expected many interleaved progress events");
  assert.ok(
    new Set(events.map((e) => e.pass)).size > 1,
    "expected more than one pass to report, or interleaving is untested"
  );
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    assert.ok(
      cur.endingsFound >= prev.endingsFound,
      `endings must not decrease: ${prev.endingsFound} -> ${cur.endingsFound}`
    );
    assert.ok(
      cur.runtimeErrorsFound >= prev.runtimeErrorsFound,
      `runtime errors must not decrease: ${prev.runtimeErrorsFound} -> ${cur.runtimeErrorsFound}`
    );
    assert.ok(
      cur.unvisitedKnots <= prev.unvisitedKnots,
      `unvisited knots must not increase: ${prev.unvisitedKnots} -> ${cur.unvisitedKnots}`
    );
  }
  // The live counts converge to the final portfolio report.
  const last = events.at(-1);
  assert.strictEqual(last.endingsFound, report.endingsFound.length);
  assert.strictEqual(last.runtimeErrorsFound, report.runtimeErrors.length);
  assert.strictEqual(last.unvisitedKnots, report.unvisitedKnots.length);
});

test("BFS strategy reaches the same endings", async () => {
  const compiled = await compile(MANOR);
  const dfs = explore(compiled.storyJson, scanKnots(MANOR));
  const bfs = explore(compiled.storyJson, scanKnots(MANOR), [], { strategy: "bfs" });
  assert.strictEqual(bfs.endingsFound.length, dfs.endingsFound.length);
  const merged = mergeMinRepro(dfs, bfs);
  for (const e of merged.endingsFound) assert.ok(e.path.length <= 3);
});

test("portfolio exploration spends one total state budget across complementary DFS passes", async () => {
  const compiled = await compile(CLEAN_BRANCH);
  const report = explorePortfolio(compiled.storyJson, scanKnots(CLEAN_BRANCH), [], {
    maxDepth: 5,
    maxStates: 2,
  });
  assert.strictEqual(report.statesExplored, 2);
  assert.strictEqual(report.limits.maxStates, 2);
  assert.strictEqual(report.endingsFound.length, 2);
});

test("random exploration is seeded, reproducible, and labels its findings", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const opts = { maxStates: 600, seed: 7 };
  const a = exploreRandom(compiled.storyJson, knots, [], opts);
  const b = exploreRandom(compiled.storyJson, knots, [], opts);
  assert.deepStrictEqual(a.endingsFound, b.endingsFound);
  assert.deepStrictEqual(a.visitedKnots.sort(), b.visitedKnots.sort());
  assert.strictEqual(a.limits.seed, 7);
  assert.ok(a.endingsFound.length > 0);
  assert.ok(a.endingsFound.every((e) => e.foundBy === "random:seed=7"));
});

// Regression for issues #20/#21: the deterministic DFS portfolio alone missed
// endings 3, 4, 6, and 7 on this fixture even with a 1M state budget, because
// it repeated the same early-choice prefixes while exhausting late suffixes.
test("portfolio covers early-choice state combinations via the random slice", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const report = explorePortfolio(compiled.storyJson, knots, [], { maxStates: 6000 });
  const labels = new Set(report.endingsFound.map((e) => e.finalText.trim()));
  for (let n = 1; n <= 7; n++) {
    assert.ok(labels.has(`Ending ${n}`), `Ending ${n} not found`);
  }
  const strategies = new Set(report.endingsFound.map((e) => e.foundBy));
  assert.ok(strategies.has("random:seed=1"), "random slice contributed findings");
  assert.ok([...strategies].some((s) => s.startsWith("dfs:")), "dfs passes contributed findings");
});

// Issue #21: the beam keeps at most beamWidth states per depth level,
// selected round-robin across variable-signature groups so no lineage is
// starved out. Deterministic without a seed: ties keep discovery order.
test("beam search covers early-choice state combinations without a seed", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const report = exploreBeam(compiled.storyJson, knots, [], { maxStates: 2500 });
  const labels = new Set(report.endingsFound.map((e) => e.finalText.trim()));
  for (let n = 1; n <= 7; n++) {
    assert.ok(labels.has(`Ending ${n}`), `Ending ${n} not found`);
  }
  // The beam pruned reachable states, so it must not claim completeness.
  assert.strictEqual(report.truncated, true);
  assert.ok(report.endingsFound.every((e) => e.foundBy === "beam:w=64"));
});

test("beam search is deterministic and diversity survives a narrow width", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const a = exploreBeam(compiled.storyJson, knots, [], { maxStates: 2500 });
  const b = exploreBeam(compiled.storyJson, knots, [], { maxStates: 2500 });
  assert.deepStrictEqual(a.endingsFound, b.endingsFound);
  assert.deepStrictEqual(a.visitedKnots.sort(), b.visitedKnots.sort());
  // Round-robin selection keeps one state per variable-signature group, so
  // even a width-8 beam reaches every gated ending on this fixture.
  const narrow = exploreBeam(compiled.storyJson, knots, [], { maxStates: 2500, beamWidth: 8 });
  const labels = new Set(narrow.endingsFound.map((e) => e.finalText.trim()));
  for (let n = 1; n <= 7; n++) {
    assert.ok(labels.has(`Ending ${n}`), `Ending ${n} not found at width 8`);
  }
});

test("beam search that never prunes matches DFS findings and reports completeness", async () => {
  const compiled = await compile(MANOR);
  const knots = scanKnots(MANOR);
  const beam = exploreBeam(compiled.storyJson, knots, [], { maxStates: 500 });
  const dfs = explore(compiled.storyJson, knots);
  assert.strictEqual(beam.endingsFound.length, dfs.endingsFound.length);
  assert.strictEqual(beam.runtimeErrors.length, 1);
  assert.ok(beam.runtimeErrors[0].path.length > 0);
  assert.strictEqual(beam.truncated, false);
  assert.throws(
    () => exploreBeam(compiled.storyJson, knots, [], { beamWidth: 0 }),
    /beamWidth must be an integer/
  );
});

test("random exploration reports runtime errors with a repro path and seed", async () => {
  const compiled = await compile(MANOR);
  const report = exploreRandom(compiled.storyJson, scanKnots(MANOR), [], {
    maxStates: 200,
    seed: 3,
  });
  assert.ok(report.runtimeErrors.length >= 1);
  const err = report.runtimeErrors[0];
  assert.ok(err.path.length > 0);
  assert.strictEqual(err.foundBy, "random:seed=3");
  // Crashing walks must not be double-counted as endings.
  assert.ok(report.endingsFound.every((e) => e.finalText.length > 0));
});

// Issue #22: unvisited knots are triaged with an inbound-divert scan so
// reports separate "possible orphan" from "probably beyond this run's limits".
test("scanInboundDiverts counts authored divert targets, ignoring comments", () => {
  const manor = scanInboundDiverts(MANOR);
  assert.strictEqual(manor.treasure_vault ?? 0, 0);
  assert.ok((manor.entrance ?? 0) >= 1);
  const grid = scanInboundDiverts(EARLY_CHOICE_GRID);
  assert.strictEqual(grid.ending7, 1);
  assert.strictEqual(grid.c15, 3);
});

test("unvisited knots are classified as orphan candidates or limit-bound", async () => {
  const compiled = await compile(MANOR);
  const report = classifyUnvisitedKnots(
    explore(compiled.storyJson, scanKnots(MANOR)),
    scanInboundDiverts(MANOR)
  );
  const vault = report.unvisitedKnots.find((k) => k.name === "treasure_vault");
  assert.strictEqual(vault.staticOrphanCandidate, true);
  assert.strictEqual(vault.inboundDiverts, 0);

  const gridCompiled = await compile(EARLY_CHOICE_GRID);
  const shallow = classifyUnvisitedKnots(
    explore(gridCompiled.storyJson, scanKnots(EARLY_CHOICE_GRID), [], { maxDepth: 5, maxStates: 2000 }),
    scanInboundDiverts(EARLY_CHOICE_GRID)
  );
  const ending = shallow.unvisitedKnots.find((k) => k.name === "ending7");
  assert.strictEqual(ending.staticOrphanCandidate, false);
  assert.strictEqual(ending.inboundDiverts, 1);

  const findings = buildHumanFindings({ explore: shallow });
  const endingFinding = findings.find((f) => f.title.includes("ending7"));
  assert.match(endingFinding.action, /--max-depth/);
  // Hosted readers run at fixed limits and cannot set CLI flags, so their copy
  // must not name flags — it points at the local CLI instead (#49).
  const hostedFindings = buildHumanFindings({ explore: shallow }, { audience: "hosted" });
  const hostedEnding = hostedFindings.find((f) => f.title.includes("ending7"));
  assert.doesNotMatch(hostedEnding.action, /--max-/);
  assert.match(hostedEnding.action, /run inkcheck locally/i);
  const vaultFinding = buildHumanFindings({ explore: report }).find((f) =>
    f.title.includes("treasure_vault")
  );
  assert.match(vaultFinding.message, /No authored divert/);
});

test("truncatedBy names the limit that actually cut coverage", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const depthBound = explore(compiled.storyJson, knots, [], { maxDepth: 5, maxStates: 2000 });
  assert.strictEqual(depthBound.truncatedBy.maxDepth, true);
  assert.strictEqual(depthBound.truncatedBy.maxStates, false);
  const stateBound = explore(compiled.storyJson, knots, [], { maxDepth: 30, maxStates: 3 });
  assert.strictEqual(stateBound.truncatedBy.maxStates, true);
  assert.strictEqual(stateBound.truncatedBy.maxDepth, false);
  const pruned = exploreBeam(compiled.storyJson, knots, [], { maxStates: 2500, beamWidth: 8 });
  assert.strictEqual(pruned.truncatedBy.beamWidth, true);
});

// Issue #27: a cheap static profile picks limits and pass weights to match
// the story's shape before the first exploration state is spent.
test("scanShapeProfile reads story shape and suggests matching settings", () => {
  const grid = scanShapeProfile(EARLY_CHOICE_GRID);
  assert.strictEqual(grid.variables, 9);
  assert.strictEqual(grid.earlyAssignmentShare, 1);
  assert.strictEqual(grid.choiceDepthEstimate, 15);
  assert.ok(grid.suggested.weights.random > grid.suggested.weights.last, "sampling weighted up");

  const deep = scanShapeProfile(DEEP_CHAIN);
  assert.strictEqual(deep.choiceDepthEstimate, 130);
  assert.strictEqual(deep.suggested.maxDepth, 260);
  assert.strictEqual(deep.variables, 0);
  assert.strictEqual(deep.suggested.weights.random, 0, "no variables: sampling dropped");

  const clean = scanShapeProfile(CLEAN_BRANCH);
  assert.strictEqual(clean.suggested.weights.beam, 0);
  assert.strictEqual(clean.suggested.maxDepth, 100);
});

// Issue #27: the runtime scheduler cannot fix a too-low depth limit — only
// the pre-flight profile can. Plain defaults find nothing on a 40-deep
// chain; --auto raises depth and proves the story exhaustive.
test("--auto applies the shape profile where defaults find nothing", () => {
  const plain = spawnSync(
    process.execPath,
    [CLI, DEEP_CHAIN, "--max-states", "500", "--json"],
    { encoding: "utf8" }
  );
  const plainReport = JSON.parse(plain.stdout).explore;
  assert.strictEqual(plainReport.endingsFound.length, 0);
  assert.strictEqual(plainReport.truncatedBy.maxDepth, true);

  const auto = spawnSync(
    process.execPath,
    [CLI, DEEP_CHAIN, "--auto", "--max-states", "500", "--json"],
    { encoding: "utf8" }
  );
  const autoOut = JSON.parse(auto.stdout);
  assert.strictEqual(autoOut.profile.suggested.maxDepth, 260);
  assert.strictEqual(autoOut.explore.limits.maxDepth, 260);
  assert.strictEqual(autoOut.explore.endingsFound.length, 1);
  assert.strictEqual(autoOut.explore.exhaustive, true);

  // Explicit flags always win over the profile.
  const pinned = spawnSync(
    process.execPath,
    [CLI, DEEP_CHAIN, "--auto", "--max-depth", "30", "--max-states", "500", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(JSON.parse(pinned.stdout).explore.limits.maxDepth, 30);
});

test("--profile prints the shape without exploring", () => {
  const proc = spawnSync(process.execPath, [CLI, EARLY_CHOICE_GRID, "--profile"], {
    encoding: "utf8",
  });
  assert.strictEqual(proc.status, 0);
  assert.match(proc.stdout, /Story shape profile/);
  assert.match(proc.stdout, /choice point\(s\)/);
  assert.doesNotMatch(proc.stdout, /explored/);
  const asJson = spawnSync(process.execPath, [CLI, EARLY_CHOICE_GRID, "--profile", "--json"], {
    encoding: "utf8",
  });
  assert.strictEqual(JSON.parse(asJson.stdout).profile.choiceDepthEstimate, 15);
});

// Issue #29: the portfolio spends its budget in deterministic rounds,
// reallocates toward passes that are still discovering, and stops the
// moment a systematic pass proves the reachable space exhausted.
test("adaptive scheduler stops early on exhaustive coverage and records its schedule", async () => {
  const compiled = await compile(MANOR);
  const report = explorePortfolio(compiled.storyJson, scanKnots(MANOR), [], {
    maxStates: 100000,
  });
  assert.strictEqual(report.exhaustive, true);
  // Early exit: manor's reachable space is ~10 states; the other ~99,990
  // budgeted states must not be spent resampling it.
  assert.ok(report.statesExplored < 100, `spent ${report.statesExplored} states`);
  assert.ok(Array.isArray(report.schedule) && report.schedule.length >= 1);
  const entry = report.schedule[0].entries[0];
  assert.ok(entry.pass.length > 0);
  assert.ok(entry.granted >= entry.consumed);
});

test("adaptive scheduler is deterministic and respects the total budget", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const a = explorePortfolio(compiled.storyJson, knots, [], { maxStates: 4000 });
  const b = explorePortfolio(compiled.storyJson, knots, [], { maxStates: 4000 });
  assert.deepStrictEqual(a, b);
  assert.ok(a.statesExplored <= 4000);
  const consumed = a.schedule
    .flatMap((round) => round.entries)
    .reduce((sum, entry) => sum + entry.consumed, 0);
  assert.strictEqual(consumed, a.statesExplored);
});

test("portfolio weights control which passes run", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const dfsOnly = explorePortfolio(compiled.storyJson, knots, [], {
    maxStates: 1000,
    weights: { last: 0.3, first: 0.3, insideOut: 0.4, beam: 0, random: 0 },
  });
  const passes = new Set(dfsOnly.schedule.flatMap((round) => round.entries.map((e) => e.pass)));
  assert.ok([...passes].every((p) => p.startsWith("dfs:")), `unexpected passes: ${[...passes]}`);
});

// Issue #28: lifetime per-pass telemetry so agents can see which pass
// earned its budget on this story shape without parsing progress logs.
test("portfolio reports per-pass telemetry consistent with the schedule", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  const report = explorePortfolio(compiled.storyJson, knots, [], { maxStates: 3000 });
  assert.ok(Array.isArray(report.passes) && report.passes.length >= 4);
  assert.ok(report.discoveryCurve.length <= 64);
  const portfolioLatest = report.discoveryCurve.at(-1);
  assert.strictEqual(report.discoverySummary.lastDiscoveryAtState, portfolioLatest.state);
  assert.strictEqual(report.discoverySummary.statesSinceLastDiscovery, report.statesExplored - portfolioLatest.state);
  assert.strictEqual(portfolioLatest.endingsFound, report.endingsFound.length);
  assert.strictEqual(portfolioLatest.runtimeErrorsFound, report.runtimeErrors.length);
  assert.strictEqual(portfolioLatest.knotsVisited, report.visitedKnots.length);
  assert.ok(portfolioLatest.visibleOutcomes <= portfolioLatest.endingsFound);

  // Marginal (portfolio-wide first-discovery) totals must equal the sums
  // of the per-round schedule entries for the same pass.
  const scheduleSums = new Map();
  for (const round of report.schedule) {
    for (const entry of round.entries) {
      const sums = scheduleSums.get(entry.pass) ?? { endings: 0, knots: 0, errors: 0 };
      sums.endings += entry.newEndings;
      sums.knots += entry.newKnots;
      sums.errors += entry.newRuntimeErrors;
      scheduleSums.set(entry.pass, sums);
    }
  }
  for (const t of report.passes) {
    const sums = scheduleSums.get(t.pass) ?? { endings: 0, knots: 0, errors: 0 };
    assert.strictEqual(t.newEndings, sums.endings, `${t.pass} newEndings`);
    assert.strictEqual(t.newKnots, sums.knots, `${t.pass} newKnots`);
    assert.strictEqual(t.newRuntimeErrors, sums.errors, `${t.pass} newRuntimeErrors`);
    assert.ok(t.statesExplored <= t.granted, `${t.pass} overspent its grants`);
    assert.ok(t.maxDepthReached <= 30);
    if (t.lastDiscoveryAtState !== null) {
      assert.ok(t.lastDiscoveryAtState <= t.statesExplored);
      assert.strictEqual(t.discoveryCurve.at(-1).state, t.lastDiscoveryAtState);
    }
    assert.ok(t.discoveryCurve.length <= 64, `${t.pass} curve exceeded bound`);
    assert.deepStrictEqual(t.discoveryCurve.map((sample) => sample.state), [...t.discoveryCurve.map((sample) => sample.state)].sort((a, b) => a - b));
  }
  const beam = report.passes.find((t) => t.pass.startsWith("beam:"));
  assert.ok(beam.peakFrontier >= 1);
  assert.ok(typeof beam.prunes === "number");
  const random = report.passes.find((t) => t.pass.startsWith("random:"));
  assert.strictEqual(random.systematic, false);
  assert.strictEqual(random.dedupeHits, 0, "random never deduplicates");
});

test("standalone passes attach their own telemetry entry", async () => {
  const compiled = await compile(MANOR);
  const report = explore(compiled.storyJson, scanKnots(MANOR));
  assert.strictEqual(report.passes.length, 1);
  const t = report.passes[0];
  assert.strictEqual(t.pass, "dfs:last");
  assert.strictEqual(t.exhaustive, true);
  assert.strictEqual(t.endingsFound, 5);
  assert.strictEqual(t.runtimeErrorsFound, 1);
  assert.ok(t.maxDepthReached >= 2);
  assert.ok(t.lastDiscoveryAtState !== null && t.lastDiscoveryAtState <= t.statesExplored);
  assert.strictEqual(t.discoveryCurve.at(-1).runtimeErrorsFound, 1);
  assert.strictEqual(t.discoveryCurve.at(-1).endingsFound, 5);
});

test("discovery curves stay bounded while preserving early and latest evidence", async () => {
  const compiled = await compile(DEEP_CHAIN);
  const report = explore(compiled.storyJson, scanKnots(DEEP_CHAIN), [], { maxDepth: 200, maxStates: 5_000 });
  const telemetry = report.passes[0];
  assert.ok(telemetry.discoveryCurve.length > 1);
  assert.ok(telemetry.discoveryCurve.length <= 64);
  assert.ok(telemetry.discoverySummary.discoveryEvents >= telemetry.discoveryCurve.length);
  assert.strictEqual(telemetry.discoverySummary.firstDiscoveryAtState, telemetry.discoveryCurve[0].state);
  assert.strictEqual(telemetry.discoverySummary.lastDiscoveryAtState, telemetry.discoveryCurve.at(-1).state);
  assert.strictEqual(telemetry.discoverySummary.statesSinceLastDiscovery, telemetry.statesExplored - telemetry.lastDiscoveryAtState);
  assert.ok(telemetry.discoverySummary.longestObservedDiscoveryGap >= telemetry.discoverySummary.latestDiscoveryGap);
  assert.strictEqual(telemetry.discoveryCurve.at(-1).state, telemetry.lastDiscoveryAtState);
  assert.strictEqual(telemetry.discoveryCurve.at(-1).knotsVisited, telemetry.knotsVisited);
  for (let index = 1; index < telemetry.discoveryCurve.length; index++) {
    const previous = telemetry.discoveryCurve[index - 1];
    const current = telemetry.discoveryCurve[index];
    assert.ok(current.state >= previous.state);
    assert.ok(current.endingsFound >= previous.endingsFound);
    assert.ok(current.runtimeErrorsFound >= previous.runtimeErrorsFound);
    assert.ok(current.knotsVisited >= previous.knotsVisited);
  }
});

test("discovery curves separate assertion, goal, stage, and visible-outcome value", async () => {
  const compiled = await compile(ASSERTION_STORY);
  const knots = scanKnots(ASSERTION_STORY);
  const goals = [{
    id: "prepared",
    stages: [
      { id: "ready", condition: { left: { variable: "ready" }, operator: "==", right: { literal: true } } },
      { id: "key", condition: { left: { variable: "key" }, operator: "==", right: { literal: true } } },
    ],
  }];
  const report = explore(compiled.storyJson, knots, [], {
    maxStates: 1_000,
    assertions: ASSERTION_RULES,
    goals,
  });
  const latest = report.passes[0].discoveryCurve.at(-1);
  assert.ok(latest.assertionViolations >= 1);
  assert.strictEqual(latest.goalsReached, 1);
  assert.strictEqual(latest.stagesReached, 2);
  assert.ok(latest.visibleOutcomes > 0);
  assert.ok(latest.visibleOutcomes < report.endingsFound.length);
});

test("CLI JSON includes telemetry for every pass including the repro slice", () => {
  const proc = spawnSync(process.execPath, [CLI, MANOR, "--json"], { encoding: "utf8" });
  const passes = JSON.parse(proc.stdout).explore.passes;
  const labels = passes.map((t) => t.pass);
  assert.ok(labels.includes("bfs"), `bfs missing from ${labels}`);
  assert.ok(labels.some((l) => l.startsWith("dfs:")));
  for (const t of passes) {
    assert.ok("dedupeHits" in t && "lastDiscoveryAtState" in t && "truncatedBy" in t);
  }
});

// Issue #30: a machine-actionable next-run verdict, computed as a pure
// deterministic function of one report; the rationale cites the fields used.
test("recommendNextRun issues the right verdict per story shape", async () => {
  const knotsChain = scanKnots(DEEP_CHAIN);
  const chainCompiled = await compile(DEEP_CHAIN);
  const chainProfile = scanShapeProfile(DEEP_CHAIN);

  // Exhaustive run → stop.
  const manorCompiled = await compile(MANOR);
  const manorReport = classifyUnvisitedKnots(
    explorePortfolio(manorCompiled.storyJson, scanKnots(MANOR), [], { maxStates: 1000 }),
    scanInboundDiverts(MANOR)
  );
  const stop = recommendNextRun(manorReport);
  assert.strictEqual(stop.recommendation, "stop");
  assert.strictEqual(stop.stop, true);
  assert.match(stop.rationale, /exhaustive/);

  // Depth-bound with inbound-divert unvisited knots → deepen, profile target wins.
  const chainReport = classifyUnvisitedKnots(
    explorePortfolio(chainCompiled.storyJson, knotsChain, [], { maxStates: 500 }),
    scanInboundDiverts(DEEP_CHAIN)
  );
  const deepen = recommendNextRun(chainReport, chainProfile);
  assert.strictEqual(deepen.recommendation, "deepen");
  assert.strictEqual(deepen.flags.maxDepth, 260);
  assert.strictEqual(deepen.flags.maxStates, 500);
  assert.match(deepen.rationale, /truncatedBy\.maxDepth/);
  assert.match(deepen.expectedGain, /inbound diverts/);

  // States-bound while passes still discovering → broaden with 4x budget.
  const gridCompiled = await compile(EARLY_CHOICE_GRID);
  const gridReport = classifyUnvisitedKnots(
    explorePortfolio(gridCompiled.storyJson, scanKnots(EARLY_CHOICE_GRID), [], { maxStates: 1000 }),
    scanInboundDiverts(EARLY_CHOICE_GRID)
  );
  const broaden = recommendNextRun(gridReport);
  assert.strictEqual(broaden.recommendation, "broaden");
  assert.strictEqual(broaden.flags.maxStates, 4000);
  assert.match(broaden.rationale, /lastDiscoveryAtState/);
});

test("recommendNextRun degrades to reseed or investigate at the ceilings", () => {
  const base = {
    statesExplored: 100_000_000,
    endingsFound: [],
    runtimeErrors: [],
    runtimeWarnings: [],
    unvisitedKnots: [{ name: "locked", file: "s.ink", line: 5, inboundDiverts: 2, staticOrphanCandidate: false }],
    visitedKnots: [],
    externalFunctionsStubbed: [],
    randomnessDetected: false,
    truncated: true,
    truncatedBy: { maxDepth: false, maxStates: true, beamWidth: false, memory: false },
    // At the state ceiling (100M), so no broaden is possible.
    limits: { maxDepth: 1000, maxStates: 100_000_000, seed: 3 },
    exhaustive: false,
  };
  // Random still hot, systematic passes saturated, budget at ceiling → reseed.
  const reseed = recommendNextRun({
    ...base,
    passes: [
      { pass: "dfs:last", systematic: true, statesExplored: 1000, granted: 1000, endingsFound: 1, runtimeErrorsFound: 0, knotsVisited: 3, newEndings: 1, newKnots: 3, newRuntimeErrors: 0, dedupeHits: 0, maxDepthReached: 10, lastDiscoveryAtState: 100, truncatedBy: base.truncatedBy, exhaustive: false },
      { pass: "random:seed=3", systematic: false, statesExplored: 1000, granted: 1000, endingsFound: 5, runtimeErrorsFound: 0, knotsVisited: 3, newEndings: 4, newKnots: 0, newRuntimeErrors: 0, dedupeHits: 0, maxDepthReached: 20, lastDiscoveryAtState: 990, truncatedBy: base.truncatedBy, exhaustive: false },
    ],
  });
  assert.strictEqual(reseed.recommendation, "reseed");
  assert.strictEqual(reseed.flags.seed, 4);
  assert.strictEqual(reseed.stop, false);

  // Everything saturated at the ceilings → investigate, pointing at knots.
  const investigate = recommendNextRun({
    ...base,
    passes: [
      { pass: "dfs:last", systematic: true, statesExplored: 1000, granted: 1000, endingsFound: 1, runtimeErrorsFound: 0, knotsVisited: 3, newEndings: 1, newKnots: 3, newRuntimeErrors: 0, dedupeHits: 0, maxDepthReached: 10, lastDiscoveryAtState: 100, truncatedBy: base.truncatedBy, exhaustive: false },
      { pass: "random:seed=3", systematic: false, statesExplored: 1000, granted: 1000, endingsFound: 5, runtimeErrorsFound: 0, knotsVisited: 3, newEndings: 4, newKnots: 0, newRuntimeErrors: 0, dedupeHits: 0, maxDepthReached: 20, lastDiscoveryAtState: 50, truncatedBy: base.truncatedBy, exhaustive: false },
    ],
  });
  assert.strictEqual(investigate.recommendation, "investigate");
  assert.strictEqual(investigate.stop, true);
  assert.match(investigate.rationale, /inbound diverts/);
});

test("--next follows recommendations to an exhaustive result", () => {
  const proc = spawnSync(
    process.execPath,
    [CLI, DEEP_CHAIN, "--max-states", "500", "--next", "--json"],
    { encoding: "utf8" }
  );
  const out = JSON.parse(proc.stdout);
  assert.strictEqual(out.runs.length, 2);
  assert.strictEqual(out.runs[0].endings, 0);
  assert.strictEqual(out.runs[0].recommendation, "deepen");
  assert.strictEqual(out.runs[1].flags.maxDepth, 260);
  assert.strictEqual(out.runs[1].endings, 1);
  assert.strictEqual(out.explore.exhaustive, true);
  assert.strictEqual(out.nextRun.recommendation, "stop");
  // Hop narration goes to stderr so machine output stays clean.
  assert.match(proc.stderr, /↻ deepen/);

  const md = spawnSync(
    process.execPath,
    [CLI, DEEP_CHAIN, "--max-states", "500", "--markdown"],
    { encoding: "utf8" }
  );
  assert.match(md.stdout, /Suggested next run \(deepen\)/);
});

// The memory guard stops cleanly before a V8 OOM (which cannot be caught
// after the fact) and keeps whatever was found so far.
test("memory guard stops each engine early and reports truncatedBy.memory", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  // A predicate that trips after ~6000 states stands in for a real heap
  // watermark; it makes the stop deterministic and instant.
  const mkGuard = () => {
    let n = 0;
    return () => n++ * 512 < 6000;
  };
  for (const run of [
    () => explore(compiled.storyJson, knots, [], { maxStates: 1_000_000, memoryGuard: mkGuard() }),
    () => exploreRandom(compiled.storyJson, knots, [], { maxStates: 1_000_000, memoryGuard: mkGuard() }),
  ]) {
    const r = run();
    assert.ok(r.statesExplored < 50_000, `expected early stop, got ${r.statesExplored}`);
    assert.strictEqual(r.truncatedBy.memory, true);
    assert.strictEqual(r.truncated, true);
  }
});

test("portfolio memory stop keeps partial results and blames only memory", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  let n = 0;
  const guard = () => n++ * 512 < 8000;
  const report = explorePortfolio(compiled.storyJson, knots, [], {
    maxStates: 1_000_000,
    memoryGuard: guard,
  });
  assert.strictEqual(report.truncatedBy.memory, true);
  assert.strictEqual(report.truncatedBy.maxStates, false, "memory, not budget, was the cause");
  assert.ok(report.statesExplored < 50_000);
  // Partial results are retained, and the schedule/telemetry still populate.
  assert.ok(report.endingsFound.length > 0);
  assert.ok(report.schedule.length >= 1);
  assert.ok(report.passes.length >= 1);
  const advice = recommendNextRun(report);
  assert.strictEqual(advice.recommendation, "investigate");
  assert.strictEqual(advice.stop, true);
  assert.match(advice.rationale, /memory/);
});

test("--max-memory produces a partial report instead of crashing", () => {
  // heapUsed at startup already exceeds 1 MB, so the guard trips immediately.
  const proc = spawnSync(
    process.execPath,
    [CLI, EARLY_CHOICE_GRID, "--max-states", "500000", "--max-memory", "1", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(proc.status, 0);
  const report = JSON.parse(proc.stdout);
  assert.strictEqual(report.explore.truncatedBy.memory, true);
  assert.strictEqual(report.nextRun.recommendation, "investigate");

  const text = spawnSync(
    process.execPath,
    [CLI, EARLY_CHOICE_GRID, "--max-states", "500000", "--max-memory", "1"],
    { encoding: "utf8" }
  );
  assert.match(text.stdout, /stopped early at \d+ states to stay under the memory guard/);
});

// The time guard mirrors the memory guard: a wall-clock budget stops the run
// cleanly and returns a partial report (truncatedBy.time) instead of the run
// being hard-killed.
test("time guard stops each engine early and reports truncatedBy.time", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  // A predicate that trips after a couple of checks (~1,024 states) stands in
  // for a real deadline — deterministic, instant, and early enough that the
  // beam does not exhaust the small fixture before the guard fires.
  const mkGuard = () => {
    let n = 0;
    return () => n++ < 2;
  };
  for (const run of [
    () => explore(compiled.storyJson, knots, [], { maxStates: 1_000_000, timeGuard: mkGuard() }),
    () => exploreRandom(compiled.storyJson, knots, [], { maxStates: 1_000_000, timeGuard: mkGuard() }),
    () => exploreBeam(compiled.storyJson, knots, [], { maxStates: 1_000_000, timeGuard: mkGuard() }),
  ]) {
    const r = run();
    assert.ok(r.statesExplored < 50_000, `expected early stop, got ${r.statesExplored}`);
    assert.strictEqual(r.truncatedBy.time, true);
    assert.strictEqual(r.truncatedBy.maxStates, false);
    assert.strictEqual(r.truncated, true);
  }
});

test("portfolio time stop keeps partial results, blames only time, and advises investigate", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  let n = 0;
  const report = explorePortfolio(compiled.storyJson, knots, [], {
    maxStates: 1_000_000,
    timeGuard: () => n++ < 14,
  });
  assert.strictEqual(report.truncatedBy.time, true);
  assert.strictEqual(report.truncatedBy.maxStates, false, "time, not budget, was the cause");
  assert.ok(report.statesExplored < 50_000);
  assert.ok(report.endingsFound.length > 0, "partial results retained");
  const advice = recommendNextRun(report);
  assert.strictEqual(advice.recommendation, "investigate");
  assert.match(advice.rationale, /time/);
});

test("memory guard takes precedence over the time guard when both trip", async () => {
  const compiled = await compile(EARLY_CHOICE_GRID);
  const knots = scanKnots(EARLY_CHOICE_GRID);
  let m = 0;
  let t = 0;
  const report = explore(compiled.storyJson, knots, [], {
    maxStates: 1_000_000,
    memoryGuard: () => m++ < 5,
    timeGuard: () => t++ < 100,
  });
  assert.strictEqual(report.truncatedBy.memory, true);
  assert.strictEqual(report.truncatedBy.time, false);
});

test("--max-time produces a partial report instead of running to the budget", () => {
  const proc = spawnSync(
    process.execPath,
    [CLI, EARLY_CHOICE_GRID, "--max-states", "100000000", "--max-time", "1", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(proc.status, 0);
  const report = JSON.parse(proc.stdout);
  assert.strictEqual(report.explore.truncatedBy.time, true);
  assert.ok(report.explore.statesExplored < 100_000_000);
  assert.strictEqual(report.nextRun.recommendation, "investigate");

  const text = spawnSync(
    process.execPath,
    [CLI, EARLY_CHOICE_GRID, "--max-states", "100000000", "--max-time", "1"],
    { encoding: "utf8" }
  );
  assert.match(text.stdout, /stopped early at \d+ states after the 1s time budget/);
});

test("an exhaustive systematic pass clears sampling-slice truncation", async () => {
  const compiled = await compile(MANOR);
  const knots = scanKnots(MANOR);
  // DFS exhausts manor well inside this budget; the random slice will still
  // spend its whole sub-budget resampling, which must not count as truncation.
  const report = explorePortfolio(compiled.storyJson, knots, [], { maxStates: 500 });
  assert.strictEqual(report.exhaustive, true);
  assert.strictEqual(report.truncated, false);
  assert.deepStrictEqual(report.truncatedBy, {
    maxDepth: false,
    maxStates: false,
    beamWidth: false,
    memory: false,
    time: false,
  });

  const gridCompiled = await compile(EARLY_CHOICE_GRID);
  const grid = explorePortfolio(gridCompiled.storyJson, scanKnots(EARLY_CHOICE_GRID), [], {
    maxStates: 500,
  });
  assert.strictEqual(grid.exhaustive, false);
  assert.strictEqual(grid.truncated, true);
});

test("markdown and text reports state limits and targeted advice", () => {
  const md = spawnSync(
    process.execPath,
    [CLI, MANOR, "--max-states", "200", "--markdown"],
    { encoding: "utf8" }
  );
  assert.match(md.stdout, /\| Depth limit \| 100 \|/);
  assert.match(md.stdout, /\| Baseline state budget \| 200 \|/);
  // A systematic pass exhausts manor within this budget, so the run is
  // complete even though the sampling slice spent its whole sub-budget.
  assert.match(md.stdout, /\| Truncated \| no \|/);
  assert.match(md.stdout, /\| Exhaustive \| yes \|/);
  assert.match(md.stdout, /possible orphan/);
  assert.match(md.stdout, /found by `dfs:/);
  const text = spawnSync(
    process.execPath,
    [CLI, EARLY_CHOICE_GRID, "--max-depth", "5", "--max-states", "400"],
    { encoding: "utf8" }
  );
  assert.match(text.stdout, /raise --max-depth/);
  assert.match(text.stdout, /inbound divert\(s\) in source/);
  assert.match(text.stdout, /unreached is not necessarily unreachable/);
});

test("playtest follows a scripted path and reports variables", async () => {
  const compiled = await compile(MANOR);
  // Take the torch, search the study, leave with the loot.
  const result = playtest(compiled.storyJson, [0, 0, 0]);
  assert.strictEqual(result.ended, true);
  assert.strictEqual(result.runtimeErrors.length, 0);
  assert.strictEqual(result.variables.gold, 50);
  assert.strictEqual(result.variables.torches, 1);
});

test("playtest reports out-of-range choices as errors", async () => {
  const compiled = await compile(MANOR);
  const result = playtest(compiled.storyJson, [9]);
  assert.strictEqual(result.runtimeErrors.length, 1);
  assert.match(result.runtimeErrors[0], /out of range/);
});

test("playtest discloses external functions stubbed to zero", async () => {
  const compiled = await compile(EXTERNAL_STORY);
  const result = playtest(compiled.storyJson, [], scanExternals(EXTERNAL_STORY));
  assert.deepStrictEqual(result.externalFunctionsStubbed, ["choose_route"]);
});

test("playtest does not call a crashing terminal state an ending", async () => {
  const compiled = await compile(LINEAR_RUNTIME_ERROR);
  const result = playtest(compiled.storyJson, []);
  assert.strictEqual(result.ended, false);
  assert.strictEqual(result.runtimeErrors.length, 1);
});

test("explore does not report a crashing linear story as an ending", async () => {
  const compiled = await compile(LINEAR_RUNTIME_ERROR);
  assert.strictEqual(compiled.success, true);
  const report = explore(compiled.storyJson, scanKnots(LINEAR_RUNTIME_ERROR));
  assert.strictEqual(report.runtimeErrors.length, 1);
  assert.strictEqual(report.endingsFound.length, 0);
});

test("explore maps content-exhaustion runtime errors to the triggering choice", async () => {
  const compiled = await compile(CONTENT_EXHAUSTION);
  assert.strictEqual(compiled.success, true);
  const report = explore(compiled.storyJson, scanKnots(CONTENT_EXHAUSTION));
  assert.strictEqual(report.runtimeErrors.length, 1);
  assert.match(report.runtimeErrors[0].message, /ran out of content/);
  assert.deepStrictEqual(report.runtimeErrors[0].sourceLocation, {
    file: "content-exhaustion.ink",
    line: 4,
    approximate: true,
  });
});

test("state identity preserves turn and random state", () => {
  const base = { flows: {}, variablesState: {}, turnIdx: 1, storySeed: 10, previousRandom: 4 };
  assert.notStrictEqual(stateKey(JSON.stringify(base)), stateKey(JSON.stringify({ ...base, turnIdx: 2 })));
  assert.notStrictEqual(
    stateKey(JSON.stringify(base)),
    stateKey(JSON.stringify({ ...base, storySeed: 11 }))
  );
  assert.notStrictEqual(
    stateKey(JSON.stringify(base)),
    stateKey(JSON.stringify({ ...base, previousRandom: 5 }))
  );
  assert.strictEqual(
    stateKey(JSON.stringify(base), { turns: false, randomness: false }),
    stateKey(JSON.stringify({ ...base, turnIdx: 2, storySeed: 11, previousRandom: 5 }), {
      turns: false,
      randomness: false,
    })
  );
});

test("scanStorySemantics follows includes and detects turn and random behavior", () => {
  const semantics = scanStorySemantics(
    path.join(__dirname, "..", "examples", "semantic-features.ink")
  );
  assert.deepStrictEqual(semantics, { usesTurns: true, usesRandomness: true });
});

test("CLI accepts limit flags before the story path", () => {
  const proc = spawnSync(process.execPath, [CLI, "--max-states", "20", MANOR, "--json"], {
    encoding: "utf8",
  });
  assert.strictEqual(proc.status, 1);
  const report = JSON.parse(proc.stdout);
  assert.strictEqual(report.compile.success, true);
  assert.deepStrictEqual(report.explore.runtimeErrors[0].sourceLocation, {
    file: "manor.ink",
    line: 25,
    approximate: true,
  });
});

test("CLI accepts --seed and reports it in the JSON limits", () => {
  const proc = spawnSync(
    process.execPath,
    [CLI, CLEAN_BRANCH, "--max-states", "100", "--seed", "9", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(proc.status, 0);
  const report = JSON.parse(proc.stdout);
  assert.strictEqual(report.explore.limits.seed, 9);
  const invalid = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--seed", "nope"], {
    encoding: "utf8",
  });
  assert.strictEqual(invalid.status, 2);
  assert.match(invalid.stderr, /requires an integer from 1 to 4294967295/);
});

test("CLI streams versioned progress to stderr without changing the final JSON report", () => {
  const plain = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--max-states", "100", "--json"], {
    encoding: "utf8",
  });
  const streamed = spawnSync(
    process.execPath,
    [CLI, CLEAN_BRANCH, "--max-states", "100", "--json", "--progress=ndjson"],
    { encoding: "utf8" }
  );
  assert.strictEqual(streamed.status, plain.status);
  assert.strictEqual(streamed.stdout, plain.stdout);
  const disabled = spawnSync(
    process.execPath,
    [CLI, CLEAN_BRANCH, "--max-states", "100", "--json", "--progress=off"],
    { encoding: "utf8" }
  );
  assert.strictEqual(disabled.stdout, plain.stdout);
  assert.strictEqual(disabled.stderr, plain.stderr);
  const report = JSON.parse(streamed.stdout);
  const events = streamed.stderr.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.length >= 7);
  assert.ok(events.every((event) => event.schemaVersion === 1));
  assert.deepStrictEqual(events.map((event) => event.sequence), events.map((_, i) => i + 1));
  assert.ok(events.every((event) => event.budgetFraction >= 0 && event.budgetFraction <= 1));
  assert.ok(events.every((event, i) => i === 0 || event.statesExplored >= events[i - 1].statesExplored));
  const discoveryProgress = events.find((event) => event.type === "progress" && event.phase === undefined && event.pass);
  assert.ok(discoveryProgress);
  assert.ok(Number.isInteger(discoveryProgress.visibleOutcomes));
  assert.ok(Number.isInteger(discoveryProgress.assertionViolations));
  assert.ok(Number.isInteger(discoveryProgress.goalsReached));
  assert.ok(Number.isInteger(discoveryProgress.stagesReached));
  assert.ok(Number.isInteger(discoveryProgress.discoveryEvents));
  assert.ok(discoveryProgress.statesSinceLastDiscovery === null || Number.isInteger(discoveryProgress.statesSinceLastDiscovery));
  const final = events.at(-1);
  assert.strictEqual(final.type, "run_end");
  assert.strictEqual(final.statesExplored, report.explore.statesExplored);
  assert.strictEqual(final.endingsFound, report.explore.endingsFound.length);
  assert.strictEqual(final.runtimeErrorsFound, report.explore.runtimeErrors.length);
  assert.strictEqual(final.unvisitedKnots, report.explore.unvisitedKnots.length);
});

test("NDJSON progress contract docs stay linked and privacy-focused", () => {
  const fs = require("node:fs");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const docs = fs.readFileSync(path.join(ROOT, "docs", "progress-ndjson.md"), "utf8");
  assert.match(readme, /docs\/progress-ndjson\.md/);
  assert.match(docs, /schemaVersion: 1/);
  assert.match(docs, /stdout report as authoritative/);
  assert.match(docs, /work-budget progress, not story coverage/);
  assert.match(docs, /"type":"progress"/);
  assert.match(docs, /"type":"run_end"/);
  assert.match(docs, /must not contain:[\s\S]*story source text[\s\S]*choice prose[\s\S]*variable names or values/);
});

test("exploration progress emits a time-based heartbeat before its state interval", async () => {
  const compiled = await compile(CLEAN_BRANCH);
  const events = [];
  explore(compiled.storyJson, scanKnots(CLEAN_BRANCH), [], {
    maxStates: 20,
    progressIntervalStates: 10_000,
    progressIntervalMs: 0,
    onProgress: (event) => events.push(event),
  });
  assert.ok(events.length > 1);
  assert.ok(events.some((event) => event.statesExplored > 0 && event.statesExplored < 10_000));
});

test("human progress uses work-budget language and stays readable without terminal controls", () => {
  const { HumanProgressRenderer } = require("../dist/terminal-progress");
  let output = "";
  const renderer = new HumanProgressRenderer({ isTTY: false, columns: 58, write: (text) => { output += text; } }, "human");
  renderer.handle({
    type: "progress",
    phase: "explore",
    pass: "beam:diversity",
    elapsedMs: 12_000,
    statesExplored: 37_250,
    stateBudget: 100_000,
    endingsFound: 7,
    runtimeErrorsFound: 1,
    unvisitedKnots: 42,
  });
  renderer.finish();
  assert.match(output, /work states/);
  assert.doesNotMatch(output, /coverage/);
  assert.doesNotMatch(output, /\x1b\[/);
});

test("CLI rejects invalid numeric and unknown options as usage errors", () => {
  const invalid = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--max-states", "nope"], {
    encoding: "utf8",
  });
  assert.strictEqual(invalid.status, 2);
  assert.match(invalid.stderr, /requires an integer from 1 to 100000000/);
  const unbounded = spawnSync(
    process.execPath,
    [CLI, CLEAN_BRANCH, "--max-states", "999999999999999999999999"],
    { encoding: "utf8" }
  );
  assert.strictEqual(unbounded.status, 2);
  assert.match(unbounded.stderr, /requires an integer from 1 to 100000000/);
  const unknown = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--surprise"], {
    encoding: "utf8",
  });
  assert.strictEqual(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/);
  const invalidProgress = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--progress=verbose"], {
    encoding: "utf8",
  });
  assert.strictEqual(invalidProgress.status, 2);
  assert.match(invalidProgress.stderr, /--progress must be auto, human, ndjson, or off/);
});

test("explore rejects unsafe limits even when called as a library", async () => {
  const compiled = await compile(CLEAN_BRANCH);
  assert.throws(
    () => explore(compiled.storyJson, [], [], { maxStates: Number.POSITIVE_INFINITY }),
    /maxStates must be an integer/
  );
});

// The state ceiling is 100M and the CLI/library default budget is 10M; small
// stories still finish in the handful of states they actually have because a
// systematic pass early-exits on exhaustive coverage.
test("state ceiling is 100M and above it is rejected", async () => {
  const compiled = await compile(CLEAN_BRANCH);
  const knots = scanKnots(CLEAN_BRANCH);
  // At the ceiling: accepted (clean-branch exhausts in 2 states, so this is instant).
  const ok = explore(compiled.storyJson, knots, [], { maxStates: 100_000_000 });
  assert.strictEqual(ok.exhaustive, true);
  // One over the ceiling: rejected.
  assert.throws(
    () => explore(compiled.storyJson, knots, [], { maxStates: 100_000_001 }),
    /maxStates must be an integer from 1 to 100000000/
  );
});

test("CLI defaults the state budget to 10,000,000", () => {
  // The progress stream reports the configured budget exactly; clean-branch
  // is fully explorable so the run early-exits despite the large default.
  const proc = spawnSync(
    process.execPath,
    [CLI, CLEAN_BRANCH, "--progress=ndjson", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(JSON.parse(proc.stdout).explore.exhaustive, true);
  const events = proc.stderr
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.stateBudget === 10_000_000));
});

test("hosted checker defaults and caps the state budget at 1,000,000", () => {
  const config = webConfigFromEnv();
  assert.strictEqual(config.maxStates, 1_000_000);
  const compose = fs.readFileSync(path.join(ROOT, "compose.yaml"), "utf8");
  assert.match(compose, /INKCHECK_WEB_MAX_STATES:\s*"1000000"/);
  const submission = validateSubmission(
    {
      root: "story.ink",
      files: { "story.ink": "Hello -> END" },
      authorized: true,
      privacyAcknowledged: true,
    },
    config
  );
  // No maxStates in the request → hosted default applies.
  assert.strictEqual(submission.maxStates, 1_000_000);
  // A request above the hosted cap is rejected (the API surfaces a "use the
  // CLI" issue link); big jobs up to 100M states belong on the local CLI.
  assert.throws(
    () =>
      validateSubmission(
        {
          root: "story.ink",
          files: { "story.ink": "Hello -> END" },
          authorized: true,
          privacyAcknowledged: true,
          maxStates: 50_000_000,
        },
        config
      ),
    SubmissionError
  );
});

test("strict mode fails when traversal is truncated", () => {
  const proc = spawnSync(
    process.execPath,
    [CLI, CLEAN_BRANCH, "--max-states", "1", "--no-min-repro", "--strict", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(proc.status, 1);
  assert.strictEqual(JSON.parse(proc.stdout).explore.truncated, true);
});

test("external stubs are disclosed and make strict coverage fail", () => {
  const proc = spawnSync(process.execPath, [CLI, EXTERNAL_STORY, "--strict", "--json"], {
    encoding: "utf8",
  });
  const report = JSON.parse(proc.stdout).explore;
  assert.strictEqual(proc.status, 1);
  assert.deepStrictEqual(report.externalFunctionsStubbed, ["choose_route"]);
});

test("markdown output is suitable for a GitHub Actions step summary", () => {
  const proc = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--markdown"], {
    encoding: "utf8",
  });
  assert.strictEqual(proc.status, 0);
  assert.match(proc.stdout, /# inkcheck report/);
  assert.match(proc.stdout, /Distinct terminal states \| 2/);
  const failed = spawnSync(process.execPath, [CLI, MANOR, "--markdown"], {
    encoding: "utf8",
  });
  assert.strictEqual(failed.status, 1);
  assert.match(failed.stdout, /Runtime failures found/);
});

test("human output groups actionable findings by severity", () => {
  const broken = spawnSync(process.execPath, [CLI, BROKEN, "--human"], {
    encoding: "utf8",
  });
  assert.strictEqual(broken.status, 1);
  assert.match(broken.stdout, /ERRORS/);
  assert.match(broken.stdout, /Compiler error/);
  assert.match(broken.stdout, /broken\.ink line 5/);
  assert.match(broken.stdout, /Next step: Fix this source line first/);

  const runtime = spawnSync(process.execPath, [CLI, MANOR, "--human"], {
    encoding: "utf8",
  });
  assert.strictEqual(runtime.status, 1);
  assert.match(runtime.stdout, /Runtime error/);
  assert.match(runtime.stdout, /manor\.ink line 25 \(approx\.\)/);
  assert.match(runtime.stdout, /Path: Enter in darkness → Descend to the cellar/);
  assert.match(runtime.stdout, /WARNINGS/);
  assert.match(runtime.stdout, /Unvisited content/);
  assert.match(runtime.stdout, /treasure_vault/);
});

test("hosted runner checks an uploaded story and deletes its job", async () => {
  const source = require("node:fs").readFileSync(CLEAN_BRANCH, "utf8");
  const config = webConfigFromEnv();
  const submission = validateSubmission(
    {
      root: "story.ink",
      files: { "story.ink": source },
      authorized: true,
      privacyAcknowledged: true,
      maxDepth: 30,
      maxStates: 500,
    },
    config
  );
  const result = await runSubmission(submission, config);
  assert.strictEqual(result.report.compile.success, true);
  assert.strictEqual(result.report.explore.endingsFound.length, 2);
  assert.deepStrictEqual(result.humanFindings, []);
  assert.strictEqual(result.meta.uploadedFiles, 1);
  assert.strictEqual(result.meta.retained, false);
  assert.doesNotMatch(JSON.stringify(result.report), /inkcheck-web-/);
});

test("hosted runner returns truncated exploration as a useful partial report", async () => {
  const source = require("node:fs").readFileSync(CLEAN_BRANCH, "utf8");
  const config = webConfigFromEnv();
  const submission = validateSubmission(
    {
      root: "story.ink",
      files: { "story.ink": source },
      authorized: true,
      privacyAcknowledged: true,
      maxDepth: 30,
      maxStates: 1,
    },
    config
  );
  const result = await runSubmission(submission, config);
  assert.strictEqual(result.report.compile.success, true);
  assert.strictEqual(result.report.explore.truncated, true);
  assert.strictEqual(result.meta.coverageLimitHit, true);
  assert.ok(
    !result.humanFindings.some(
      (finding) =>
        finding.category === "Coverage note" &&
        /hosted pass|coverage boundary|deeper hosted pass/i.test(
          `${finding.title} ${finding.message} ${finding.action}`
        )
    )
  );
  // Hosted findings must never point at CLI flags the web user cannot set (#49).
  assert.ok(
    result.humanFindings.every((finding) => !/--max-/.test(finding.action)),
    "hosted humanFindings must not name CLI flags"
  );
});

test("hosted runner returns a partial report when the time budget is hit, not a limit error", async () => {
  // Regression for #71: a run that hits the wall-clock budget must hand back
  // the partial report the engine already computed (truncatedBy.time), not the
  // misleading "story too detailed" limit error with nothing to show. A tight
  // hosted timeout with a large state budget forces the time budget to bind.
  const source = require("node:fs").readFileSync(EARLY_CHOICE_GRID, "utf8");
  // Leave enough hard-deadline headroom for process startup on Windows while
  // still forcing the CLI's one-second graceful budget to bind.
  const config = { ...webConfigFromEnv(), timeoutMs: 5_000 };
  const submission = validateSubmission(
    {
      root: "story.ink",
      files: { "story.ink": source },
      authorized: true,
      privacyAcknowledged: true,
      maxDepth: 30,
      maxStates: 1_000_000,
    },
    config
  );
  const result = await runSubmission(submission, config);
  assert.strictEqual(result.report.compile.success, true);
  assert.strictEqual(result.report.explore.truncatedBy.time, true, "time was the binding limit");
  assert.strictEqual(result.report.explore.truncatedBy.maxStates, false);
  assert.ok(result.meta.coverageLimitHit, "partial coverage is flagged");
});

test("hosted runner returns compile failures as reports", async () => {
  const source = require("node:fs").readFileSync(BROKEN, "utf8");
  const config = webConfigFromEnv();
  const submission = validateSubmission(
    {
      root: "broken.ink",
      files: { "broken.ink": source },
      authorized: true,
      privacyAcknowledged: true,
    },
    config
  );
  const result = await runSubmission(submission, config);
  assert.strictEqual(result.report.compile.success, false);
  assert.strictEqual(result.report.compile.errors, 3);
  assert.strictEqual(result.meta.retained, false);
});

test("release version stays synchronized across package and manifests", () => {
  const readJson = (file) => JSON.parse(require("node:fs").readFileSync(path.join(ROOT, file)));
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const tool = readJson("tool.json");
  const server = readJson("server.json");
  const { VERSION } = require("../dist/version");
  assert.strictEqual(pkg.version, "0.5.1");
  assert.strictEqual(lock.version, pkg.version);
  assert.strictEqual(lock.packages[""].version, pkg.version);
  assert.strictEqual(tool.version, pkg.version);
  assert.strictEqual(server.version, pkg.version);
  assert.strictEqual(server.packages[0].version, pkg.version);
  assert.strictEqual(VERSION, pkg.version);
  assert.strictEqual(pkg.bin["inkcheck-web"], "dist/web.js");
  for (const required of [
    "dist",
    "web",
    "docs/hosted-checker.md",
    "docs/agent-discovery.md",
    "docs/report-schema-v1.md",
    "docs/inkjam-qa-guide.md",
    "CHANGELOG.md",
    "llms.txt",
    "server.json",
    "tool.json",
  ]) {
    assert.ok(pkg.files.includes(required), `${required} must ship in the npm package`);
  }
});
