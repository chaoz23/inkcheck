import * as os from "os";
import * as path from "path";
import * as v8 from "v8";
import { MessageChannel, receiveMessageOnPort, Worker } from "worker_threads";
import {
  DEFAULT_PORTFOLIO_WEIGHTS,
  DiscoveryCurveRecorder,
  explorePortfolio,
  mergeExploreResults,
  type ConcurrentWorkerEvidence,
  type ExploreOptions,
  type ExploreProgress,
  type ExploreResult,
  type PortfolioWeights,
  type ScheduleRoundEntry,
} from "./explore";
import type { KnotInfo } from "./inklecate";
import type { PortfolioPassKind, PortfolioWorkerData, PortfolioWorkerMessage } from "./portfolio-worker";

const MAX_PORTFOLIO_CONCURRENCY = 16;
const MIN_WORKER_HEAP_BYTES = 64 * 1024 * 1024;
const MAX_WORKER_WAIT_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ConcurrentPortfolioOptions extends ExploreOptions {
  concurrency: number;
  memoryCapBytes?: number;
  deadlineMs?: number;
  /** Deterministic failure injection for worker-loss contract tests. */
  failPassForTest?: PortfolioPassKind;
}

interface PassPlan {
  pass: PortfolioPassKind;
  weight: number;
  grant: number;
}

interface WorkerOutcome {
  plan: PassPlan;
  result?: ExploreResult;
  status: ConcurrentWorkerEvidence["status"];
  error?: string;
}

interface RunningWorker {
  worker: Worker;
  plan: PassPlan;
  control: Int32Array;
  port: MessageChannel["port1"];
  progress?: ExploreProgress;
}

function availableCpus(): number {
  return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
}

function splitBudget(total: number, weights: number[]): number[] {
  const sum = weights.reduce((left, right) => left + right, 0);
  if (sum <= 0) return weights.map((_, index) => index === 0 ? total : 0);
  const shares = weights.map((weight) => total * weight / sum);
  const grants = shares.map(Math.floor);
  let remaining = total - grants.reduce((left, right) => left + right, 0);
  const order = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; remaining > 0; index = (index + 1) % order.length) {
    grants[order[index].index]++;
    remaining--;
  }
  return grants;
}

function plans(maxStates: number, weights: PortfolioWeights): PassPlan[] {
  const candidates: Array<Omit<PassPlan, "grant">> = [];
  if (weights.last > 0) candidates.push({ pass: "dfs:last", weight: weights.last });
  if (weights.first > 0) candidates.push({ pass: "dfs:first", weight: weights.first });
  if (weights.insideOut > 0) candidates.push({ pass: "dfs:inside-out", weight: weights.insideOut });
  if (weights.beam > 0 && maxStates >= 10) candidates.push({ pass: "beam:diversity", weight: weights.beam });
  if (weights.random > 0 && maxStates >= 5) candidates.push({ pass: "random", weight: weights.random });
  if (candidates.length === 0) candidates.push({ pass: "dfs:last", weight: 1 });
  const grants = splitBudget(maxStates, candidates.map((candidate) => candidate.weight));
  return candidates
    .map((candidate, index) => ({ ...candidate, grant: grants[index] }))
    .filter((candidate) => candidate.grant > 0);
}

function sanitizedOptions(options: ConcurrentPortfolioOptions, grant: number): ExploreOptions {
  const {
    concurrency: _concurrency,
    memoryCapBytes: _memoryCapBytes,
    deadlineMs: _deadlineMs,
    failPassForTest: _failPassForTest,
    onProgress: _onProgress,
    onSnapshot: _onSnapshot,
    memoryGuard: _memoryGuard,
    timeGuard: _timeGuard,
    weights: _weights,
    ...safe
  } = options;
  return { ...safe, maxStates: grant };
}

function sequential(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  options: ConcurrentPortfolioOptions,
  fallbackReason?: "single_core" | "memory_headroom" | "single_pass"
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

function runWorker(
  plan: PassPlan,
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  options: ConcurrentPortfolioOptions,
  memoryCapBytes: number
): RunningWorker {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(controlBuffer);
  const channel = new MessageChannel();
  const data: PortfolioWorkerData = {
    pass: plan.pass,
    storyJson,
    knots,
    externals,
    options: sanitizedOptions(options, plan.grant),
    memoryCapBytes,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.failPassForTest === plan.pass ? { failForTest: true } : {}),
    control: controlBuffer,
    port: channel.port2,
  };
  const worker = new Worker(path.join(__dirname, "portfolio-worker.js"), {
    workerData: data,
    transferList: [channel.port2],
    resourceLimits: { maxOldGenerationSizeMb: Math.max(16, Math.floor(memoryCapBytes / (1024 * 1024))) },
  });
  return { worker, plan, control, port: channel.port1 };
}

function tryCollectWorker(
  running: RunningWorker,
  deadlineMs: number | undefined
): WorkerOutcome | undefined {
  const signalled = Atomics.load(running.control, 0) !== 0;
  const exited = running.worker.threadId === -1;
  const timedOut = deadlineMs !== undefined && Date.now() >= deadlineMs;
  let received: Extract<PortfolioWorkerMessage, { type: "result" }> | undefined;
  for (;;) {
    const message = receiveMessageOnPort(running.port)?.message as PortfolioWorkerMessage | undefined;
    if (!message) break;
    if (message.type === "progress") running.progress = message.progress;
    else received = message;
  }
  if (!received && !signalled && !exited && !timedOut) return undefined;
  running.port.close();
  void running.worker.terminate();
  if (!received) {
    return {
      plan: running.plan,
      status: timedOut ? "time" : "failed",
      error: timedOut ? "worker exceeded the shared deadline" : "worker exited without a result",
    };
  }
  if (!received.ok) {
    return { plan: running.plan, status: "failed", error: received.error.slice(0, 512) };
  }
  const status = received.result.truncatedBy.memory
    ? "memory"
    : received.result.truncatedBy.time
      ? "time"
      : "completed";
  return { plan: running.plan, result: received.result, status };
}

function runPool(
  passPlans: PassPlan[],
  effectiveConcurrency: number,
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  options: ConcurrentPortfolioOptions,
  perWorkerMemory: number
): WorkerOutcome[] {
  const outcomes = new Array<WorkerOutcome | undefined>(passPlans.length);
  const active: Array<{ index: number; running: RunningWorker }> = [];
  const waitStartedAt = Date.now();
  let next = 0;
  let lastProgressStates = -1;
  const emitProgress = () => {
    if (!options.onProgress) return;
    const progress = [
      ...outcomes.flatMap((outcome) => outcome?.result?.passes?.[0]
        ? [{
            pass: outcome.result.passes[0].pass,
            statesExplored: outcome.result.statesExplored,
            endingsFound: outcome.result.endingsFound.length,
            runtimeErrorsFound: outcome.result.runtimeErrors.length,
            unvisitedKnots: outcome.result.unvisitedKnots.length,
            visibleOutcomes: new Set(outcome.result.endingsFound.map((ending) => ending.finalText.trim().replace(/\s+/g, " "))).size,
            assertionViolations: outcome.result.assertionResults.reduce((total, assertion) => total + assertion.violations.length, 0),
            goalsReached: (outcome.result.goalResults ?? []).filter((goal) => goal.status === "reached").length,
            stagesReached: (outcome.result.goalResults ?? []).reduce((total, goal) => total + (goal.stages ?? []).filter((stage) => stage.status === "reached").length, 0),
            discoveryEvents: outcome.result.discoverySummary?.discoveryEvents ?? 0,
            statesSinceLastDiscovery: outcome.result.discoverySummary?.statesSinceLastDiscovery ?? null,
          } satisfies ExploreProgress]
        : []),
      ...active.flatMap((item) => item.running.progress ? [item.running.progress] : []),
    ];
    const statesExplored = progress.reduce((total, item) => total + item.statesExplored, 0);
    if (statesExplored <= lastProgressStates) return;
    lastProgressStates = statesExplored;
    const max = (field: keyof ExploreProgress) => Math.max(0, ...progress.map((item) => Number(item[field]) || 0));
    options.onProgress({
      pass: "portfolio:concurrent",
      statesExplored,
      endingsFound: max("endingsFound"),
      runtimeErrorsFound: max("runtimeErrorsFound"),
      unvisitedKnots: progress.length ? Math.min(...progress.map((item) => item.unvisitedKnots)) : knots.length,
      visibleOutcomes: max("visibleOutcomes"),
      assertionViolations: max("assertionViolations"),
      goalsReached: max("goalsReached"),
      stagesReached: max("stagesReached"),
      discoveryEvents: max("discoveryEvents"),
      statesSinceLastDiscovery: null,
    });
  };
  const launch = () => {
    while (active.length < effectiveConcurrency && next < passPlans.length
      && (options.deadlineMs === undefined || Date.now() < options.deadlineMs)) {
      const index = next++;
      active.push({
        index,
        running: runWorker(passPlans[index], storyJson, knots, externals, options, perWorkerMemory),
      });
    }
  };
  launch();
  while (active.length > 0) {
    let completed = false;
    for (let index = active.length - 1; index >= 0; index--) {
      const outcome = tryCollectWorker(active[index].running, options.deadlineMs);
      if (!outcome) continue;
      outcomes[active[index].index] = outcome;
      active.splice(index, 1);
      completed = true;
    }
    emitProgress();
    if (completed) {
      launch();
      continue;
    }
    if (Date.now() - waitStartedAt >= MAX_WORKER_WAIT_MS) {
      for (const item of active) {
        item.running.port.close();
        void item.running.worker.terminate();
        outcomes[item.index] = {
          plan: item.running.plan,
          status: "failed",
          error: "worker exceeded the seven-day executor watchdog",
        };
      }
      active.length = 0;
      break;
    }
    Atomics.wait(active[0].running.control, 0, 0, 50);
  }
  for (; next < passPlans.length; next++) {
    outcomes[next] = {
      plan: passPlans[next],
      status: "time",
      error: "shared deadline elapsed before this worker started",
    };
  }
  return outcomes.filter((outcome): outcome is WorkerOutcome => outcome !== undefined);
}

function marginalEntry(result: ExploreResult, plan: PassPlan, seen: {
  endings: Set<string>;
  knots: Set<string>;
  errors: Set<string>;
}): ScheduleRoundEntry {
  let newEndings = 0;
  for (const ending of result.endingsFound) {
    const key = `${ending.finalText}\0${JSON.stringify(ending.variables)}`;
    if (!seen.endings.has(key)) {
      seen.endings.add(key);
      newEndings++;
    }
  }
  let newKnots = 0;
  for (const knot of result.visitedKnots) {
    if (!seen.knots.has(knot)) {
      seen.knots.add(knot);
      newKnots++;
    }
  }
  let newRuntimeErrors = 0;
  for (const error of result.runtimeErrors) {
    if (!seen.errors.has(error.message)) {
      seen.errors.add(error.message);
      newRuntimeErrors++;
    }
  }
  return {
    pass: plan.pass === "random" ? result.passes?.[0]?.pass ?? plan.pass : plan.pass,
    granted: plan.grant,
    consumed: result.statesExplored,
    newEndings,
    newKnots,
    newRuntimeErrors,
  };
}

/**
 * Run the existing complementary portfolio passes in bounded worker slots.
 * Pass grants and merge order are canonical, so worker completion timing does
 * not affect final evidence. This first executor uses one fixed weighted
 * allocation; promotion evidence is required before it can replace the
 * adaptive sequential default. The fixed allocator is an experimental worker
 * substrate, not a promotion candidate; see docs/concurrency-evaluation.md.
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
  const passPlans = plans(maxStates, options.weights ?? DEFAULT_PORTFOLIO_WEIGHTS);
  if (options.concurrency === 1) return sequential(storyJson, knots, externals, options);
  if (passPlans.length === 1) return sequential(storyJson, knots, externals, options, "single_pass");
  const cpuCeiling = Math.max(1, availableCpus());
  if (cpuCeiling < 2) return sequential(storyJson, knots, externals, options, "single_core");
  const globalMemoryCap = options.memoryCapBytes ?? Math.floor(v8.getHeapStatistics().heap_size_limit * 0.85);
  const parentReserve = Math.min(256 * 1024 * 1024, Math.max(MIN_WORKER_HEAP_BYTES, Math.floor(globalMemoryCap * 0.15)));
  const memoryConcurrency = Math.floor(Math.max(0, globalMemoryCap - parentReserve) / MIN_WORKER_HEAP_BYTES);
  const effectiveConcurrency = Math.min(options.concurrency, cpuCeiling, passPlans.length, memoryConcurrency);
  if (effectiveConcurrency < 2) return sequential(storyJson, knots, externals, options, "memory_headroom");
  const perWorkerMemory = Math.floor((globalMemoryCap - parentReserve) / effectiveConcurrency);
  const outcomes = runPool(
    passPlans,
    effectiveConcurrency,
    storyJson,
    knots,
    externals,
    options,
    perWorkerMemory
  );
  const successful = outcomes.filter((outcome): outcome is WorkerOutcome & { result: ExploreResult } => outcome.result !== undefined);
  if (successful.length === 0) {
    throw new Error(`all concurrent portfolio workers failed: ${outcomes.map((outcome) => `${outcome.plan.pass}: ${outcome.error}`).join("; ")}`);
  }
  const seen = { endings: new Set<string>(), knots: new Set<string>(), errors: new Set<string>() };
  const visibleOutcomes = new Set<string>();
  const assertionViolations = new Set<string>();
  const goals = new Set<string>();
  const stages = new Set<string>();
  const curve = new DiscoveryCurveRecorder();
  let canonicalStates = 0;
  const scheduleEntries = successful.map((outcome) => {
    const entry = marginalEntry(outcome.result, outcome.plan, seen);
    canonicalStates += outcome.result.statesExplored;
    for (const ending of outcome.result.endingsFound) visibleOutcomes.add(ending.finalText.trim().replace(/\s+/g, " "));
    for (const assertion of outcome.result.assertionResults) {
      for (const violation of assertion.violations) {
        assertionViolations.add(`${assertion.id}\0${JSON.stringify(violation.observedValues)}\0${JSON.stringify(violation.choiceIndices)}`);
      }
    }
    for (const goal of outcome.result.goalResults ?? []) {
      if (goal.status === "reached") goals.add(goal.id);
      for (const stage of goal.stages ?? []) if (stage.status === "reached") stages.add(`${goal.id}/${stage.id}`);
    }
    curve.observe(canonicalStates, {
      endingsFound: seen.endings.size,
      runtimeErrorsFound: seen.errors.size,
      knotsVisited: seen.knots.size,
      visibleOutcomes: visibleOutcomes.size,
      assertionViolations: assertionViolations.size,
      goalsReached: goals.size,
      stagesReached: stages.size,
      uniqueStatesObserved: 0,
    });
    return entry;
  });
  const workerEvidence: ConcurrentWorkerEvidence[] = outcomes.map((outcome) => ({
    pass: outcome.plan.pass,
    granted: outcome.plan.grant,
    consumed: outcome.result?.statesExplored ?? 0,
    status: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
  }));
  const [first, ...rest] = successful;
  const merged = rest.reduce((result, outcome) => mergeExploreResults(result, outcome.result), first.result);
  merged.limits.maxStates = maxStates;
  merged.schedule = [{
    round: 1,
    entries: scheduleEntries,
  }];
  merged.discoveryCurve = curve.result();
  merged.discoverySummary = curve.summary(merged.statesExplored);
  const failed = outcomes.some((outcome) => outcome.status === "failed");
  const timedOut = outcomes.some((outcome) => outcome.status === "time");
  if (failed && !merged.exhaustive) {
    merged.truncated = true;
    merged.truncatedBy.worker = true;
  } else if (timedOut && !merged.exhaustive) {
    merged.truncated = true;
    merged.truncatedBy.time = true;
    merged.truncatedBy.maxStates = false;
  }
  merged.execution = {
    mode: "concurrent",
    requestedConcurrency: options.concurrency,
    effectiveConcurrency,
    workers: workerEvidence,
  };
  options.onProgress?.({
    pass: "portfolio:concurrent",
    statesExplored: merged.statesExplored,
    endingsFound: merged.endingsFound.length,
    runtimeErrorsFound: merged.runtimeErrors.length,
    unvisitedKnots: merged.unvisitedKnots.length,
    visibleOutcomes: visibleOutcomes.size,
    assertionViolations: assertionViolations.size,
    goalsReached: goals.size,
    stagesReached: stages.size,
    discoveryEvents: merged.discoverySummary?.discoveryEvents ?? 0,
    statesSinceLastDiscovery: merged.discoverySummary?.statesSinceLastDiscovery ?? null,
  });
  options.onSnapshot?.(merged);
  return merged;
}
