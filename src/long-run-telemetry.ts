import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import type {
  PassTelemetry,
  SharedResourceObservationV2,
  SharedYieldCountsV1,
} from "./explore";

export const LONG_RUN_TELEMETRY_SCHEMA_VERSION = 1;
export const MAX_LONG_RUN_TELEMETRY_PASSES = 32;
/** Enough for the maximum integral of safe-integer bytes over safe-integer milliseconds. */
export const MAX_LONG_RUN_BYTE_MILLISECONDS_DIGITS = 33;

export const LONG_RUN_PHASES = [
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
] as const;

export type LongRunPhaseV1 = typeof LONG_RUN_PHASES[number];

export interface RunPhaseDurationsV1 {
  /** Inclusive run setup. Component phases may overlap an inclusive parent phase. */
  setupMs: number;
  compilationMs: number;
  sourceScanMs: number;
  searchActiveMs: number;
  minimumReproductionMs: number;
  checkpointWriteMs: number;
  checkpointReopenMs: number;
  replayScoringMs: number;
  reportEnrichmentMs: number;
  reportWriteMs: number;
  /** Inclusive post-search work; component finalization phases remain separately visible. */
  finalizationMs: number;
}

export interface ByteTimeIntegralV1 {
  basis: "deterministic_logical_accounted_bytes" | "observed_process_rss_bytes";
  /** Twice the exact integral as a canonical bounded unsigned decimal. */
  byteMillisecondsTimesTwo: string;
  divisor: 2;
}

export interface LongRunYieldRateV1 {
  /** Identities added strictly after the first live sample through the last. */
  identities: number;
  identitiesPerMillionTransitions: number | null;
  identitiesPerSearchActiveMinute: number | null;
  identitiesPerRetainedGiBMinute: number | null;
}

export interface LongRunYieldRatesV1 {
  critical: LongRunYieldRateV1;
  intent: LongRunYieldRateV1;
  authoredCoverage: LongRunYieldRateV1;
  visibleOutcomes: LongRunYieldRateV1;
  semanticTransitions: LongRunYieldRateV1;
  terminalVariants: LongRunYieldRateV1;
}

export interface LongRunPassCostV1 {
  schemaVersion: 1;
  pass: string;
  samplesObserved: number;
  firstObservationElapsedMs: number | null;
  lastObservationElapsedMs: number | null;
  /** Time covered by adjacent live samples from this pass, excluding unobserved edges. */
  searchActiveMs: number;
  /** Transitions strictly after the first live sample through the last. */
  transitions: number;
  logicalRetained: ByteTimeIntegralV1;
  processRss: ByteTimeIntegralV1;
  yield: LongRunYieldRatesV1;
}

export interface LongRunTelemetryV1 {
  schemaVersion: 1;
  phases: RunPhaseDurationsV1;
  /** Costs and yields remain pass-local because identities can overlap across passes. */
  passes: LongRunPassCostV1[];
}

export type LongRunTelemetryPassInputV1 = Pick<
  PassTelemetry,
  "pass" | "statesExplored" | "sharedObservability"
>;

export interface LongRunTelemetryRecorder {
  observeShared(observation: SharedResourceObservationV2, elapsedMs: number): void;
  startPhase(phase: LongRunPhaseV1): void;
  endPhase(phase: LongRunPhaseV1): number;
  finalize(passes: readonly LongRunTelemetryPassInputV1[]): LongRunTelemetryV1;
}

interface PassAccumulator {
  pass: string;
  samplesObserved: number;
  firstObservationElapsedMs: number;
  lastObservationElapsedMs: number;
  searchActiveMs: number;
  logicalByteMillisecondsTimesTwo: bigint;
  rssByteMillisecondsTimesTwo: bigint;
  lastSequence: number;
  lastState: number;
  lastRunWideState: number;
  lastLogicalBytes: number;
  lastRssBytes: number;
  firstYield: SharedYieldCountsV1;
  lastYield: SharedYieldCountsV1;
}

const PHASE_DURATION_FIELD: Record<LongRunPhaseV1, keyof RunPhaseDurationsV1> = {
  setup: "setupMs",
  compilation: "compilationMs",
  source_scan: "sourceScanMs",
  search_active: "searchActiveMs",
  minimum_reproduction: "minimumReproductionMs",
  checkpoint_write: "checkpointWriteMs",
  checkpoint_reopen: "checkpointReopenMs",
  replay_scoring: "replayScoringMs",
  report_enrichment: "reportEnrichmentMs",
  report_write: "reportWriteMs",
  finalization: "finalizationMs",
};

const PHASE_DURATION_KEYS = [
  "setupMs",
  "compilationMs",
  "sourceScanMs",
  "searchActiveMs",
  "minimumReproductionMs",
  "checkpointWriteMs",
  "checkpointReopenMs",
  "replayScoringMs",
  "reportEnrichmentMs",
  "reportWriteMs",
  "finalizationMs",
] as const;

const TELEMETRY_KEYS = ["schemaVersion", "phases", "passes"] as const;
const PASS_COST_KEYS = [
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
] as const;
const BYTE_TIME_KEYS = ["basis", "byteMillisecondsTimesTwo", "divisor"] as const;
const YIELD_KEYS = [
  "critical",
  "intent",
  "authoredCoverage",
  "visibleOutcomes",
  "semanticTransitions",
  "terminalVariants",
] as const;
const YIELD_RATE_KEYS = [
  "identities",
  "identitiesPerMillionTransitions",
  "identitiesPerSearchActiveMinute",
  "identitiesPerRetainedGiBMinute",
] as const;

const RETAINED_GIB_MINUTE_TIMES_TWO = 2n * 1024n * 1024n * 1024n * 60_000n;
const MAX_LONG_RUN_BYTE_MILLISECONDS_TIMES_TWO = 10n ** BigInt(MAX_LONG_RUN_BYTE_MILLISECONDS_DIGITS) - 1n;
const CANONICAL_UNSIGNED_DECIMAL = /^(0|[1-9]\d*)$/;
const PASS_PATTERN = /^[A-Za-z0-9._:=/-]{1,128}$/;

function emptyPhaseDurations(): RunPhaseDurationsV1 {
  return {
    setupMs: 0,
    compilationMs: 0,
    sourceScanMs: 0,
    searchActiveMs: 0,
    minimumReproductionMs: 0,
    checkpointWriteMs: 0,
    checkpointReopenMs: 0,
    replayScoringMs: 0,
    reportEnrichmentMs: 0,
    reportWriteMs: 0,
    finalizationMs: 0,
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || Array.isArray(value)) {
    throw new TypeError(`${name} must be a canonical plain data record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (utilTypes.isProxy(prototype)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError(`${name} must be a canonical plain data record`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      throw new TypeError(`${name} must contain only enumerable string-keyed data properties`);
    }
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} must contain only enumerable string-keyed data properties`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
  name: string
): Record<Keys[number], unknown> {
  const candidate = record(value, name);
  const actual = Reflect.ownKeys(candidate);
  if (actual.some((key) => typeof key !== "string")
    || actual.length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(candidate, key))) {
    throw new TypeError(`${name} has an invalid shape`);
  }
  return candidate as Record<Keys[number], unknown>;
}

function denseDataArray(value: unknown, name: string, maximumLength: number): unknown[] {
  if (value === null
    || typeof value !== "object"
    || utilTypes.isProxy(value)
    || !Array.isArray(value)) {
    throw new TypeError(`${name} must be a canonical dense data array`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (utilTypes.isProxy(prototype) || prototype !== Array.prototype) {
    throw new TypeError(`${name} must be a canonical dense data array`);
  }

  // Native array length is a non-accessor own property. Read its descriptor
  // first so an oversized sparse array is rejected before allocating a full
  // descriptor snapshot.
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value")) {
    throw new TypeError(`${name} must be a canonical dense data array`);
  }
  const length = safeInteger(lengthDescriptor.value, `${name}.length`);
  if (length > maximumLength) {
    throw new RangeError(`${name} must contain at most ${maximumLength} entries`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string") || ownKeys.length !== length + 1) {
    throw new TypeError(`${name} must be a canonical dense data array without extra properties`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw new TypeError(`${name} must be a canonical dense data array without holes or accessors`);
    }
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

function safeInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RangeError(`${name} must be a safe integer at least ${minimum}`);
  }
  return value as number;
}

function nullableSafeInteger(value: unknown, name: string): number | null {
  return value === null ? null : safeInteger(value, name);
}

function finiteRate(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number or null`);
  }
  return value;
}

function passName(value: unknown, name: string): string {
  if (typeof value !== "string" || !PASS_PATTERN.test(value)) {
    throw new RangeError(`${name} must be a bounded opaque pass label`);
  }
  return value;
}

function safeAdd(left: number, right: number, name: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} exceeds safe-integer range`);
  return value;
}

function boundedIntegral(value: bigint, name: string): bigint {
  if (value < 0n || value > MAX_LONG_RUN_BYTE_MILLISECONDS_TIMES_TWO) {
    throw new RangeError(`${name} exceeds the bounded decimal integral range`);
  }
  return value;
}

function canonicalIntegral(value: unknown, name: string): bigint {
  if (typeof value !== "string"
    || value.length > MAX_LONG_RUN_BYTE_MILLISECONDS_DIGITS
    || !CANONICAL_UNSIGNED_DECIMAL.test(value)) {
    throw new RangeError(
      `${name} must be a canonical unsigned decimal of at most ${MAX_LONG_RUN_BYTE_MILLISECONDS_DIGITS} digits`
    );
  }
  return boundedIntegral(BigInt(value), name);
}

function cloneYield(value: SharedYieldCountsV1): SharedYieldCountsV1 {
  return {
    critical: { ...value.critical },
    intent: { ...value.intent },
    authoredCoverage: { ...value.authoredCoverage },
    visibleOutcomes: value.visibleOutcomes,
    semanticTransitions: value.semanticTransitions,
    terminalVariants: value.terminalVariants,
    rawTerritory: { ...value.rawTerritory },
  };
}

function emptyYield(): SharedYieldCountsV1 {
  return {
    critical: { runtimeErrors: 0, assertionViolations: 0 },
    intent: { goalsReached: 0, stagesReached: 0 },
    authoredCoverage: { knotsVisited: 0 },
    visibleOutcomes: 0,
    semanticTransitions: 0,
    terminalVariants: 0,
    rawTerritory: { transitions: 0, uniqueStates: 0, dedupeHits: 0 },
  };
}

function subtractYield(current: SharedYieldCountsV1, previous: SharedYieldCountsV1): SharedYieldCountsV1 {
  if (!yieldAtMost(previous, current)) throw new RangeError("shared yield interval is not cumulative");
  return {
    critical: {
      runtimeErrors: current.critical.runtimeErrors - previous.critical.runtimeErrors,
      assertionViolations: current.critical.assertionViolations - previous.critical.assertionViolations,
    },
    intent: {
      goalsReached: current.intent.goalsReached - previous.intent.goalsReached,
      stagesReached: current.intent.stagesReached - previous.intent.stagesReached,
    },
    authoredCoverage: {
      knotsVisited: current.authoredCoverage.knotsVisited - previous.authoredCoverage.knotsVisited,
    },
    visibleOutcomes: current.visibleOutcomes - previous.visibleOutcomes,
    semanticTransitions: current.semanticTransitions - previous.semanticTransitions,
    terminalVariants: current.terminalVariants - previous.terminalVariants,
    rawTerritory: {
      transitions: current.rawTerritory.transitions - previous.rawTerritory.transitions,
      uniqueStates: current.rawTerritory.uniqueStates - previous.rawTerritory.uniqueStates,
      dedupeHits: current.rawTerritory.dedupeHits - previous.rawTerritory.dedupeHits,
    },
  };
}

function checkedYieldCounts(value: unknown, name: string): SharedYieldCountsV1 {
  const candidate = record(value, name);
  const critical = record(candidate.critical, `${name}.critical`);
  const intent = record(candidate.intent, `${name}.intent`);
  const authoredCoverage = record(candidate.authoredCoverage, `${name}.authoredCoverage`);
  const rawTerritory = record(candidate.rawTerritory, `${name}.rawTerritory`);
  return {
    critical: {
      runtimeErrors: safeInteger(critical.runtimeErrors, `${name}.critical.runtimeErrors`),
      assertionViolations: safeInteger(critical.assertionViolations, `${name}.critical.assertionViolations`),
    },
    intent: {
      goalsReached: safeInteger(intent.goalsReached, `${name}.intent.goalsReached`),
      stagesReached: safeInteger(intent.stagesReached, `${name}.intent.stagesReached`),
    },
    authoredCoverage: {
      knotsVisited: safeInteger(authoredCoverage.knotsVisited, `${name}.authoredCoverage.knotsVisited`),
    },
    visibleOutcomes: safeInteger(candidate.visibleOutcomes, `${name}.visibleOutcomes`),
    semanticTransitions: safeInteger(candidate.semanticTransitions, `${name}.semanticTransitions`),
    terminalVariants: safeInteger(candidate.terminalVariants, `${name}.terminalVariants`),
    rawTerritory: {
      transitions: safeInteger(rawTerritory.transitions, `${name}.rawTerritory.transitions`),
      uniqueStates: safeInteger(rawTerritory.uniqueStates, `${name}.rawTerritory.uniqueStates`),
      dedupeHits: safeInteger(rawTerritory.dedupeHits, `${name}.rawTerritory.dedupeHits`),
    },
  };
}

function yieldAtMost(left: SharedYieldCountsV1, right: SharedYieldCountsV1): boolean {
  return left.critical.runtimeErrors <= right.critical.runtimeErrors
    && left.critical.assertionViolations <= right.critical.assertionViolations
    && left.intent.goalsReached <= right.intent.goalsReached
    && left.intent.stagesReached <= right.intent.stagesReached
    && left.authoredCoverage.knotsVisited <= right.authoredCoverage.knotsVisited
    && left.visibleOutcomes <= right.visibleOutcomes
    && left.semanticTransitions <= right.semanticTransitions
    && left.terminalVariants <= right.terminalVariants
    && left.rawTerritory.transitions <= right.rawTerritory.transitions
    && left.rawTerritory.uniqueStates <= right.rawTerritory.uniqueStates
    && left.rawTerritory.dedupeHits <= right.rawTerritory.dedupeHits;
}

function yieldEqual(left: SharedYieldCountsV1, right: SharedYieldCountsV1): boolean {
  return yieldAtMost(left, right) && yieldAtMost(right, left);
}

function categoryIdentities(value: SharedYieldCountsV1): Record<keyof LongRunYieldRatesV1, number> {
  return {
    critical: safeAdd(
      value.critical.runtimeErrors,
      value.critical.assertionViolations,
      "critical identities"
    ),
    intent: safeAdd(value.intent.goalsReached, value.intent.stagesReached, "intent identities"),
    authoredCoverage: value.authoredCoverage.knotsVisited,
    visibleOutcomes: value.visibleOutcomes,
    semanticTransitions: value.semanticTransitions,
    terminalVariants: value.terminalVariants,
  };
}

function rate(numerator: number, denominator: number | bigint, scale: number | bigint): number | null {
  if (denominator === 0 || denominator === 0n) return null;
  const value = numerator / Number(denominator) * Number(scale);
  if (!Number.isFinite(value) || value < 0) throw new RangeError("yield rate is not finite");
  return value;
}

function yieldRates(
  value: SharedYieldCountsV1,
  searchActiveMs: number,
  retainedByteMillisecondsTimesTwo: bigint
): LongRunYieldRatesV1 {
  const transitions = value.rawTerritory.transitions;
  const identities = categoryIdentities(value);
  return Object.fromEntries(YIELD_KEYS.map((key) => [key, {
    identities: identities[key],
    identitiesPerMillionTransitions: rate(identities[key], transitions, 1_000_000),
    identitiesPerSearchActiveMinute: rate(identities[key], searchActiveMs, 60_000),
    identitiesPerRetainedGiBMinute: rate(
      identities[key],
      retainedByteMillisecondsTimesTwo,
      RETAINED_GIB_MINUTE_TIMES_TWO
    ),
  }])) as unknown as LongRunYieldRatesV1;
}

function clonePhases(value: RunPhaseDurationsV1): RunPhaseDurationsV1 {
  return { ...value };
}

function byteTimeIntegral(
  basis: ByteTimeIntegralV1["basis"],
  byteMillisecondsTimesTwo: bigint
): ByteTimeIntegralV1 {
  return {
    basis,
    byteMillisecondsTimesTwo: boundedIntegral(
      byteMillisecondsTimesTwo,
      `${basis} byte-millisecond integral`
    ).toString(),
    divisor: 2,
  };
}

function checkedPhaseDurations(value: unknown): RunPhaseDurationsV1 {
  const candidate = exactRecord(value, PHASE_DURATION_KEYS, "long-run phase durations");
  return {
    setupMs: safeInteger(candidate.setupMs, "phases.setupMs"),
    compilationMs: safeInteger(candidate.compilationMs, "phases.compilationMs"),
    sourceScanMs: safeInteger(candidate.sourceScanMs, "phases.sourceScanMs"),
    searchActiveMs: safeInteger(candidate.searchActiveMs, "phases.searchActiveMs"),
    minimumReproductionMs: safeInteger(candidate.minimumReproductionMs, "phases.minimumReproductionMs"),
    checkpointWriteMs: safeInteger(candidate.checkpointWriteMs, "phases.checkpointWriteMs"),
    checkpointReopenMs: safeInteger(candidate.checkpointReopenMs, "phases.checkpointReopenMs"),
    replayScoringMs: safeInteger(candidate.replayScoringMs, "phases.replayScoringMs"),
    reportEnrichmentMs: safeInteger(candidate.reportEnrichmentMs, "phases.reportEnrichmentMs"),
    reportWriteMs: safeInteger(candidate.reportWriteMs, "phases.reportWriteMs"),
    finalizationMs: safeInteger(candidate.finalizationMs, "phases.finalizationMs"),
  };
}

function checkedByteTimeIntegral(
  value: unknown,
  expectedBasis: ByteTimeIntegralV1["basis"],
  name: string
): ByteTimeIntegralV1 {
  const candidate = exactRecord(value, BYTE_TIME_KEYS, name);
  if (candidate.basis !== expectedBasis) throw new RangeError(`${name}.basis is invalid`);
  if (candidate.divisor !== 2) throw new RangeError(`${name}.divisor must be 2`);
  return byteTimeIntegral(
    expectedBasis,
    canonicalIntegral(candidate.byteMillisecondsTimesTwo, `${name}.byteMillisecondsTimesTwo`)
  );
}

function checkedYieldRate(value: unknown, name: string): LongRunYieldRateV1 {
  const candidate = exactRecord(value, YIELD_RATE_KEYS, name);
  return {
    identities: safeInteger(candidate.identities, `${name}.identities`),
    identitiesPerMillionTransitions: finiteRate(
      candidate.identitiesPerMillionTransitions,
      `${name}.identitiesPerMillionTransitions`
    ),
    identitiesPerSearchActiveMinute: finiteRate(
      candidate.identitiesPerSearchActiveMinute,
      `${name}.identitiesPerSearchActiveMinute`
    ),
    identitiesPerRetainedGiBMinute: finiteRate(
      candidate.identitiesPerRetainedGiBMinute,
      `${name}.identitiesPerRetainedGiBMinute`
    ),
  };
}

function checkedYieldRates(value: unknown, name: string): LongRunYieldRatesV1 {
  const candidate = exactRecord(value, YIELD_KEYS, name);
  return {
    critical: checkedYieldRate(candidate.critical, `${name}.critical`),
    intent: checkedYieldRate(candidate.intent, `${name}.intent`),
    authoredCoverage: checkedYieldRate(candidate.authoredCoverage, `${name}.authoredCoverage`),
    visibleOutcomes: checkedYieldRate(candidate.visibleOutcomes, `${name}.visibleOutcomes`),
    semanticTransitions: checkedYieldRate(candidate.semanticTransitions, `${name}.semanticTransitions`),
    terminalVariants: checkedYieldRate(candidate.terminalVariants, `${name}.terminalVariants`),
  };
}

function sameRate(left: number | null, right: number | null): boolean {
  return left === right;
}

function checkedPassCost(value: unknown, index: number): LongRunPassCostV1 {
  const name = `long-run pass ${index}`;
  const candidate = exactRecord(value, PASS_COST_KEYS, name);
  if (candidate.schemaVersion !== 1) throw new RangeError(`${name}.schemaVersion must be 1`);
  const samplesObserved = safeInteger(candidate.samplesObserved, `${name}.samplesObserved`);
  const firstObservationElapsedMs = nullableSafeInteger(
    candidate.firstObservationElapsedMs,
    `${name}.firstObservationElapsedMs`
  );
  const lastObservationElapsedMs = nullableSafeInteger(
    candidate.lastObservationElapsedMs,
    `${name}.lastObservationElapsedMs`
  );
  const searchActiveMs = safeInteger(candidate.searchActiveMs, `${name}.searchActiveMs`);
  const transitions = safeInteger(candidate.transitions, `${name}.transitions`);
  const logicalRetained = checkedByteTimeIntegral(
    candidate.logicalRetained,
    "deterministic_logical_accounted_bytes",
    `${name}.logicalRetained`
  );
  const processRss = checkedByteTimeIntegral(
    candidate.processRss,
    "observed_process_rss_bytes",
    `${name}.processRss`
  );
  const observedYield = checkedYieldRates(candidate.yield, `${name}.yield`);

  if (samplesObserved === 0) {
    if (firstObservationElapsedMs !== null || lastObservationElapsedMs !== null
      || searchActiveMs !== 0
      || transitions !== 0
      || logicalRetained.byteMillisecondsTimesTwo !== "0"
      || processRss.byteMillisecondsTimesTwo !== "0") {
      throw new RangeError(`${name} zero-sample costs must have null bounds and zero integrals`);
    }
  } else {
    if (firstObservationElapsedMs === null || lastObservationElapsedMs === null
      || lastObservationElapsedMs < firstObservationElapsedMs
      || searchActiveMs !== lastObservationElapsedMs - firstObservationElapsedMs) {
      throw new RangeError(`${name} observation bounds do not match searchActiveMs`);
    }
    if (samplesObserved === 1
      && (transitions !== 0
        || searchActiveMs !== 0
        || logicalRetained.byteMillisecondsTimesTwo !== "0"
        || processRss.byteMillisecondsTimesTwo !== "0")) {
      throw new RangeError(`${name} one-sample costs cannot claim an interval`);
    }
    if (samplesObserved > 1 && samplesObserved - 1 > transitions) {
      throw new RangeError(`${name} cannot contain more ordered sample intervals than transitions`);
    }
  }

  if (searchActiveMs === 0
    && (logicalRetained.byteMillisecondsTimesTwo !== "0"
      || processRss.byteMillisecondsTimesTwo !== "0")) {
    throw new RangeError(`${name} zero-duration costs must have zero integrals`);
  }

  if (samplesObserved <= 1) {
    for (const key of YIELD_KEYS) {
      const category = observedYield[key];
      if (category.identities !== 0
        || category.identitiesPerMillionTransitions !== null
        || category.identitiesPerSearchActiveMinute !== null
        || category.identitiesPerRetainedGiBMinute !== null) {
        throw new RangeError(`${name}.yield.${key} must be zero with null rates without an observed interval`);
      }
    }
  }

  for (const key of YIELD_KEYS) {
    const expected = {
      identitiesPerMillionTransitions: rate(observedYield[key].identities, transitions, 1_000_000),
      identitiesPerSearchActiveMinute: rate(observedYield[key].identities, searchActiveMs, 60_000),
      identitiesPerRetainedGiBMinute: rate(
        observedYield[key].identities,
        BigInt(logicalRetained.byteMillisecondsTimesTwo),
        RETAINED_GIB_MINUTE_TIMES_TWO
      ),
    };
    if (!sameRate(observedYield[key].identitiesPerMillionTransitions, expected.identitiesPerMillionTransitions)
      || !sameRate(observedYield[key].identitiesPerSearchActiveMinute, expected.identitiesPerSearchActiveMinute)
      || !sameRate(observedYield[key].identitiesPerRetainedGiBMinute, expected.identitiesPerRetainedGiBMinute)) {
      throw new RangeError(`${name}.yield.${key} rates do not match their pass-local denominators`);
    }
  }

  return {
    schemaVersion: 1,
    pass: passName(candidate.pass, `${name}.pass`),
    samplesObserved,
    firstObservationElapsedMs,
    lastObservationElapsedMs,
    searchActiveMs,
    transitions,
    logicalRetained,
    processRss,
    yield: observedYield,
  };
}

/** Validate and detach a bounded telemetry value at a persistence or output boundary. */
export function validateLongRunTelemetryV1(value: unknown): LongRunTelemetryV1 {
  const candidate = exactRecord(value, TELEMETRY_KEYS, "long-run telemetry");
  if (candidate.schemaVersion !== 1) throw new RangeError("long-run telemetry schemaVersion must be 1");
  const passValues = denseDataArray(
    candidate.passes,
    "long-run telemetry passes",
    MAX_LONG_RUN_TELEMETRY_PASSES
  );
  const seen = new Set<string>();
  const passes: LongRunPassCostV1[] = [];
  for (let index = 0; index < passValues.length; index += 1) {
    const pass = checkedPassCost(passValues[index], index);
    if (seen.has(pass.pass)) {
      throw new RangeError("long-run telemetry pass labels must be unique");
    }
    seen.add(pass.pass);
    passes.push(pass);
  }
  return {
    schemaVersion: 1,
    phases: checkedPhaseDurations(candidate.phases),
    passes,
  };
}

export function createLongRunTelemetryRecorder(options: {
  nowMs?: () => number;
} = {}): LongRunTelemetryRecorder {
  const nowMs = options.nowMs ?? (() => Math.floor(performance.now()));
  const phases = emptyPhaseDurations();
  const accumulators = new Map<string, PassAccumulator>();
  const closedPasses = new Set<string>();
  const activePhases = new Map<LongRunPhaseV1, number>();
  let lastPhaseClockMs: number | undefined;
  let lastObservationElapsedMs: number | undefined;
  let lastObservationRunWideState: number | undefined;
  let lastObservedPass: string | undefined;
  let finalized = false;

  const assertMutable = (): void => {
    if (finalized) throw new Error("long-run telemetry recorder is already finalized");
  };

  const readNow = (): number => {
    const value = safeInteger(nowMs(), "nowMs");
    if (lastPhaseClockMs !== undefined && value < lastPhaseClockMs) {
      throw new RangeError("nowMs must be monotonic");
    }
    lastPhaseClockMs = value;
    return value;
  };

  const observeShared = (observation: SharedResourceObservationV2, elapsedMs: number): void => {
    assertMutable();
    const elapsed = safeInteger(elapsedMs, "elapsedMs");
    if (lastObservationElapsedMs !== undefined && elapsed < lastObservationElapsedMs) {
      throw new RangeError("shared observation elapsedMs must be monotonic");
    }
    if (observation?.schemaVersion !== 2 || observation.sample?.schemaVersion !== 2) {
      throw new RangeError("long-run telemetry requires SharedResourceObservationV2");
    }
    const pass = passName(observation.pass, "observation.pass");
    const sequence = safeInteger(observation.sample.sequence, "observation.sample.sequence", 1);
    const state = safeInteger(observation.sample.state, "observation.sample.state");
    const runWideState = safeInteger(observation.runWideState, "observation.runWideState");
    if (observation.sample.yield.throughState !== state) {
      throw new RangeError("observation sample yield boundary must equal its pass-local state");
    }
    safeInteger(observation.sample.yield.fromStateExclusive, "observation.sample.yield.fromStateExclusive");
    if (observation.sample.yield.fromStateExclusive > state) {
      throw new RangeError("observation sample yield interval is out of order");
    }
    const cumulativeYield = checkedYieldCounts(
      observation.sample.yield.cumulative,
      "observation.sample.yield.cumulative"
    );
    if (cumulativeYield.rawTerritory.transitions !== state) {
      throw new RangeError("observation cumulative transitions must equal its pass-local state");
    }
    const currentSearchBytes = safeInteger(
      observation.sample.retention.current.totalAccountedBytes,
      "observation.sample.retention.current.totalAccountedBytes"
    );
    const logicalBytes = safeInteger(
      observation.process.comparedLogicalAccountedBytes,
      "observation.process.comparedLogicalAccountedBytes"
    );
    if (logicalBytes < currentSearchBytes) {
      throw new RangeError("logical owner accounting cannot be smaller than current retained search bytes");
    }
    const rssBytes = safeInteger(observation.process.rssBytes, "observation.process.rssBytes");

    if (lastObservationRunWideState !== undefined && runWideState < lastObservationRunWideState) {
      throw new RangeError("shared observation runWideState must be monotonic");
    }
    if (lastObservedPass !== undefined && pass !== lastObservedPass) {
      closedPasses.add(lastObservedPass);
      if (closedPasses.has(pass)) {
        throw new RangeError("shared observations for one pass must form one contiguous segment");
      }
    }

    let accumulator = accumulators.get(pass);
    if (!accumulator) {
      if (accumulators.size >= MAX_LONG_RUN_TELEMETRY_PASSES) {
        throw new RangeError(`long-run telemetry cannot retain more than ${MAX_LONG_RUN_TELEMETRY_PASSES} passes`);
      }
      accumulator = {
        pass,
        samplesObserved: 1,
        firstObservationElapsedMs: elapsed,
        lastObservationElapsedMs: elapsed,
        searchActiveMs: 0,
        logicalByteMillisecondsTimesTwo: 0n,
        rssByteMillisecondsTimesTwo: 0n,
        lastSequence: sequence,
        lastState: state,
        lastRunWideState: runWideState,
        lastLogicalBytes: logicalBytes,
        lastRssBytes: rssBytes,
        firstYield: cloneYield(cumulativeYield),
        lastYield: cloneYield(cumulativeYield),
      };
      accumulators.set(pass, accumulator);
    } else {
      if (sequence <= accumulator.lastSequence || state <= accumulator.lastState
        || runWideState <= accumulator.lastRunWideState
        || elapsed < accumulator.lastObservationElapsedMs
        || !yieldAtMost(accumulator.lastYield, cumulativeYield)) {
        throw new RangeError("shared observations within a pass must be strictly ordered and cumulative");
      }
      const elapsedDelta = elapsed - accumulator.lastObservationElapsedMs;
      const logicalInterval = boundedIntegral(
        (BigInt(accumulator.lastLogicalBytes) + BigInt(logicalBytes)) * BigInt(elapsedDelta),
        "logical retained byte-millisecond interval"
      );
      const rssInterval = boundedIntegral(
        (BigInt(accumulator.lastRssBytes) + BigInt(rssBytes)) * BigInt(elapsedDelta),
        "process RSS byte-millisecond interval"
      );
      const nextSamplesObserved = safeAdd(accumulator.samplesObserved, 1, "samplesObserved");
      const nextSearchActiveMs = safeAdd(accumulator.searchActiveMs, elapsedDelta, "searchActiveMs");
      const nextLogicalIntegral = boundedIntegral(
        accumulator.logicalByteMillisecondsTimesTwo + logicalInterval,
        "logical retained byte-millisecond integral"
      );
      const nextRssIntegral = boundedIntegral(
        accumulator.rssByteMillisecondsTimesTwo + rssInterval,
        "process RSS byte-millisecond integral"
      );
      // Commit only after every arithmetic check succeeds.
      accumulator.samplesObserved = nextSamplesObserved;
      accumulator.searchActiveMs = nextSearchActiveMs;
      accumulator.logicalByteMillisecondsTimesTwo = nextLogicalIntegral;
      accumulator.rssByteMillisecondsTimesTwo = nextRssIntegral;
      accumulator.lastObservationElapsedMs = elapsed;
      accumulator.lastSequence = sequence;
      accumulator.lastState = state;
      accumulator.lastRunWideState = runWideState;
      accumulator.lastLogicalBytes = logicalBytes;
      accumulator.lastRssBytes = rssBytes;
      accumulator.lastYield = cloneYield(cumulativeYield);
    }
    lastObservationElapsedMs = elapsed;
    lastObservationRunWideState = runWideState;
    lastObservedPass = pass;
  };

  const startPhase = (phase: LongRunPhaseV1): void => {
    assertMutable();
    if (!LONG_RUN_PHASES.includes(phase)) throw new RangeError(`unknown long-run phase: ${phase}`);
    if (activePhases.has(phase)) throw new Error(`long-run phase ${phase} is already active`);
    activePhases.set(phase, readNow());
  };

  const endPhase = (phase: LongRunPhaseV1): number => {
    assertMutable();
    const startedAtMs = activePhases.get(phase);
    if (startedAtMs === undefined) {
      throw new Error(`long-run phase ${phase} is not active`);
    }
    const endedAtMs = readNow();
    const durationMs = endedAtMs - startedAtMs;
    const field = PHASE_DURATION_FIELD[phase];
    phases[field] = safeAdd(phases[field], durationMs, `phases.${field}`);
    activePhases.delete(phase);
    return durationMs;
  };

  const finalize = (passes: readonly LongRunTelemetryPassInputV1[]): LongRunTelemetryV1 => {
    assertMutable();
    if (activePhases.size > 0) {
      throw new Error(`cannot finalize while long-run phases are active: ${[...activePhases.keys()].join(", ")}`);
    }
    const finalPasses = denseDataArray(passes, "final passes", MAX_LONG_RUN_TELEMETRY_PASSES);
    const seen = new Set<string>();
    const passCosts: LongRunPassCostV1[] = [];
    for (let index = 0; index < finalPasses.length; index += 1) {
      const input = record(finalPasses[index], `passes[${index}]`);
      const pass = passName(input.pass, `passes[${index}].pass`);
      if (seen.has(pass)) throw new RangeError(`duplicate final pass label: ${pass}`);
      seen.add(pass);
      const statesExplored = safeInteger(input.statesExplored, `passes[${index}].statesExplored`);
      const accumulator = accumulators.get(pass);
      const shared = input.sharedObservability === undefined
        ? undefined
        : record(input.sharedObservability, `passes[${index}].sharedObservability`);
      if (shared !== undefined && shared.schemaVersion !== 2) {
        if (accumulator) throw new RangeError(`final telemetry for observed pass ${pass} is not schema v2`);
        continue;
      }
      if (shared === undefined && !accumulator) continue;
      let cumulativeYield: SharedYieldCountsV1;
      if (shared?.schemaVersion === 2) {
        const yieldSummary = record(
          shared.yieldSummary,
          `passes[${index}].sharedObservability.yieldSummary`
        );
        cumulativeYield = checkedYieldCounts(
          yieldSummary.cumulative,
          `passes[${index}].sharedObservability.yieldSummary.cumulative`
        );
      } else {
        cumulativeYield = cloneYield(accumulator!.lastYield);
      }
      if (cumulativeYield.rawTerritory.transitions > statesExplored) {
        throw new RangeError(`final yield transitions exceed statesExplored for pass ${pass}`);
      }
      if (cumulativeYield.rawTerritory.transitions !== statesExplored) {
        throw new RangeError(`final yield transitions must equal statesExplored for pass ${pass}`);
      }
      if (accumulator
        && (accumulator.lastState !== statesExplored || !yieldEqual(accumulator.lastYield, cumulativeYield))) {
        throw new RangeError(`final telemetry must match the terminal live observation for pass ${pass}`);
      }
      // The trapezoids span only adjacent live samples. Align yield and work
      // to that same closed interval instead of crediting an unobserved prefix.
      const intervalYield = accumulator
        ? subtractYield(accumulator.lastYield, accumulator.firstYield)
        : emptyYield();
      const samplesObserved = accumulator?.samplesObserved ?? 0;
      const searchActiveMs = accumulator?.searchActiveMs ?? 0;
      const logicalIntegral = accumulator?.logicalByteMillisecondsTimesTwo ?? 0n;
      passCosts.push({
        schemaVersion: 1,
        pass,
        samplesObserved,
        firstObservationElapsedMs: accumulator?.firstObservationElapsedMs ?? null,
        lastObservationElapsedMs: accumulator?.lastObservationElapsedMs ?? null,
        searchActiveMs,
        transitions: intervalYield.rawTerritory.transitions,
        logicalRetained: byteTimeIntegral("deterministic_logical_accounted_bytes", logicalIntegral),
        processRss: byteTimeIntegral("observed_process_rss_bytes", accumulator?.rssByteMillisecondsTimesTwo ?? 0n),
        yield: yieldRates(intervalYield, searchActiveMs, logicalIntegral),
      });
    }
    for (const pass of accumulators.keys()) {
      if (!seen.has(pass)) throw new RangeError(`observed pass ${pass} is missing from final passes`);
    }
    const result = validateLongRunTelemetryV1({
      schemaVersion: 1,
      phases: clonePhases(phases),
      passes: passCosts,
    });
    finalized = true;
    return result;
  };

  return { observeShared, startPhase, endPhase, finalize };
}
