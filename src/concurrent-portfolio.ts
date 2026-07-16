import * as os from "os";
import * as v8 from "v8";
import {
  DEFAULT_PORTFOLIO_WEIGHTS,
  explorePortfolio,
  type ExploreOptions,
  type ExploreResult,
  type PortfolioPassKind,
  type PortfolioWeights,
} from "./explore";
import type { KnotInfo } from "./inklecate";
import { explorePortfolioAdaptiveConcurrent } from "./adaptive-concurrent-portfolio";

const MAX_PORTFOLIO_CONCURRENCY = 16;
const MIN_WORKER_HEAP_BYTES = 64 * 1024 * 1024;

export interface ConcurrentPortfolioOptions extends ExploreOptions {
  concurrency: number;
  memoryCapBytes?: number;
  deadlineMs?: number;
  /** Deterministic failure injection for worker-loss contract tests. */
  failPassForTest?: PortfolioPassKind;
  /** Deterministic aggregate-memory injection for resource contract tests. */
  aggregateMemoryUsedForTest?: () => number;
}

function availableCpus(): number {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}

function enabledPasses(maxStates: number, weights: PortfolioWeights): number {
  let count = 0;
  if (weights.last > 0) count++;
  if (weights.first > 0) count++;
  if (weights.insideOut > 0) count++;
  if (weights.beam > 0 && maxStates >= 10) count++;
  if (weights.random > 0 && maxStates >= 5) count++;
  return Math.max(1, count);
}

function sequential(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  options: ConcurrentPortfolioOptions,
  fallbackReason?: "single_core" | "memory_headroom" | "single_pass" | "pilot_depth_bound" | "pilot_authored_frontier_saturated"
): ExploreResult {
  const result = explorePortfolio(storyJson, knots, externals, options);
  result.execution = {
    mode: "sequential",
    requestedConcurrency: options.concurrency,
    effectiveConcurrency: 1,
    ...(fallbackReason ? { fallbackReason } : {}),
    workers: (result.passes ?? []).map((pass) => ({
      pass: pass.pass,
      granted: pass.granted,
      consumed: pass.statesExplored,
      status: pass.truncatedBy.memory ? "memory" : pass.truncatedBy.time ? "time" : "completed",
    })),
  };
  return result;
}

export const CONCURRENCY_ACTIVATION_PILOT_STATES = 1_024;

/**
 * Research-only activation candidate for issue #169. A bounded sequential
 * pilot rejects stories that exhaust cheaply, bind on depth, or saturate the
 * authored knot frontier. Open-frontier stories then run the unchanged
 * concurrent ceiling so evidence remains comparable. The restarted pilot
 * work is explicit and therefore not production-eligible.
 */
export function explorePortfolioPilotActivatedConcurrent(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  options: ConcurrentPortfolioOptions
): ExploreResult {
  const maxStates = options.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 100_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 100000000");
  }
  const pilotBudget = Math.min(CONCURRENCY_ACTIVATION_PILOT_STATES, maxStates);
  const pilot = explorePortfolio(storyJson, knots, externals, {
    ...options,
    maxStates: pilotBudget,
    onProgress: undefined,
    onSnapshot: undefined,
  });
  const pilotConsumedBudget = pilotBudget === maxStates;
  if (pilot.exhaustive || pilotConsumedBudget) {
    const reason = pilot.exhaustive ? "pilot_exhaustive" : "pilot_consumed_budget";
    pilot.execution = {
      mode: "sequential",
      requestedConcurrency: options.concurrency,
      effectiveConcurrency: 1,
      fallbackReason: reason,
      activation: {
        policyVersion: "pilot-frontier-v2",
        decision: "stay_sequential",
        reason,
        pilotBudget,
        pilotStatesExplored: pilot.statesExplored,
        pilotExhaustive: pilot.exhaustive,
        duplicateStateEvaluations: 0,
        uncertainty: "high",
        productionEligible: false,
      },
      workers: (pilot.passes ?? []).map((pass) => ({
        pass: pass.pass,
        granted: pass.granted,
        consumed: pass.statesExplored,
        status: pass.truncatedBy.memory ? "memory" : pass.truncatedBy.time ? "time" : "completed",
      })),
    };
    options.onSnapshot?.(pilot);
    return pilot;
  }

  const authoredKnots = knots.filter((knot) => !knot.isFunction).length;
  const staySequentialReason = pilot.truncatedBy.maxDepth
    ? "pilot_depth_bound"
    : authoredKnots > 0 && pilot.visitedKnots.length >= authoredKnots
      ? "pilot_authored_frontier_saturated"
      : undefined;
  const result = staySequentialReason
    ? sequential(storyJson, knots, externals, options, staySequentialReason)
    : explorePortfolioConcurrent(storyJson, knots, externals, options);
  result.execution ??= {
    mode: "sequential",
    requestedConcurrency: options.concurrency,
    effectiveConcurrency: 1,
    workers: [],
  };
  result.execution.activation = {
    policyVersion: "pilot-frontier-v2",
    decision: staySequentialReason ? "stay_sequential" : "activate_concurrent",
    reason: staySequentialReason ?? "pilot_open_frontier",
    pilotBudget,
    pilotStatesExplored: pilot.statesExplored,
    pilotExhaustive: false,
    duplicateStateEvaluations: pilot.statesExplored,
    uncertainty: "high",
    productionEligible: false,
  };
  return result;
}

/**
 * Run the production adaptive portfolio in persistent bounded worker slots.
 * Each slot owns one or more pausable passes across deterministic scheduler
 * rounds; reports are merged in canonical pass order, never completion order.
 */
export function explorePortfolioConcurrent(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  options: ConcurrentPortfolioOptions
): ExploreResult {
  const maxStates = options.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 100_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 100000000");
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > MAX_PORTFOLIO_CONCURRENCY) {
    throw new RangeError(`concurrency must be an integer from 1 to ${MAX_PORTFOLIO_CONCURRENCY}`);
  }
  if (options.concurrency === 1) return sequential(storyJson, knots, externals, options);
  const passCount = enabledPasses(maxStates, options.weights ?? DEFAULT_PORTFOLIO_WEIGHTS);
  if (passCount === 1 || maxStates === 1) return sequential(storyJson, knots, externals, options, "single_pass");
  const cpuCeiling = Math.max(1, availableCpus());
  if (cpuCeiling < 2) return sequential(storyJson, knots, externals, options, "single_core");
  const globalMemoryCap = options.memoryCapBytes ?? Math.floor(v8.getHeapStatistics().heap_size_limit * 0.85);
  const parentReserve = Math.min(256 * 1024 * 1024, Math.max(MIN_WORKER_HEAP_BYTES, Math.floor(globalMemoryCap * 0.15)));
  const memoryConcurrency = Math.floor(Math.max(0, globalMemoryCap - parentReserve) / MIN_WORKER_HEAP_BYTES);
  const effectiveConcurrency = Math.min(options.concurrency, cpuCeiling, passCount, memoryConcurrency);
  if (effectiveConcurrency < 2) return sequential(storyJson, knots, externals, options, "memory_headroom");
  const perWorkerMemory = Math.floor((globalMemoryCap - parentReserve) / effectiveConcurrency);
  return explorePortfolioAdaptiveConcurrent(
    storyJson,
    knots,
    externals,
    { ...options, memoryCapBytes: globalMemoryCap },
    effectiveConcurrency,
    perWorkerMemory,
    globalMemoryCap - perWorkerMemory * effectiveConcurrency
  );
}
