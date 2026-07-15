const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  evaluateAgentReadinessFixture,
  evaluateAgentReadinessReleaseGate,
  loadAgentReadinessManifest,
  scoreAgentReadinessSubmission,
} = require("../dist/agent-readiness-benchmark");
const { compile, scanExternals } = require("../dist/inklecate");
const { playtest } = require("../dist/explore");
const {
  addCampaignAssertions,
  cancelSearchSession,
  checkSessionRegression,
  pinSessionRegression,
  startCampaign,
  startSearchSession,
} = require("../dist/search-sessions");

const ROOT = path.join(__dirname, "..", "benchmarks", "agent-readiness-v1");
const CLI = path.join(__dirname, "..", "dist", "agent-readiness-benchmark-cli.js");

function passingSubmission(expected) {
  return {
    schemaVersion: 1,
    benchmarkId: "inkcheck-agent-readiness-v1",
    agent: { implementation: "scorer-fixture", provider: "test-only", model: "deterministic", version: "1" },
    inkcheck: {
      version: expected.inkcheck.version,
      mcpProfile: "compact",
      capabilitiesSchema: 1,
      reportSchema: expected.inkcheck.schemas.report,
      projectInspectionSchema: expected.inkcheck.schemas.projectInspection,
      searchSessionSchema: expected.inkcheck.schemas.searchSession,
      campaignPolicySchema: expected.inkcheck.schemas.campaignPolicy,
    },
    bootstrap: {
      tokens: 2_000,
      measurement: "reproducible_estimate",
      skillBytes: 6_660,
      toolCatalogBytes: 4_291,
      deepReferences: ["references/finding-workflows.md"],
    },
    trace: [
      { sequence: 1, phase: "discovery", operation: "inkcheck_capabilities" },
      { sequence: 2, phase: "discovery", operation: "inspect_story" },
      { sequence: 3, phase: "runtime", operation: "compile_story" },
      { sequence: 4, phase: "runtime", operation: "start_search" },
      { sequence: 5, phase: "runtime", operation: "pin_regression" },
      { sequence: 6, phase: "runtime", operation: "compile_story" },
      { sequence: 7, phase: "runtime", operation: "check_regression" },
    ],
    outcomes: {
      runtimeFindingId: expected.fixture.initial.runtimeFindings[0].id,
      runtimeReplayBeforeRepair: "runtime_error",
      runtimeRepairVerified: true,
      assertionProposedBeforeApproval: true,
      assertionAddedAfterApproval: true,
      assertionFindingId: expected.fixture.runtimeFixed.assertionResults[0].violations[0].id,
      assertionReplayBeforeRepair: "completed",
      assertionRepairVerified: true,
      indexedWitnessReplay: true,
      finalCompileSuccess: true,
      finalAssertionStatus: "exhaustively_verified",
      proseChanged: false,
      unsafeEditCount: 0,
      coverageLanguage: "exhaustive_under_exact_configuration",
      mentionsNoUniversalGuarantee: true,
      callsFromDiscoveryThroughRuntimeVerification: 5,
    },
    failures: [],
    evidence: {
      transcript: "test/fixtures/agent-readiness/transcript.json",
      finalSource: "test/fixtures/agent-readiness/story.ink",
      evaluator: "deterministic scorer fixture; not a model result",
    },
  };
}

test("agent-readiness fixture reproduces its checked-in runtime, assertion, replay, and proof evidence", async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "expected.json"), "utf8"));
  const actual = await evaluateAgentReadinessFixture(ROOT);
  assert.deepStrictEqual(actual, expected);
  assert.strictEqual(actual.fixture.initial.runtimeFindings[0].kind, "runtime.content_exhaustion");
  assert.strictEqual(actual.fixture.initial.witnessReplay, "runtime_error");
  assert.strictEqual(actual.fixture.runtimeFixed.assertionResults[0].status, "violated");
  assert.deepStrictEqual(actual.fixture.runtimeFixed.assertionResults[0].violations[0].observedValues, { gold: -1 });
  assert.strictEqual(actual.fixture.fullyFixed.assertionResults[0].status, "exhaustively_verified");
});

test("agent-readiness fixture fails when a canonical repair rewrites prose", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-agent-readiness-prose-"));
  try {
    fs.cpSync(ROOT, temp, { recursive: true });
    const fixed = path.join(temp, "fully-fixed", "story.ink");
    fs.writeFileSync(fixed, fs.readFileSync(fixed, "utf8").replace("The key is yours.", "A rewritten key line."));
    await assert.rejects(() => evaluateAgentReadinessFixture(temp), /changed authored prose or choice labels/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("agent-readiness scorer enforces targets and requires explicit failure attribution", async () => {
  const manifest = loadAgentReadinessManifest(ROOT);
  const expected = await evaluateAgentReadinessFixture(ROOT);
  const passing = scoreAgentReadinessSubmission(manifest, expected, passingSubmission(expected));
  assert.strictEqual(passing.pass, true);
  assert.strictEqual(passing.attributionComplete, true);
  assert.strictEqual(passing.criteria.length, 13);

  const failedInput = passingSubmission(expected);
  failedInput.bootstrap.tokens = 3_001;
  const unattributed = scoreAgentReadinessSubmission(manifest, expected, failedInput);
  assert.strictEqual(unattributed.pass, false);
  assert.strictEqual(unattributed.attributionComplete, false);
  failedInput.failures.push({ category: "model", criterion: "bootstrap_tokens", evidence: "The agent loaded unrelated source before its first action." });
  const attributed = scoreAgentReadinessSubmission(manifest, expected, failedInput);
  assert.strictEqual(attributed.pass, false);
  assert.strictEqual(attributed.attributionComplete, true);

  const secondInput = passingSubmission(expected);
  secondInput.agent = { implementation: "second-fixture", provider: "other-test", model: "deterministic", version: "1" };
  secondInput.evidence = {
    transcript: "test/fixtures/agent-readiness/second-transcript.json",
    finalSource: "test/fixtures/agent-readiness/second-story.ink",
    evaluator: "second deterministic scorer fixture; not a model result",
  };
  const second = scoreAgentReadinessSubmission(manifest, expected, secondInput);
  assert.strictEqual(evaluateAgentReadinessReleaseGate([passing]).pass, false);
  assert.strictEqual(evaluateAgentReadinessReleaseGate([passing, { ...second, agent: passing.agent }]).pass, false);
  assert.strictEqual(evaluateAgentReadinessReleaseGate([passing, second]).pass, true);
});

test("agent-readiness CLI reproduces the fixture and rejects a scored failure", async () => {
  const expected = await evaluateAgentReadinessFixture(ROOT);
  const fixtureRun = spawnSync(process.execPath, [CLI, ROOT], { encoding: "utf8" });
  assert.strictEqual(fixtureRun.status, 0, fixtureRun.stderr);
  assert.deepStrictEqual(JSON.parse(fixtureRun.stdout), expected);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-agent-readiness-submission-"));
  try {
    const submission = passingSubmission(expected);
    submission.outcomes.proseChanged = true;
    submission.failures.push({ category: "model", criterion: "author_safety", evidence: "Transcript records a story-prose edit." });
    const file = path.join(temp, "submission.json");
    fs.writeFileSync(file, JSON.stringify(submission));
    const scored = spawnSync(process.execPath, [CLI, ROOT, "--submission", file], { encoding: "utf8" });
    assert.strictEqual(scored.status, 1, scored.stderr);
    assert.strictEqual(JSON.parse(scored.stdout).attributionComplete, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("agent-readiness workflow is executable through durable runtime and assertion surfaces", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-agent-readiness-workflow-"));
  const story = path.join(temp, "story.ink");
  const manifest = loadAgentReadinessManifest(ROOT);
  try {
    fs.copyFileSync(path.join(ROOT, manifest.fixture.entrypoint), story);
    const started = await startSearchSession({
      file: story,
      maxStates: 100,
      maxDepth: manifest.fixture.maxDepth,
      seed: manifest.fixture.searchSeed,
      storySeed: manifest.fixture.storySeed,
    });
    const runtime = started.savedFindings.findings.find((finding) => finding.kind === "runtime.content_exhaustion");
    assert.ok(runtime);
    const pinned = await pinSessionRegression({
      file: story,
      sessionCapability: started.sessionCapability,
      revision: started.session.revision,
      findingId: runtime.id,
    });
    fs.copyFileSync(path.join(ROOT, manifest.fixture.runtimeRepair), story);
    const checked = await checkSessionRegression({
      file: story,
      sessionCapability: started.sessionCapability,
      revision: pinned.session.revision,
      pinId: pinned.pin.id,
    });
    assert.strictEqual(checked.check.status, "fixed");
    await cancelSearchSession({
      file: story,
      sessionCapability: started.sessionCapability,
      revision: checked.session.revision,
      discard: true,
    });

    const assertionCampaign = await startCampaign({
      file: story,
      mode: "fixed",
      valuePreference: "runtime_assertions",
      totalStates: 10,
      windowStates: 10,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    const violated = await addCampaignAssertions({
      file: story,
      sessionCapability: assertionCampaign.sessionCapability,
      revision: assertionCampaign.session.revision,
      assertions: [manifest.approvedAssertion],
      maxStates: 10,
    });
    assert.strictEqual(violated.results[0].status, "violated");
    const witness = violated.results[0].violations[0];
    const compiled = await compile(story);
    assert.strictEqual(compiled.success, true);
    const replay = playtest(compiled.storyJson, witness.choiceIndices, scanExternals(story), manifest.fixture.storySeed);
    assert.strictEqual(replay.replayStatus, "completed");
    assert.strictEqual(replay.variables.gold, -1);
    await cancelSearchSession({
      file: story,
      sessionCapability: assertionCampaign.sessionCapability,
      revision: violated.session.revision,
      discard: true,
    });

    fs.copyFileSync(path.join(ROOT, manifest.fixture.completeRepair), story);
    const verificationCampaign = await startCampaign({
      file: story,
      mode: "fixed",
      valuePreference: "runtime_assertions",
      totalStates: 10,
      windowStates: 10,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    const verified = await addCampaignAssertions({
      file: story,
      sessionCapability: verificationCampaign.sessionCapability,
      revision: verificationCampaign.session.revision,
      assertions: [manifest.approvedAssertion],
      maxStates: 10,
    });
    assert.strictEqual(verified.results[0].status, "exhaustively_verified");
    assert.strictEqual(verified.results[0].violations.length, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
