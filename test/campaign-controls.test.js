const test = require("node:test");
const assert = require("node:assert");
const {
  campaignPolicyInput,
  campaignRecommendation,
  explainCampaignDecision,
  forecastCampaign,
  recommendLongTailShadow,
  resolveCampaignControl,
} = require("../dist/campaign-controls");
const {
  commitCampaignRun,
  createCampaignLedger,
  createCampaignPolicy,
  planCampaignRun,
} = require("../dist/campaign-policy");

const fingerprint = "campaign-controls-0123456789";
const start = "2026-07-14T12:00:00.000Z";

test("named campaign modes resolve to bounded replayable defaults and explicit overrides", () => {
  const quick = resolveCampaignControl({ mode: "quick" }, 512);
  assert.deepStrictEqual({
    states: quick.totalStates,
    window: quick.windowStates,
    elapsed: quick.maxElapsedSeconds,
    disk: quick.maxDiskMb,
    resource: quick.resourcePreference,
    stop: quick.stopPolicy,
  }, { states: 250_000, window: 50_000, elapsed: 60, disk: 128, resource: "scarce", stop: "knee" });

  const deep = resolveCampaignControl({
    mode: "deep",
    totalStates: 5_000_000,
    resourcePreference: "balanced",
    valuePreference: "outcomes",
  }, 768);
  assert.deepStrictEqual(deep.overrideKeys, ["resourcePreference", "totalStates", "valuePreference"]);
  const policy = createCampaignPolicy(campaignPolicyInput(deep));
  assert.strictEqual(policy.policyVersion, 2);
  assert.deepStrictEqual(policy.control, {
    mode: "deep",
    resourcePreference: "balanced",
    valuePreference: "outcomes",
    stopPolicy: "knee",
    overrideKeys: ["resourcePreference", "totalStates", "valuePreference"],
  });
});

test("fixed mode preserves legacy derived windows and requires only the old ceilings", () => {
  const fixed = resolveCampaignControl({
    legacyIntent: "scarce",
    totalStates: 10_000,
    maxElapsedSeconds: 60,
    maxDiskMb: 100,
  }, 512);
  assert.strictEqual(fixed.mode, "fixed");
  assert.strictEqual(fixed.windowStates, 500);
  assert.strictEqual(fixed.stopPolicy, "ceilings");
  assert.throws(() => resolveCampaignControl({ mode: "fixed" }, 512), /requires totalStates/);
});

function ledgerWithWindows({ valuePreference = "broad_qa", stopPolicy = "knee", yields }) {
  const policy = createCampaignPolicy({
    intent: "balanced",
    mode: "balanced",
    valuePreference,
    stopPolicy,
    totalStates: 10_000,
    maxElapsedMs: 60_000,
    maxMemoryBytes: 10_000_000,
    maxDiskBytes: 10_000_000,
    maxConcurrency: 1,
    typicalWindowStates: 100,
    longTailShare: 0.1,
    minLongTailProbes: 1,
    regressionReserveStates: 0,
  });
  let ledger = createCampaignLedger(policy, fingerprint, start);
  yields.forEach((yieldValue, index) => {
    const now = new Date(Date.parse(start) + index * 2_000).toISOString();
    const plan = planCampaignRun(ledger, { now, bindingFingerprint: fingerprint, recommendation: "continue" });
    assert.strictEqual(plan.action, "allocate");
    ledger = commitCampaignRun(plan.ledger, {
      now: new Date(Date.parse(now) + 1_000).toISOString(),
      bindingFingerprint: fingerprint,
      allocationId: plan.allocation.id,
      consumedStates: 100,
      peakMemoryBytes: 1_000 + index,
      currentDiskBytes: 2_000 + index,
      stopReason: "window_complete",
      windowElapsedMs: 1_000,
      reportId: `report-${String(index + 1).padStart(24, "0")}`,
      yield: yieldValue,
    });
  });
  return ledger;
}

test("preference-aware forecasts require repeated dry windows and retain uncertainty", () => {
  const ledger = ledgerWithWindows({
    valuePreference: "outcomes",
    yields: [
      { critical: 1, intent: 0, authoredCoverage: 2, terminalVariants: 0 },
      { critical: 0, intent: 0, authoredCoverage: 1, terminalVariants: 0 },
      { critical: 0, intent: 0, authoredCoverage: 1, terminalVariants: 0 },
    ],
  });
  const forecast = forecastCampaign(ledger);
  assert.strictEqual(forecast.meaningfulYield.preference, "outcomes");
  assert.strictEqual(forecast.meaningfulYield.shared.discoveries, 0);
  assert.strictEqual(forecast.knee.status, "candidate");
  assert.strictEqual(forecast.uncertainty, "high");
  assert.strictEqual(campaignRecommendation(ledger), "stop_at_knee");
  assert.match(forecast.disclosure, /not a probability.*coverage claim/);
});

test("decision explanations are compact, attributable, and link report drill-down", () => {
  const ledger = ledgerWithWindows({
    stopPolicy: "ceilings",
    yields: [{ critical: 1, intent: 0, authoredCoverage: 2, terminalVariants: 1 }],
  });
  const decision = explainCampaignDecision(ledger);
  assert.match(decision.policyId, /^policy-[0-9a-f]{24}$/);
  assert.strictEqual(decision.policyVersion, 2);
  assert.strictEqual(decision.latestAllocation.reason, "ordinary window continues broad bounded QA");
  assert.strictEqual(decision.drilldown.curvesTool, "open_report");
  assert.match(decision.drilldown.reportId, /^report-/);
  assert.strictEqual(campaignRecommendation(ledger), "continue");
});

function longTailSequence({
  resourcePreference = "balanced",
  valuePreference = "outcomes",
  yields,
  observability = [],
}) {
  const windowStates = 100;
  const policy = createCampaignPolicy({
    intent: resourcePreference,
    mode: "fixed",
    valuePreference,
    stopPolicy: "ceilings",
    totalStates: windowStates * (yields.length + 1),
    maxElapsedMs: 1_000_000,
    maxMemoryBytes: 10_000_000,
    maxDiskBytes: 10_000_000,
    maxConcurrency: 1,
    typicalWindowStates: windowStates,
    longTailShare: yields.length / (yields.length + 1),
    minLongTailProbes: 1,
    regressionReserveStates: 0,
  });
  let ledger = createCampaignLedger(policy, fingerprint, start);
  const commit = (plan, yieldValue, index, observation) => commitCampaignRun(plan.ledger, {
    now: new Date(Date.parse(start) + (index * 2 + 1) * 1_000).toISOString(),
    bindingFingerprint: fingerprint,
    allocationId: plan.allocation.id,
    consumedStates: plan.allocation.grantedStates,
    peakMemoryBytes: 1_000,
    currentDiskBytes: 2_000,
    stopReason: "window_complete",
    windowElapsedMs: 1_000,
    reportId: `report-${String(index + 100).padStart(24, "0")}`,
    yield: yieldValue,
    ...(observation ? { observability: observation } : {}),
  });
  const base = planCampaignRun(ledger, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
  assert.strictEqual(base.action, "allocate");
  assert.strictEqual(base.allocation.purpose, "typical");
  ledger = commit(base, { critical: 0, intent: 0, authoredCoverage: 0, terminalVariants: 0 }, 0);
  const shadows = [];
  yields.forEach((yieldValue, index) => {
    const now = new Date(Date.parse(start) + (index * 2 + 2) * 1_000).toISOString();
    const plan = planCampaignRun(ledger, {
      now,
      bindingFingerprint: fingerprint,
      recommendation: "continue",
      longTailPartition: { strategy: "portfolio", seed: index + 1, frontier: "root", maxDepth: 200 },
    });
    assert.strictEqual(plan.action, "allocate");
    assert.strictEqual(plan.allocation.purpose, "long_tail");
    ledger = commit(plan, yieldValue, index + 1, observability[index]);
    shadows.push(recommendLongTailShadow(ledger));
  });
  return { ledger, shadows };
}

test("long-tail shadow replays the Intercept curve without changing live allocation", () => {
  const terminalVariants = [1030, 508, 400, 340, 300, 293, 239, 229, 219];
  const { ledger, shadows } = longTailSequence({
    yields: terminalVariants.map((value) => ({ critical: 0, intent: 0, authoredCoverage: 0, terminalVariants: value })),
  });
  assert.deepStrictEqual(shadows.map((shadow) => shadow.action), [
    "rotate_partition", "rotate_partition", "rotate_partition", "rotate_partition", "rotate_partition",
    "rotate_partition", "rotate_partition", "rotate_partition",
    "stop_after_floor",
  ]);
  assert.strictEqual(shadows[3].reason, "preferred_yield_declining_rotate");
  assert.strictEqual(shadows[3].recent.trend, "declining");
  assert.strictEqual(shadows[3].recent.meaningfulDiscoveries, 1_248);
  assert.strictEqual(shadows[3].recent.perMillionStates, 4_160_000);
  assert.strictEqual(shadows[3].recent.perSecond, 416);
  assert.strictEqual(shadows.at(-1).reason, "long_tail_authorization_exhausted");
  assert.strictEqual(shadows.at(-1).remainingAuthorizedStates, 0);
  assert.strictEqual(shadows.at(-1).liveEffect, false);
  assert.deepStrictEqual(shadows.at(-1).unavailableSignals, ["duplicate_rate", "discovery_spacing"]);
  assert.strictEqual(campaignRecommendation(ledger), "continue");
  assert.deepStrictEqual(explainCampaignDecision(ledger).longTailShadow, shadows.at(-1));
});

function observedWindow({ campaignNew, rediscovered, state, latestGap, longestGap }) {
  const zero = { critical: 0, intent: 0, authoredCoverage: 0 };
  return {
    schemaVersion: 1,
    observedYield: { ...zero, terminalVariants: campaignNew + rediscovered },
    rediscoveredYield: { ...zero, terminalVariants: rediscovered },
    discoverySpacing: {
      scope: "report_meaningful_events",
      discoveryEvents: campaignNew + rediscovered,
      firstDiscoveryAtState: 1,
      lastDiscoveryAtState: state - latestGap,
      statesSinceLastDiscovery: latestGap,
      latestDiscoveryGap: latestGap,
      longestObservedDiscoveryGap: longestGap,
    },
  };
}

test("long-tail shadow exposes selected-value rediscovery and factual discovery gaps", () => {
  const campaignNew = [10, 2, 1, 1];
  const rediscovered = [10, 18, 19, 19];
  const observability = campaignNew.map((value, index) => observedWindow({
    campaignNew: value,
    rediscovered: rediscovered[index],
    state: 100,
    latestGap: 10 + index,
    longestGap: 20 + index,
  }));
  const { shadows } = longTailSequence({
    yields: campaignNew.map((terminalVariants) => ({ critical: 0, intent: 0, authoredCoverage: 0, terminalVariants })),
    observability,
  });
  const shadow = shadows[2];
  assert.deepStrictEqual(shadow.signals.duplicateRate, {
    scope: "selected_value_report_rediscovery",
    observed: 60,
    campaignNew: 13,
    rediscovered: 47,
    rate: 0.783333,
  });
  assert.deepStrictEqual(shadow.signals.discoverySpacing, {
    scope: "report_meaningful_events",
    windows: 3,
    discoveryEvents: 60,
    statesSinceLastDiscovery: 12,
    latestDiscoveryGap: 12,
    longestObservedDiscoveryGap: 22,
  });
  assert.deepStrictEqual(shadow.unavailableSignals, []);
  assert.strictEqual(shadow.liveEffect, false);
});

test("campaign commits reject observability that invents or loses evidence", () => {
  const policy = createCampaignPolicy({
    intent: "balanced",
    totalStates: 1_000,
    maxElapsedMs: 60_000,
    maxMemoryBytes: 10_000_000,
    maxDiskBytes: 10_000_000,
    maxConcurrency: 1,
  });
  const ledger = createCampaignLedger(policy, fingerprint, start);
  const plan = planCampaignRun(ledger, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
  assert.strictEqual(plan.action, "allocate");
  assert.throws(() => commitCampaignRun(plan.ledger, {
    now: new Date(Date.parse(start) + 1_000).toISOString(),
    bindingFingerprint: fingerprint,
    allocationId: plan.allocation.id,
    consumedStates: 100,
    peakMemoryBytes: 1_000,
    currentDiskBytes: 2_000,
    stopReason: "window_complete",
    yield: { critical: 0, intent: 0, authoredCoverage: 0, terminalVariants: 2 },
    observability: observedWindow({ campaignNew: 1, rediscovered: 1, state: 100, latestGap: 10, longestGap: 20 }),
  }), /must equal campaign-new plus rediscovered evidence/);
});

test("long-tail shadow protects recovery and separates dry value preferences", () => {
  const zero = { critical: 0, intent: 0, authoredCoverage: 0, terminalVariants: 100 };
  const recovered = longTailSequence({
    valuePreference: "runtime_assertions",
    yields: [zero, zero, { ...zero, critical: 1 }, zero, zero],
  }).shadows;
  assert.strictEqual(recovered[1].action, "rotate_partition");
  assert.strictEqual(recovered[2].action, "expand_same_family");
  assert.strictEqual(recovered[2].reason, "critical_or_intent_progress");

  const dry = longTailSequence({
    valuePreference: "runtime_assertions",
    yields: [zero, zero, zero, zero, zero],
  }).shadows;
  assert.strictEqual(dry[2].action, "rotate_partition");
  assert.strictEqual(dry[3].action, "stop_after_floor");
  assert.strictEqual(dry[3].reason, "preferred_yield_dry");
  assert.strictEqual(dry[3].recent.yield.terminalVariants, 300);
  assert.strictEqual(dry[3].recent.meaningfulDiscoveries, 0);
});

test("resource postures require progressively more dry probes before a shadow stop", () => {
  const zero = { critical: 0, intent: 0, authoredCoverage: 0, terminalVariants: 0 };
  const firstStop = (resourcePreference) => longTailSequence({
    resourcePreference,
    valuePreference: "outcomes",
    yields: [zero, zero, zero, zero, zero, zero],
  }).shadows.findIndex((shadow) => shadow.reason === "preferred_yield_dry") + 1;
  assert.deepStrictEqual({ scarce: firstStop("scarce"), balanced: firstStop("balanced"), abundant: firstStop("abundant") }, {
    scarce: 3,
    balanced: 4,
    abundant: 5,
  });
});

test("nonzero late recovery is rotated or expanded, never mistaken for an asymptote", () => {
  const value = (terminalVariants) => ({ critical: 0, intent: 0, authoredCoverage: 0, terminalVariants });
  const recovered = longTailSequence({
    valuePreference: "outcomes",
    yields: [value(100), value(50), value(25), value(200), value(100)],
  }).shadows;
  assert.strictEqual(recovered.slice(0, 4).some((shadow) => shadow.action === "stop_after_floor"), false);
  assert.strictEqual(recovered[3].action, "rotate_partition");
  assert.strictEqual(recovered[3].recent.trend, "mixed");

  const stable = longTailSequence({
    valuePreference: "outcomes",
    yields: [value(100), value(100), value(100), value(100), value(100)],
  }).shadows;
  assert.strictEqual(stable[3].action, "expand_same_family");
  assert.strictEqual(stable[3].reason, "preferred_yield_rising_or_stable");
});
