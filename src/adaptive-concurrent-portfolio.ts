import * as path from "path";
import { MessageChannel, receiveMessageOnPort, Worker } from "worker_threads";
import {
  DEFAULT_PORTFOLIO_WEIGHTS,
  DiscoveryCurveRecorder,
  mergeExploreResults,
  type ConcurrentWorkerEvidence,
  type ExploreOptions,
  type ExploreProgress,
  type ExploreResult,
  type PassTelemetry,
  type PortfolioPassKind,
  type PortfolioWeights,
  type ScheduleRound,
  type ScheduleRoundEntry,
} from "./explore";
import type { KnotInfo } from "./inklecate";
import type {
  AdaptiveFinalPassResult,
  AdaptivePassAssignment,
  AdaptivePortfolioWorkerCommand,
  AdaptivePortfolioWorkerData,
  AdaptivePortfolioWorkerMessage,
  AdaptiveRoundPassResult,
} from "./adaptive-portfolio-worker";

const MAX_WORKER_WAIT_MS = 7 * 24 * 60 * 60 * 1_000;

export interface AdaptiveConcurrentOptions extends ExploreOptions {
  concurrency: number;
  memoryCapBytes: number;
  deadlineMs?: number;
  failPassForTest?: PortfolioPassKind;
}

interface PassSpec {
  index: number;
  pass: PortfolioPassKind;
  weight: number;
}

interface WorkerSlot {
  worker: Worker;
  assignments: AdaptivePassAssignment[];
  control: Int32Array;
  port: MessageChannel["port1"];
  progress: Map<number, ExploreProgress>;
  ready: boolean;
  failed?: string;
  timedOut?: boolean;
  round?: { number: number; results: AdaptiveRoundPassResult[] };
  final?: AdaptiveFinalPassResult[];
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

function passSpecs(maxStates: number, weights: PortfolioWeights): PassSpec[] {
  const specs: Array<Omit<PassSpec, "index">> = [];
  if (weights.last > 0) specs.push({ pass: "dfs:last", weight: weights.last });
  if (weights.first > 0) specs.push({ pass: "dfs:first", weight: weights.first });
  if (weights.insideOut > 0) specs.push({ pass: "dfs:inside-out", weight: weights.insideOut });
  if (weights.beam > 0 && maxStates >= 10) specs.push({ pass: "beam:diversity", weight: weights.beam });
  if (weights.random > 0 && maxStates >= 5) specs.push({ pass: "random", weight: weights.random });
  if (specs.length === 0) specs.push({ pass: "dfs:last", weight: 1 });
  return specs.map((spec, index) => ({ ...spec, index }));
}

function sanitizedOptions(options: AdaptiveConcurrentOptions): ExploreOptions {
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
  return safe;
}

function startSlot(
  assignments: AdaptivePassAssignment[],
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  options: AdaptiveConcurrentOptions,
  perWorkerMemory: number
): WorkerSlot {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const channel = new MessageChannel();
  const data: AdaptivePortfolioWorkerData = {
    assignments,
    storyJson,
    knots,
    externals,
    options: sanitizedOptions(options),
    memoryCapBytes: perWorkerMemory,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.failPassForTest ? { failPassForTest: options.failPassForTest } : {}),
    control: controlBuffer,
    port: channel.port2,
  };
  const worker = new Worker(path.join(__dirname, "adaptive-portfolio-worker.js"), {
    workerData: data,
    transferList: [channel.port2],
    resourceLimits: { maxOldGenerationSizeMb: Math.max(16, Math.floor(perWorkerMemory / (1024 * 1024))) },
  });
  return {
    worker,
    assignments,
    control: new Int32Array(controlBuffer),
    port: channel.port1,
    progress: new Map(),
    ready: false,
  };
}

function drain(slot: WorkerSlot): void {
  for (;;) {
    const message = receiveMessageOnPort(slot.port)?.message as AdaptivePortfolioWorkerMessage | undefined;
    if (!message) break;
    if (message.type === "ready") slot.ready = true;
    else if (message.type === "progress") slot.progress.set(message.index, message.progress);
    else if (message.type === "round") slot.round = { number: message.round, results: message.results };
    else if (message.type === "final") slot.final = message.results;
    else slot.failed = message.error;
  }
  if (!slot.failed && slot.worker.threadId === -1 && !slot.final) {
    slot.failed = "worker exited without a final result";
  }
}

function stopSlot(slot: WorkerSlot): void {
  slot.port.close();
  void slot.worker.terminate();
}

function waitFor(
  slots: WorkerSlot[],
  done: (slot: WorkerSlot) => boolean,
  options: AdaptiveConcurrentOptions,
  emitProgress: () => void
): void {
  const startedAt = Date.now();
  while (slots.some((slot) => !done(slot) && !slot.failed && !slot.timedOut)) {
    for (const slot of slots) drain(slot);
    emitProgress();
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      for (const slot of slots) {
        if (!done(slot) && !slot.failed) slot.timedOut = true;
      }
      break;
    }
    if (Date.now() - startedAt >= MAX_WORKER_WAIT_MS) {
      for (const slot of slots) {
        if (!done(slot) && !slot.failed) slot.failed = "worker exceeded the seven-day executor watchdog";
      }
      break;
    }
    const waiting = slots.find((slot) => !done(slot) && !slot.failed && !slot.timedOut);
    if (waiting) {
      const value = Atomics.load(waiting.control, 0);
      Atomics.wait(waiting.control, 0, value, 50);
    }
  }
  for (const slot of slots) drain(slot);
  emitProgress();
}

function exactEndingKey(ending: ExploreResult["endingsFound"][number]): string {
  return `${ending.finalText}|${JSON.stringify(ending.variables)}`;
}

function visibleOutcomeKey(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function assertionKey(
  assertionId: string,
  violation: ExploreResult["assertionResults"][number]["violations"][number]
): string {
  const values = Object.fromEntries(Object.entries(violation.observedValues).sort(([left], [right]) => left.localeCompare(right)));
  return `${assertionId}|${JSON.stringify(values)}|${JSON.stringify(violation.choiceIndices)}`;
}

export function explorePortfolioAdaptiveConcurrent(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  options: AdaptiveConcurrentOptions,
  effectiveConcurrency: number,
  perWorkerMemory: number
): ExploreResult {
  const maxStates = options.maxStates ?? 100_000;
  const specs = passSpecs(maxStates, options.weights ?? DEFAULT_PORTFOLIO_WEIGHTS);
  const assignments = Array.from({ length: effectiveConcurrency }, () => [] as AdaptivePassAssignment[]);
  for (const spec of specs) assignments[spec.index % effectiveConcurrency].push({ index: spec.index, pass: spec.pass });
  const slots = assignments
    .filter((items) => items.length > 0)
    .map((items) => startSlot(items, storyJson, knots, externals, options, perWorkerMemory));
  const latestSnapshots = new Map<number, ExploreResult>();
  const finalResults = new Map<number, AdaptiveFinalPassResult>();
  let lastProgressStates = -1;
  const emitProgress = () => {
    if (!options.onProgress) return;
    const progress = slots.flatMap((slot) => [...slot.progress.values()]);
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

  waitFor(slots, (slot) => slot.ready, options, emitProgress);
  if (slots.every((slot) => slot.failed || slot.timedOut)) {
    for (const slot of slots) stopSlot(slot);
    throw new Error(`all concurrent portfolio workers failed to initialize: ${slots.map((slot) => slot.failed ?? "deadline elapsed").join("; ")}`);
  }

  const roundSize = Math.max(1, Math.floor(maxStates / 10));
  const minShare = 0.08;
  const schedule: ScheduleRound[] = [];
  const currentWeights = specs.map((spec) => spec.weight);
  const active = specs.map(() => true);
  const marginalTotals = specs.map(() => ({ endings: 0, knots: 0, errors: 0, visible: 0, assertions: 0, goals: 0, stages: 0 }));
  const marginalCurves = specs.map(() => new DiscoveryCurveRecorder());
  const seenEndings = new Set<string>();
  const seenKnots = new Set<string>();
  const seenErrors = new Set<string>();
  const seenVisibleOutcomes = new Set<string>();
  const seenAssertions = new Set<string>();
  const seenGoals = new Set<string>();
  const seenStages = new Set<string>();
  const portfolioCurve = new DiscoveryCurveRecorder();
  let remaining = maxStates;
  let exhaustedEarly = false;
  let memoryStopped = false;
  let timeStopped = false;
  let workerStopped = false;

  while (remaining > 0 && !exhaustedEarly && !memoryStopped && !timeStopped && !workerStopped && active.some(Boolean)) {
    const activeIndices = specs.map((_, index) => index).filter((index) => active[index]);
    const roundBudget = Math.min(roundSize, remaining);
    const grants = splitBudget(roundBudget, activeIndices.map((index) => currentWeights[index]));
    const grantsByIndex = new Map(activeIndices.map((index, offset) => [index, grants[offset]]));
    const roundNumber = schedule.length + 1;
    const commanded = slots.filter((slot) => slot.assignments.some((assignment) => (grantsByIndex.get(assignment.index) ?? 0) > 0));
    for (const slot of commanded) {
      slot.round = undefined;
      const command: AdaptivePortfolioWorkerCommand = {
        type: "run",
        round: roundNumber,
        grants: slot.assignments.flatMap((assignment) => {
          const grant = grantsByIndex.get(assignment.index) ?? 0;
          return grant > 0 ? [{ index: assignment.index, grant }] : [];
        }),
      };
      slot.worker.postMessage(command);
    }
    waitFor(commanded, (slot) => slot.round?.number === roundNumber, options, emitProgress);
    workerStopped = commanded.some((slot) => Boolean(slot.failed));
    timeStopped = commanded.some((slot) => slot.timedOut);
    const roundResults = commanded.flatMap((slot) => slot.round?.number === roundNumber ? slot.round.results : []);
    const resultByIndex = new Map(roundResults.map((result) => [result.index, result]));
    const entries: ScheduleRoundEntry[] = [];
    const scores = new Array<number>(specs.length).fill(0);
    for (const index of activeIndices) {
      const result = resultByIndex.get(index);
      if (!result) continue;
      latestSnapshots.set(index, result.snapshot);
      remaining -= result.consumed;
      let newEndings = 0;
      let newVisibleOutcomes = 0;
      for (const ending of result.snapshot.endingsFound) {
        const key = exactEndingKey(ending);
        if (!seenEndings.has(key)) {
          seenEndings.add(key);
          newEndings++;
        }
        const visibleKey = visibleOutcomeKey(ending.finalText);
        if (!seenVisibleOutcomes.has(visibleKey)) {
          seenVisibleOutcomes.add(visibleKey);
          newVisibleOutcomes++;
        }
      }
      let newKnots = 0;
      for (const knot of result.snapshot.visitedKnots) {
        if (!seenKnots.has(knot)) {
          seenKnots.add(knot);
          newKnots++;
        }
      }
      let newRuntimeErrors = 0;
      for (const error of result.snapshot.runtimeErrors) {
        if (!seenErrors.has(error.message)) {
          seenErrors.add(error.message);
          newRuntimeErrors++;
        }
      }
      let newAssertions = 0;
      for (const assertion of result.snapshot.assertionResults) {
        for (const violation of assertion.violations) {
          const key = assertionKey(assertion.id, violation);
          if (!seenAssertions.has(key)) {
            seenAssertions.add(key);
            newAssertions++;
          }
        }
      }
      let newGoals = 0;
      let newStages = 0;
      for (const goal of result.snapshot.goalResults ?? []) {
        if (goal.status === "reached" && !seenGoals.has(goal.id)) {
          seenGoals.add(goal.id);
          newGoals++;
        }
        for (const stage of goal.stages ?? []) {
          const key = `${goal.id}/${stage.id}`;
          if (stage.status === "reached" && !seenStages.has(key)) {
            seenStages.add(key);
            newStages++;
          }
        }
      }
      marginalTotals[index].endings += newEndings;
      marginalTotals[index].knots += newKnots;
      marginalTotals[index].errors += newRuntimeErrors;
      marginalTotals[index].visible += newVisibleOutcomes;
      marginalTotals[index].assertions += newAssertions;
      marginalTotals[index].goals += newGoals;
      marginalTotals[index].stages += newStages;
      marginalCurves[index].observe(result.snapshot.statesExplored, {
        endingsFound: marginalTotals[index].endings,
        runtimeErrorsFound: marginalTotals[index].errors,
        knotsVisited: marginalTotals[index].knots,
        visibleOutcomes: marginalTotals[index].visible,
        assertionViolations: marginalTotals[index].assertions,
        goalsReached: marginalTotals[index].goals,
        stagesReached: marginalTotals[index].stages,
        uniqueStatesObserved: 0,
      });
      entries.push({
        pass: result.label,
        granted: result.granted,
        consumed: result.consumed,
        newEndings,
        newKnots,
        newRuntimeErrors,
      });
      scores[index] = newRuntimeErrors * 5 + newEndings * 3 + newKnots * 2;
      portfolioCurve.observe(maxStates - remaining, {
        endingsFound: seenEndings.size,
        runtimeErrorsFound: seenErrors.size,
        knotsVisited: seenKnots.size,
        visibleOutcomes: seenVisibleOutcomes.size,
        assertionViolations: seenAssertions.size,
        goalsReached: seenGoals.size,
        stagesReached: seenStages.size,
        uniqueStatesObserved: 0,
      });
      active[index] = !result.done;
      memoryStopped ||= result.memoryStopped;
      timeStopped ||= result.timeStopped;
      exhaustedEarly ||= result.exhaustive;
    }
    schedule.push({ round: roundNumber, entries });
    if (options.onSnapshot && latestSnapshots.size > 0) {
      const snapshots = [...latestSnapshots.entries()].sort(([left], [right]) => left - right).map(([, value]) => structuredClone(value));
      const [first, ...rest] = snapshots;
      const snapshot = rest.reduce((merged, value) => mergeExploreResults(merged, value), first);
      snapshot.limits.maxStates = maxStates;
      snapshot.schedule = structuredClone(schedule);
      snapshot.discoveryCurve = portfolioCurve.result();
      snapshot.discoverySummary = portfolioCurve.summary(maxStates - remaining);
      options.onSnapshot(snapshot);
    }
    const totalScore = scores.reduce((left, right) => left + right, 0);
    if (totalScore > 0) {
      const pool = 1 - minShare * specs.length;
      for (let index = 0; index < currentWeights.length; index++) {
        currentWeights[index] = minShare + Math.max(0, pool) * (scores[index] / totalScore);
      }
    }
  }

  const surviving = slots.filter((slot) => !slot.failed && !slot.timedOut);
  for (const slot of surviving) {
    slot.final = undefined;
    slot.worker.postMessage({ type: "finalize" } satisfies AdaptivePortfolioWorkerCommand);
  }
  waitFor(surviving, (slot) => slot.final !== undefined, options, emitProgress);
  for (const slot of surviving) {
    for (const result of slot.final ?? []) finalResults.set(result.index, result);
  }
  for (const [index, final] of finalResults) latestSnapshots.set(index, final.result);
  for (const slot of slots) stopSlot(slot);

  const orderedResults = [...latestSnapshots.entries()].sort(([left], [right]) => left - right);
  if (orderedResults.length === 0) {
    throw new Error("all concurrent portfolio workers failed before returning usable evidence");
  }
  const perPassStates = new Map(specs.map((spec) => [
    spec.index,
    finalResults.get(spec.index)?.telemetry.statesExplored ?? latestSnapshots.get(spec.index)?.statesExplored ?? 0,
  ]));
  const [first, ...rest] = orderedResults.map(([, result]) => result);
  const merged = rest.reduce((value, result) => mergeExploreResults(value, result), first);
  merged.limits.maxStates = maxStates;
  merged.schedule = schedule;
  merged.discoveryCurve = portfolioCurve.result();
  merged.discoverySummary = portfolioCurve.summary(maxStates - remaining);
  const telemetry: PassTelemetry[] = [];
  for (const spec of specs) {
    const final = finalResults.get(spec.index);
    if (!final) continue;
    telemetry.push({
      ...final.telemetry,
      newEndings: marginalTotals[spec.index].endings,
      newKnots: marginalTotals[spec.index].knots,
      newRuntimeErrors: marginalTotals[spec.index].errors,
      portfolioMarginalCurve: marginalCurves[spec.index].result(),
      portfolioMarginalSummary: marginalCurves[spec.index].summary(final.telemetry.statesExplored),
    });
  }
  merged.passes = telemetry;
  if (workerStopped && !merged.exhaustive) {
    merged.truncated = true;
    merged.truncatedBy.worker = true;
    merged.truncatedBy.maxStates = false;
  } else if (memoryStopped && !merged.exhaustive) {
    merged.truncated = true;
    merged.truncatedBy.memory = true;
    merged.truncatedBy.maxStates = false;
  } else if (timeStopped && !merged.exhaustive) {
    merged.truncated = true;
    merged.truncatedBy.time = true;
    merged.truncatedBy.maxStates = false;
  }
  const granted = specs.map((spec) => schedule.reduce(
    (total, round) => total + (round.entries.find((entry) => entry.pass === (finalResults.get(spec.index)?.telemetry.pass ?? spec.pass))?.granted ?? 0),
    0
  ));
  // mergeExploreResults mutates its first result, so worker accounting must
  // read the immutable per-pass telemetry captured before the canonical merge.
  const consumed = specs.map((spec) => perPassStates.get(spec.index) ?? 0);
  const workerEvidence: ConcurrentWorkerEvidence[] = specs.map((spec) => {
    const slot = slots[spec.index % effectiveConcurrency];
    const passTelemetry = finalResults.get(spec.index)?.telemetry;
    return {
      pass: finalResults.get(spec.index)?.telemetry.pass ?? spec.pass,
      granted: granted[spec.index],
      consumed: consumed[spec.index],
      status: slot.failed ? "failed" : slot.timedOut || passTelemetry?.truncatedBy.time ? "time" : passTelemetry?.truncatedBy.memory ? "memory" : "completed",
      ...(slot.failed ? { error: slot.failed } : {}),
    };
  });
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
    visibleOutcomes: seenVisibleOutcomes.size,
    assertionViolations: seenAssertions.size,
    goalsReached: seenGoals.size,
    stagesReached: seenStages.size,
    discoveryEvents: merged.discoverySummary?.discoveryEvents ?? 0,
    statesSinceLastDiscovery: merged.discoverySummary?.statesSinceLastDiscovery ?? null,
  });
  return merged;
}
