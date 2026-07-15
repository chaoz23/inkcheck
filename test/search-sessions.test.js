const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const { openReportArtifact, saveReportArtifact } = require("../dist/artifacts");
const { compile } = require("../dist/inklecate");
const {
  addSessionGoal,
  cancelSearchSession,
  checkSessionRegression,
  continueSearchSession,
  continueCampaign,
  inspectSearchSession,
  openSessionFinding,
  openSessionReport,
  pinSessionRegression,
  replaySessionWitness,
  startSearchSession,
  startCampaign,
} = require("../dist/search-sessions");
const { campaignLedgerDigest } = require("../dist/campaign-policy");

const FIXTURE = path.join(__dirname, "fixtures", "search", "low-dedup-wide.ink");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-session-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(FIXTURE, file);
  return { root, file };
}

test("MCP result-window continuation equals one uninterrupted shared run", async () => {
  const split = project();
  const full = project();
  try {
    const first = await startSearchSession({
      file: split.file,
      maxStates: 73,
      maxDepth: 150,
      seed: 7,
    });
    assert.strictEqual(first.session.status, "paused");
    assert.strictEqual(first.session.recoverable, true);
    assert.match(first.sessionCapability, /^mcp-session-[A-Za-z0-9_-]{43}$/);
    const resumed = await continueSearchSession({
      file: split.file,
      sessionCapability: first.sessionCapability,
      revision: first.session.revision,
      maxStates: 500,
    });
    const uninterrupted = await startSearchSession({
      file: full.file,
      maxStates: 500,
      maxDepth: 150,
      seed: 7,
    });
    const splitReport = await openReportArtifact(split.root, resumed.session.latestReportId);
    const fullReport = await openReportArtifact(full.root, uninterrupted.session.latestReportId);
    assert.deepStrictEqual(splitReport.report, fullReport.report);
    assert.strictEqual(resumed.session.latestReportId, uninterrupted.session.latestReportId);
    assert.strictEqual(resumed.session.revision, 2);
    assert.strictEqual(resumed.session.events.at(-1).type, "continued");
  } finally {
    fs.rmSync(split.root, { recursive: true, force: true });
    fs.rmSync(full.root, { recursive: true, force: true });
  }
});

test("campaign result-window continuation equals one uninterrupted shared run", async () => {
  const split = project();
  const full = project();
  try {
    const first = await startCampaign({
      file: split.file,
      intent: "balanced",
      totalStates: 1_000,
      windowStates: 73,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      maxDepth: 150,
      seed: 7,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    assert.strictEqual(first.session.status, "paused");
    assert.strictEqual(first.campaign.windows, 1);
    assert.strictEqual(first.campaign.unusedStates, 1_000 - first.session.statesExplored);
    await assert.rejects(
      () => continueSearchSession({
        file: split.file,
        sessionCapability: first.sessionCapability,
        revision: first.session.revision,
        maxStates: 146,
      }),
      /must use continue_campaign/
    );
    await assert.rejects(
      () => addSessionGoal({
        file: split.file,
        sessionCapability: first.sessionCapability,
        revision: first.session.revision,
        maxStates: 10,
        goal: { id: "forbidden", condition: { left: { variable: "depth" }, operator: ">=", right: { literal: 1 } } },
      }),
      /not available inside a campaign/
    );
    const resumed = await continueCampaign({
      file: split.file,
      sessionCapability: first.sessionCapability,
      revision: first.session.revision,
    });
    const uninterrupted = await startSearchSession({ file: full.file, maxStates: 146, maxDepth: 150, seed: 7 });
    const splitReport = await openReportArtifact(split.root, resumed.session.latestReportId);
    const fullReport = await openReportArtifact(full.root, uninterrupted.session.latestReportId);
    assert.deepStrictEqual(splitReport.report, fullReport.report);
    assert.strictEqual(resumed.session.latestReportId, uninterrupted.session.latestReportId);
    assert.strictEqual(resumed.campaign.windows, 2);
    assert.strictEqual(resumed.campaign.spend.states, resumed.session.statesExplored);
    assert.ok(resumed.campaign.spend.peakMemoryBytes > 0);
    assert.ok(resumed.campaign.spend.currentDiskBytes > 0);
    assert.strictEqual(resumed.campaign.latestWindow.reportId, resumed.session.latestReportId);
    assert.strictEqual(resumed.campaign.latestWindow.checkpointId, resumed.session.latestCheckpointId);
    assert.strictEqual(resumed.nextOperation.tool, "continue_campaign");
  } finally {
    fs.rmSync(split.root, { recursive: true, force: true });
    fs.rmSync(full.root, { recursive: true, force: true });
  }
});

test("named campaign controls return compact attributable decision evidence", async () => {
  const { root, file } = project();
  try {
    const started = await startCampaign({
      file,
      mode: "balanced",
      totalStates: 1_000,
      windowStates: 73,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      valuePreference: "outcomes",
      stopPolicy: "ceilings",
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    const decision = started.campaign.decision;
    assert.strictEqual(decision.mode, "balanced");
    assert.strictEqual(decision.resourcePreference, "balanced");
    assert.strictEqual(decision.valuePreference, "outcomes");
    assert.strictEqual(decision.stopPolicy, "ceilings");
    assert.match(decision.policyId, /^policy-[0-9a-f]{24}$/);
    assert.strictEqual(decision.forecast.basis, "completed_campaign_windows");
    assert.strictEqual(decision.forecast.uncertainty, "high");
    assert.strictEqual(decision.drilldown.reportId, started.session.latestReportId);
    assert.deepStrictEqual(decision.overrides, [
      "longTailShare", "maxDiskMb", "maxElapsedSeconds", "minLongTailProbes",
      "regressionReserveStates", "stopPolicy", "totalStates", "valuePreference", "windowStates",
    ]);
    const opened = await openSessionReport({
      file,
      sessionCapability: started.sessionCapability,
      reportId: decision.drilldown.reportId,
    });
    assert.strictEqual(opened.artifact.id, started.session.latestReportId);
    const finding = started.savedFindings.findings[0];
    assert.ok(finding);
    const expanded = await openSessionFinding({
      file,
      sessionCapability: started.sessionCapability,
      reportId: decision.drilldown.reportId,
      findingId: finding.id,
    });
    assert.strictEqual(expanded.summary.id, finding.id);
    await assert.rejects(
      () => openSessionReport({
        file,
        sessionCapability: started.sessionCapability,
        reportId: "report-000000000000000000000000",
      }),
      /not owned by this search session/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign controls reject goal valuation before exact directed children exist", async () => {
  const { root, file } = project();
  try {
    await assert.rejects(
      () => startCampaign({ file, mode: "quick", valuePreference: "approved_goals" }),
      /not available for exact resumable campaigns/
    );
    assert.strictEqual(fs.existsSync(path.join(root, ".inkcheck", "sessions")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign policies are bounded by the durable metadata window quota", async () => {
  const { root, file } = project();
  try {
    await assert.rejects(
      () => startCampaign({
        file,
        intent: "balanced",
        totalStates: 1_000,
        windowStates: 1,
        maxElapsedSeconds: 60,
        maxDiskMb: 100,
        longTailShare: 0,
        minLongTailProbes: 0,
        regressionReserveStates: 0,
      }),
      /more than 512 durable windows/
    );
    assert.strictEqual(fs.existsSync(path.join(root, ".inkcheck", "sessions")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign metadata is private, restart-safe, provenance-bound, and digest checked", async () => {
  const { root, file } = project();
  try {
    const started = await startCampaign({
      file,
      intent: "scarce",
      totalStates: 1_000,
      windowStates: 73,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    const inspected = await inspectSearchSession({ file, sessionCapability: started.sessionCapability });
    assert.strictEqual(inspected.campaign.campaignId, started.campaign.campaignId);
    assert.strictEqual(inspected.sessionCapability, undefined);
    const directory = path.join(root, ".inkcheck", "sessions");
    const metadata = path.join(directory, fs.readdirSync(directory)[0]);
    const raw = fs.readFileSync(metadata, "utf8");
    assert.strictEqual(raw.includes(started.sessionCapability), false);
    for (const sensitive of ["stateJson", "choicePath", "transcript", "variables", "frontier", "nodes"]) {
      assert.strictEqual(raw.includes(sensitive), false, `campaign metadata leaked ${sensitive}`);
    }
    const value = JSON.parse(raw);
    const allocation = value.campaign.ledger.allocations[0];
    assert.match(allocation.provenance.reportId, /^report-[0-9a-f]{24}$/);
    assert.match(allocation.provenance.checkpointId, /^checkpoint-[0-9a-f]{24}$/);
    assert.ok(allocation.provenance.elapsedMs >= 0);
    value.campaign.ledger.spend.states += 1;
    fs.writeFileSync(metadata, JSON.stringify(value));
    await assert.rejects(
      () => inspectSearchSession({ file, sessionCapability: started.sessionCapability }),
      /missing required bounded fields/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign stale revisions and source changes fail closed while retaining prior evidence", async () => {
  const { root, file } = project();
  try {
    const started = await startCampaign({
      file,
      intent: "balanced",
      totalStates: 1_000,
      windowStates: 73,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    await assert.rejects(
      () => continueCampaign({ file, sessionCapability: started.sessionCapability, revision: 99 }),
      /revision is 1, not 99/
    );
    const priorReport = started.session.latestReportId;
    const priorCheckpoint = started.session.latestCheckpointId;
    fs.appendFileSync(file, "\nChanged after campaign window.\n");
    const invalidated = await continueCampaign({
      file,
      sessionCapability: started.sessionCapability,
      revision: 1,
    });
    assert.strictEqual(invalidated.campaign.status, "invalidated");
    assert.strictEqual(invalidated.campaign.stopReason, "source_changed");
    assert.strictEqual(invalidated.session.latestReportId, priorReport);
    assert.strictEqual(invalidated.session.recoverable, false);
    assert.strictEqual(invalidated.session.latestCheckpointId, undefined);
    const metadata = JSON.parse(fs.readFileSync(path.join(root, ".inkcheck", "sessions", fs.readdirSync(path.join(root, ".inkcheck", "sessions"))[0]), "utf8"));
    assert.strictEqual(metadata.campaign.ledger.allocations[0].provenance.checkpointId, priorCheckpoint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("campaign cancellation and persisted hard boundaries retain the latest partial report", async () => {
  const cancelledProject = project();
  const boundedProject = project();
  try {
    const cancelledStart = await startCampaign({
      file: cancelledProject.file,
      intent: "scarce",
      totalStates: 1_000,
      windowStates: 73,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    const cancelled = await cancelSearchSession({
      file: cancelledProject.file,
      sessionCapability: cancelledStart.sessionCapability,
      revision: 1,
    });
    assert.strictEqual(cancelled.campaign.status, "complete");
    assert.strictEqual(cancelled.campaign.stopReason, "cancelled");
    assert.strictEqual(cancelled.session.recoverable, false);
    assert.strictEqual(cancelled.session.latestReportId, cancelledStart.session.latestReportId);
    assert.strictEqual(cancelled.nextOperation.tool, "start_campaign");

    const bounded = await startCampaign({
      file: boundedProject.file,
      intent: "balanced",
      totalStates: 1_000,
      windowStates: 73,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    const directory = path.join(boundedProject.root, ".inkcheck", "sessions");
    const metadata = path.join(directory, fs.readdirSync(directory)[0]);
    const value = JSON.parse(fs.readFileSync(metadata, "utf8"));
    value.campaign.ledger.spend.currentDiskBytes = value.campaign.ledger.policy.ceilings.maxDiskBytes;
    value.campaign.digest = campaignLedgerDigest(value.campaign.ledger);
    fs.writeFileSync(metadata, JSON.stringify(value));
    const stopped = await continueCampaign({
      file: boundedProject.file,
      sessionCapability: bounded.sessionCapability,
      revision: 1,
    });
    assert.strictEqual(stopped.campaign.stopReason, "disk_ceiling");
    assert.strictEqual(stopped.session.latestReportId, bounded.session.latestReportId);
    assert.strictEqual(stopped.campaign.windows, 1);
  } finally {
    fs.rmSync(cancelledProject.root, { recursive: true, force: true });
    fs.rmSync(boundedProject.root, { recursive: true, force: true });
  }
});

test("MCP session inspection is bounded, private, and usable without process memory", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 73, findingLimit: 1 });
    const inspected = await inspectSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      findingLimit: 1,
    });
    assert.strictEqual(inspected.sessionCapability, undefined);
    assert.strictEqual(inspected.session.latestReportId, started.session.latestReportId);
    assert.ok(inspected.savedFindings.page.returned <= 1);
    assert.strictEqual("report" in inspected, false);
    assert.strictEqual("checkpoint" in inspected, false);

    const directory = path.join(root, ".inkcheck", "sessions");
    const names = fs.readdirSync(directory);
    assert.strictEqual(names.length, 1);
    assert.match(names[0], /^session-[0-9a-f]{64}\.json$/);
    const raw = fs.readFileSync(path.join(directory, names[0]), "utf8");
    assert.strictEqual(raw.includes(started.sessionCapability), false);
    for (const sensitive of ["stateJson", "choicePath", "transcript", "variables", "frontier", "nodes"]) {
      assert.strictEqual(raw.includes(sensitive), false, `metadata leaked ${sensitive}`);
    }
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(path.join(directory, names[0])).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancel retains an exact frontier by default and discard forgets the capability", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 73 });
    const cancelled = await cancelSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      revision: started.session.revision,
    });
    assert.strictEqual(cancelled.session.status, "cancelled");
    assert.strictEqual(cancelled.session.recoverable, true);
    const resumed = await continueSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      revision: cancelled.session.revision,
      maxStates: 100,
    });
    assert.strictEqual(resumed.session.revision, 3);
    const discarded = await cancelSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      revision: resumed.session.revision,
      discard: true,
    });
    assert.strictEqual(discarded.discarded, true);
    await assert.rejects(
      () => inspectSearchSession({ file, sessionCapability: started.sessionCapability }),
      /not found/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP sessions fail closed for capabilities, entrypoints, revisions, grants, and stale source", async () => {
  const { root, file } = project();
  try {
    const other = path.join(root, "other.ink");
    fs.copyFileSync(FIXTURE, other);
    const started = await startSearchSession({ file, maxStates: 73 });
    await assert.rejects(
      () => inspectSearchSession({ file, sessionCapability: "not-a-capability" }),
      /invalid search session capability/
    );
    await assert.rejects(
      () => inspectSearchSession({ file: other, sessionCapability: started.sessionCapability }),
      /different story entrypoint/
    );
    await assert.rejects(
      () => continueSearchSession({ file, sessionCapability: started.sessionCapability, revision: 99, maxStates: 100 }),
      /revision is 1, not 99/
    );
    await assert.rejects(
      () => continueSearchSession({ file, sessionCapability: started.sessionCapability, revision: 1, maxStates: 73 }),
      /greater than the prior total grant/
    );
    await assert.rejects(
      () => continueSearchSession({ file, sessionCapability: started.sessionCapability, revision: 1, maxStates: 5_000_074 }),
      /may add at most 5000000/
    );
    fs.appendFileSync(file, "\nChanged after the checkpoint.\n");
    await assert.rejects(
      () => continueSearchSession({ file, sessionCapability: started.sessionCapability, revision: 1, maxStates: 100 }),
      /resume requires the exact source and knot map/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP session metadata rejects incompatible versions and one recoverable session per story", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 73 });
    await assert.rejects(
      () => startSearchSession({ file, maxStates: 73 }),
      /already has a recoverable search session/
    );
    const directory = path.join(root, ".inkcheck", "sessions");
    const metadata = path.join(directory, fs.readdirSync(directory)[0]);
    let value = JSON.parse(fs.readFileSync(metadata, "utf8"));
    value.schemaVersion = 1;
    fs.writeFileSync(metadata, JSON.stringify(value));
    const upgraded = await cancelSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      revision: 1,
    });
    assert.strictEqual(upgraded.session.revision, 2);
    value = JSON.parse(fs.readFileSync(metadata, "utf8"));
    assert.strictEqual(value.schemaVersion, 5);
    value.schemaVersion = 3;
    delete value.directedGranted;
    delete value.directedStatesExplored;
    delete value.goalProbes;
    fs.writeFileSync(metadata, JSON.stringify(value));
    const legacy = await inspectSearchSession({ file, sessionCapability: started.sessionCapability });
    assert.deepStrictEqual(legacy.session.budget.directed, { granted: 0, consumed: 0 });
    value = JSON.parse(fs.readFileSync(metadata, "utf8"));
    value.events.push({
      sequence: 3,
      type: "replayed",
      revision: 3,
      totalGranted: value.totalGranted,
      statesExplored: value.statesExplored,
      reportId: value.latestReportId,
      findingId: "runtime.error:test",
      replayStatus: "runtime_error",
      transcript: "must never persist",
    });
    fs.writeFileSync(metadata, JSON.stringify(value));
    await assert.rejects(
      () => inspectSearchSession({ file, sessionCapability: started.sessionCapability }),
      /missing required bounded fields/
    );
    value.events.pop();
    value.schemaVersion = 999;
    fs.writeFileSync(metadata, JSON.stringify(value));
    await assert.rejects(
      () => startSearchSession({ file, maxStates: 73 }),
      /unsupported search session schema 999/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add_goal spends additive directed work while preserving the exact base session", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 73, maxDepth: 150, seed: 7 });
    const baseReportId = started.session.latestReportId;
    const baseCheckpointId = started.session.latestCheckpointId;
    const checkpointFile = path.join(root, ".inkcheck", "checkpoints", `${baseCheckpointId}.json`);
    const checkpointHash = createHash("sha256").update(fs.readFileSync(checkpointFile)).digest("hex");
    const added = await addSessionGoal({
      file,
      sessionCapability: started.sessionCapability,
      revision: started.session.revision,
      maxStates: 20,
      goal: {
        id: "reach_depth",
        condition: { left: { variable: "depth" }, operator: ">=", right: { literal: 2 } },
      },
    });
    assert.strictEqual(added.result.status, "reached");
    assert.match(added.goalHandle, /^goal-[0-9a-f]{24}$/);
    assert.strictEqual(added.session.revision, 2);
    assert.strictEqual(added.session.latestReportId, baseReportId);
    assert.strictEqual(added.session.latestCheckpointId, baseCheckpointId);
    assert.deepStrictEqual(added.session.budget.base, { granted: 73, consumed: started.session.statesExplored });
    assert.deepStrictEqual(added.session.budget.directed, { granted: 20, consumed: added.budget.directedConsumed });
    assert.strictEqual(added.session.budget.total.granted, 93);
    assert.match(added.semantics, /started at the story root.*additive/i);
    assert.strictEqual(
      createHash("sha256").update(fs.readFileSync(checkpointFile)).digest("hex"),
      checkpointHash
    );

    const goalReport = await openReportArtifact(root, added.goalReportId);
    assert.strictEqual(goalReport.artifact.freshness, "current");
    assert.strictEqual(goalReport.report.effectiveConfiguration.executionScope, "goal-probe");
    assert.strictEqual(goalReport.report.effectiveConfiguration.limits.maxStates, 0);
    assert.strictEqual(goalReport.report.effectiveConfiguration.limits.goalMaxStates, 20);
    assert.strictEqual(goalReport.report.explore.goalBudget.generalGranted, 0);
    assert.strictEqual(goalReport.report.explore.goalBudget.directedGranted, 20);

    const inspected = await inspectSearchSession({ file, sessionCapability: started.sessionCapability });
    assert.deepStrictEqual(inspected.session.goalProbes, [{
      goalHandle: added.goalHandle,
      status: "reached",
      reportId: added.goalReportId,
      directedGranted: 20,
      directedConsumed: added.budget.directedConsumed,
    }]);
    const sessionPath = path.join(root, ".inkcheck", "sessions", fs.readdirSync(path.join(root, ".inkcheck", "sessions"))[0]);
    const raw = fs.readFileSync(sessionPath, "utf8");
    for (const sensitive of ["reach_depth", '"depth"', '"condition"', '"observedValues"', '"choiceIndices"']) {
      assert.strictEqual(raw.includes(sensitive), false, `session metadata leaked ${sensitive}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add_goal reports bounded misses and supports staged goals", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 10, maxDepth: 150 });
    const missed = await addSessionGoal({
      file,
      sessionCapability: started.sessionCapability,
      revision: 1,
      maxStates: 1,
      goal: {
        id: "far_code",
        condition: { left: { variable: "path_code" }, operator: "==", right: { literal: 999999 } },
      },
    });
    assert.strictEqual(missed.result.status, "not_reached_within_limits");
    const staged = await addSessionGoal({
      file,
      sessionCapability: started.sessionCapability,
      revision: 2,
      maxStates: 20,
      goal: {
        id: "two_steps",
        stages: [
          { id: "one", condition: { left: { variable: "depth" }, operator: ">=", right: { literal: 1 } } },
          { id: "two", condition: { left: { variable: "depth" }, operator: ">=", right: { literal: 2 } } },
        ],
      },
    });
    assert.strictEqual(staged.result.status, "reached");
    assert.deepStrictEqual(staged.result.stages.map((stage) => stage.status), ["reached", "reached"]);
    assert.strictEqual(staged.session.budget.directed.granted, 21);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("add_goal fails before work for invalid goals, stale revisions, changed source, and campaign caps", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 10, maxDepth: 150 });
    const goal = {
      id: "bad_variable",
      condition: { left: { variable: "missing" }, operator: "==", right: { literal: true } },
    };
    await assert.rejects(
      () => addSessionGoal({ file, sessionCapability: started.sessionCapability, revision: 1, maxStates: 1, goal }),
      /unknown variable missing/
    );
    await assert.rejects(
      () => addSessionGoal({ file, sessionCapability: started.sessionCapability, revision: 99, maxStates: 1, goal }),
      /revision is 1, not 99/
    );
    fs.appendFileSync(file, "\nChanged before goal.\n");
    await assert.rejects(
      () => addSessionGoal({
        file,
        sessionCapability: started.sessionCapability,
        revision: 1,
        maxStates: 1,
        goal: { id: "depth", condition: { left: { variable: "depth" }, operator: ">=", right: { literal: 1 } } },
      }),
      /requires the exact source/
    );
    fs.copyFileSync(FIXTURE, file);
    const sessionPath = path.join(root, ".inkcheck", "sessions", fs.readdirSync(path.join(root, ".inkcheck", "sessions"))[0]);
    const metadata = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    metadata.totalGranted = 99_000_000;
    fs.writeFileSync(sessionPath, JSON.stringify(metadata));
    await assert.rejects(
      () => addSessionGoal({
        file,
        sessionCapability: started.sessionCapability,
        revision: 1,
        maxStates: 1_000_001,
        goal: { id: "depth", condition: { left: { variable: "depth" }, operator: ">=", right: { literal: 1 } } },
      }),
      /base plus directed grants must not exceed 100000000/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP witness replay executes current evidence and records only a privacy-safe audit event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-replay-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), file);
  try {
    const started = await startSearchSession({ file, maxStates: 100 });
    const findingId = started.savedFindings.findings[0].id;
    const replayed = await replaySessionWitness({
      file,
      sessionCapability: started.sessionCapability,
      revision: started.session.revision,
      findingId,
    });
    assert.strictEqual(replayed.reportId, started.session.latestReportId);
    assert.strictEqual(replayed.finding.id, findingId);
    assert.strictEqual(replayed.replay.replayStatus, "runtime_error");
    assert.strictEqual(replayed.session.revision, 2);
    assert.deepStrictEqual(replayed.session.events.at(-1), {
      sequence: 2,
      type: "replayed",
      revision: 2,
      totalGranted: 100,
      statesExplored: started.session.statesExplored,
      reportId: started.session.latestReportId,
      findingId,
      replayStatus: "runtime_error",
    });
    assert.match(replayed.disclosure, /transcript, choice text, and final variables/);

    const inspected = await inspectSearchSession({ file, sessionCapability: started.sessionCapability });
    assert.strictEqual(inspected.session.revision, 2);
    assert.strictEqual(inspected.session.events.at(-1).findingId, findingId);
    const metadata = path.join(root, ".inkcheck", "sessions", fs.readdirSync(path.join(root, ".inkcheck", "sessions"))[0]);
    const raw = fs.readFileSync(metadata, "utf8");
    for (const sensitive of ["Do you need", "steps", "choiceIndices", "variables", "pendingChoices"]) {
      assert.strictEqual(raw.includes(sensitive), false, `replay metadata leaked ${sensitive}`);
    }
    await assert.rejects(
      () => replaySessionWitness({ file, sessionCapability: started.sessionCapability, revision: 1, findingId }),
      /revision is 2, not 1/
    );
    fs.appendFileSync(file, "\nChanged source after replay.\n");
    await assert.rejects(
      () => replaySessionWitness({ file, sessionCapability: started.sessionCapability, revision: 2, findingId }),
      /replay requires current source; report is stale/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP witness replay rejects foreign IDs and findings without indexed witnesses", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-replay-invalid-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), file);
  try {
    const started = await startSearchSession({ file, maxStates: 100 });
    await assert.rejects(
      () => replaySessionWitness({
        file,
        sessionCapability: started.sessionCapability,
        revision: 1,
        findingId: "runtime.error:foreign",
      }),
      /finding not found/
    );

    const compiled = await compile(file);
    assert.strictEqual(compiled.success, true);
    const noWitnessId = "ending.reached:no-witness";
    const reference = saveReportArtifact(root, file, {
      schemaVersion: 1,
      storyFingerprint: {
        algorithm: "sha256",
        source: "compiled-story",
        value: createHash("sha256").update(compiled.storyJson).digest("hex"),
      },
      effectiveConfiguration: {},
      compile: { issues: [] },
      explore: {
        runtimeErrors: [],
        endingsFound: [{ id: noWitnessId, kind: "ending.reached" }],
        assertionResults: [],
        goalResults: [],
      },
    });
    const sessions = path.join(root, ".inkcheck", "sessions");
    const metadata = path.join(sessions, fs.readdirSync(sessions)[0]);
    const record = JSON.parse(fs.readFileSync(metadata, "utf8"));
    record.latestReportId = reference.id;
    fs.writeFileSync(metadata, JSON.stringify(record));
    await assert.rejects(
      () => replaySessionWitness({
        file,
        sessionCapability: started.sessionCapability,
        revision: 1,
        findingId: noWitnessId,
      }),
      /no supported indexed replay witness/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP runtime regression pins classify still failing, fixed, and path changed without new search work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-regression-"));
  const file = path.join(root, "story.ink");
  const brokenSource = fs.readFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), "utf8");
  fs.writeFileSync(file, brokenSource);
  try {
    const started = await startSearchSession({ file, maxStates: 100 });
    const findingId = started.savedFindings.findings[0].id;
    const pinned = await pinSessionRegression({
      file,
      sessionCapability: started.sessionCapability,
      revision: 1,
      findingId,
    });
    assert.match(pinned.pin.id, /^regression-[0-9a-f]{24}$/);
    assert.strictEqual(pinned.pin.findingId, findingId);
    assert.strictEqual(pinned.pin.choiceCount, 1);
    assert.strictEqual(pinned.session.revision, 2);
    assert.strictEqual(pinned.session.events.at(-1).type, "regression_pinned");

    const unchanged = await checkSessionRegression({
      file,
      sessionCapability: started.sessionCapability,
      revision: 2,
      pinId: pinned.pin.id,
    });
    assert.strictEqual(unchanged.check.status, "still_failing");
    assert.strictEqual(unchanged.check.reason, "pinned_failure_reproduced");
    assert.strictEqual(unchanged.nextOperation.tool, "check_regression");
    assert.strictEqual(unchanged.session.revision, 3);
    assert.strictEqual(unchanged.session.statesExplored, started.session.statesExplored);

    fs.writeFileSync(file, `${brokenSource}    -> DONE\n`);
    const fixed = await checkSessionRegression({
      file,
      sessionCapability: started.sessionCapability,
      revision: 3,
      pinId: pinned.pin.id,
    });
    assert.strictEqual(fixed.check.status, "fixed");
    assert.strictEqual(fixed.check.reason, "completed_without_pinned_failure");
    assert.strictEqual(fixed.nextOperation.tool, "cancel_search");
    assert.strictEqual(fixed.session.revision, 4);
    assert.strictEqual(fixed.session.statesExplored, started.session.statesExplored);

    fs.writeFileSync(file, "The choice was removed.\n-> END\n");
    const changed = await checkSessionRegression({
      file,
      sessionCapability: started.sessionCapability,
      revision: 4,
      pinId: pinned.pin.id,
    });
    assert.strictEqual(changed.check.status, "path_changed");
    assert.strictEqual(changed.check.reason, "indexed_path_changed");
    assert.strictEqual(changed.session.revision, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regression pins are idempotent, private, session-bound, and contain no replay prose", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-regression-private-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), file);
  try {
    const started = await startSearchSession({ file, maxStates: 100 });
    const findingId = started.savedFindings.findings[0].id;
    const first = await pinSessionRegression({ file, sessionCapability: started.sessionCapability, revision: 1, findingId });
    const second = await pinSessionRegression({ file, sessionCapability: started.sessionCapability, revision: 2, findingId });
    assert.strictEqual(second.pin.id, first.pin.id);
    const pins = path.join(root, ".inkcheck", "regressions");
    assert.deepStrictEqual(fs.readdirSync(pins), [`${first.pin.id}.json`]);
    const artifact = path.join(pins, `${first.pin.id}.json`);
    const raw = fs.readFileSync(artifact, "utf8");
    assert.match(raw, /"choices": \[\s*0\s*\]/);
    assert.match(raw, /"expectedRuntimeErrorHashes"/);
    for (const sensitive of ["Do you need", "You wait", "transcript", "variables", "pendingChoices", "RUNTIME ERROR"]) {
      assert.strictEqual(raw.includes(sensitive), false, `pin artifact leaked ${sensitive}`);
    }
    const sessionFile = path.join(root, ".inkcheck", "sessions", fs.readdirSync(path.join(root, ".inkcheck", "sessions"))[0]);
    const sessionRaw = fs.readFileSync(sessionFile, "utf8");
    assert.strictEqual(sessionRaw.includes('"choices"'), false);
    assert.strictEqual(sessionRaw.includes('"expectedRuntimeErrorHashes"'), false);
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(pins).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(artifact).mode & 0o777, 0o600);
    }

    const other = path.join(root, "other.ink");
    fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), other);
    const foreign = await startSearchSession({ file: other, maxStates: 100 });
    await assert.rejects(
      () => checkSessionRegression({
        file: other,
        sessionCapability: foreign.sessionCapability,
        revision: 1,
        pinId: first.pin.id,
      }),
      /belongs to another search session/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regression pinning fails closed for stale source, unsupported findings, compile errors, and corrupt pins", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-regression-errors-"));
  const runtimeFile = path.join(root, "runtime.ink");
  const endingFile = path.join(root, "ending.ink");
  fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), runtimeFile);
  fs.copyFileSync(path.join(__dirname, "..", "examples", "clean-branch.ink"), endingFile);
  try {
    const runtime = await startSearchSession({ file: runtimeFile, maxStates: 100 });
    const runtimeId = runtime.savedFindings.findings[0].id;
    fs.appendFileSync(runtimeFile, "\nChanged before pin.\n");
    await assert.rejects(
      () => pinSessionRegression({ file: runtimeFile, sessionCapability: runtime.sessionCapability, revision: 1, findingId: runtimeId }),
      /regression pin requires current source/
    );

    const ending = await startSearchSession({ file: endingFile, maxStates: 100 });
    const endingId = ending.savedFindings.findings.find((finding) => finding.kind === "ending.reached").id;
    await assert.rejects(
      () => pinSessionRegression({ file: endingFile, sessionCapability: ending.sessionCapability, revision: 1, findingId: endingId }),
      /currently support runtime findings only/
    );

    const pinnedFile = path.join(root, "pinned.ink");
    fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), pinnedFile);
    const pinnedSession = await startSearchSession({ file: pinnedFile, maxStates: 100 });
    const pinned = await pinSessionRegression({
      file: pinnedFile,
      sessionCapability: pinnedSession.sessionCapability,
      revision: 1,
      findingId: pinnedSession.savedFindings.findings[0].id,
    });
    fs.writeFileSync(pinnedFile, "-> missing_knot\n");
    await assert.rejects(
      () => checkSessionRegression({
        file: pinnedFile,
        sessionCapability: pinnedSession.sessionCapability,
        revision: 2,
        pinId: pinned.pin.id,
      }),
      /current story does not compile/
    );
    fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), pinnedFile);
    const artifact = path.join(root, ".inkcheck", "regressions", `${pinned.pin.id}.json`);
    const corrupt = JSON.parse(fs.readFileSync(artifact, "utf8"));
    corrupt.transcript = "must never persist";
    fs.writeFileSync(artifact, JSON.stringify(corrupt));
    await assert.rejects(
      () => checkSessionRegression({
        file: pinnedFile,
        sessionCapability: pinnedSession.sessionCapability,
        revision: 2,
        pinId: pinned.pin.id,
      }),
      /privacy-sensitive fields/
    );
    delete corrupt.transcript;
    corrupt.schemaVersion = 999;
    fs.writeFileSync(artifact, JSON.stringify(corrupt));
    await assert.rejects(
      () => checkSessionRegression({
        file: pinnedFile,
        sessionCapability: pinnedSession.sessionCapability,
        revision: 2,
        pinId: pinned.pin.id,
      }),
      /unsupported regression pin schema 999/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regression pin storage enforces the per-project file ceiling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-regression-quota-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), file);
  try {
    const started = await startSearchSession({ file, maxStates: 100 });
    const pins = path.join(root, ".inkcheck", "regressions");
    fs.mkdirSync(pins, { recursive: true });
    for (let index = 0; index < 100; index++) {
      fs.writeFileSync(path.join(pins, `regression-${index.toString(16).padStart(24, "0")}.json`), "{}");
    }
    await assert.rejects(
      () => pinSessionRegression({
        file,
        sessionCapability: started.sessionCapability,
        revision: 1,
        findingId: started.savedFindings.findings[0].id,
      }),
      /already has 100 regression pins/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
