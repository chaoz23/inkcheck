import * as os from "os";
import * as v8 from "v8";
import {
  DEFAULT_PORTFOLIO_WEIGHTS,
  createPortfolioPassEngine,
  explorePortfolio,
  explorePortfolioFromPilot,
  type ExploreOptions,
  type ExploreResult,
  type PortfolioPassKind,
  type PortfolioWeights,
} from "./explore";
import type { KnotInfo } from "./inklecate";
import { explorePortfolioAdaptiveConcurrent, portfolioPassSpecs, splitBudget } from "./adaptive-concurrent-portfolio";

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
  /** Internal-only smaller activation pilot for scheduler contract tests. */
  activationPilotStatesForTest?: number;
}

function availableCpus(): number {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}

function hasForcedRootCycle(result: ExploreResult): boolean {
  return result.loopRisks?.some(
    (risk) => risk.firstObservedAtState === 0 && risk.repeatedAtState === 1
  ) ?? false;
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
  fallbackReason?: "single_core" | "memory_headroom" | "single_pass" | "pilot_forced_cycle" | "pilot_depth_bound" | "pilot_authored_frontier_saturated"
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
  const configuredPilot = options.activationPilotStatesForTest ?? CONCURRENCY_ACTIVATION_PILOT_STATES;
  if (!Number.isSafeInteger(configuredPilot) || configuredPilot < 1 || configuredPilot > CONCURRENCY_ACTIVATION_PILOT_STATES) {
    throw new RangeError(`activation pilot must be an integer from 1 to ${CONCURRENCY_ACTIVATION_PILOT_STATES}`);
  }
  const pilotBudget = Math.min(configuredPilot, maxStates);
  const pilot = explorePortfolio(storyJson, knots, externals, {
    ...options,
    maxStates: pilotBudget,
    onProgress: undefined,
    onSnapshot: undefined,
  });
  const pilotConsumedBudget = pilotBudget === maxStates;
  const forcedRootCycle = hasForcedRootCycle(pilot);
  if (pilot.exhaustive || pilotConsumedBudget || forcedRootCycle) {
    const reason = pilot.exhaustive ? "pilot_exhaustive" : pilotConsumedBudget ? "pilot_consumed_budget" : "pilot_forced_cycle";
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

/** Exact-budget successor to the restart-based activation evaluator. */
export function explorePortfolioPilotHandoffConcurrent(
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
  if (options.concurrency === 1 || maxStates === 1) return sequential(storyJson, knots, externals, options);
  const configuredPilot = options.activationPilotStatesForTest ?? CONCURRENCY_ACTIVATION_PILOT_STATES;
  if (!Number.isSafeInteger(configuredPilot) || configuredPilot < 1 || configuredPilot > CONCURRENCY_ACTIVATION_PILOT_STATES) {
    throw new RangeError(`activation pilot must be an integer from 1 to ${CONCURRENCY_ACTIVATION_PILOT_STATES}`);
  }
  if (maxStates <= configuredPilot) {
    const result = sequential(storyJson, knots, externals, options);
    result.execution!.fallbackReason = "budget_below_pilot";
    result.execution!.activation = {
      policyVersion: "single-pass-frontier-v3",
      decision: "stay_sequential",
      reason: "budget_below_pilot",
      pilotBudget: configuredPilot,
      pilotStatesExplored: 0,
      pilotExhaustive: false,
      duplicateStateEvaluations: 0,
      uncertainty: "high",
      productionEligible: true,
    };
    return result;
  }
  const weights = options.weights ?? DEFAULT_PORTFOLIO_WEIGHTS;
  const specs = portfolioPassSpecs(maxStates, weights);
  const pilotPass = specs.find((spec) => spec.pass === "dfs:inside-out")?.pass
    ?? specs.find((spec) => spec.pass.startsWith("dfs:"))?.pass;
  if (!pilotPass) return sequential(storyJson, knots, externals, options, "single_pass");

  const pilotBudget = Math.min(configuredPilot, maxStates);
  const firstRoundGrants = splitBudget(Math.max(1, Math.floor(maxStates / 10)), specs.map((spec) => spec.weight));
  const pilotRoundGrant = firstRoundGrants[specs.find((spec) => spec.pass === pilotPass)!.index];
  if (pilotBudget > pilotRoundGrant) {
    const result = sequential(storyJson, knots, externals, options);
    result.execution!.fallbackReason = "budget_below_pilot";
    result.execution!.activation = {
      policyVersion: "single-pass-frontier-v3",
      decision: "stay_sequential",
      reason: "budget_below_pilot",
      pilotBudget,
      pilotStatesExplored: 0,
      pilotExhaustive: false,
      pilotPass,
      duplicateStateEvaluations: 0,
      uncertainty: "high",
      productionEligible: true,
    };
    return result;
  }
  const engine = createPortfolioPassEngine(pilotPass, storyJson, knots, externals, {
    ...options,
    onProgress: undefined,
    onSnapshot: undefined,
  });
  const consumed = engine.run(pilotBudget);
  const pilot = { pass: pilotPass, engine, granted: pilotBudget, consumed };
  const snapshot = engine.snapshot();
  const forcedRootCycle = hasForcedRootCycle(snapshot);
  const authoredKnots = knots.filter((knot) => !knot.isFunction).length;
  const pilotConsumedBudget = consumed >= maxStates;
  const reason = forcedRootCycle
    ? "pilot_forced_cycle"
    : engine.exhaustive()
    ? "pilot_exhaustive"
    : pilotConsumedBudget
      ? "pilot_consumed_budget"
      : snapshot.truncatedBy.maxDepth
        ? "pilot_depth_bound"
        : authoredKnots > 0 && snapshot.visitedKnots.length >= authoredKnots
          ? "pilot_authored_frontier_saturated"
          : "pilot_open_frontier";
  const requestedDecision = reason === "pilot_open_frontier" ? "activate_concurrent" : "stay_sequential";
  let result: ExploreResult;

  if (engine.exhaustive() || pilotConsumedBudget || forcedRootCycle) {
    result = engine.finalize();
    const telemetry = engine.telemetry();
    result.passes = [telemetry];
    result.schedule = [{
      round: 1,
      entries: [{
        pass: telemetry.pass,
        granted: pilotBudget,
        consumed,
        newEndings: telemetry.endingsFound,
        newKnots: telemetry.knotsVisited,
        newRuntimeErrors: telemetry.runtimeErrorsFound,
      }],
    }];
    result.execution = {
      mode: "sequential",
      requestedConcurrency: options.concurrency,
      effectiveConcurrency: 1,
      ...(reason === "pilot_open_frontier" ? {} : { fallbackReason: reason }),
      workers: [{
        pass: engine.label,
        granted: pilotBudget,
        consumed,
        status: engine.stoppedForMemory() ? "memory" : engine.stoppedForTime() ? "time" : "completed",
        location: "parent",
      }],
    };
    options.onProgress?.({
      pass: engine.label,
      statesExplored: result.statesExplored,
      endingsFound: result.endingsFound.length,
      runtimeErrorsFound: result.runtimeErrors.length,
      unvisitedKnots: result.unvisitedKnots.length,
      visibleOutcomes: new Set(result.endingsFound.map((ending) => ending.finalText.trim().replace(/\s+/g, " "))).size,
      assertionViolations: result.assertionResults.filter((assertion) => assertion.status === "violated").length,
      goalsReached: (result.goalResults ?? []).filter((goal) => goal.status === "reached").length,
      stagesReached: (result.goalResults ?? []).reduce((total, goal) => total + (goal.stages ?? []).filter((stage) => stage.status === "reached").length, 0),
      discoveryEvents: result.discoverySummary?.discoveryEvents ?? 0,
      statesSinceLastDiscovery: result.discoverySummary?.statesSinceLastDiscovery ?? null,
    });
    options.onSnapshot?.(result);
  } else if (requestedDecision === "stay_sequential") {
    result = explorePortfolioFromPilot(storyJson, knots, externals, options, pilot);
    result.execution = {
      mode: "sequential",
      requestedConcurrency: options.concurrency,
      effectiveConcurrency: 1,
      ...(reason === "pilot_open_frontier" ? {} : { fallbackReason: reason }),
      workers: (result.passes ?? []).map((pass) => ({
        pass: pass.pass,
        granted: pass.granted,
        consumed: pass.statesExplored,
        status: pass.truncatedBy.memory ? "memory" : pass.truncatedBy.time ? "time" : "completed",
        ...(pass.pass === engine.label ? { location: "parent" as const } : {}),
      })),
    };
  } else {
    const cpuCeiling = Math.max(1, availableCpus());
    const globalMemoryCap = options.memoryCapBytes ?? Math.floor(v8.getHeapStatistics().heap_size_limit * 0.85);
    const parentReserve = Math.min(256 * 1024 * 1024, Math.max(MIN_WORKER_HEAP_BYTES, Math.floor(globalMemoryCap * 0.15)));
    const memoryWorkers = Math.floor(Math.max(0, globalMemoryCap - parentReserve) / MIN_WORKER_HEAP_BYTES);
    const workerCount = Math.min(options.concurrency - 1, cpuCeiling - 1, specs.length - 1, memoryWorkers);
    if (workerCount < 1) {
      result = explorePortfolioFromPilot(storyJson, knots, externals, options, pilot);
      result.execution = {
        mode: "sequential",
        requestedConcurrency: options.concurrency,
        effectiveConcurrency: 1,
        fallbackReason: cpuCeiling < 2 ? "single_core" : "memory_headroom",
        workers: (result.passes ?? []).map((pass) => ({
          pass: pass.pass,
          granted: pass.granted,
          consumed: pass.statesExplored,
          status: pass.truncatedBy.memory ? "memory" : pass.truncatedBy.time ? "time" : "completed",
          ...(pass.pass === engine.label ? { location: "parent" as const } : {}),
        })),
      };
    } else {
      const perWorkerMemory = Math.floor((globalMemoryCap - parentReserve) / workerCount);
      result = explorePortfolioAdaptiveConcurrent(
        storyJson,
        knots,
        externals,
        { ...options, memoryCapBytes: globalMemoryCap },
        workerCount,
        perWorkerMemory,
        globalMemoryCap - perWorkerMemory * workerCount,
        pilot
      );
    }
  }
  result.execution!.activation = {
    policyVersion: "single-pass-frontier-v3",
    decision: requestedDecision,
    reason,
    pilotBudget,
    pilotStatesExplored: consumed,
    pilotExhaustive: engine.exhaustive(),
    pilotPass,
    duplicateStateEvaluations: 0,
    uncertainty: "high",
    productionEligible: true,
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
