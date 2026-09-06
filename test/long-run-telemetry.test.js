const { test } = require("node:test");
const assert = require("node:assert");

const {
  LONG_RUN_PHASES,
  MAX_LONG_RUN_BYTE_MILLISECONDS_DIGITS,
  MAX_LONG_RUN_TELEMETRY_PASSES,
  createLongRunTelemetryRecorder,
  validateLongRunTelemetryV1,
} = require("../dist/long-run-telemetry");

function yieldCounts({
  runtimeErrors = 0,
  assertionViolations = 0,
  goalsReached = 0,
  stagesReached = 0,
  knotsVisited = 0,
  visibleOutcomes = 0,
  semanticTransitions = 0,
  terminalVariants = 0,
  transitions = 0,
  uniqueStates = transitions,
  dedupeHits = 0,
} = {}) {
  return {
    critical: { runtimeErrors, assertionViolations },
    intent: { goalsReached, stagesReached },
    authoredCoverage: { knotsVisited },
    visibleOutcomes,
    semanticTransitions,
    terminalVariants,
    rawTerritory: { transitions, uniqueStates, dedupeHits },
  };
}

function observation({
  pass = "shared:deep-novelty-v1:seed=1",
  sequence,
  state,
  runWideState = state,
  elapsedMs,
  logicalBytes,
  searchBytes = logicalBytes,
  rssBytes,
  cumulative = yieldCounts({ transitions: state }),
}) {
  return {
    elapsedMs,
    value: {
      schemaVersion: 2,
      pass,
      runWideState,
      sample: {
        schemaVersion: 2,
        sequence,
        state,
        yield: {
          schemaVersion: 1,
          fromStateExclusive: Math.max(0, state - 1),
          throughState: state,
          delta: cumulative,
          cumulative,
        },
        retention: {
          schemaVersion: 1,
          current: { totalAccountedBytes: searchBytes },
          peak: { totalAccountedBytes: searchBytes },
          releasedNodes: 0,
          frontierCompactions: 0,
        },
      },
      process: {
        schemaVersion: 1,
        scope: "process",
        heapUsedBytes: rssBytes,
        heapTotalBytes: rssBytes,
        rssBytes,
        externalBytes: 0,
        arrayBuffersBytes: 0,
        comparedLogicalAccountedBytes: logicalBytes,
        unattributedBytes: rssBytes - logicalBytes,
      },
    },
  };
}

function pass(pass, statesExplored, cumulative) {
  return {
    pass,
    statesExplored,
    sharedObservability: {
      schemaVersion: 2,
      yieldSummary: { cumulative },
    },
  };
}

function observe(recorder, sample) {
  recorder.observeShared(sample.value, sample.elapsedMs);
}

test("long-run telemetry records exact trapezoids, inclusive phases, and category-specific rates", () => {
  let now = 0;
  const recorder = createLongRunTelemetryRecorder({ nowMs: () => now });
  recorder.startPhase("setup");
  now = 5;
  recorder.startPhase("compilation");
  now = 12;
  assert.strictEqual(recorder.endPhase("compilation"), 7);
  now = 20;
  assert.strictEqual(recorder.endPhase("setup"), 20);
  now = 25;
  recorder.startPhase("search_active");
  now = 85;
  recorder.endPhase("search_active");

  const firstYield = yieldCounts({
    runtimeErrors: 1,
    goalsReached: 1,
    knotsVisited: 2,
    visibleOutcomes: 2,
    semanticTransitions: 3,
    terminalVariants: 3,
    transitions: 10,
  });
  const finalYield = yieldCounts({
    runtimeErrors: 2,
    assertionViolations: 1,
    goalsReached: 1,
    stagesReached: 2,
    knotsVisited: 4,
    visibleOutcomes: 5,
    semanticTransitions: 6,
    terminalVariants: 7,
    transitions: 30,
  });
  observe(recorder, observation({
    sequence: 1,
    state: 10,
    elapsedMs: 100,
    searchBytes: 90,
    logicalBytes: 100,
    rssBytes: 1_000,
    cumulative: firstYield,
  }));
  observe(recorder, observation({
    sequence: 3,
    state: 30,
    elapsedMs: 160,
    searchBytes: 270,
    logicalBytes: 300,
    rssBytes: 1_400,
    cumulative: finalYield,
  }));

  const telemetry = recorder.finalize([
    pass("shared:deep-novelty-v1:seed=1", 30, finalYield),
  ]);
  assert.deepStrictEqual(telemetry.phases, {
    setupMs: 20,
    compilationMs: 7,
    sourceScanMs: 0,
    searchActiveMs: 60,
    minimumReproductionMs: 0,
    checkpointWriteMs: 0,
    checkpointReopenMs: 0,
    replayScoringMs: 0,
    reportEnrichmentMs: 0,
    reportWriteMs: 0,
    finalizationMs: 0,
  });
  const cost = telemetry.passes[0];
  assert.deepStrictEqual(cost.logicalRetained, {
    basis: "deterministic_logical_accounted_bytes",
    byteMillisecondsTimesTwo: "24000",
    divisor: 2,
  });
  assert.deepStrictEqual(cost.processRss, {
    basis: "observed_process_rss_bytes",
    byteMillisecondsTimesTwo: "144000",
    divisor: 2,
  });
  assert.strictEqual(cost.samplesObserved, 2);
  assert.strictEqual(cost.firstObservationElapsedMs, 100);
  assert.strictEqual(cost.lastObservationElapsedMs, 160);
  assert.strictEqual(cost.searchActiveMs, 60);
  assert.strictEqual(cost.transitions, 20);
  assert.deepStrictEqual(cost.yield.critical, {
    identities: 2,
    identitiesPerMillionTransitions: 100_000,
    identitiesPerSearchActiveMinute: 2_000,
    identitiesPerRetainedGiBMinute: 10_737_418_240,
  });
  assert.deepStrictEqual(validateLongRunTelemetryV1(telemetry), telemetry);
  assert.throws(() => recorder.finalize([]), /already finalized/);
});

test("pass costs remain local and never sum overlapping identities into a run total", () => {
  const recorder = createLongRunTelemetryRecorder();
  const a = "shared:pass-a";
  const b = "shared:pass-b";
  const firstA = yieldCounts({ transitions: 5 });
  const finalA = yieldCounts({ runtimeErrors: 1, transitions: 10 });
  const firstB = yieldCounts({ transitions: 10 });
  const finalB = yieldCounts({ runtimeErrors: 1, transitions: 20 });
  observe(recorder, observation({ pass: a, sequence: 1, state: 5, runWideState: 5, elapsedMs: 0, logicalBytes: 100, rssBytes: 1_000, cumulative: firstA }));
  observe(recorder, observation({ pass: a, sequence: 2, state: 10, runWideState: 10, elapsedMs: 10, logicalBytes: 100, rssBytes: 1_000, cumulative: finalA }));
  observe(recorder, observation({ pass: b, sequence: 1, state: 10, runWideState: 20, elapsedMs: 20, logicalBytes: 200, rssBytes: 2_000, cumulative: firstB }));
  observe(recorder, observation({ pass: b, sequence: 2, state: 20, runWideState: 30, elapsedMs: 40, logicalBytes: 200, rssBytes: 2_000, cumulative: finalB }));

  assert.throws(() => observe(recorder, observation({
    pass: a,
    sequence: 3,
    state: 11,
    runWideState: 31,
    elapsedMs: 41,
    logicalBytes: 100,
    rssBytes: 1_000,
    cumulative: yieldCounts({ runtimeErrors: 1, transitions: 11 }),
  })), /contiguous segment/);

  const telemetry = recorder.finalize([pass(b, 20, finalB), pass(a, 10, finalA)]);
  assert.deepStrictEqual(telemetry.passes.map((value) => value.pass), [b, a]);
  assert.strictEqual("yield" in telemetry, false);
  assert.strictEqual("transitions" in telemetry, false);
  assert.deepStrictEqual(telemetry.passes.map((value) => value.yield.critical.identities), [1, 1]);
  assert.deepStrictEqual(
    telemetry.passes.map((value) => value.logicalRetained.byteMillisecondsTimesTwo),
    ["8000", "2000"]
  );
});

test("zero and one live sample retain honest null denominators", () => {
  const noSamples = createLongRunTelemetryRecorder().finalize([
    pass("shared:no-samples", 0, yieldCounts()),
  ]).passes[0];
  assert.strictEqual(noSamples.samplesObserved, 0);
  assert.strictEqual(noSamples.firstObservationElapsedMs, null);
  assert.strictEqual(noSamples.lastObservationElapsedMs, null);
  assert.strictEqual(noSamples.searchActiveMs, 0);
  assert.strictEqual(noSamples.logicalRetained.byteMillisecondsTimesTwo, "0");
  assert.deepStrictEqual(noSamples.yield.critical, {
    identities: 0,
    identitiesPerMillionTransitions: null,
    identitiesPerSearchActiveMinute: null,
    identitiesPerRetainedGiBMinute: null,
  });

  const recorder = createLongRunTelemetryRecorder();
  const cumulative = yieldCounts({ transitions: 5 });
  observe(recorder, observation({
    pass: "shared:one-sample",
    sequence: 1,
    state: 5,
    runWideState: 5,
    elapsedMs: 12,
    logicalBytes: 100,
    rssBytes: 1_000,
    cumulative,
  }));
  const oneSample = recorder.finalize([pass("shared:one-sample", 5, cumulative)]).passes[0];
  assert.strictEqual(oneSample.samplesObserved, 1);
  assert.strictEqual(oneSample.firstObservationElapsedMs, 12);
  assert.strictEqual(oneSample.lastObservationElapsedMs, 12);
  assert.strictEqual(oneSample.searchActiveMs, 0);
  assert.strictEqual(oneSample.transitions, 0);
  assert.strictEqual(oneSample.logicalRetained.byteMillisecondsTimesTwo, "0");
  assert.strictEqual(oneSample.yield.critical.identities, 0);
  assert.strictEqual(oneSample.yield.critical.identitiesPerMillionTransitions, null);
  assert.strictEqual(oneSample.yield.critical.identitiesPerSearchActiveMinute, null);
  assert.strictEqual(oneSample.yield.critical.identitiesPerRetainedGiBMinute, null);
});

test("recorders fail closed on ordering and preserve exact realistic marathon integrals", () => {
  let now = 10;
  const phases = createLongRunTelemetryRecorder({ nowMs: () => now });
  phases.startPhase("setup");
  assert.throws(() => phases.startPhase("setup"), /already active/);
  now = 9;
  assert.throws(() => phases.endPhase("setup"), /monotonic/);
  assert.throws(() => phases.finalize([]), /phases are active/);

  const ordered = createLongRunTelemetryRecorder();
  const first = observation({ sequence: 1, state: 5, elapsedMs: 10, logicalBytes: 100, rssBytes: 1_000 });
  observe(ordered, first);
  assert.throws(() => observe(ordered, observation({
    sequence: 2,
    state: 6,
    elapsedMs: 9,
    logicalBytes: 100,
    rssBytes: 1_000,
  })), /elapsedMs must be monotonic/);
  assert.throws(() => observe(ordered, observation({
    sequence: 1,
    state: 6,
    elapsedMs: 11,
    logicalBytes: 100,
    rssBytes: 1_000,
  })), /strictly ordered/);
  assert.throws(() => observe(ordered, observation({
    sequence: 2,
    state: 6,
    elapsedMs: 11,
    logicalBytes: 100,
    rssBytes: 1_000,
    cumulative: yieldCounts({ transitions: 4 }),
  })), /cumulative transitions|strictly ordered and cumulative/);
  const recoveredYield = yieldCounts({ transitions: 6 });
  observe(ordered, observation({
    sequence: 2,
    state: 6,
    elapsedMs: 11,
    logicalBytes: 100,
    rssBytes: 1_000,
    cumulative: recoveredYield,
  }));
  const recovered = ordered.finalize([
    pass("shared:deep-novelty-v1:seed=1", 6, recoveredYield),
  ]).passes[0];
  assert.strictEqual(recovered.samplesObserved, 2);
  assert.strictEqual(recovered.searchActiveMs, 1);
  assert.strictEqual(recovered.logicalRetained.byteMillisecondsTimesTwo, "200");

  const marathon = createLongRunTelemetryRecorder();
  const fourGiB = 4 * 1024 * 1024 * 1024;
  const sixGiB = 6 * 1024 * 1024 * 1024;
  observe(marathon, observation({
    sequence: 1,
    state: 1,
    elapsedMs: 0,
    logicalBytes: fourGiB,
    rssBytes: sixGiB,
  }));
  const marathonYield = yieldCounts({ transitions: 2 });
  observe(marathon, observation({
    sequence: 2,
    state: 2,
    elapsedMs: 3_600_000,
    logicalBytes: fourGiB,
    rssBytes: sixGiB,
    cumulative: marathonYield,
  }));
  const marathonCost = marathon.finalize([
    pass("shared:deep-novelty-v1:seed=1", 2, marathonYield),
  ]).passes[0];
  assert.strictEqual(
    marathonCost.logicalRetained.byteMillisecondsTimesTwo,
    "30923764531200000"
  );
  assert.strictEqual(
    marathonCost.processRss.byteMillisecondsTimesTwo,
    "46385646796800000"
  );

  const maximum = createLongRunTelemetryRecorder();
  const max = Number.MAX_SAFE_INTEGER;
  observe(maximum, observation({
    sequence: 1,
    state: 1,
    elapsedMs: 0,
    logicalBytes: max,
    rssBytes: max,
  }));
  const maximumYield = yieldCounts({ transitions: 2 });
  observe(maximum, observation({
    sequence: 2,
    state: 2,
    elapsedMs: max,
    logicalBytes: max,
    rssBytes: max,
    cumulative: maximumYield,
  }));
  const maximumIntegral = maximum.finalize([
    pass("shared:deep-novelty-v1:seed=1", 2, maximumYield),
  ]).passes[0].logicalRetained.byteMillisecondsTimesTwo;
  assert.strictEqual(maximumIntegral, (2n * BigInt(max) * BigInt(max)).toString());
  assert.ok(maximumIntegral.length <= MAX_LONG_RUN_BYTE_MILLISECONDS_DIGITS);
  assert.throws(() => createLongRunTelemetryRecorder().observeShared(first.value, 1.5), /safe integer/);
});

test("finalization rejects missing, duplicate, downgraded, or regressed pass facts", () => {
  const build = () => {
    const recorder = createLongRunTelemetryRecorder();
    const cumulative = yieldCounts({ runtimeErrors: 1, transitions: 5 });
    observe(recorder, observation({ sequence: 1, state: 5, elapsedMs: 1, logicalBytes: 100, rssBytes: 1_000, cumulative }));
    return { recorder, cumulative };
  };
  assert.throws(() => build().recorder.finalize([]), /missing from final passes/);
  {
    const { recorder, cumulative } = build();
    assert.throws(() => recorder.finalize([
      pass("shared:deep-novelty-v1:seed=1", 5, cumulative),
      pass("shared:deep-novelty-v1:seed=1", 5, cumulative),
    ]), /duplicate final pass/);
  }
  {
    const { recorder } = build();
    assert.throws(() => recorder.finalize([{
      pass: "shared:deep-novelty-v1:seed=1",
      statesExplored: 5,
      sharedObservability: { schemaVersion: 1 },
    }]), /not schema v2/);
  }
  {
    const { recorder } = build();
    assert.throws(() => recorder.finalize([
      pass("shared:deep-novelty-v1:seed=1", 5, yieldCounts({ transitions: 4 })),
    ]), /final yield transitions|terminal live observation/);
  }
  {
    const { recorder, cumulative } = build();
    assert.throws(() => recorder.finalize([
      pass("shared:deep-novelty-v1:seed=1", 6, {
        ...cumulative,
        critical: { ...cumulative.critical, runtimeErrors: 2 },
        rawTerritory: { ...cumulative.rawTerritory, transitions: 6, uniqueStates: 6 },
      }),
    ]), /terminal live observation/);
  }
});

test("validation is exact, bounded, relational, and returns a detached value", () => {
  const telemetry = createLongRunTelemetryRecorder().finalize([]);
  const validated = validateLongRunTelemetryV1(telemetry);
  assert.deepStrictEqual(validated, telemetry);
  assert.notStrictEqual(validated, telemetry);
  assert.notStrictEqual(validated.phases, telemetry.phases);

  assert.throws(() => validateLongRunTelemetryV1({ ...telemetry, extra: true }), /invalid shape/);
  assert.throws(() => validateLongRunTelemetryV1({
    ...telemetry,
    phases: { ...telemetry.phases, setupMs: Number.MAX_SAFE_INTEGER + 1 },
  }), /safe integer/);
  assert.throws(() => validateLongRunTelemetryV1({
    ...telemetry,
    passes: Array.from({ length: MAX_LONG_RUN_TELEMETRY_PASSES + 1 }, (_, index) => ({ index })),
  }), /at most/);
  assert.deepStrictEqual(LONG_RUN_PHASES, [
    "setup",
    "compilation",
    "source_scan",
    "search_active",
    "minimum_reproduction",
    "checkpoint_write",
    "checkpoint_reopen",
    "replay_scoring",
    "report_enrichment",
    "report_write",
    "finalization",
  ]);

  const recorder = createLongRunTelemetryRecorder();
  const cumulative = yieldCounts({ runtimeErrors: 1, transitions: 10 });
  observe(recorder, observation({ sequence: 1, state: 5, elapsedMs: 0, logicalBytes: 100, rssBytes: 1_000 }));
  observe(recorder, observation({ sequence: 2, state: 10, elapsedMs: 10, logicalBytes: 100, rssBytes: 1_000, cumulative }));
  const withPass = recorder.finalize([pass("shared:deep-novelty-v1:seed=1", 10, cumulative)]);
  const badRate = structuredClone(withPass);
  badRate.passes[0].yield.critical.identitiesPerMillionTransitions = 1;
  assert.throws(() => validateLongRunTelemetryV1(badRate), /rates do not match/);
  const nonFinite = structuredClone(withPass);
  nonFinite.passes[0].yield.critical.identitiesPerMillionTransitions = Infinity;
  assert.throws(() => validateLongRunTelemetryV1(nonFinite), /finite non-negative/);
  const leadingZero = structuredClone(withPass);
  leadingZero.passes[0].logicalRetained.byteMillisecondsTimesTwo = "00";
  assert.throws(() => validateLongRunTelemetryV1(leadingZero), /canonical unsigned decimal/);
  const oversizedIntegral = structuredClone(withPass);
  oversizedIntegral.passes[0].logicalRetained.byteMillisecondsTimesTwo =
    "9".repeat(MAX_LONG_RUN_BYTE_MILLISECONDS_DIGITS + 1);
  assert.throws(() => validateLongRunTelemetryV1(oversizedIntegral), /canonical unsigned decimal/);
});

test("validation rejects proxies, accessors, overridden array methods, and sparse arrays without invoking hooks", () => {
  const telemetry = createLongRunTelemetryRecorder().finalize([]);

  let directProxyHooks = 0;
  const directProxy = new Proxy(telemetry, {
    get() {
      directProxyHooks += 1;
      throw new Error("direct proxy get trap must not run");
    },
    getOwnPropertyDescriptor() {
      directProxyHooks += 1;
      throw new Error("direct proxy descriptor trap must not run");
    },
    getPrototypeOf() {
      directProxyHooks += 1;
      throw new Error("direct proxy prototype trap must not run");
    },
    ownKeys() {
      directProxyHooks += 1;
      throw new Error("direct proxy ownKeys trap must not run");
    },
  });
  assert.throws(() => validateLongRunTelemetryV1(directProxy), /canonical plain data record/);
  assert.strictEqual(directProxyHooks, 0);

  let prototypeProxyHooks = 0;
  const prototypeProxy = new Proxy({}, {
    get() {
      prototypeProxyHooks += 1;
      throw new Error("prototype proxy get trap must not run");
    },
    getOwnPropertyDescriptor() {
      prototypeProxyHooks += 1;
      throw new Error("prototype proxy descriptor trap must not run");
    },
    ownKeys() {
      prototypeProxyHooks += 1;
      throw new Error("prototype proxy ownKeys trap must not run");
    },
  });
  const prototypeBacked = Object.create(prototypeProxy);
  Object.defineProperties(prototypeBacked, Object.getOwnPropertyDescriptors(telemetry));
  assert.throws(() => validateLongRunTelemetryV1(prototypeBacked), /canonical plain data record/);
  assert.strictEqual(prototypeProxyHooks, 0);

  let passesGetterCalls = 0;
  const passesAccessor = { ...telemetry };
  Object.defineProperty(passesAccessor, "passes", {
    configurable: true,
    enumerable: true,
    get() {
      passesGetterCalls += 1;
      return [];
    },
  });
  assert.throws(() => validateLongRunTelemetryV1(passesAccessor), /data properties/);
  assert.strictEqual(passesGetterCalls, 0);

  let passesProxyHooks = 0;
  const passesProxy = new Proxy([], {
    get() {
      passesProxyHooks += 1;
      throw new Error("passes proxy get trap must not run");
    },
    getOwnPropertyDescriptor() {
      passesProxyHooks += 1;
      throw new Error("passes proxy descriptor trap must not run");
    },
    getPrototypeOf() {
      passesProxyHooks += 1;
      throw new Error("passes proxy prototype trap must not run");
    },
    ownKeys() {
      passesProxyHooks += 1;
      throw new Error("passes proxy ownKeys trap must not run");
    },
  });
  assert.throws(
    () => validateLongRunTelemetryV1({ ...telemetry, passes: passesProxy }),
    /canonical dense data array/
  );
  assert.strictEqual(passesProxyHooks, 0);

  let arrayPrototypeProxyHooks = 0;
  const arrayPrototypeProxy = new Proxy([], {
    get() {
      arrayPrototypeProxyHooks += 1;
      throw new Error("array prototype proxy get trap must not run");
    },
    getOwnPropertyDescriptor() {
      arrayPrototypeProxyHooks += 1;
      throw new Error("array prototype proxy descriptor trap must not run");
    },
    ownKeys() {
      arrayPrototypeProxyHooks += 1;
      throw new Error("array prototype proxy ownKeys trap must not run");
    },
  });
  const prototypeBackedPasses = [];
  Object.setPrototypeOf(prototypeBackedPasses, arrayPrototypeProxy);
  assert.throws(
    () => validateLongRunTelemetryV1({ ...telemetry, passes: prototypeBackedPasses }),
    /canonical dense data array/
  );
  assert.strictEqual(arrayPrototypeProxyHooks, 0);

  let overriddenMapCalls = 0;
  const overriddenMap = [];
  overriddenMap.map = () => {
    overriddenMapCalls += 1;
    return Array.from({ length: 1_000 }, () => ({}));
  };
  assert.throws(
    () => validateLongRunTelemetryV1({ ...telemetry, passes: overriddenMap }),
    /without extra properties/
  );
  assert.strictEqual(overriddenMapCalls, 0);

  assert.throws(
    () => validateLongRunTelemetryV1({ ...telemetry, passes: new Array(1) }),
    /without extra properties|without holes/
  );

  let indexGetterCalls = 0;
  const accessorIndex = new Array(1);
  Object.defineProperty(accessorIndex, "0", {
    configurable: true,
    enumerable: true,
    get() {
      indexGetterCalls += 1;
      return {};
    },
  });
  assert.throws(
    () => validateLongRunTelemetryV1({ ...telemetry, passes: accessorIndex }),
    /without holes or accessors/
  );
  assert.strictEqual(indexGetterCalls, 0);

  assert.throws(() => createLongRunTelemetryRecorder().finalize(new Array(1)), /without extra properties|without holes/);
  let finalPassGetterCalls = 0;
  const finalPass = { statesExplored: 0, sharedObservability: undefined };
  Object.defineProperty(finalPass, "pass", {
    configurable: true,
    enumerable: true,
    get() {
      finalPassGetterCalls += 1;
      return "shared:accessor";
    },
  });
  assert.throws(() => createLongRunTelemetryRecorder().finalize([finalPass]), /data properties/);
  assert.strictEqual(finalPassGetterCalls, 0);
});

test("validation requires zero interval identities and zero integrals for zero-duration coverage", () => {
  const emptyPass = createLongRunTelemetryRecorder().finalize([
    pass("shared:no-live-interval", 0, yieldCounts()),
  ]);
  for (const category of Object.keys(emptyPass.passes[0].yield)) {
    const tampered = structuredClone(emptyPass);
    tampered.passes[0].yield[category].identities = 1;
    assert.throws(() => validateLongRunTelemetryV1(tampered), /without an observed interval/);
  }

  const oneSampleRecorder = createLongRunTelemetryRecorder();
  const oneSampleYield = yieldCounts({ runtimeErrors: 1, transitions: 1 });
  observe(oneSampleRecorder, observation({
    pass: "shared:one-live-sample",
    sequence: 1,
    state: 1,
    elapsedMs: 10,
    logicalBytes: 100,
    rssBytes: 1_000,
    cumulative: oneSampleYield,
  }));
  const oneSample = oneSampleRecorder.finalize([
    pass("shared:one-live-sample", 1, oneSampleYield),
  ]);
  const tamperedOneSample = structuredClone(oneSample);
  tamperedOneSample.passes[0].yield.critical.identities = 1;
  assert.throws(() => validateLongRunTelemetryV1(tamperedOneSample), /without an observed interval/);

  const zeroDurationRecorder = createLongRunTelemetryRecorder();
  observe(zeroDurationRecorder, observation({
    pass: "shared:zero-duration",
    sequence: 1,
    state: 1,
    elapsedMs: 20,
    logicalBytes: 100,
    rssBytes: 1_000,
  }));
  const finalYield = yieldCounts({ transitions: 2 });
  observe(zeroDurationRecorder, observation({
    pass: "shared:zero-duration",
    sequence: 2,
    state: 2,
    elapsedMs: 20,
    logicalBytes: 300,
    rssBytes: 2_000,
    cumulative: finalYield,
  }));
  const zeroDuration = zeroDurationRecorder.finalize([
    pass("shared:zero-duration", 2, finalYield),
  ]);
  assert.strictEqual(zeroDuration.passes[0].samplesObserved, 2);
  assert.strictEqual(zeroDuration.passes[0].searchActiveMs, 0);
  assert.strictEqual(zeroDuration.passes[0].logicalRetained.byteMillisecondsTimesTwo, "0");
  assert.strictEqual(zeroDuration.passes[0].processRss.byteMillisecondsTimesTwo, "0");
  assert.deepStrictEqual(validateLongRunTelemetryV1(zeroDuration), zeroDuration);

  const tamperedLogical = structuredClone(zeroDuration);
  tamperedLogical.passes[0].logicalRetained.byteMillisecondsTimesTwo = "1";
  for (const category of Object.values(tamperedLogical.passes[0].yield)) {
    category.identitiesPerRetainedGiBMinute = 0;
  }
  assert.throws(() => validateLongRunTelemetryV1(tamperedLogical), /zero-duration costs must have zero integrals/);

  const tamperedRss = structuredClone(zeroDuration);
  tamperedRss.passes[0].processRss.byteMillisecondsTimesTwo = "1";
  assert.throws(() => validateLongRunTelemetryV1(tamperedRss), /zero-duration costs must have zero integrals/);
});

test("the recorder projects only bounded aggregate facts from richer live objects", () => {
  const marker = "PRIVATE_STORY_CHOICE_AND_VARIABLE_PAYLOAD";
  const recorder = createLongRunTelemetryRecorder();
  const first = observation({
    sequence: 1,
    state: 1,
    elapsedMs: 0,
    logicalBytes: 100,
    rssBytes: 1_000,
  });
  first.value.privateStory = marker;
  first.value.sample.privateChoice = marker;
  first.value.sample.yield.cumulative.privateVariable = marker;
  first.value.process.privateMessage = marker;
  observe(recorder, first);
  const finalYield = yieldCounts({ runtimeErrors: 1, transitions: 2 });
  const last = observation({
    sequence: 2,
    state: 2,
    elapsedMs: 10,
    logicalBytes: 100,
    rssBytes: 1_000,
    cumulative: finalYield,
  });
  last.value.sample.retention.privateWitness = marker;
  observe(recorder, last);
  const finalPass = pass("shared:deep-novelty-v1:seed=1", 2, finalYield);
  finalPass.sharedObservability.privateReport = marker;
  const telemetry = recorder.finalize([finalPass]);
  assert.doesNotMatch(JSON.stringify(telemetry), new RegExp(marker));
  assert.deepStrictEqual(Object.keys(telemetry), ["schemaVersion", "phases", "passes"]);
  assert.deepStrictEqual(Object.keys(telemetry.passes[0]), [
    "schemaVersion",
    "pass",
    "samplesObserved",
    "firstObservationElapsedMs",
    "lastObservationElapsedMs",
    "searchActiveMs",
    "transitions",
    "logicalRetained",
    "processRss",
    "yield",
  ]);
  const injected = structuredClone(telemetry);
  injected.passes[0].privatePayload = marker;
  assert.throws(() => validateLongRunTelemetryV1(injected), /invalid shape/);
});
