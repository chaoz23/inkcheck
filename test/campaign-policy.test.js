const test = require("node:test");
const assert = require("node:assert");
const {
  createCampaignLedger,
  createCampaignPolicy,
  planCampaignRun,
  commitCampaignRun,
} = require("../dist/campaign-policy");

const fingerprint = "source-config-0123456789abcdef";
const start = "2026-07-14T12:00:00.000Z";

function policy(intent, overrides = {}) {
  return createCampaignPolicy({
    intent,
    totalStates: 10_000,
    maxElapsedMs: 60_000,
    maxMemoryBytes: 1_000_000,
    maxDiskBytes: 1_000_000,
    maxConcurrency: 2,
    maxCostMicrounits: 10_000,
    ...overrides,
  });
}

function complete(ledger, allocation, offsetMs = 1_000) {
  return commitCampaignRun(ledger, {
    now: new Date(Date.parse(start) + offsetMs).toISOString(),
    bindingFingerprint: fingerprint,
    allocationId: allocation.id,
    consumedStates: allocation.grantedStates,
    peakMemoryBytes: 100,
    currentDiskBytes: 100,
    costMicrounits: 1,
    stopReason: "window_complete",
    yield: { critical: 0, intent: 0, authoredCoverage: 1, terminalVariants: 0 },
  });
}

test("campaign policy validates reserves and exposes honest bounded semantics", () => {
  const value = policy("balanced");
  assert.strictEqual(value.schemaVersion, 1);
  assert.strictEqual(value.policyVersion, 1);
  assert.match(value.disclosure, /never proof of coverage/);
  assert.throws(() => policy("balanced", { longTailShare: 0.9, regressionReserveStates: 1_000 }), /leave states/);
  assert.throws(() => policy("scarce", { maxConcurrency: 0 }), /at least 1/);
  assert.throws(() => policy("scarce", { minLongTailProbes: 10_000 }), /one state per minimum probe/);
});

test("identical inputs produce identical campaign IDs, allocations, and reasons", () => {
  const left = createCampaignLedger(policy("balanced"), fingerprint, start);
  const right = createCampaignLedger(policy("balanced"), fingerprint, start);
  assert.deepStrictEqual(left, right);
  const input = { now: start, bindingFingerprint: fingerprint, recommendation: "continue", partition: { strategy: "shared", seed: 7 } };
  assert.deepStrictEqual(planCampaignRun(left, input), planCampaignRun(right, input));
  const reordered = planCampaignRun(left, {
    ...input,
    partition: { seed: 7, strategy: "shared" },
  });
  assert.strictEqual(reordered.action, "allocate");
  const original = planCampaignRun(left, input);
  assert.strictEqual(original.action, "allocate");
  assert.strictEqual(reordered.allocation.id, original.allocation.id);
});

test("ordinary windows cannot consume regression or long-tail reserves", () => {
  const configured = policy("balanced", {
    totalStates: 1_000,
    typicalWindowStates: 900,
    longTailShare: 0.2,
    minLongTailProbes: 0,
    regressionReserveStates: 300,
  });
  const ledger = createCampaignLedger(configured, fingerprint, start);
  const planned = planCampaignRun(ledger, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
  assert.strictEqual(planned.action, "allocate");
  assert.strictEqual(planned.allocation.purpose, "typical");
  assert.strictEqual(planned.allocation.grantedStates, 500);
});

test("protected long-tail work continues past a knee, then stops with unused budget", () => {
  let ledger = createCampaignLedger(policy("scarce", {
    totalStates: 1_000,
    typicalWindowStates: 100,
    longTailShare: 0.2,
    minLongTailProbes: 1,
    regressionReserveStates: 100,
  }), fingerprint, start);
  const ordinary = planCampaignRun(ledger, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
  assert.strictEqual(ordinary.action, "allocate");
  ledger = complete(ordinary.ledger, ordinary.allocation);
  const tail = planCampaignRun(ledger, { now: "2026-07-14T12:00:02.000Z", bindingFingerprint: fingerprint, recommendation: "stop_at_knee" });
  assert.strictEqual(tail.action, "allocate");
  assert.strictEqual(tail.allocation.purpose, "long_tail");
  assert.match(tail.allocation.reason, /continues beyond/);
  ledger = complete(tail.ledger, tail.allocation, 3_000);
  const secondTail = planCampaignRun(ledger, { now: "2026-07-14T12:00:04.000Z", bindingFingerprint: fingerprint, recommendation: "stop_at_knee" });
  assert.strictEqual(secondTail.action, "allocate");
  ledger = complete(secondTail.ledger, secondTail.allocation, 5_000);
  const stopped = planCampaignRun(ledger, { now: "2026-07-14T12:00:06.000Z", bindingFingerprint: fingerprint, recommendation: "stop_at_knee" });
  assert.strictEqual(stopped.action, "stop");
  assert.strictEqual(stopped.reason, "knee_observed");
  assert.ok(stopped.ledger.spend.states < stopped.ledger.policy.ceilings.totalStates);
  assert.match(stopped.ledger.events.at(-1).reason, /not coverage proof/);
});

test("pending exact replays receive the protected regression reserve", () => {
  const ledger = createCampaignLedger(policy("balanced", { regressionReserveStates: 500 }), fingerprint, start);
  const planned = planCampaignRun(ledger, {
    now: start,
    bindingFingerprint: fingerprint,
    recommendation: "continue",
    pendingRegressionReplays: 1,
    partition: { goalId: "regression-runtime-1" },
  });
  assert.strictEqual(planned.action, "allocate");
  assert.strictEqual(planned.allocation.purpose, "regression");
  assert.strictEqual(planned.allocation.grantedStates, 500);
});

test("source changes invalidate safely and stale commits fail closed", () => {
  const ledger = createCampaignLedger(policy("balanced"), fingerprint, start);
  const planned = planCampaignRun(ledger, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
  assert.strictEqual(planned.action, "allocate");
  const invalid = planCampaignRun(planned.ledger, {
    now: "2026-07-14T12:00:01.000Z",
    bindingFingerprint: "changed-source-0123456789",
    recommendation: "continue",
  });
  assert.strictEqual(invalid.action, "stop");
  assert.strictEqual(invalid.reason, "source_changed");
  assert.throws(() => commitCampaignRun(planned.ledger, {
    now: "2026-07-14T12:00:01.000Z",
    bindingFingerprint: "changed-source-0123456789",
    allocationId: planned.allocation.id,
    consumedStates: 1,
    peakMemoryBytes: 1,
    currentDiskBytes: 1,
    stopReason: "cancelled",
  }), /fingerprint changed/);
  assert.throws(() => planCampaignRun(ledger, {
    now: "2026-07-14T11:59:59.000Z",
    bindingFingerprint: fingerprint,
    recommendation: "continue",
  }), /must not precede campaign creation/);
});

test("aggregate ceilings and concurrency reject work before ledger mutation", () => {
  const base = createCampaignLedger(policy("balanced", { maxConcurrency: 1, maxCostMicrounits: 2 }), fingerprint, start);
  const planned = planCampaignRun(base, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
  assert.strictEqual(planned.action, "allocate");
  const blocked = planCampaignRun(planned.ledger, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
  assert.strictEqual(blocked.action, "wait");
  assert.strictEqual(blocked.reason, "concurrency_ceiling");
  assert.deepStrictEqual(blocked.ledger, planned.ledger);
  assert.throws(() => commitCampaignRun(planned.ledger, {
    now: "2026-07-14T12:00:01.000Z",
    bindingFingerprint: fingerprint,
    allocationId: planned.allocation.id,
    consumedStates: planned.allocation.grantedStates + 1,
    peakMemoryBytes: 1,
    currentDiskBytes: 1,
    stopReason: "bad_child",
  }), /more states/);
  assert.throws(() => commitCampaignRun(planned.ledger, {
    now: "2026-07-14T12:00:01.000Z",
    bindingFingerprint: fingerprint,
    allocationId: planned.allocation.id,
    consumedStates: 1,
    peakMemoryBytes: 1_000_001,
    currentDiskBytes: 1,
    stopReason: "memory",
  }), /memory ceiling/);
  assert.strictEqual(planned.ledger.spend.states, 0);
});

test("ordinary exhaustion hands reserved states to long-tail work", () => {
  let ledger = createCampaignLedger(policy("scarce", {
    totalStates: 1_000,
    typicalWindowStates: 300,
    longTailShare: 0.2,
    minLongTailProbes: 0,
    regressionReserveStates: 200,
  }), fingerprint, start);
  for (let index = 0; index < 2; index += 1) {
    const plan = planCampaignRun(ledger, {
      now: new Date(Date.parse(start) + index * 1_000).toISOString(),
      bindingFingerprint: fingerprint,
      recommendation: "continue",
    });
    assert.strictEqual(plan.action, "allocate");
    ledger = complete(plan.ledger, plan.allocation, index * 1_000 + 500);
  }
  const reserved = planCampaignRun(ledger, {
    now: "2026-07-14T12:00:03.000Z",
    bindingFingerprint: fingerprint,
    recommendation: "continue",
  });
  assert.strictEqual(reserved.action, "allocate");
  assert.strictEqual(reserved.allocation.purpose, "long_tail");
});

test("validated policies, partitions, yields, and stop reasons fail closed when tampered", () => {
  const tampered = policy("balanced");
  tampered.longTail.reservedStates += 1;
  assert.throws(() => createCampaignLedger(tampered, fingerprint, start), /modified after validation/);
  const ledger = createCampaignLedger(policy("balanced"), fingerprint, start);
  assert.throws(() => planCampaignRun(ledger, {
    now: start,
    bindingFingerprint: fingerprint,
    recommendation: "continue",
    partition: { strategy: "imaginary" },
  }), /partition.strategy/);
  const planned = planCampaignRun(ledger, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
  assert.strictEqual(planned.action, "allocate");
  assert.throws(() => commitCampaignRun(planned.ledger, {
    now: "2026-07-14T12:00:01.000Z",
    bindingFingerprint: fingerprint,
    allocationId: planned.allocation.id,
    consumedStates: 1,
    peakMemoryBytes: 1,
    currentDiskBytes: 1,
    stopReason: "contains spaces",
  }), /stopReason/);
});

test("deadline, elapsed-time, disk, cost, and exhaustive boundaries stay explicit", () => {
  const deadlinePolicy = policy("balanced", {
    maxElapsedMs: 1_000,
    deadlineAt: "2026-07-14T12:00:10.000Z",
    maxDiskBytes: 10,
    maxCostMicrounits: 2,
  });
  const elapsedLedger = createCampaignLedger(deadlinePolicy, fingerprint, start);
  const elapsedStop = planCampaignRun(elapsedLedger, {
    now: "2026-07-14T12:00:01.000Z",
    bindingFingerprint: fingerprint,
    recommendation: "continue",
  });
  assert.strictEqual(elapsedStop.action, "stop");
  assert.strictEqual(elapsedStop.reason, "time_ceiling");

  const deadlineLedger = createCampaignLedger(policy("balanced", {
    maxElapsedMs: 20_000,
    deadlineAt: "2026-07-14T12:00:10.000Z",
  }), fingerprint, start);
  const deadlineStop = planCampaignRun(deadlineLedger, {
    now: "2026-07-14T12:00:10.000Z",
    bindingFingerprint: fingerprint,
    recommendation: "continue",
  });
  assert.strictEqual(deadlineStop.action, "stop");
  assert.strictEqual(deadlineStop.reason, "deadline");
  const exhaustive = planCampaignRun(deadlineLedger, {
    now: start,
    bindingFingerprint: fingerprint,
    recommendation: "continue",
    exhaustive: true,
  });
  assert.strictEqual(exhaustive.action, "stop");
  assert.strictEqual(exhaustive.reason, "exhaustive");

  const planned = planCampaignRun(createCampaignLedger(deadlinePolicy, fingerprint, start), {
    now: start,
    bindingFingerprint: fingerprint,
    recommendation: "continue",
  });
  assert.strictEqual(planned.action, "allocate");
  const observation = {
    now: "2026-07-14T12:00:00.500Z",
    bindingFingerprint: fingerprint,
    allocationId: planned.allocation.id,
    consumedStates: 1,
    peakMemoryBytes: 1,
    currentDiskBytes: 11,
    stopReason: "window_complete",
  };
  assert.throws(() => commitCampaignRun(planned.ledger, observation), /disk ceiling/);
  assert.throws(() => commitCampaignRun(planned.ledger, { ...observation, currentDiskBytes: 1, costMicrounits: 3 }), /cost ceiling/);
});

test("scarce, balanced, and abundant simulations preserve progressively more long-tail work", () => {
  const summaries = ["scarce", "balanced", "abundant"].map((intent) => {
    let ledger = createCampaignLedger(policy(intent, { typicalWindowStates: 100 }), fingerprint, start);
    const first = planCampaignRun(ledger, { now: start, bindingFingerprint: fingerprint, recommendation: "continue" });
    ledger = complete(first.ledger, first.allocation);
    for (let index = 0; index < 30; index += 1) {
      const plan = planCampaignRun(ledger, {
        now: new Date(Date.parse(start) + 2_000 + index * 1_000).toISOString(),
        bindingFingerprint: fingerprint,
        recommendation: "stop_at_knee",
      });
      if (plan.action === "stop") break;
      ledger = complete(plan.ledger, plan.allocation, 2_500 + index * 1_000);
    }
    return {
      intent,
      tailStates: ledger.allocations.filter((entry) => entry.purpose === "long_tail").reduce((sum, entry) => sum + (entry.consumedStates ?? 0), 0),
      tailRuns: ledger.allocations.filter((entry) => entry.purpose === "long_tail").length,
    };
  });
  assert.deepStrictEqual(summaries.map((summary) => summary.tailStates), [500, 1_500, 2_500]);
  assert.deepStrictEqual(summaries.map((summary) => summary.tailRuns), [5, 15, 25]);
});
