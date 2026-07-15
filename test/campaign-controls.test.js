const test = require("node:test");
const assert = require("node:assert");
const {
  campaignPolicyInput,
  campaignRecommendation,
  explainCampaignDecision,
  forecastCampaign,
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
