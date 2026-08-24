import {
  SHARED_OBSERVABILITY_REASON_ORDER_V2,
  sharedObservabilityLedgerLogicalUtf8BytesUpperBoundV1,
} from "./explore";

export type MachineDetail = "summary" | "standard" | "full";

export const DEFAULT_MACHINE_DETAIL: MachineDetail = "standard";
export const DEFAULT_MACHINE_FINDING_LIMIT = 20;
export const MAX_MACHINE_FINDING_LIMIT = 100;
export const MAX_STANDARD_MACHINE_RESPONSE_BYTES = 32 * 1024;

interface FindingSummary {
  id: string;
  kind: string;
  section: string;
  hasWitness: boolean;
  hasReplay: boolean;
  sourceLocation?: { file: string; line: number | null; approximate?: boolean; pathTruncated?: boolean };
  message?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedText(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function sourceLocation(finding: Record<string, unknown>): FindingSummary["sourceLocation"] {
  const witness = record(finding.witness);
  const raw = record(finding.sourceLocation)
    ?? record(witness?.triggeringSourceLocation)
    ?? (typeof finding.file === "string" ? { file: finding.file, line: finding.line ?? null } : undefined);
  if (!raw || typeof raw.file !== "string" || (raw.line !== null && !Number.isSafeInteger(raw.line))) return undefined;
  const pathTruncated = raw.file.length > 256;
  return {
    file: pathTruncated ? `...${raw.file.slice(-253)}` : raw.file,
    line: raw.line as number | null,
    ...(typeof raw.approximate === "boolean" ? { approximate: raw.approximate } : {}),
    ...(pathTruncated ? { pathTruncated: true } : {}),
  };
}

function findingSummary(value: unknown, section: string): FindingSummary | undefined {
  const finding = record(value);
  if (!finding || typeof finding.id !== "string" || typeof finding.kind !== "string") return undefined;
  const location = sourceLocation(finding);
  return {
    id: finding.id.slice(0, 256),
    kind: finding.kind.slice(0, 128),
    section,
    hasWitness: record(finding.witness) !== undefined,
    hasReplay: record(finding.replay) !== undefined,
    ...(location ? { sourceLocation: location } : {}),
    ...(finding.kind.startsWith("compile.") && boundedText(finding.message)
      ? { message: boundedText(finding.message) }
      : {}),
  };
}

export function machineFindingSummaries(report: Record<string, unknown>): FindingSummary[] {
  const findings: FindingSummary[] = [];
  const push = (value: unknown, section: string) => {
    const summary = findingSummary(value, section);
    if (summary) findings.push(summary);
  };
  const compile = record(report.compile);
  array(compile?.issues).forEach((finding, index) => push(finding, `compile.issues[${index}]`));
  const explore = record(report.explore);
  array(explore?.runtimeErrors).forEach((finding, index) => push(finding, `explore.runtimeErrors[${index}]`));
  array(explore?.assertionResults).forEach((result, resultIndex) => {
    array(record(result)?.violations).forEach((finding, index) => push(
      finding,
      `explore.assertionResults[${resultIndex}].violations[${index}]`
    ));
  });
  array(explore?.goalResults).forEach((result, resultIndex) => {
    const goal = record(result);
    push(goal?.witness, `explore.goalResults[${resultIndex}].witness`);
    array(goal?.stages).forEach((stage, stageIndex) => push(
      record(stage)?.witness,
      `explore.goalResults[${resultIndex}].stages[${stageIndex}].witness`
    ));
  });
  array(explore?.endingsFound).forEach((finding, index) => push(finding, `explore.endingsFound[${index}]`));
  return findings;
}

function compileSummary(compile: Record<string, unknown> | undefined) {
  const issues = array(compile?.issues).map(record).filter(Boolean) as Record<string, unknown>[];
  const count = (severity: string) => issues.filter((issue) => issue.severity === severity).length;
  return {
    success: compile?.success === true,
    issueCount: issues.length,
    errors: count("ERROR"),
    warnings: count("WARNING"),
    todos: count("TODO"),
  };
}

function configurationSummary(configuration: Record<string, unknown> | undefined) {
  const limits = record(configuration?.limits);
  return {
    search: configuration?.search,
    concurrency: configuration?.concurrency,
    concurrencyMode: configuration?.concurrencyMode,
    ...(configuration?.concurrencyFallbackReason === undefined
      ? {}
      : { concurrencyFallbackReason: configuration.concurrencyFallbackReason }),
    minRepro: configuration?.minRepro,
    storySeed: configuration?.storySeed,
    ...(limits ? { limits } : {}),
    assertionCount: array(configuration?.assertions).length,
    goalCount: array(configuration?.goals).length,
  };
}

function executionSummary(value: unknown) {
  const execution = record(value);
  if (!execution) return undefined;
  const resources = record(execution.resources);
  const activation = record(execution.activation);
  return {
    mode: execution.mode,
    requestedConcurrency: execution.requestedConcurrency,
    effectiveConcurrency: execution.effectiveConcurrency,
    ...(execution.fallbackReason === undefined ? {} : { fallbackReason: execution.fallbackReason }),
    ...(activation ? {
      activation: {
        policyVersion: activation.policyVersion,
        decision: activation.decision,
        reason: activation.reason,
        pilotBudget: activation.pilotBudget,
        pilotStatesExplored: activation.pilotStatesExplored,
        pilotExhaustive: activation.pilotExhaustive,
        pilotPass: activation.pilotPass,
        duplicateStateEvaluations: activation.duplicateStateEvaluations,
        uncertainty: activation.uncertainty,
        productionEligible: activation.productionEligible,
      },
    } : {}),
    ...(resources ? {
      resources: {
        stateBudget: resources.stateBudget,
        heapEnvelopeBytes: resources.heapEnvelopeBytes,
        parentReserveBytes: resources.parentReserveBytes,
        perWorkerHeapLimitBytes: resources.perWorkerHeapLimitBytes,
        totalWorkerHeapLimitBytes: resources.totalWorkerHeapLimitBytes,
        peakTrackedHeapBytes: resources.peakTrackedHeapBytes,
        aggregateMemoryStopped: resources.aggregateMemoryStopped,
        ...(resources.deadlineMs === undefined ? {} : { deadlineMs: resources.deadlineMs }),
      },
    } : {}),
    workers: array(execution.workers).map((value) => {
      const worker = record(value);
      return {
        pass: worker?.pass,
        granted: worker?.granted,
        consumed: worker?.consumed,
        status: worker?.status,
      };
    }),
  };
}

const MAX_COMPACT_SHARED_OBSERVABILITY_PASSES = 8;
const MAX_SHARED_OBSERVABILITY_SAMPLES = 128;
const MAX_SHARED_OBSERVABILITY_TRIGGER_MASK_V2 =
  (1 << SHARED_OBSERVABILITY_REASON_ORDER_V2.length) - 1;
const SHARED_RETAINED_MEMORY_FIELDS = [
  "pendingStateBytes", "pendingVariableBytes", "activeStateBytes", "activeVariableBytes",
  "ancestryBytes", "dedupeBytes", "semanticIndexBytes", "frontierReferenceBytes",
  "findingBytes", "totalAccountedBytes", "pendingStates", "retainedNodes", "frontierReferences",
] as const;
const SHARED_RETAINED_MEMORY_BYTE_FIELDS = [
  "pendingStateBytes", "pendingVariableBytes", "activeStateBytes", "activeVariableBytes",
  "ancestryBytes", "dedupeBytes", "semanticIndexBytes", "frontierReferenceBytes",
  "findingBytes",
] as const;

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sharedPass(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const match = /^shared:(?:deep-novelty|variable-aware|goal-directed)-v1:seed=(\d{1,10})$/.exec(value);
  if (!match) return undefined;
  const seed = Number(match[1]);
  return Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff ? value : undefined;
}

function sharedRetainedMemory(value: unknown): Record<string, number> | undefined {
  const memory = record(value);
  if (!memory) return undefined;
  const projected: Record<string, number> = {};
  for (const field of SHARED_RETAINED_MEMORY_FIELDS) {
    const count = memory[field];
    if (!nonNegativeSafeInteger(count)) return undefined;
    projected[field] = count;
  }
  return projected;
}

function sharedRetainedCurrentTotalIsExact(memory: Record<string, number>): boolean {
  let total = 0;
  for (const field of SHARED_RETAINED_MEMORY_BYTE_FIELDS) {
    if (memory[field] > Number.MAX_SAFE_INTEGER - total) return false;
    total += memory[field];
  }
  return memory.totalAccountedBytes === total;
}

function sharedRetainedByteComponentsAtMostTotal(memory: Record<string, number>): boolean {
  return SHARED_RETAINED_MEMORY_BYTE_FIELDS.every(
    (field) => memory[field] <= memory.totalAccountedBytes
  );
}

function sharedRetainedTotalAtMostByteComponentSum(memory: Record<string, number>): boolean {
  let total = 0;
  for (const field of SHARED_RETAINED_MEMORY_BYTE_FIELDS) {
    if (memory[field] > Number.MAX_SAFE_INTEGER - total) return false;
    total += memory[field];
  }
  return memory.totalAccountedBytes <= total;
}

function sharedRetainedMemoryAtMost(
  current: Record<string, number>,
  peak: Record<string, number>
): boolean {
  return SHARED_RETAINED_MEMORY_FIELDS.every((field) => current[field] <= peak[field]);
}

function sharedYieldCounts(value: unknown): Record<string, unknown> | undefined {
  const counts = record(value);
  const critical = record(counts?.critical);
  const intent = record(counts?.intent);
  const authoredCoverage = record(counts?.authoredCoverage);
  const rawTerritory = record(counts?.rawTerritory);
  if (!counts || !critical || !intent || !authoredCoverage || !rawTerritory) return undefined;
  const numeric = [
    critical.runtimeErrors, critical.assertionViolations,
    intent.goalsReached, intent.stagesReached,
    authoredCoverage.knotsVisited, counts.visibleOutcomes, counts.semanticTransitions,
    counts.terminalVariants, rawTerritory.transitions, rawTerritory.uniqueStates,
    rawTerritory.dedupeHits,
  ];
  if (!numeric.every(nonNegativeSafeInteger)) return undefined;
  return {
    critical: {
      runtimeErrors: critical.runtimeErrors,
      assertionViolations: critical.assertionViolations,
    },
    intent: {
      goalsReached: intent.goalsReached,
      stagesReached: intent.stagesReached,
    },
    authoredCoverage: { knotsVisited: authoredCoverage.knotsVisited },
    visibleOutcomes: counts.visibleOutcomes,
    semanticTransitions: counts.semanticTransitions,
    terminalVariants: counts.terminalVariants,
    rawTerritory: {
      transitions: rawTerritory.transitions,
      uniqueStates: rawTerritory.uniqueStates,
      dedupeHits: rawTerritory.dedupeHits,
    },
  };
}

function sharedObservabilityYieldVector(value: Record<string, unknown>): number[] | undefined {
  const critical = record(value.critical);
  const intent = record(value.intent);
  const authoredCoverage = record(value.authoredCoverage);
  const counts = [
    critical?.runtimeErrors,
    critical?.assertionViolations,
    intent?.goalsReached,
    intent?.stagesReached,
    authoredCoverage?.knotsVisited,
    value.visibleOutcomes,
    value.semanticTransitions,
    value.terminalVariants,
  ];
  return counts.every(nonNegativeSafeInteger) ? counts as number[] : undefined;
}

function sharedObservabilityTriggerYield(
  value: unknown,
  intervalDelta?: Record<string, unknown>
): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 8) return undefined;
  const projected: number[] = [];
  for (const count of value) {
    if (!nonNegativeSafeInteger(count)) return undefined;
    projected.push(count);
  }
  if (intervalDelta) {
    const intervalVector = sharedObservabilityYieldVector(intervalDelta);
    if (!intervalVector || projected.some((count, index) => count > intervalVector[index])) {
      return undefined;
    }
  }
  return projected;
}

function sharedResourceSample(value: unknown): Record<string, unknown> | undefined {
  const sample = record(value);
  const retention = record(sample?.retention);
  const interval = record(sample?.yield);
  const current = sharedRetainedMemory(retention?.current);
  const peak = sharedRetainedMemory(retention?.peak);
  const delta = sharedYieldCounts(interval?.delta);
  const cumulative = sharedYieldCounts(interval?.cumulative);
  const v1 = sample?.schemaVersion === 1;
  const v2 = sample?.schemaVersion === 2;
  const reasons = v2 ? array(sample?.reasons) : [];
  const reasonRanks = reasons.length <= SHARED_OBSERVABILITY_REASON_ORDER_V2.length
    ? reasons.map((reason) =>
        SHARED_OBSERVABILITY_REASON_ORDER_V2.indexOf(
          reason as typeof SHARED_OBSERVABILITY_REASON_ORDER_V2[number]
        ))
    : [];
  const expectedTriggerMask = reasonRanks.reduce(
    (mask, rank) => rank < 0 ? mask : mask | (1 << rank),
    0
  );
  const triggerYield = v2
    ? sharedObservabilityTriggerYield(sample?.triggerYield, delta)
    : undefined;
  const yieldReasonPositions = new Set(
    reasonRanks.filter((rank) => rank >= 1 && rank <= 8).map((rank) => rank - 1)
  );
  const triggerYieldMatchesReasons = triggerYield?.every(
    (count, index) => (count > 0) === yieldReasonPositions.has(index)
  ) === true;
  if (!sample || (!v1 && !v2)
    || (v1 && (typeof sample.boundary !== "string"
      || !["interval", "termination", "interval_and_termination"].includes(sample.boundary as string)))
    || (v2 && (!nonNegativeSafeInteger(sample.sequence) || sample.sequence < 1
      || reasons.length < 1 || reasons.length > SHARED_OBSERVABILITY_REASON_ORDER_V2.length
      || reasonRanks.some((rank, index) => rank < 0 || (index > 0 && rank <= reasonRanks[index - 1]))
      || !nonNegativeSafeInteger(sample.triggerMask) || sample.triggerMask < 1
      || sample.triggerMask > MAX_SHARED_OBSERVABILITY_TRIGGER_MASK_V2
      || sample.triggerMask !== expectedTriggerMask
      || !triggerYield || !triggerYieldMatchesReasons))
    || !nonNegativeSafeInteger(sample.state)
    || !retention || retention.schemaVersion !== 1 || !current || !peak
    || !sharedRetainedCurrentTotalIsExact(current)
    || !sharedRetainedByteComponentsAtMostTotal(peak)
    || !sharedRetainedTotalAtMostByteComponentSum(peak)
    || !sharedRetainedMemoryAtMost(current, peak)
    || !nonNegativeSafeInteger(retention.releasedNodes)
    || !nonNegativeSafeInteger(retention.frontierCompactions)
    || !interval || interval.schemaVersion !== 1
    || !nonNegativeSafeInteger(interval.fromStateExclusive)
    || !nonNegativeSafeInteger(interval.throughState)
    || interval.fromStateExclusive > interval.throughState
    || interval.throughState !== sample.state
    || !delta || !cumulative) {
    return undefined;
  }
  return {
    schemaVersion: sample.schemaVersion,
    ...(v1
      ? { boundary: sample.boundary }
      : {
          sequence: sample.sequence,
          reasons,
          triggerMask: sample.triggerMask,
          triggerYield,
        }),
    state: sample.state,
    retention: {
      schemaVersion: 1,
      current,
      peak,
      releasedNodes: retention.releasedNodes,
      frontierCompactions: retention.frontierCompactions,
    },
    yield: {
      schemaVersion: 1,
      fromStateExclusive: interval.fromStateExclusive,
      throughState: interval.throughState,
      delta,
      cumulative,
    },
  };
}

function sharedYieldTimingCategory(value: unknown): Record<string, unknown> | undefined {
  const category = record(value);
  if (!category || !nonNegativeSafeInteger(category.identities)) return undefined;
  for (const field of ["firstAtState", "lastAtState", "longestDryStates", "currentDryStates"]) {
    const item = category[field];
    if (item !== null && !nonNegativeSafeInteger(item)) return undefined;
  }
  const rate = category.identitiesPerMillionTransitions;
  if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)) return undefined;
  return {
    identities: category.identities,
    firstAtState: category.firstAtState,
    lastAtState: category.lastAtState,
    longestDryStates: category.longestDryStates,
    currentDryStates: category.currentDryStates,
    identitiesPerMillionTransitions: rate,
  };
}

function sharedYieldTiming(value: unknown): Record<string, unknown> | undefined {
  const timing = record(value);
  if (!timing || timing.schemaVersion !== 2) return undefined;
  const projected: Record<string, unknown> = { schemaVersion: 2 };
  for (const field of [
    "critical", "intent", "authoredCoverage", "visibleOutcomes", "semanticTransitions", "terminalVariants",
  ]) {
    const category = sharedYieldTimingCategory(timing[field]);
    if (!category) return undefined;
    projected[field] = category;
  }
  return projected;
}

function sharedYieldSummary(value: unknown): Record<string, unknown> | undefined {
  const summary = record(value);
  const throughFirstUseful = sharedYieldCounts(summary?.throughFirstUseful);
  const afterFirstUseful = sharedYieldCounts(summary?.afterFirstUseful);
  const cumulative = sharedYieldCounts(summary?.cumulative);
  const firstUsefulAtState = summary?.firstUsefulAtState;
  const firstCriticalAtState = summary?.firstCriticalAtState;
  if (!summary || summary.schemaVersion !== 1
    || (firstUsefulAtState !== null && !nonNegativeSafeInteger(firstUsefulAtState))
    || (firstCriticalAtState !== null && !nonNegativeSafeInteger(firstCriticalAtState))
    || !throughFirstUseful || !afterFirstUseful || !cumulative) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    firstUsefulAtState,
    firstCriticalAtState,
    throughFirstUseful,
    afterFirstUseful,
    cumulative,
  };
}

function sharedObservabilitySummary(value: unknown) {
  const summaries: Record<string, unknown>[] = [];
  for (const passValue of array(value)) {
    if (summaries.length >= MAX_COMPACT_SHARED_OBSERVABILITY_PASSES) break;
    const pass = record(passValue);
    const telemetry = record(pass?.sharedObservability);
    const projectedPass = sharedPass(pass?.pass);
    const v1 = telemetry?.schemaVersion === 1;
    const v2 = telemetry?.schemaVersion === 2;
    if (!pass || !telemetry || !projectedPass || (!v1 && !v2)
      || !nonNegativeSafeInteger(telemetry.sampleIntervalStates)
      || telemetry.sampleIntervalStates < 1 || telemetry.sampleIntervalStates > 10_000_000
      || !nonNegativeSafeInteger(telemetry.samplesRecorded)
      || !nonNegativeSafeInteger(telemetry.samplesRetained)
      || telemetry.samplesRetained > MAX_SHARED_OBSERVABILITY_SAMPLES
      || !nonNegativeSafeInteger(telemetry.samplesCompacted)
      || telemetry.samplesRecorded - telemetry.samplesRetained !== telemetry.samplesCompacted
      || typeof telemetry.historyComplete !== "boolean"
      || (v2 && (!nonNegativeSafeInteger(telemetry.cadenceSamplesRecorded)
        || telemetry.cadenceSamplesRecorded > telemetry.samplesRecorded
        || typeof telemetry.eventHistoryComplete !== "boolean"))) continue;
    const samples = array(telemetry.samples);
    if (samples.length !== telemetry.samplesRetained) continue;
    const latest = samples.length ? sharedResourceSample(samples.at(-1)) : undefined;
    const yieldSummary = sharedYieldSummary(telemetry.yieldSummary);
    const timing = v2 ? sharedYieldTiming(telemetry.timing) : undefined;
    if ((samples.length && !latest) || !yieldSummary || (v2 && !timing)) continue;
    summaries.push({
      pass: projectedPass,
      schemaVersion: telemetry.schemaVersion,
      sampleIntervalStates: telemetry.sampleIntervalStates,
      samplesRecorded: telemetry.samplesRecorded,
      ...(v2 ? { cadenceSamplesRecorded: telemetry.cadenceSamplesRecorded } : {}),
      samplesRetained: telemetry.samplesRetained,
      samplesCompacted: telemetry.samplesCompacted,
      historyComplete: telemetry.historyComplete,
      ...(v2 ? { eventHistoryComplete: telemetry.eventHistoryComplete } : {}),
      ...(latest ? { latestSample: latest } : {}),
      yieldSummary,
      ...(timing ? { timing } : {}),
    });
  }
  return summaries.length ? summaries : undefined;
}

function sharedOwnerAccountingSummary(value: unknown) {
  const summaries: Record<string, unknown>[] = [];
  for (const passValue of array(value)) {
    if (summaries.length >= MAX_COMPACT_SHARED_OBSERVABILITY_PASSES) break;
    const pass = record(passValue);
    const projectedPass = sharedPass(pass?.pass);
    const accounting = record(pass?.sharedOwnerAccounting);
    const current = record(accounting?.current);
    const peak = record(accounting?.peak);
    const currentLedger = record(current?.observabilityLedger);
    const peakLedger = record(peak?.observabilityLedger);
    const sharedMemory = record(pass?.sharedMemory);
    const retainedCurrent = sharedRetainedMemory(sharedMemory?.current);
    const retainedPeak = sharedRetainedMemory(sharedMemory?.peak);
    const observability = record(pass?.sharedObservability);
    const maximumCurrentLedgerBytes = nonNegativeSafeInteger(currentLedger?.count)
      ? sharedObservabilityLedgerLogicalUtf8BytesUpperBoundV1(currentLedger.count as number)
      : undefined;
    const maximumPeakLedgerBytes = nonNegativeSafeInteger(peakLedger?.count)
      ? sharedObservabilityLedgerLogicalUtf8BytesUpperBoundV1(peakLedger.count as number)
      : undefined;
    if (!pass || !projectedPass || !accounting || accounting.schemaVersion !== 1
      || accounting.basis !== "deterministic_logical_utf8"
      || typeof accounting.historyComplete !== "boolean"
      || !current || !peak || !currentLedger || !peakLedger
      || !retainedCurrent || !retainedPeak || !observability
      || observability.schemaVersion !== 2
      || !nonNegativeSafeInteger(currentLedger.count)
      || !nonNegativeSafeInteger(currentLedger.logicalUtf8Bytes)
      || !nonNegativeSafeInteger(current.totalAccountedBytes)
      || !nonNegativeSafeInteger(peakLedger.count)
      || !nonNegativeSafeInteger(peakLedger.logicalUtf8Bytes)
      || !nonNegativeSafeInteger(peak.totalAccountedBytes)
      || maximumCurrentLedgerBytes === undefined
      || currentLedger.logicalUtf8Bytes > maximumCurrentLedgerBytes
      || maximumPeakLedgerBytes === undefined
      || peakLedger.logicalUtf8Bytes > maximumPeakLedgerBytes
      || !nonNegativeSafeInteger(observability.samplesRecorded)
      || !nonNegativeSafeInteger(observability.samplesRetained)
      || array(observability.samples).length !== observability.samplesRetained
      || currentLedger.count !== observability.samplesRetained
      || currentLedger.count > MAX_SHARED_OBSERVABILITY_SAMPLES
      || peakLedger.count < currentLedger.count
      || peakLedger.count > Math.min(
        observability.samplesRecorded as number,
        MAX_SHARED_OBSERVABILITY_SAMPLES
      )
      || peakLedger.logicalUtf8Bytes < currentLedger.logicalUtf8Bytes
      || !sharedRetainedCurrentTotalIsExact(retainedCurrent)
      || !sharedRetainedByteComponentsAtMostTotal(retainedPeak)
      || !sharedRetainedTotalAtMostByteComponentSum(retainedPeak)
      || !sharedRetainedMemoryAtMost(retainedCurrent, retainedPeak)
      || currentLedger.logicalUtf8Bytes
        > Number.MAX_SAFE_INTEGER - retainedCurrent.totalAccountedBytes
      || current.totalAccountedBytes
        !== retainedCurrent.totalAccountedBytes + currentLedger.logicalUtf8Bytes
      || peak.totalAccountedBytes < current.totalAccountedBytes
      || peak.totalAccountedBytes < peakLedger.logicalUtf8Bytes
      || peakLedger.logicalUtf8Bytes
        > Number.MAX_SAFE_INTEGER - retainedPeak.totalAccountedBytes
      || peak.totalAccountedBytes
        > retainedPeak.totalAccountedBytes + peakLedger.logicalUtf8Bytes
      || (accounting.historyComplete
        && (observability.historyComplete !== true
          || peak.totalAccountedBytes < retainedPeak.totalAccountedBytes))) continue;
    summaries.push({
      pass: projectedPass,
      schemaVersion: 1,
      basis: "deterministic_logical_utf8",
      historyComplete: accounting.historyComplete,
      current: {
        observabilityLedger: {
          count: currentLedger.count,
          logicalUtf8Bytes: currentLedger.logicalUtf8Bytes,
        },
        totalAccountedBytes: current.totalAccountedBytes,
      },
      peak: {
        observabilityLedger: {
          count: peakLedger.count,
          logicalUtf8Bytes: peakLedger.logicalUtf8Bytes,
        },
        totalAccountedBytes: peak.totalAccountedBytes,
      },
    });
  }
  return summaries.length ? summaries : undefined;
}

function explorationSummary(explore: Record<string, unknown> | undefined) {
  if (!explore) return undefined;
  const assertionResults = array(explore.assertionResults).map(record).filter(Boolean) as Record<string, unknown>[];
  const assertionViolationCount = assertionResults.reduce(
    (total, result) => total + array(result.violations).length,
    0
  );
  const sharedObservability = sharedObservabilitySummary(explore.passes);
  const sharedOwnerAccounting = sharedOwnerAccountingSummary(explore.passes);
  return {
    statesExplored: explore.statesExplored,
    runtimeErrorCount: array(explore.runtimeErrors).length,
    loopRiskCount: array(explore.loopRisks).length,
    assertionViolationCount,
    endingCount: array(explore.endingsFound).length,
    goalCount: array(explore.goalResults).length,
    visitedKnotCount: array(explore.visitedKnots).length,
    unvisitedKnotCount: array(explore.unvisitedKnots).length,
    runtimeWarningCount: array(explore.runtimeWarnings).length,
    externalStubCount: array(explore.externalFunctionsStubbed).length,
    randomnessDetected: explore.randomnessDetected === true,
    truncated: explore.truncated === true,
    truncatedBy: explore.truncatedBy,
    exhaustive: explore.exhaustive === true,
    limits: explore.limits,
    ...(explore.execution ? { execution: executionSummary(explore.execution) } : {}),
    ...(sharedObservability ? { sharedObservability } : {}),
    ...(sharedOwnerAccounting ? { sharedOwnerAccounting } : {}),
  };
}

function nextRunSummary(nextRun: Record<string, unknown> | undefined) {
  if (!nextRun) return undefined;
  return {
    recommendation: nextRun.recommendation,
    stop: nextRun.stop,
    flags: nextRun.flags,
    rationale: boundedText(nextRun.rationale),
    expectedGain: boundedText(nextRun.expectedGain),
  };
}

export function projectMachineReport(
  report: Record<string, unknown>,
  detail: MachineDetail = DEFAULT_MACHINE_DETAIL,
  findingLimit = DEFAULT_MACHINE_FINDING_LIMIT
): Record<string, unknown> {
  if (!Number.isSafeInteger(findingLimit) || findingLimit < 1 || findingLimit > MAX_MACHINE_FINDING_LIMIT) {
    throw new RangeError(`findingLimit must be an integer from 1 to ${MAX_MACHINE_FINDING_LIMIT}`);
  }
  if (detail === "full") {
    return {
      ...report,
      response: {
        detail,
        dataTruncated: false,
        explorationTruncated: record(report.explore)?.truncated === true,
        contentPolicy: "Full report explicitly requested; authored text, choices, variables, and witnesses may be present.",
      },
    };
  }

  const allFindings = machineFindingSummaries(report);
  const returnedFindings = detail === "standard" ? allFindings.slice(0, findingLimit) : [];
  const omittedFindingCount = allFindings.length - returnedFindings.length;
  const compile = record(report.compile);
  const explore = record(report.explore);
  const nextRun = nextRunSummary(record(report.nextRun));
  const projected: Record<string, unknown> = {
    schemaVersion: report.schemaVersion,
    inkcheckVersion: report.inkcheckVersion,
    storyFingerprint: report.storyFingerprint,
    effectiveConfiguration: configurationSummary(record(report.effectiveConfiguration)),
    bindingLimit: report.bindingLimit ?? null,
    compile: compileSummary(compile),
    ...(explore ? { explore: explorationSummary(explore) } : {}),
    ...(nextRun ? { nextRun } : {}),
    nextAction: compile?.success === false
      ? { operation: "inspect_source", reason: "Compilation failed; inspect one compile finding before exploration." }
      : nextRun
        ? { operation: nextRun.stop === true ? "inspect_findings" : "start_search", reason: nextRun.rationale }
        : { operation: "compile_story", reason: "Compile before exploration." },
    ...(detail === "standard" ? { findings: returnedFindings } : {}),
    response: {
      detail,
      dataTruncated: omittedFindingCount > 0,
      explorationTruncated: explore?.truncated === true,
      findings: {
        returned: returnedFindings.length,
        total: allFindings.length,
        omitted: omittedFindingCount,
        pageLimit: detail === "standard" ? findingLimit : 0,
      },
      drillDown: {
        fullReport: { tool: "explore_story", detail: "full" },
        pagedFindings: { tool: "start_search", note: "Use durable result windows for stable cursors and fetch-by-ID." },
      },
      contentPolicy: detail === "summary"
        ? "Counts, limits, and next action only; authored text, choices, variables, and witnesses are omitted."
        : "Privacy-minimal finding identities, source locations, and bounded compile diagnostics only; authored story text, choices, variables, and witnesses are omitted.",
    },
  };
  const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
  if (bytes > MAX_STANDARD_MACHINE_RESPONSE_BYTES) {
    throw new Error(`bounded machine response exceeded ${MAX_STANDARD_MACHINE_RESPONSE_BYTES} bytes`);
  }
  return projected;
}
