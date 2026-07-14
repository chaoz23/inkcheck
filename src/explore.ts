import { createHash } from "crypto";
import { Story } from "inkjs";
import { KnotInfo, DEFAULT_MAX_DEPTH } from "./inklecate";
import {
  rarityWeight,
  runtimeErrorKey,
  variableChanges,
  variableStateKey,
  variableTransitionKey,
} from "./search-benchmark";
import {
  AssertionDefinition,
  AssertionResult,
  AssertionTracker,
  validateAssertions,
} from "./assertions";
import { GoalDefinition, GoalResult, GoalTracker, validateGoals } from "./goals";
import { recommendShadowDecision, type ShadowDecision } from "./decision-policy";
import { CumulativeFloorAllocator, type FloorAllocation } from "./floor-allocator";

export const DEFAULT_STORY_SEED = 1;
export const MAX_STORY_SEED = 2_147_483_646;

export interface PlaytestStep {
  text: string;
  tags: string[];
  choicesOffered: string[];
  choiceTaken: number | null;
}

export interface PlaytestResult {
  /** Initial Ink runtime RNG seed used for this replay. */
  storySeed: number;
  steps: PlaytestStep[];
  ended: boolean;
  /** Choices remaining at the point the transcript stopped (empty if the story ended). */
  pendingChoices: string[];
  variables: Record<string, unknown>;
  runtimeErrors: string[];
  runtimeWarnings: string[];
  /** EXTERNAL functions replaced with zero during this playtest. */
  externalFunctionsStubbed: string[];
  /** Whether an indexed witness still follows the same shape. */
  replayStatus: "completed" | "runtime_error" | "path_changed";
}

export interface EndingReport {
  /** Choice-text trail that led here, e.g. ["Pick the lock", "Go north"]. */
  path: string[];
  /** Zero-based choice indices matching `path`, suitable for exact replay. */
  choiceIndices: number[];
  /** Transition count when this finding was first observed. */
  firstDiscoveredAtState: number;
  finalText: string;
  variables: Record<string, unknown>;
  /** Search pass that found this ending, e.g. "dfs:last" or "random:seed=1". */
  foundBy?: string;
}

export interface RuntimeErrorReport {
  message: string;
  path: string[];
  choiceIndices: number[];
  firstDiscoveredAtState: number;
  sourceLocation?: { file: string; line: number; approximate: boolean };
  /** Search pass that found this error, e.g. "dfs:last" or "random:seed=1". */
  foundBy?: string;
}

/** Which configured limit cut coverage short, when `truncated` is true. */
export interface TruncationCauses {
  /** At least one live path was cut at the depth limit. */
  maxDepth: boolean;
  /** The state budget ran out with work remaining. */
  maxStates: boolean;
  /** The beam pass pruned reachable states at its frontier cap. */
  beamWidth: boolean;
  /** Exploration stopped early to stay under the memory guard. */
  memory: boolean;
  /** Exploration stopped early because the wall-clock time budget elapsed. */
  time: boolean;
}

export interface UnvisitedKnotReport {
  name: string;
  file: string;
  line: number;
  /** Authored diverts/threads targeting this knot found in the source. */
  inboundDiverts?: number;
  /** No authored divert found — the knot may be orphaned (triage hint, not proof). */
  staticOrphanCandidate?: boolean;
}

export interface ExploreResult {
  statesExplored: number;
  endingsFound: EndingReport[];
  runtimeErrors: RuntimeErrorReport[];
  assertionResults: AssertionResult[];
  /** Optional author/agent search targets; absent for ordinary runs. */
  goalResults?: GoalResult[];
  /** Configured and consumed allocation when explicit goals steer part of a run. */
  goalBudget?: {
    generalGranted: number;
    generalConsumed: number;
    directedGranted: number;
    directedConsumed: number;
  };
  runtimeWarnings: string[];
  /** Authored knots never visited on any explored path (functions excluded). */
  unvisitedKnots: UnvisitedKnotReport[];
  visitedKnots: string[];
  /** EXTERNAL functions that were replaced with a constant zero during exploration. */
  externalFunctionsStubbed: string[];
  /** Whether Ink random functions or shuffle sequences occur in the source. */
  randomnessDetected: boolean;
  truncated: boolean;
  /** Which limit(s) actually cut coverage, so reports can advise which to raise. */
  truncatedBy: TruncationCauses;
  /**
   * A systematic pass (DFS/BFS/beam) visited every reachable state without
   * hitting any limit. When true after a merge, the whole run is complete and
   * sampling-slice budget exhaustion no longer counts as truncation.
   */
  exhaustive: boolean;
  limits: {
    maxDepth: number;
    /** Ordinary baseline/repro exploration budget. */
    maxStates: number;
    /** Explicit additional directed-goal budget. */
    goalMaxStates?: number;
    /** Combined configured work ceiling when goal work is enabled. */
    totalMaxStates?: number;
    seed?: number;
    /** Initial Ink runtime RNG seed, independent of the search sampling seed. */
    storySeed: number;
  };
  /** Portfolio runs only: the adaptive schedule that was actually executed. */
  schedule?: ScheduleRound[];
  /** Lifetime per-pass telemetry; merges concatenate contributing passes. */
  passes?: PassTelemetry[];
  /** Portfolio-wide meaningful discoveries in actual interleaved execution order. */
  discoveryCurve?: DiscoveryCurveSample[];
  discoverySummary?: DiscoveryCurveSummary;
  /** Research-only replay of shadow reallocation decisions; never emitted by the default portfolio. */
  policyReplay?: PolicyReplayRound[];
}

/**
 * Key a story state while preserving semantically relevant hidden state.
 * Ink stories can inspect TURNS() and make later random choices, so those
 * fields are removed only when a source scan has established they are unused.
 */
export function stateKey(
  stateJson: string,
  sensitivity: { turns?: boolean; randomness?: boolean } = { turns: true, randomness: true }
): string {
  try {
    const state = JSON.parse(stateJson);
    if (sensitivity.turns === false) delete state.turnIdx;
    if (sensitivity.randomness === false) {
      delete state.storySeed;
      delete state.previousRandom;
    }
    return createHash("sha1").update(JSON.stringify(state)).digest("hex");
  } catch {
    return createHash("sha1").update(stateJson).digest("hex");
  }
}

function cleanInkValue(v: unknown): unknown {
  if (typeof v === "string" && v.startsWith("^")) return v.slice(1);
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

function extractVariables(story: InstanceType<typeof Story>): Record<string, unknown> {
  try {
    // Ink save JSON contains only globals changed from their defaults. Enumerate
    // the declared globals instead, then use the public VariablesState accessor
    // so unchanged variables remain visible to reports and assertions.
    const state = story.variablesState as unknown as {
      _defaultGlobalVariables?: Map<string, unknown>;
      [name: string]: unknown;
    };
    const out: Record<string, unknown> = {};
    for (const name of state._defaultGlobalVariables?.keys() ?? []) {
      out[name] = cleanInkValue(state[name]);
    }
    return out;
  } catch {
    return {};
  }
}

function assertionKnotCounts(
  story: InstanceType<typeof Story>,
  definitions: AssertionDefinition[] | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rule of definitions ?? []) {
    if (typeof rule.when !== "object" || counts.has(rule.when.knot)) continue;
    try {
      counts.set(rule.when.knot, story.state.VisitCountAtPathString(rule.when.knot));
    } catch {
      counts.set(rule.when.knot, 0);
    }
  }
  return counts;
}

function enteredAssertionKnots(
  story: InstanceType<typeof Story>,
  before: Map<string, number>
): string[] {
  return [...before].filter(([name, count]) => {
    try {
      return story.state.VisitCountAtPathString(name) > count;
    } catch {
      return false;
    }
  }).map(([name]) => name);
}

function assertionTracker(
  story: InstanceType<typeof Story>,
  knots: KnotInfo[],
  definitions: AssertionDefinition[] | undefined,
  foundBy: string
): AssertionTracker {
  const rules = definitions ?? [];
  const issues = validateAssertions(rules, extractVariables(story), knots.filter((knot) => !knot.isFunction).map((knot) => knot.name));
  if (issues.length) throw new RangeError(`Invalid assertions:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  return new AssertionTracker(
    rules,
    foundBy,
    Object.fromEntries(knots.filter((knot) => !knot.isFunction).map((knot) => [knot.name, { file: knot.file, line: knot.line }]))
  );
}

export function validateAssertionsForStory(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  definitions: AssertionDefinition[]
): void {
  const session = makeStory(storyJson, externals);
  continueMaximally(session);
  const issues = validateAssertions(
    definitions,
    extractVariables(session.story),
    knots.filter((knot) => !knot.isFunction).map((knot) => knot.name)
  );
  if (issues.length) throw new RangeError(`Invalid assertions:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
}

export function validateGoalsForStory(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  goals: GoalDefinition[]
): void {
  const session = makeStory(storyJson, externals);
  continueMaximally(session);
  const issues = validateGoals(
    goals,
    extractVariables(session.story),
    knots.filter((knot) => !knot.isFunction).map((knot) => knot.name)
  );
  if (issues.length) throw new RangeError(`Invalid goals:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
}

interface StorySession {
  story: InstanceType<typeof Story>;
  errors: string[];
  warnings: string[];
}

function normalizeStorySeed(storySeed = DEFAULT_STORY_SEED): number {
  if (!Number.isSafeInteger(storySeed) || storySeed < 1 || storySeed > MAX_STORY_SEED) {
    throw new RangeError(`storySeed must be an integer from 1 to ${MAX_STORY_SEED}`);
  }
  return storySeed;
}

function makeStory(
  storyJson: string,
  externals: string[],
  storySeed = DEFAULT_STORY_SEED
): StorySession {
  const story = new Story(storyJson);
  const normalizedStorySeed = normalizeStorySeed(storySeed);
  story.state.storySeed = normalizedStorySeed;
  story.state.previousRandom = 0;
  const errors: string[] = [];
  const warnings: string[] = [];
  story.onError = (msg: string, type: number) => {
    // inkjs ErrorType: 0 Author(TODO), 1 Warning, 2 Error
    if (type === 2) errors.push(msg);
    else warnings.push(msg);
  };
  story.allowExternalFunctionFallbacks = true;
  for (const name of externals) {
    try {
      story.BindExternalFunction(name, () => 0, true);
    } catch {
      /* already bound via fallback */
    }
  }
  return { story, errors, warnings };
}

/** Continue() as far as possible, collecting text and tags; errors go to the session. */
function continueMaximally(s: StorySession): PlaytestStep {
  const step: PlaytestStep = { text: "", tags: [], choicesOffered: [], choiceTaken: null };
  const parts: string[] = [];
  try {
    while (s.story.canContinue) {
      parts.push(s.story.Continue() ?? "");
      if (s.story.currentTags?.length) step.tags.push(...s.story.currentTags);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    let position = "";
    try {
      const p = s.story.state.currentPathString ?? s.story.state.previousPointer?.path?.toString();
      if (p) position = ` (at ${p})`;
    } catch {
      /* position unavailable */
    }
    s.errors.push(msg + position);
  }
  step.text = parts.join("");
  step.choicesOffered = s.story.currentChoices.map((c: { text: string }) => c.text);
  return step;
}

/** Play a single scripted path through a compiled story. */
export function playtest(
  storyJson: string,
  choices: number[],
  externals: string[] = [],
  storySeed = DEFAULT_STORY_SEED
): PlaytestResult {
  const normalizedStorySeed = normalizeStorySeed(storySeed);
  const s = makeStory(storyJson, externals, normalizedStorySeed);
  const steps: PlaytestStep[] = [];
  let pathChanged = false;
  let step = continueMaximally(s);
  for (const idx of choices) {
    if (idx < 0 || idx >= s.story.currentChoices.length) {
      pathChanged = true;
      s.errors.push(
        `Choice index ${idx} out of range (${s.story.currentChoices.length} available) after: "${step.text.trim().slice(-80)}"`
      );
      break;
    }
    step.choiceTaken = idx;
    steps.push(step);
    try {
      s.story.ChooseChoiceIndex(idx);
    } catch (e) {
      s.errors.push(e instanceof Error ? e.message : String(e));
      break;
    }
    step = continueMaximally(s);
  }
  steps.push(step);
  const ended =
    s.errors.length === 0 && !s.story.canContinue && s.story.currentChoices.length === 0;
  return {
    storySeed: normalizedStorySeed,
    steps,
    ended,
    pendingChoices: s.story.currentChoices.map((c: { text: string }) => c.text),
    variables: extractVariables(s.story),
    runtimeErrors: s.errors,
    runtimeWarnings: s.warnings,
    externalFunctionsStubbed: [...externals],
    replayStatus: pathChanged ? "path_changed" : s.errors.length > 0 ? "runtime_error" : "completed",
  };
}

interface Frame {
  stateJson: string;
  path: string[];
  choiceIndices: number[];
  depth: number;
}

function dfsPushOrder(
  numChoices: number,
  priority: NonNullable<ExploreOptions["dfsChoicePriority"]>
): number[] {
  const source = Array.from({ length: numChoices }, (_, i) => i);
  let desired: number[];
  if (priority === "first") {
    desired = source;
  } else if (priority === "inside-out") {
    desired = [];
    const center = Math.floor((source.length - 1) / 2);
    for (let offset = 0; desired.length < source.length; offset++) {
      const left = center - offset;
      const right = center + offset;
      if (left >= 0) desired.push(left);
      if (right < source.length && right !== left) desired.push(right);
    }
  } else {
    desired = source.reverse();
  }
  return desired.reverse();
}

function sourceLocationForPath(
  pathString: string,
  knots: KnotInfo[],
  instructionOffset: number
): RuntimeErrorReport["sourceLocation"] {
  const [root, ...segments] = pathString.split(".");
  const knot = knots.find((candidate) => candidate.name === root);
  if (!knot) return undefined;
  const numeric = segments
    .map((segment) => Number(segment))
    .filter((segment) => Number.isSafeInteger(segment) && segment >= 0);
  const offset = numeric.length ? Math.max(0, numeric[numeric.length - 1] - instructionOffset) : 0;
  return { file: knot.file, line: knot.line + offset, approximate: true };
}

function sourceLocationForRuntimeError(
  message: string,
  knots: KnotInfo[]
): RuntimeErrorReport["sourceLocation"] {
  const position = message.match(/\(at ([^)]+)\)\s*$/)?.[1];
  if (!position) return undefined;
  // Ink runtime paths are compiled instruction positions, not source line
  // numbers. For authored knots they are close enough to point humans at the
  // right neighborhood, so label the mapped location as approximate.
  return sourceLocationForPath(position, knots, 2);
}

function sourceLocationForChoiceSourcePath(
  sourcePath: unknown,
  knots: KnotInfo[]
): RuntimeErrorReport["sourceLocation"] {
  if (typeof sourcePath !== "string" || !sourcePath) return undefined;
  // Choice source paths point at generated instruction positions near the
  // authored choice. Use them only as a fallback when inkjs emits an error
  // without its own runtime address, such as "ran out of content".
  return sourceLocationForPath(sourcePath, knots, 4);
}

export interface ExploreOptions {
  maxDepth?: number;
  maxStates?: number;
  /** "dfs" (default) surfaces endings early; "bfs" yields shortest paths. */
  strategy?: "dfs" | "bfs";
  /** In DFS, choose which authored choices are explored first. Default "last". */
  dfsChoicePriority?: "first" | "last" | "inside-out";
  /** Preserve turn counters when the source uses TURNS()/TURNS_SINCE(). Default true. */
  preserveTurnState?: boolean;
  /** Preserve RNG bookkeeping when the source uses random behavior. Default true. */
  preserveRandomState?: boolean;
  /** Report that the source scanner found random behavior. */
  randomnessDetected?: boolean;
  /** PRNG seed for the random-sampling pass; fixed default keeps CI reproducible. */
  seed?: number;
  /** Initial Ink runtime RNG seed; independent of search allocation. Default 1. */
  storySeed?: number;
  /** Frontier cap per depth level for the novelty beam pass. Default 64. */
  beamWidth?: number;
  /** Relative budget weights for the portfolio passes (e.g. from a shape profile). */
  weights?: PortfolioWeights;
  /** Receive privacy-safe bounded-search work snapshots. */
  onProgress?: (progress: ExploreProgress) => void;
  /** Receive periodic full evidence snapshots for crash-safe evaluation persistence. */
  onSnapshot?: (result: ExploreResult) => void;
  /** Internal/test override for the normal 10,000-state progress cadence. */
  progressIntervalStates?: number;
  /** Internal/test override for the normal one-second progress heartbeat. */
  progressIntervalMs?: number;
  /**
   * Memory guard, checked periodically during exploration. Return false to
   * stop cleanly before an out-of-memory crash; the pass keeps whatever it
   * found and reports `truncatedBy.memory`. A V8 heap OOM cannot be caught
   * after the fact, so staying under a watermark is the only safe option.
   */
  memoryGuard?: () => boolean;
  /**
   * Time guard, checked periodically during exploration. Return false when a
   * wall-clock budget has elapsed; the pass stops cleanly, keeps whatever it
   * found, and reports `truncatedBy.time`. Lets a hosted or CI run hand back
   * a partial report at a deadline instead of being hard-killed mid-run.
   */
  timeGuard?: () => boolean;
  /** Internal selector for the experimental variable-aware shared frontier. */
  sharedVariableAware?: boolean;
  /** Prevalidated non-executable project assertions evaluated on visited states. */
  assertions?: AssertionDefinition[];
  /** Prevalidated goal conditions used only by an explicitly bounded goal slice. */
  goals?: GoalDefinition[];
  /** Additional directed-goal states; baseline maxStates is never reduced. Default 0. */
  goalMaxStates?: number;
  /** Internal selector for the deterministic goal-proximity shared frontier. */
  sharedGoalAware?: boolean;
}

export const DEFAULT_RANDOM_SEED = 1;
export const DEFAULT_BEAM_WIDTH = 64;
export const DEFAULT_PROGRESS_INTERVAL_STATES = 10_000;
export const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;
const RESOURCE_GUARD_INTERVAL = 512;
const TIMED_RESOURCE_GUARD_INTERVAL = 64;

export interface ExploreProgress {
  pass: string;
  statesExplored: number;
  endingsFound: number;
  runtimeErrorsFound: number;
  unvisitedKnots: number;
  visibleOutcomes: number;
  assertionViolations: number;
  goalsReached: number;
  stagesReached: number;
  discoveryEvents: number;
  statesSinceLastDiscovery: number | null;
}

/** Relative budget weights for the portfolio passes; normalized before use. */
export interface PortfolioWeights {
  last: number;
  first: number;
  insideOut: number;
  beam: number;
  random: number;
}

/** Default split, tuned for unknown story shapes. */
export const DEFAULT_PORTFOLIO_WEIGHTS: PortfolioWeights = {
  last: 0.195,
  first: 0.195,
  insideOut: 0.26,
  beam: 0.15,
  random: 0.2,
};

/** One pass's share of one scheduler round, with its marginal discoveries. */
export interface ScheduleRoundEntry {
  pass: string;
  granted: number;
  consumed: number;
  newEndings: number;
  newKnots: number;
  newRuntimeErrors: number;
}

export interface ScheduleRound {
  round: number;
  entries: ScheduleRoundEntry[];
}

export interface PolicyReplayRound {
  round: number;
  decision: ShadowDecision;
  allocationApplied: boolean;
  allocationGate: "applied" | "warmup" | "priority" | "not_reallocate";
  nextRoundWeights: Array<{ pass: string; share: number }>;
  /** Present only when a previously approved policy overlay controls this round. */
  floorService?: FloorAllocation;
}

/**
 * Lifetime telemetry for one exploration pass (issue #28), so agents and CI
 * can see which pass earned its budget on this story shape without parsing
 * progress logs. A long gap since `lastDiscoveryAtState` does not prove a
 * pass is done — late discoveries after long dry spells are real — so this
 * reports facts and leaves stop/continue judgments to the consumer.
 */
export interface PassTelemetry {
  pass: string;
  /** Systematic passes can prove exhaustive coverage; sampling passes cannot. */
  systematic: boolean;
  statesExplored: number;
  /** Total state allowance issued to this pass. */
  granted: number;
  /** Findings this pass recorded itself, regardless of other passes. */
  endingsFound: number;
  runtimeErrorsFound: number;
  knotsVisited: number;
  /** Portfolio-wide first discoveries credited to this pass (equal to the own counts outside a portfolio run). */
  newEndings: number;
  newKnots: number;
  newRuntimeErrors: number;
  /** Transitions whose resulting state was already seen (always 0 for random: it never deduplicates). */
  dedupeHits: number;
  /** Deepest choice trail this pass followed. */
  maxDepthReached: number;
  /** This pass's transition count when it last recorded a finding new to itself; null if it found nothing. */
  lastDiscoveryAtState: number | null;
  /** Bounded deterministic samples of this pass's meaningful discovery curve. */
  discoveryCurve: DiscoveryCurveSample[];
  /** Factual bounded-run distances; no plateau or completeness inference. */
  discoverySummary: DiscoveryCurveSummary;
  /** Portfolio-only first-discovery value credited to this pass in scheduler order. */
  portfolioMarginalCurve?: DiscoveryCurveSample[];
  /** Compaction-safe distances for the portfolio-marginal curve. */
  portfolioMarginalSummary?: DiscoveryCurveSummary;
  truncatedBy: TruncationCauses;
  exhaustive: boolean;
  /** Beam only: largest frontier kept between levels. */
  peakFrontier?: number;
  /** Beam only: levels where reachable children were pruned at the width cap. */
  prunes?: number;
  /** Shared search only: globally unique states inserted. */
  uniqueStates?: number;
  /** Shared search only: largest number of discovered states awaiting expansion. */
  peakPendingStates?: number;
  /** Shared search only: largest serialized-byte total awaiting expansion. */
  peakPendingBytes?: number;
  /** Shared search only: distinct variable snapshots observed. */
  variableStatesObserved?: number;
  /** Shared search only: distinct variable changes observed. */
  variableTransitionsObserved?: number;
  /** Shared search only: variable changes observed exactly once. */
  rareVariableTransitions?: number;
}

export interface DiscoveryCounts {
  endingsFound: number;
  runtimeErrorsFound: number;
  knotsVisited: number;
  visibleOutcomes: number;
  assertionViolations: number;
  goalsReached: number;
  stagesReached: number;
  uniqueStatesObserved: number;
}

export interface DiscoveryCurveSample extends DiscoveryCounts {
  state: number;
  newEndings: number;
  newRuntimeErrors: number;
  newKnots: number;
  newVisibleOutcomes: number;
  newAssertionViolations: number;
  newGoalsReached: number;
  newStagesReached: number;
  newUniqueStates: number;
  /** States since the immediately preceding discovery event before bounded compaction; null for the first. */
  statesSincePreviousDiscovery: number | null;
}

export interface DiscoveryCurveSummary {
  discoveryEvents: number;
  firstDiscoveryAtState: number | null;
  lastDiscoveryAtState: number | null;
  statesSinceLastDiscovery: number | null;
  latestDiscoveryGap: number | null;
  longestObservedDiscoveryGap: number | null;
}

const MAX_DISCOVERY_CURVE_SAMPLES = 64;

export class DiscoveryCurveRecorder {
  private samples: DiscoveryCurveSample[] = [];
  private previousTotal = 0;
  private previousState: number | null = null;
  private firstState: number | null = null;
  private eventCount = 0;
  private latestGap: number | null = null;
  private longestGap: number | null = null;
  private previousCounts: DiscoveryCounts = {
    endingsFound: 0,
    runtimeErrorsFound: 0,
    knotsVisited: 0,
    visibleOutcomes: 0,
    assertionViolations: 0,
    goalsReached: 0,
    stagesReached: 0,
    uniqueStatesObserved: 0,
  };

  observe(state: number, counts: DiscoveryCounts): boolean {
    const total = counts.endingsFound + counts.runtimeErrorsFound + counts.knotsVisited
      + counts.assertionViolations + counts.goalsReached + counts.stagesReached;
    if (total <= this.previousTotal) return false;
    const gap = this.previousState === null ? null : state - this.previousState;
    this.samples.push({
      state,
      ...counts,
      newEndings: counts.endingsFound - this.previousCounts.endingsFound,
      newRuntimeErrors: counts.runtimeErrorsFound - this.previousCounts.runtimeErrorsFound,
      newKnots: counts.knotsVisited - this.previousCounts.knotsVisited,
      newVisibleOutcomes: counts.visibleOutcomes - this.previousCounts.visibleOutcomes,
      newAssertionViolations: counts.assertionViolations - this.previousCounts.assertionViolations,
      newGoalsReached: counts.goalsReached - this.previousCounts.goalsReached,
      newStagesReached: counts.stagesReached - this.previousCounts.stagesReached,
      newUniqueStates: counts.uniqueStatesObserved - this.previousCounts.uniqueStatesObserved,
      statesSincePreviousDiscovery: gap,
    });
    this.firstState ??= state;
    this.eventCount++;
    this.latestGap = gap;
    if (gap !== null) this.longestGap = Math.max(this.longestGap ?? 0, gap);
    this.previousTotal = total;
    this.previousCounts = { ...counts };
    this.previousState = state;
    if (this.samples.length > MAX_DISCOVERY_CURVE_SAMPLES) {
      const first = this.samples[0];
      const last = this.samples[this.samples.length - 1];
      const interior = this.samples.slice(1, -1).filter((_, index) => index % 2 === 1);
      this.samples = [first, ...interior, last];
    }
    return true;
  }

  result(): DiscoveryCurveSample[] {
    return this.samples.map((sample) => ({ ...sample }));
  }

  summary(statesExplored: number): DiscoveryCurveSummary {
    return {
      discoveryEvents: this.eventCount,
      firstDiscoveryAtState: this.firstState,
      lastDiscoveryAtState: this.previousState,
      statesSinceLastDiscovery: this.previousState === null ? null : statesExplored - this.previousState,
      latestDiscoveryGap: this.latestGap,
      longestObservedDiscoveryGap: this.longestGap,
    };
  }
}

function visibleOutcomeKey(finalText: string): string {
  return finalText.trim().replace(/\s+/g, " ");
}

function stableObservedValues(values: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
}

function assertionViolationKey(ruleId: string, observedValues: Record<string, unknown>, choiceIndices: number[]): string {
  return `${ruleId}|${stableObservedValues(observedValues)}|${JSON.stringify(choiceIndices)}`;
}

function portfolioRuntimeErrorKey(error: RuntimeErrorReport): string {
  if (error.sourceLocation?.approximate) {
    return `${error.message}|${error.sourceLocation.file}|approximate`;
  }
  return runtimeErrorKey(error);
}

function recordEnding(
  endings: Map<string, EndingReport>,
  visibleOutcomes: Set<string>,
  key: string,
  ending: EndingReport
): void {
  endings.set(key, ending);
  visibleOutcomes.add(visibleOutcomeKey(ending.finalText));
}

/**
 * A pausable exploration pass. `run(grant)` consumes up to `grant` more
 * story-state transitions and pauses exactly where it stopped, so the
 * portfolio scheduler can interleave passes in rounds without changing any
 * pass's traversal order. Budget-exhaustion truncation is decided only at
 * `finalize()` — pausing at a grant boundary is not truncation.
 */
interface PassEngine {
  readonly label: string;
  /** Systematic passes can prove exhaustive coverage; sampling passes cannot. */
  readonly systematic: boolean;
  /** Consume up to `grant` transitions; returns how many were consumed. */
  run(grant: number): number;
  /** True when the pass has no work left. */
  done(): boolean;
  /** True when the pass proved complete coverage of the reachable space. */
  exhaustive(): boolean;
  /** True once the memory guard stopped this pass early. */
  stoppedForMemory(): boolean;
  /** True once the time guard stopped this pass early. */
  stoppedForTime(): boolean;
  /** Findings so far, without budget-truncation flags. */
  snapshot(): ExploreResult;
  /** Final result: marks maxStates truncation when work remained. */
  finalize(): ExploreResult;
  /** Lifetime counters for this pass; call after finalize for final flags. */
  telemetry(): PassTelemetry;
}

function progressFromSnapshot(pass: string, statesExplored: number, result: ExploreResult): ExploreProgress {
  const goals = result.goalResults ?? [];
  const telemetry = result.passes?.find((entry) => entry.pass === pass);
  const summary = result.discoverySummary ?? telemetry?.discoverySummary;
  const latestFinding = [
    ...result.endingsFound.map((ending) => ending.firstDiscoveredAtState),
    ...result.runtimeErrors.map((error) => error.firstDiscoveredAtState),
  ].reduce<number | null>((latest, state) => latest === null ? state : Math.max(latest, state), null);
  return {
    pass,
    statesExplored,
    endingsFound: result.endingsFound.length,
    runtimeErrorsFound: result.runtimeErrors.length,
    unvisitedKnots: result.unvisitedKnots.length,
    visibleOutcomes: new Set(result.endingsFound.map((ending) => visibleOutcomeKey(ending.finalText))).size,
    assertionViolations: result.assertionResults.filter((assertion) => assertion.status === "violated").length,
    goalsReached: goals.filter((goal) => goal.status === "reached").length,
    stagesReached: goals.reduce((total, goal) => total + (goal.stages ?? []).filter((stage) => stage.status === "reached").length, 0),
    discoveryEvents: summary?.discoveryEvents ?? 0,
    statesSinceLastDiscovery: summary?.statesSinceLastDiscovery
      ?? (latestFinding === null ? null : statesExplored - latestFinding),
  };
}

function runEngineToBudget(engine: PassEngine, maxStates: number, opts: ExploreOptions): ExploreResult {
  const stateInterval = opts.progressIntervalStates ?? DEFAULT_PROGRESS_INTERVAL_STATES;
  const timeInterval = opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const chunkSize = opts.progressIntervalMs === 0 ? 1 : 1_000;
  let remaining = maxStates;
  let lastStates = 0;
  let lastAt = Date.now();
  while (remaining > 0 && !engine.done() && !engine.stoppedForMemory() && !engine.stoppedForTime()) {
    const consumed = engine.run(Math.min(chunkSize, remaining));
    remaining -= consumed;
    const snapshot = engine.snapshot();
    const now = Date.now();
    if (
      opts.onProgress &&
      (snapshot.statesExplored - lastStates >= stateInterval || now - lastAt >= timeInterval)
    ) {
      lastStates = snapshot.statesExplored;
      lastAt = now;
      opts.onProgress(progressFromSnapshot(engine.label, snapshot.statesExplored, snapshot));
    }
    if (consumed === 0) break;
  }
  const result = engine.finalize();
  result.passes = [engine.telemetry()];
  opts.onProgress?.(progressFromSnapshot(engine.label, result.statesExplored, result));
  return result;
}

function createSearchEngine(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  opts: ExploreOptions
): PassEngine {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
    throw new RangeError("maxDepth must be an integer from 1 to 1000");
  }
  const strategy = opts.strategy ?? "dfs";
  const dfsChoicePriority = opts.dfsChoicePriority ?? "last";
  const foundBy = strategy === "bfs" ? "bfs" : `dfs:${dfsChoicePriority}`;
  const stateSensitivity = {
    turns: opts.preserveTurnState ?? true,
    randomness: opts.preserveRandomState ?? true,
  };

  const endings = new Map<string, EndingReport>();
  const visibleOutcomes = new Set<string>();
  const runtimeErrors = new Map<string, RuntimeErrorReport>();
  const runtimeWarnings = new Set<string>();
  const visitedKnots = new Set<string>();
  const seenStates = new Set<string>();
  let statesExplored = 0;
  let totalGranted = 0;
  let truncated = false;
  const truncatedBy: TruncationCauses = { maxDepth: false, maxStates: false, beamWidth: false, memory: false, time: false };
  let dedupeHits = 0;
  let maxDepthReached = 0;
  let lastDiscoveryAtState: number | null = null;
  const discoveryCurve = new DiscoveryCurveRecorder();
  const noteDiscoveryProgress = () => {
    if (discoveryCurve.observe(statesExplored, {
      endingsFound: endings.size,
      runtimeErrorsFound: runtimeErrors.size,
      knotsVisited: visitedKnots.size,
      visibleOutcomes: visibleOutcomes.size,
      assertionViolations: assertions.violationCount(),
      goalsReached: goals.reachedGoalCount(),
      stagesReached: goals.reachedStageCount(),
      uniqueStatesObserved: seenStates.size,
    })) {
      lastDiscoveryAtState = statesExplored;
    }
  };

  const nonFunctionKnots = knots.filter((k) => !k.isFunction);

  const recordKnotCoverage = (session: StorySession) => {
    for (const k of nonFunctionKnots) {
      if (visitedKnots.has(k.name)) continue;
      try {
        if (session.story.state.VisitCountAtPathString(k.name) > 0) visitedKnots.add(k.name);
      } catch {
        /* path not addressable */
      }
    }
  };

  // One pooled instance: constructing Story parses the full compiled JSON,
  // so we do it once and rewind between branches with LoadJson.
  const s = makeStory(storyJson, externals, opts.storySeed);
  const resetSession = () => {
    s.errors.length = 0;
    s.warnings.length = 0;
  };

  // Root: continue the fresh story to the first choice point.
  const rootStep = continueMaximally(s);
  const assertions = assertionTracker(s.story, knots, opts.assertions, foundBy);
  const goals = new GoalTracker(opts.goals ?? [], foundBy);
  s.errors.forEach((e) =>
    runtimeErrors.set(e, { message: e, path: [], choiceIndices: [], firstDiscoveredAtState: 0, sourceLocation: sourceLocationForRuntimeError(e, knots), foundBy })
  );
  s.warnings.forEach((w) => runtimeWarnings.add(w));
  recordKnotCoverage(s);
  const rootVariables = extractVariables(s.story);
  const rootEnded = rootStep.choicesOffered.length === 0 && s.errors.length === 0;
  assertions.observe({
    variables: rootVariables,
    terminal: rootEnded,
    knots: [...assertionKnotCounts(s.story, opts.assertions)].filter(([, count]) => count > 0).map(([name]) => name),
    path: [],
    choiceIndices: [],
    state: 0,
  });
  goals.observe({ variables: rootVariables, path: [], choiceIndices: [], state: 0 });

  if (rootStep.choicesOffered.length === 0 && s.errors.length === 0) {
    // Linear story (or immediate end).
    recordEnding(endings, visibleOutcomes, rootStep.text, {
      path: [],
      choiceIndices: [],
      firstDiscoveredAtState: 0,
      finalText: rootStep.text.trim().split(/\n/).slice(-3).join("\n"),
      variables: rootVariables,
      foundBy,
    });
  }
  noteDiscoveryProgress();

  const rootState = s.story.state.ToJson();
  seenStates.add(stateKey(rootState, stateSensitivity));
  const frames: Frame[] = [{ stateJson: rootState, path: [], choiceIndices: [], depth: 0 }];
  let head = 0; // BFS read pointer (avoids O(n) shifts)
  // Pause state: the frame currently being expanded and its choice cursor.
  let current: { frame: Frame; order: number[]; cursor: number } | null = null;

  /**
   * Process the next unit of work: at most one choice transition. Frame
   * pops and restore failures cost no budget but still make progress, so a
   * grant of 1 can never spin. Returns false when nothing remains.
   */
  const advance = (): boolean => {
    while (!current) {
      const hasNext = strategy === "bfs" ? head < frames.length : frames.length > 0;
      if (!hasNext) return false;
      const frame = strategy === "bfs" ? frames[head++] : frames.pop()!;
      resetSession();
      try {
        s.story.state.LoadJson(frame.stateJson);
      } catch (e) {
        runtimeErrors.set(String(e), {
          message: `State restore failed: ${e instanceof Error ? e.message : e}`,
          path: frame.path,
          choiceIndices: frame.choiceIndices,
          firstDiscoveredAtState: statesExplored,
          foundBy,
        });
        continue;
      }
      const numChoices = s.story.currentChoices.length;
      if (numChoices === 0) continue;
      current = {
        frame,
        order:
          strategy === "dfs"
            ? dfsPushOrder(numChoices, dfsChoicePriority)
            : Array.from({ length: numChoices }, (_, i) => i),
        cursor: 0,
      };
    }
    const frame = current.frame;
    const i = current.order[current.cursor++];
    if (current.cursor >= current.order.length) current = null;
    resetSession();
    s.story.state.LoadJson(frame.stateJson);
    const assertionCountsBefore = assertionKnotCounts(s.story, opts.assertions);
    const choice = s.story.currentChoices[i] as { text?: string; sourcePath?: string } | undefined;
    const choiceText = choice?.text ?? `#${i}`;
    const path = [...frame.path, choiceText];
    const choiceIndices = [...frame.choiceIndices, i];
    const choiceLocation = sourceLocationForChoiceSourcePath(choice?.sourcePath, knots);
    try {
      s.story.ChooseChoiceIndex(i);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      runtimeErrors.set(msg, {
        message: msg,
        path,
        choiceIndices,
        firstDiscoveredAtState: statesExplored,
        sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation,
        foundBy,
      });
      noteDiscoveryProgress();
      return true;
    }
    const step = continueMaximally(s);
    statesExplored++;
    if (path.length > maxDepthReached) maxDepthReached = path.length;
    s.errors.forEach((msg) => {
      if (!runtimeErrors.has(msg)) {
        runtimeErrors.set(msg, {
          message: msg,
          path,
          choiceIndices,
          firstDiscoveredAtState: statesExplored,
          sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation,
          foundBy,
        });
      }
    });
    s.warnings.forEach((w) => runtimeWarnings.add(w));
    recordKnotCoverage(s);
    noteDiscoveryProgress();

    const ended = !s.story.canContinue && s.story.currentChoices.length === 0;
    const stateVariables = extractVariables(s.story);
    assertions.observe({
      variables: stateVariables,
      terminal: ended && s.errors.length === 0,
      knots: enteredAssertionKnots(s.story, assertionCountsBefore),
      path,
      choiceIndices,
      state: statesExplored,
    });
    goals.observe({ variables: stateVariables, path, choiceIndices, state: statesExplored });
    if (ended && s.errors.length === 0) {
      const finalText = step.text.trim().split(/\n/).slice(-3).join("\n");
      const key = finalText + "|" + JSON.stringify(stateVariables);
      if (!endings.has(key)) {
        recordEnding(endings, visibleOutcomes, key, { path, choiceIndices, firstDiscoveredAtState: statesExplored, finalText, variables: stateVariables, foundBy });
        noteDiscoveryProgress();
      }
      return true;
    }
    if (path.length >= maxDepth) {
      truncated = true;
      truncatedBy.maxDepth = true;
      return true;
    }
    const nextState = s.story.state.ToJson();
    const key = stateKey(nextState, stateSensitivity);
    if (seenStates.has(key)) {
      dedupeHits++;
      return true; // identical state: subtree already covered
    }
    seenStates.add(key);
    frames.push({ stateJson: nextState, path, choiceIndices, depth: frame.depth + 1 });
    return true;
  };

  let finished = false;
  let memoryStopped = false;
  const memoryGuard = opts.memoryGuard;
  let timeStopped = false;
  const timeGuard = opts.timeGuard;
  const guardInterval = timeGuard ? TIMED_RESOURCE_GUARD_INTERVAL : RESOURCE_GUARD_INTERVAL;
  const done = () =>
    finished ||
    (!current && (strategy === "bfs" ? head >= frames.length : frames.length === 0));

  const buildResult = (): ExploreResult => {
    const exhaustive = !truncated && (finished || done());
    return ({
    statesExplored,
    discoverySummary: discoveryCurve.summary(statesExplored),
    endingsFound: [...endings.values()],
    runtimeErrors: [...runtimeErrors.values()],
    assertionResults: assertions.results(exhaustive),
    ...(opts.goals?.length ? { goalResults: goals.results(exhaustive) } : {}),
    runtimeWarnings: [...runtimeWarnings],
    unvisitedKnots: nonFunctionKnots
      .filter((k) => !visitedKnots.has(k.name))
      .map(({ name, file, line }) => ({ name, file, line })),
    visitedKnots: [...visitedKnots],
    externalFunctionsStubbed: [...externals],
    randomnessDetected: opts.randomnessDetected ?? false,
    truncated,
    truncatedBy,
    exhaustive,
    limits: { maxDepth, maxStates: totalGranted, storySeed: normalizeStorySeed(opts.storySeed) },
    });
  };

  return {
    label: foundBy,
    systematic: true,
    run(grant: number): number {
      totalGranted += grant;
      const start = statesExplored;
      let sinceGuard = 0;
      while (statesExplored - start < grant) {
        if ((memoryGuard || timeGuard) && ++sinceGuard >= guardInterval) {
          sinceGuard = 0;
          if (memoryGuard && !memoryGuard()) {
            memoryStopped = true;
            break;
          }
          if (timeGuard && !timeGuard()) {
            timeStopped = true;
            break;
          }
        }
        if (!advance()) {
          finished = true;
          break;
        }
      }
      return statesExplored - start;
    },
    done,
    exhaustive: () => done() && !truncated,
    stoppedForMemory: () => memoryStopped,
    stoppedForTime: () => timeStopped,
    snapshot: buildResult,
    finalize(): ExploreResult {
      if (memoryStopped) {
        truncated = true;
        truncatedBy.memory = true;
      } else if (timeStopped) {
        truncated = true;
        truncatedBy.time = true;
      } else if (!done()) {
        truncated = true;
        truncatedBy.maxStates = true;
      }
      return buildResult();
    },
    telemetry(): PassTelemetry {
      return {
        pass: foundBy,
        systematic: true,
        statesExplored,
        granted: totalGranted,
        endingsFound: endings.size,
        runtimeErrorsFound: runtimeErrors.size,
        knotsVisited: visitedKnots.size,
        newEndings: endings.size,
        newKnots: visitedKnots.size,
        newRuntimeErrors: runtimeErrors.size,
        dedupeHits,
        maxDepthReached,
        lastDiscoveryAtState,
        discoveryCurve: discoveryCurve.result(),
        discoverySummary: discoveryCurve.summary(statesExplored),
        truncatedBy: { ...truncatedBy },
        exhaustive: done() && !truncated,
      };
    },
  };
}

/**
 * Bounded systematic walk of the story's choice tree. Reports every
 * distinct terminal state, every runtime error with the choice trail that triggers
 * it, and knot coverage. States are pruned only after configured-insensitive
 * turn/RNG bookkeeping is canonicalized.
 * A single pooled Story instance is reused across states via LoadJson, so
 * the compiled JSON is parsed once regardless of exploration size.
 */
export function explore(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  const maxStates = opts.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 100_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 100000000");
  }
  const engine = createSearchEngine(storyJson, knots, externals, opts);
  return runEngineToBudget(engine, maxStates, opts);
}

interface SharedNode {
  stateJson?: string;
  variables?: Record<string, unknown>;
  parent: number | null;
  choiceText?: string;
  choiceIndex?: number;
  depth: number;
}

interface SharedHeapItem {
  id: number;
  score: number;
  order: number;
}

class SharedMaxHeap {
  private readonly items: SharedHeapItem[] = [];

  private higher(a: SharedHeapItem, b: SharedHeapItem): boolean {
    return a.score > b.score || (a.score === b.score && a.order < b.order);
  }

  push(item: SharedHeapItem): void {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.higher(items[parent], item)) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  pop(): SharedHeapItem | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const first = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      let index = 0;
      while (true) {
        let child = index * 2 + 1;
        if (child >= items.length) break;
        if (child + 1 < items.length && this.higher(items[child + 1], items[child])) {
          child++;
        }
        if (this.higher(last, items[child])) break;
        items[index] = items[child];
        index = child;
      }
      items[index] = last;
    }
    return first;
  }
}

/**
 * Experimental shared-state search. Several deterministic frontier views
 * select from one global state table, so a state referenced by multiple
 * policies is still expanded only once. The engine is systematic when its
 * frontier drains without a depth/resource cut, but remains opt-in while the
 * benchmark corpus establishes where it complements the default portfolio.
 */
function createSharedEngine(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  opts: ExploreOptions
): PassEngine {
  const maxDepth = opts.maxDepth ?? 30;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
    throw new RangeError("maxDepth must be an integer from 1 to 1000");
  }
  const seed = opts.seed ?? DEFAULT_RANDOM_SEED;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError("seed must be an integer from 0 to 4294967295");
  }
  const variableAware = opts.sharedVariableAware ?? false;
  const goalAware = opts.sharedGoalAware ?? false;
  const foundBy = goalAware
    ? `shared:goal-directed-v1:seed=${seed}`
    : variableAware
    ? `shared:variable-aware-v1:seed=${seed}`
    : `shared:deep-novelty-v1:seed=${seed}`;
  const stateSensitivity = {
    turns: opts.preserveTurnState ?? true,
    randomness: opts.preserveRandomState ?? true,
  };

  const endings = new Map<string, EndingReport>();
  const visibleOutcomes = new Set<string>();
  const runtimeErrors = new Map<string, RuntimeErrorReport>();
  const runtimeWarnings = new Set<string>();
  const visitedKnots = new Set<string>();
  const seenStates = new Set<string>();
  const seenChoiceSets = new Set<string>();
  const variableStateCounts = new Map<string, number>();
  const variableTransitionCounts = new Map<string, number>();
  const nonFunctionKnots = knots.filter((k) => !k.isFunction);
  const nodes: SharedNode[] = [];
  const expanded: boolean[] = [];
  const deep: number[] = [];
  const random: number[] = [];
  const novelty = new SharedMaxHeap();
  const variablePriority = new SharedMaxHeap();
  const goalPriority = new SharedMaxHeap();
  const rng = mulberry32(seed);
  const policies: Array<"novelty" | "deep" | "variable" | "goal" | "random"> = goalAware
    ? ["novelty", "deep", "goal", "random", "novelty", "deep", "goal", "random"]
    : variableAware
    ? ["novelty", "deep", "deep", "random", "novelty", "deep", "variable", "random"]
    : ["novelty", "deep", "deep", "random"];
  let policyCursor = 0;
  let insertionOrder = 0;
  let pendingStates = 0;
  let pendingBytes = 0;
  let peakPendingStates = 0;
  let peakPendingBytes = 0;
  let statesExplored = 0;
  let totalGranted = 0;
  let dedupeHits = 0;
  let maxDepthReached = 0;
  let deepestStateDiscovered = 0;
  let lastDiscoveryAtState: number | null = null;
  const discoveryCurve = new DiscoveryCurveRecorder();
  let truncated = false;
  const truncatedBy: TruncationCauses = {
    maxDepth: false,
    maxStates: false,
    beamWidth: false,
    memory: false,
    time: false,
  };
  let finished = false;
  let memoryStopped = false;
  let timeStopped = false;
  const memoryGuard = opts.memoryGuard;
  const timeGuard = opts.timeGuard;
  const guardInterval = timeGuard ? TIMED_RESOURCE_GUARD_INTERVAL : RESOURCE_GUARD_INTERVAL;

  const noteDiscoveryProgress = () => {
    if (discoveryCurve.observe(statesExplored, {
      endingsFound: endings.size,
      runtimeErrorsFound: runtimeErrors.size,
      knotsVisited: visitedKnots.size,
      visibleOutcomes: visibleOutcomes.size,
      assertionViolations: assertions.violationCount(),
      goalsReached: goals.reachedGoalCount(),
      stagesReached: goals.reachedStageCount(),
      uniqueStatesObserved: seenStates.size,
    })) {
      lastDiscoveryAtState = statesExplored;
    }
  };

  const recordKnotCoverage = (session: StorySession): number => {
    let added = 0;
    for (const knot of nonFunctionKnots) {
      if (visitedKnots.has(knot.name)) continue;
      try {
        if (session.story.state.VisitCountAtPathString(knot.name) > 0) {
          visitedKnots.add(knot.name);
          added++;
        }
      } catch {
        /* path not addressable */
      }
    }
    return added;
  };

  const witnessFor = (
    nodeId: number,
    extraChoice?: { text: string; index: number }
  ): { path: string[]; choiceIndices: number[] } => {
    const path: string[] = [];
    const choiceIndices: number[] = [];
    let id: number | null = nodeId;
    while (id !== null) {
      const node: SharedNode = nodes[id];
      if (node.choiceText !== undefined) {
        path.push(node.choiceText);
        choiceIndices.push(node.choiceIndex!);
      }
      id = node.parent;
    }
    path.reverse();
    choiceIndices.reverse();
    if (extraChoice !== undefined) {
      path.push(extraChoice.text);
      choiceIndices.push(extraChoice.index);
    }
    return { path, choiceIndices };
  };

  const valid = (id: number | undefined): id is number =>
    id !== undefined && !expanded[id] && nodes[id]?.stateJson !== undefined;

  const addNode = (
    stateJson: string,
    variables: Record<string, unknown>,
    parent: number | null,
    choiceText: string | undefined,
    choiceIndex: number | undefined,
    depth: number,
    noveltyScore: number,
    variableScore = 0,
    goalScore = 0
  ): void => {
    const id = nodes.length;
    nodes.push({ stateJson, variables, parent, choiceText, choiceIndex, depth });
    expanded.push(false);
    deep.push(id);
    random.push(id);
    novelty.push({
      id,
      score: noveltyScore * 1_000_000 + depth,
      order: insertionOrder++,
    });
    if (variableAware) {
      variablePriority.push({
        id,
        score: variableScore * 1_000_000 + noveltyScore * 1_000 + depth,
        order: insertionOrder++,
      });
    }
    if (goalAware) {
      goalPriority.push({ id, score: goalScore * 1_000 + noveltyScore, order: insertionOrder++ });
    }
    pendingStates++;
    pendingBytes += stateJson.length;
    peakPendingStates = Math.max(peakPendingStates, pendingStates);
    peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
  };

  const takeDeep = (): number | undefined => {
    while (deep.length > 0) {
      const id = deep.pop();
      if (valid(id)) return id;
    }
    return undefined;
  };

  const takeNovelty = (): number | undefined => {
    while (true) {
      const item = novelty.pop();
      if (!item) return undefined;
      if (valid(item.id)) return item.id;
    }
  };

  const takeRandom = (): number | undefined => {
    while (random.length > 0) {
      const index = Math.floor(rng() * random.length);
      const id = random[index];
      random[index] = random[random.length - 1];
      random.pop();
      if (valid(id)) return id;
    }
    return undefined;
  };

  const takeVariable = (): number | undefined => {
    while (true) {
      const item = variablePriority.pop();
      if (!item) return undefined;
      if (valid(item.id)) return item.id;
    }
  };

  const takeGoal = (): number | undefined => {
    while (true) {
      const item = goalPriority.pop();
      if (!item) return undefined;
      if (valid(item.id)) return item.id;
    }
  };

  const takeNext = (): number | undefined => {
    for (let attempt = 0; attempt < policies.length; attempt++) {
      const policy = policies[policyCursor++ % policies.length];
      const id = policy === "deep"
        ? takeDeep()
        : policy === "random"
          ? takeRandom()
          : policy === "goal"
            ? takeGoal()
          : policy === "variable"
            ? takeVariable()
            : takeNovelty();
      if (id !== undefined) return id;
    }
    return takeGoal() ?? takeNovelty() ?? takeVariable() ?? takeDeep() ?? takeRandom();
  };

  const session = makeStory(storyJson, externals, opts.storySeed);
  const resetSession = () => {
    session.errors.length = 0;
    session.warnings.length = 0;
  };

  const rootStep = continueMaximally(session);
  const assertions = assertionTracker(session.story, knots, opts.assertions, foundBy);
  const goals = new GoalTracker(opts.goals ?? [], foundBy);
  session.errors.forEach((message) =>
    runtimeErrors.set(message, {
      message,
      path: [],
      choiceIndices: [],
      firstDiscoveredAtState: 0,
      sourceLocation: sourceLocationForRuntimeError(message, knots),
      foundBy,
    })
  );
  session.warnings.forEach((warning) => runtimeWarnings.add(warning));
  recordKnotCoverage(session);
  const rootVariables = extractVariables(session.story);
  assertions.observe({
    variables: rootVariables,
    terminal: rootStep.choicesOffered.length === 0 && session.errors.length === 0,
    knots: [...assertionKnotCounts(session.story, opts.assertions)].filter(([, count]) => count > 0).map(([name]) => name),
    path: [],
    choiceIndices: [],
    state: 0,
  });
  goals.observe({ variables: rootVariables, path: [], choiceIndices: [], state: 0 });
  variableStateCounts.set(variableStateKey(rootVariables), 1);

  if (rootStep.choicesOffered.length === 0) {
    if (session.errors.length === 0) {
      const finalText = rootStep.text.trim().split(/\n/).slice(-3).join("\n");
      recordEnding(endings, visibleOutcomes, `${finalText}|${JSON.stringify(rootVariables)}`, {
        path: [],
        choiceIndices: [],
        firstDiscoveredAtState: 0,
        finalText,
        variables: rootVariables,
        foundBy,
      });
    }
    finished = true;
  } else {
    const rootState = session.story.state.ToJson();
    seenStates.add(stateKey(rootState, stateSensitivity));
    seenChoiceSets.add(rootStep.choicesOffered.slice().sort().join("\u0001"));
    addNode(rootState, rootVariables, null, undefined, undefined, 0, 1, 0, goals.priority(rootVariables));
  }
  noteDiscoveryProgress();

  interface SharedChoice {
    index: number;
    text: string;
    sourcePath?: string;
  }
  let current: { nodeId: number; choices: SharedChoice[]; cursor: number } | null = null;

  const finishCurrent = () => {
    if (!current) return;
    const node = nodes[current.nodeId];
    node.stateJson = undefined;
    node.variables = undefined;
    current = null;
  };

  const advance = (): boolean => {
    while (!current) {
      const nodeId = takeNext();
      if (nodeId === undefined) {
        finished = true;
        return false;
      }
      const node = nodes[nodeId];
      expanded[nodeId] = true;
      pendingStates--;
      pendingBytes -= node.stateJson!.length;
      resetSession();
      try {
        session.story.state.LoadJson(node.stateJson!);
      } catch (error) {
        const message = `State restore failed: ${error instanceof Error ? error.message : error}`;
        runtimeErrors.set(message, {
          message,
          ...witnessFor(nodeId),
          firstDiscoveredAtState: statesExplored,
          foundBy,
        });
        node.stateJson = undefined;
        node.variables = undefined;
        noteDiscoveryProgress();
        continue;
      }
      current = {
        nodeId,
        choices: session.story.currentChoices.map(
          (choice: { text?: string; sourcePath?: string }, index: number) => ({
            index,
            text: choice.text ?? `#${index}`,
            sourcePath: choice.sourcePath,
          })
        ),
        cursor: 0,
      };
      if (current.choices.length === 0) finishCurrent();
    }

    const active = current;
    const node = nodes[active.nodeId];
    const choice = active.choices[active.cursor++];
    const lastChoice = active.cursor >= active.choices.length;
    const finishIfLast = () => {
      if (lastChoice) finishCurrent();
    };
    resetSession();
    session.story.state.LoadJson(node.stateJson!);
    const assertionCountsBefore = assertionKnotCounts(session.story, opts.assertions);
    const witness = witnessFor(active.nodeId, { text: choice.text, index: choice.index });
    const { path, choiceIndices } = witness;
    const choiceLocation = sourceLocationForChoiceSourcePath(choice.sourcePath, knots);
    try {
      session.story.ChooseChoiceIndex(choice.index);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtimeErrors.set(message, {
        message,
        path,
        choiceIndices,
        firstDiscoveredAtState: statesExplored,
        sourceLocation: sourceLocationForRuntimeError(message, knots) ?? choiceLocation,
        foundBy,
      });
      noteDiscoveryProgress();
      finishIfLast();
      return true;
    }

    const step = continueMaximally(session);
    statesExplored++;
    maxDepthReached = Math.max(maxDepthReached, path.length);
    session.errors.forEach((message) => {
      if (!runtimeErrors.has(message)) {
        runtimeErrors.set(message, {
          message,
          path,
          choiceIndices,
          firstDiscoveredAtState: statesExplored,
          sourceLocation: sourceLocationForRuntimeError(message, knots) ?? choiceLocation,
          foundBy,
        });
      }
    });
    session.warnings.forEach((warning) => runtimeWarnings.add(warning));
    const newKnots = recordKnotCoverage(session);
    const nextVariables = extractVariables(session.story);
    const variableState = variableStateKey(nextVariables);
    const previousVariableStateObservations = variableStateCounts.get(variableState) ?? 0;
    const newVariableState = previousVariableStateObservations === 0;
    variableStateCounts.set(variableState, previousVariableStateObservations + 1);
    const changes = variableChanges(node.variables ?? {}, nextVariables);
    let rarestTransitionWeight = 0;
    for (const change of changes) {
      const key = variableTransitionKey(change);
      const previousObservations = variableTransitionCounts.get(key) ?? 0;
      rarestTransitionWeight = Math.max(rarestTransitionWeight, rarityWeight(previousObservations));
      variableTransitionCounts.set(key, previousObservations + 1);
    }
    noteDiscoveryProgress();

    if (session.errors.length > 0) {
      finishIfLast();
      return true;
    }

    const ended = !session.story.canContinue && session.story.currentChoices.length === 0;
    assertions.observe({
      variables: nextVariables,
      terminal: ended && session.errors.length === 0,
      knots: enteredAssertionKnots(session.story, assertionCountsBefore),
      path,
      choiceIndices,
      state: statesExplored,
    });
    goals.observe({ variables: nextVariables, path, choiceIndices, state: statesExplored });
    if (ended) {
      const finalText = step.text.trim().split(/\n/).slice(-3).join("\n");
      const key = `${finalText}|${JSON.stringify(nextVariables)}`;
      if (!endings.has(key)) {
        recordEnding(endings, visibleOutcomes, key, { path, choiceIndices, firstDiscoveredAtState: statesExplored, finalText, variables: nextVariables, foundBy });
        noteDiscoveryProgress();
      }
      finishIfLast();
      return true;
    }

    if (path.length >= maxDepth) {
      truncated = true;
      truncatedBy.maxDepth = true;
      finishIfLast();
      return true;
    }

    const nextState = session.story.state.ToJson();
    const key = stateKey(nextState, stateSensitivity);
    if (seenStates.has(key)) {
      dedupeHits++;
      finishIfLast();
      return true;
    }
    seenStates.add(key);
    const choiceSet = session.story.currentChoices
      .map((offered: { text?: string; sourcePath?: string }) => offered.sourcePath ?? offered.text ?? "")
      .sort()
      .join("\u0001");
    const newChoiceSet = !seenChoiceSets.has(choiceSet);
    seenChoiceSets.add(choiceSet);
    let noveltyScore = newKnots * 8 + (newVariableState ? 4 : 0) + (newChoiceSet ? 2 : 0);
    const stateRarity = 3 * rarityWeight(previousVariableStateObservations);
    const transitionRarity = changes.length > 0 ? 3 * rarestTransitionWeight : 0;
    const variableScore = Math.min(6, stateRarity + transitionRarity);
    if (path.length > deepestStateDiscovered) {
      deepestStateDiscovered = path.length;
      noveltyScore++;
    }
    addNode(
      nextState,
      nextVariables,
      active.nodeId,
      choice.text,
      choice.index,
      path.length,
      noveltyScore,
      variableScore,
      goals.priority(nextVariables)
    );
    finishIfLast();
    return true;
  };

  const done = () => finished || (!current && pendingStates === 0);

  const buildResult = (): ExploreResult => {
    const exhaustive = done() && !truncated;
    return ({
    statesExplored,
    discoverySummary: discoveryCurve.summary(statesExplored),
    endingsFound: [...endings.values()],
    runtimeErrors: [...runtimeErrors.values()],
    assertionResults: assertions.results(exhaustive),
    ...(opts.goals?.length ? { goalResults: goals.results(exhaustive) } : {}),
    runtimeWarnings: [...runtimeWarnings],
    unvisitedKnots: nonFunctionKnots
      .filter((knot) => !visitedKnots.has(knot.name))
      .map(({ name, file, line }) => ({ name, file, line })),
    visitedKnots: [...visitedKnots],
    externalFunctionsStubbed: [...externals],
    randomnessDetected: opts.randomnessDetected ?? false,
    truncated,
    truncatedBy,
    exhaustive,
    limits: { maxDepth, maxStates: totalGranted, seed, storySeed: normalizeStorySeed(opts.storySeed) },
    });
  };

  return {
    label: foundBy,
    systematic: true,
    run(grant: number): number {
      totalGranted += grant;
      const start = statesExplored;
      let sinceGuard = 0;
      while (statesExplored - start < grant) {
        if ((memoryGuard || timeGuard) && ++sinceGuard >= guardInterval) {
          sinceGuard = 0;
          if (memoryGuard && !memoryGuard()) {
            memoryStopped = true;
            break;
          }
          if (timeGuard && !timeGuard()) {
            timeStopped = true;
            break;
          }
        }
        if (!advance()) break;
      }
      return statesExplored - start;
    },
    done,
    exhaustive: () => done() && !truncated,
    stoppedForMemory: () => memoryStopped,
    stoppedForTime: () => timeStopped,
    snapshot: buildResult,
    finalize(): ExploreResult {
      if (memoryStopped) {
        truncated = true;
        truncatedBy.memory = true;
      } else if (timeStopped) {
        truncated = true;
        truncatedBy.time = true;
      } else if (!done()) {
        truncated = true;
        truncatedBy.maxStates = true;
      }
      return buildResult();
    },
    telemetry(): PassTelemetry {
      return {
        pass: foundBy,
        systematic: true,
        statesExplored,
        granted: totalGranted,
        endingsFound: endings.size,
        runtimeErrorsFound: runtimeErrors.size,
        knotsVisited: visitedKnots.size,
        newEndings: endings.size,
        newKnots: visitedKnots.size,
        newRuntimeErrors: runtimeErrors.size,
        dedupeHits,
        maxDepthReached,
        lastDiscoveryAtState,
        discoveryCurve: discoveryCurve.result(),
        discoverySummary: discoveryCurve.summary(statesExplored),
        truncatedBy: { ...truncatedBy },
        exhaustive: done() && !truncated,
        uniqueStates: seenStates.size,
        peakPendingStates,
        peakPendingBytes,
        variableStatesObserved: variableStateCounts.size,
        variableTransitionsObserved: variableTransitionCounts.size,
        rareVariableTransitions: [...variableTransitionCounts.values()].filter((count) => count === 1).length,
      };
    },
  };
}

export function exploreShared(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  const maxStates = opts.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 100_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 100000000");
  }
  return runEngineToBudget(createSharedEngine(storyJson, knots, externals, opts), maxStates, opts);
}

export function exploreSharedVariableAware(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  return exploreShared(storyJson, knots, externals, { ...opts, sharedVariableAware: true });
}

/**
 * Run the selected baseline engine with its full budget, then optionally add a
 * deterministic directed-goal slice. Extra work is explicit; goal definitions
 * with a zero goal budget are still observed by every baseline engine.
 */
export function exploreWithGoals(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  opts: ExploreOptions,
  baseline: "portfolio" | "shared" | "shared-variable" = "portfolio"
): ExploreResult {
  const maxStates = opts.maxStates ?? 100_000;
  const goalMaxStates = opts.goalMaxStates ?? 0;
  if (!Number.isSafeInteger(goalMaxStates) || goalMaxStates < 0 || goalMaxStates > 100_000_000) {
    throw new RangeError("goalMaxStates must be an integer from 0 to 100000000");
  }
  if (maxStates + goalMaxStates > 100_000_000) {
    throw new RangeError("maxStates + goalMaxStates must not exceed 100000000");
  }
  if (goalMaxStates > 0 && !opts.goals?.length) {
    throw new RangeError("goalMaxStates requires at least one goal");
  }
  const baseOptions = { ...opts, maxStates, goalMaxStates: undefined };
  const general = baseline === "shared-variable"
    ? exploreSharedVariableAware(storyJson, knots, externals, baseOptions)
    : baseline === "shared"
      ? exploreShared(storyJson, knots, externals, baseOptions)
      : explorePortfolio(storyJson, knots, externals, baseOptions);
  const generalConsumed = general.statesExplored;
  if (goalMaxStates === 0) return general;
  const directed = exploreShared(storyJson, knots, externals, {
    ...opts,
    maxStates: goalMaxStates,
    goalMaxStates: undefined,
    sharedVariableAware: false,
    sharedGoalAware: true,
    onProgress: opts.onProgress
      ? (progress) => opts.onProgress!({ ...progress, statesExplored: generalConsumed + progress.statesExplored })
      : undefined,
  });
  const directedConsumed = directed.statesExplored;
  const merged = mergeExploreResults(general, directed);
  merged.limits.maxStates = maxStates;
  merged.limits.goalMaxStates = goalMaxStates;
  merged.limits.totalMaxStates = maxStates + goalMaxStates;
  merged.goalBudget = {
    generalGranted: maxStates,
    generalConsumed,
    directedGranted: goalMaxStates,
    directedConsumed,
  };
  return merged;
}

/** Deterministic PRNG (mulberry32) so random exploration stays reproducible in CI. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRandomEngine(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  opts: ExploreOptions
): PassEngine {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
    throw new RangeError("maxDepth must be an integer from 1 to 1000");
  }
  const seed = opts.seed ?? DEFAULT_RANDOM_SEED;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError("seed must be an integer from 0 to 4294967295");
  }
  const foundBy = `random:seed=${seed}`;
  const rng = mulberry32(seed);

  const endings = new Map<string, EndingReport>();
  const visibleOutcomes = new Set<string>();
  const runtimeErrors = new Map<string, RuntimeErrorReport>();
  const runtimeWarnings = new Set<string>();
  const visitedKnots = new Set<string>();
  let statesExplored = 0;
  let totalGranted = 0;
  let truncated = false;
  const truncatedBy: TruncationCauses = { maxDepth: false, maxStates: false, beamWidth: false, memory: false, time: false };
  let memoryStopped = false;
  const memoryGuard = opts.memoryGuard;
  let timeStopped = false;
  const timeGuard = opts.timeGuard;
  const guardInterval = timeGuard ? TIMED_RESOURCE_GUARD_INTERVAL : RESOURCE_GUARD_INTERVAL;
  let maxDepthReached = 0;
  let lastDiscoveryAtState: number | null = null;
  const discoveryCurve = new DiscoveryCurveRecorder();
  const noteDiscoveryProgress = () => {
    if (discoveryCurve.observe(statesExplored, {
      endingsFound: endings.size,
      runtimeErrorsFound: runtimeErrors.size,
      knotsVisited: visitedKnots.size,
      visibleOutcomes: visibleOutcomes.size,
      assertionViolations: assertions.violationCount(),
      goalsReached: goals.reachedGoalCount(),
      stagesReached: goals.reachedStageCount(),
      uniqueStatesObserved: statesExplored,
    })) {
      lastDiscoveryAtState = statesExplored;
    }
  };

  const nonFunctionKnots = knots.filter((k) => !k.isFunction);
  const recordKnotCoverage = (session: StorySession) => {
    for (const k of nonFunctionKnots) {
      if (visitedKnots.has(k.name)) continue;
      try {
        if (session.story.state.VisitCountAtPathString(k.name) > 0) visitedKnots.add(k.name);
      } catch {
        /* path not addressable */
      }
    }
  };

  const s = makeStory(storyJson, externals, opts.storySeed);
  const resetSession = () => {
    s.errors.length = 0;
    s.warnings.length = 0;
  };

  const rootStep = continueMaximally(s);
  const assertions = assertionTracker(s.story, knots, opts.assertions, foundBy);
  const goals = new GoalTracker(opts.goals ?? [], foundBy);
  s.errors.forEach((e) =>
    runtimeErrors.set(e, { message: e, path: [], choiceIndices: [], firstDiscoveredAtState: 0, sourceLocation: sourceLocationForRuntimeError(e, knots), foundBy })
  );
  s.warnings.forEach((w) => runtimeWarnings.add(w));
  recordKnotCoverage(s);
  const rootVariables = extractVariables(s.story);

  // Linear story (or immediate end): a single walk covers it; further
  // sampling would revisit the same line of text forever.
  const linear = rootStep.choicesOffered.length === 0;
  assertions.observe({
    variables: rootVariables,
    terminal: linear && s.errors.length === 0,
    knots: [...assertionKnotCounts(s.story, opts.assertions)].filter(([, count]) => count > 0).map(([name]) => name),
    path: [],
    choiceIndices: [],
    state: 0,
  });
  goals.observe({ variables: rootVariables, path: [], choiceIndices: [], state: 0 });
  if (linear && s.errors.length === 0) {
    recordEnding(endings, visibleOutcomes, rootStep.text, {
      path: [],
      choiceIndices: [],
      firstDiscoveredAtState: 0,
      finalText: rootStep.text.trim().split(/\n/).slice(-3).join("\n"),
      variables: rootVariables,
      foundBy,
    });
  }
  noteDiscoveryProgress();

  const rootState = linear ? "" : s.story.state.ToJson();
  // Pause state: the walk in progress. The pooled story instance holds the
  // live mid-walk position between grants; only this engine touches it.
  let walkPath: string[] | null = null;
  let walkChoiceIndices: number[] | null = null;

  /** Take one transition of the current (or a fresh) walk. */
  const advance = (): void => {
    if (walkPath === null) {
      resetSession();
      s.story.state.LoadJson(rootState);
      walkPath = [];
      walkChoiceIndices = [];
    }
    const numChoices = s.story.currentChoices.length;
    if (numChoices === 0) {
      walkPath = null;
      walkChoiceIndices = null;
      return;
    }
    const i = Math.floor(rng() * numChoices);
    const choice = s.story.currentChoices[i] as { text?: string; sourcePath?: string } | undefined;
    const choiceText = choice?.text ?? `#${i}`;
    const choiceLocation = sourceLocationForChoiceSourcePath(choice?.sourcePath, knots);
    walkPath.push(choiceText);
    walkChoiceIndices!.push(i);
    const assertionCountsBefore = assertionKnotCounts(s.story, opts.assertions);
    // Count the transition attempt up front so failing walks still consume
    // budget and the sampling loop always terminates.
    statesExplored++;
    if (walkPath.length > maxDepthReached) maxDepthReached = walkPath.length;
    try {
      s.story.ChooseChoiceIndex(i);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!runtimeErrors.has(msg)) {
        runtimeErrors.set(msg, { message: msg, path: [...walkPath], choiceIndices: [...walkChoiceIndices!], firstDiscoveredAtState: statesExplored, sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation, foundBy });
      }
      noteDiscoveryProgress();
      walkPath = null;
      walkChoiceIndices = null;
      return;
    }
    const step = continueMaximally(s);
    s.errors.forEach((msg) => {
      if (!runtimeErrors.has(msg)) {
        runtimeErrors.set(msg, { message: msg, path: [...walkPath!], choiceIndices: [...walkChoiceIndices!], firstDiscoveredAtState: statesExplored, sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation, foundBy });
      }
    });
    s.warnings.forEach((w) => runtimeWarnings.add(w));
    recordKnotCoverage(s);
    noteDiscoveryProgress();
    if (s.errors.length > 0) {
      walkPath = null;
      walkChoiceIndices = null;
      return;
    }
    const ended = !s.story.canContinue && s.story.currentChoices.length === 0;
    const stateVariables = extractVariables(s.story);
    assertions.observe({
      variables: stateVariables,
      terminal: ended,
      knots: enteredAssertionKnots(s.story, assertionCountsBefore),
      path: [...walkPath!],
      choiceIndices: [...walkChoiceIndices!],
      state: statesExplored,
    });
    goals.observe({
      variables: stateVariables,
      path: [...walkPath!],
      choiceIndices: [...walkChoiceIndices!],
      state: statesExplored,
    });
    if (ended) {
      const finalText = step.text.trim().split(/\n/).slice(-3).join("\n");
      const key = finalText + "|" + JSON.stringify(stateVariables);
      if (!endings.has(key)) {
        recordEnding(endings, visibleOutcomes, key, { path: [...walkPath], choiceIndices: [...walkChoiceIndices!], firstDiscoveredAtState: statesExplored, finalText, variables: stateVariables, foundBy });
        noteDiscoveryProgress();
      }
      walkPath = null;
      walkChoiceIndices = null;
      return;
    }
    if (walkPath.length >= maxDepth) {
      truncated = true;
      truncatedBy.maxDepth = true;
      walkPath = null;
      walkChoiceIndices = null;
      return;
    }
    resetSession();
  };

  const buildResult = (): ExploreResult => ({
    statesExplored,
    discoverySummary: discoveryCurve.summary(statesExplored),
    endingsFound: [...endings.values()],
    runtimeErrors: [...runtimeErrors.values()],
    assertionResults: assertions.results(false),
    ...(opts.goals?.length ? { goalResults: goals.results(false) } : {}),
    runtimeWarnings: [...runtimeWarnings],
    unvisitedKnots: nonFunctionKnots
      .filter((k) => !visitedKnots.has(k.name))
      .map(({ name, file, line }) => ({ name, file, line })),
    visitedKnots: [...visitedKnots],
    externalFunctionsStubbed: [...externals],
    randomnessDetected: opts.randomnessDetected ?? false,
    truncated,
    truncatedBy,
    // Sampling can only ever disprove completeness, never prove it.
    exhaustive: false,
    limits: { maxDepth, maxStates: totalGranted, seed, storySeed: normalizeStorySeed(opts.storySeed) },
  });

  return {
    label: foundBy,
    systematic: false,
    run(grant: number): number {
      totalGranted += grant;
      if (linear) return 0;
      const start = statesExplored;
      let sinceGuard = 0;
      while (statesExplored - start < grant) {
        if ((memoryGuard || timeGuard) && ++sinceGuard >= guardInterval) {
          sinceGuard = 0;
          if (memoryGuard && !memoryGuard()) {
            memoryStopped = true;
            break;
          }
          if (timeGuard && !timeGuard()) {
            timeStopped = true;
            break;
          }
        }
        advance();
      }
      return statesExplored - start;
    },
    // A linear story is fully sampled by its root walk; otherwise sampling
    // always has more walks to take.
    done: () => linear,
    exhaustive: () => false,
    stoppedForMemory: () => memoryStopped,
    stoppedForTime: () => timeStopped,
    telemetry(): PassTelemetry {
      return {
        pass: foundBy,
        systematic: false,
        statesExplored,
        granted: totalGranted,
        endingsFound: endings.size,
        runtimeErrorsFound: runtimeErrors.size,
        knotsVisited: visitedKnots.size,
        newEndings: endings.size,
        newKnots: visitedKnots.size,
        newRuntimeErrors: runtimeErrors.size,
        dedupeHits: 0,
        maxDepthReached,
        lastDiscoveryAtState,
        discoveryCurve: discoveryCurve.result(),
        discoverySummary: discoveryCurve.summary(statesExplored),
        truncatedBy: { ...truncatedBy },
        exhaustive: false,
      };
    },
    snapshot: buildResult,
    finalize(): ExploreResult {
      if (memoryStopped) {
        truncated = true;
        truncatedBy.memory = true;
      } else if (timeStopped) {
        truncated = true;
        truncatedBy.time = true;
      } else if (!linear) {
        truncated = true;
        truncatedBy.maxStates = true;
      }
      return buildResult();
    },
  };
}

/**
 * Seeded random playthroughs from the story root. Unlike the systematic DFS
 * passes, each walk re-rolls every choice point, which varies early-choice
 * prefixes instead of exhausting late-choice suffixes. The seed makes runs
 * reproducible; `statesExplored` counts choice transitions across all walks.
 * Sampling never proves completeness, so a budget-bound random result is
 * always reported as truncated; only merging with an exhaustive systematic
 * pass can clear that.
 */
export function exploreRandom(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  const maxStates = opts.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 100_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 100000000");
  }
  const engine = createRandomEngine(storyJson, knots, externals, opts);
  return runEngineToBudget(engine, maxStates, opts);
}

/**
 * Frontier-capped breadth-first search with diversity-first selection.
 * Expands the whole frontier one choice level at a time like BFS, but keeps
 * at most `beamWidth` states per level. Survivors are picked round-robin
 * across variable-signature groups so that no story-state lineage can be
 * starved out by another lineage's siblings; within a group, children are
 * ranked by novelty (newly visited knots weigh 8 each, a new variable
 * signature 4, a new offered-choice set 2). This spreads budget across
 * early-choice prefixes the way BFS does while bounding the frontier memory
 * that makes naive BFS impractical on large stories. Fully deterministic
 * without a seed: ties keep discovery order. Whenever the beam prunes a
 * reachable child the result is marked truncated, because a pruning beam
 * never proves exhaustive coverage.
 */
function createBeamEngine(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[],
  opts: ExploreOptions
): PassEngine {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const beamWidth = opts.beamWidth ?? DEFAULT_BEAM_WIDTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
    throw new RangeError("maxDepth must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(beamWidth) || beamWidth < 1 || beamWidth > 10_000) {
    throw new RangeError("beamWidth must be an integer from 1 to 10000");
  }
  const foundBy = `beam:w=${beamWidth}`;
  const stateSensitivity = {
    turns: opts.preserveTurnState ?? true,
    randomness: opts.preserveRandomState ?? true,
  };

  const endings = new Map<string, EndingReport>();
  const visibleOutcomes = new Set<string>();
  const runtimeErrors = new Map<string, RuntimeErrorReport>();
  const runtimeWarnings = new Set<string>();
  const visitedKnots = new Set<string>();
  const seenStates = new Set<string>();
  const seenVarSignatures = new Set<string>();
  const seenChoiceSets = new Set<string>();
  let statesExplored = 0;
  let totalGranted = 0;
  let truncated = false;
  const truncatedBy: TruncationCauses = { maxDepth: false, maxStates: false, beamWidth: false, memory: false, time: false };
  let memoryStopped = false;
  const memoryGuard = opts.memoryGuard;
  let timeStopped = false;
  const timeGuard = opts.timeGuard;
  const guardInterval = timeGuard ? TIMED_RESOURCE_GUARD_INTERVAL : RESOURCE_GUARD_INTERVAL;
  let dedupeHits = 0;
  let maxDepthReached = 0;
  let peakFrontier = 0;
  let prunes = 0;
  let lastDiscoveryAtState: number | null = null;
  const discoveryCurve = new DiscoveryCurveRecorder();
  const noteDiscoveryProgress = () => {
    if (discoveryCurve.observe(statesExplored, {
      endingsFound: endings.size,
      runtimeErrorsFound: runtimeErrors.size,
      knotsVisited: visitedKnots.size,
      visibleOutcomes: visibleOutcomes.size,
      assertionViolations: assertions.violationCount(),
      goalsReached: goals.reachedGoalCount(),
      stagesReached: goals.reachedStageCount(),
      uniqueStatesObserved: seenStates.size,
    })) {
      lastDiscoveryAtState = statesExplored;
    }
  };

  const nonFunctionKnots = knots.filter((k) => !k.isFunction);
  const recordKnotCoverage = (session: StorySession) => {
    for (const k of nonFunctionKnots) {
      if (visitedKnots.has(k.name)) continue;
      try {
        if (session.story.state.VisitCountAtPathString(k.name) > 0) visitedKnots.add(k.name);
      } catch {
        /* path not addressable */
      }
    }
  };

  const s = makeStory(storyJson, externals, opts.storySeed);
  const resetSession = () => {
    s.errors.length = 0;
    s.warnings.length = 0;
  };

  const rootStep = continueMaximally(s);
  const assertions = assertionTracker(s.story, knots, opts.assertions, foundBy);
  const goals = new GoalTracker(opts.goals ?? [], foundBy);
  s.errors.forEach((e) =>
    runtimeErrors.set(e, { message: e, path: [], choiceIndices: [], firstDiscoveredAtState: 0, sourceLocation: sourceLocationForRuntimeError(e, knots), foundBy })
  );
  s.warnings.forEach((w) => runtimeWarnings.add(w));
  recordKnotCoverage(s);
  const rootVariables = extractVariables(s.story);
  assertions.observe({
    variables: rootVariables,
    terminal: rootStep.choicesOffered.length === 0 && s.errors.length === 0,
    knots: [...assertionKnotCounts(s.story, opts.assertions)].filter(([, count]) => count > 0).map(([name]) => name),
    path: [],
    choiceIndices: [],
    state: 0,
  });
  goals.observe({ variables: rootVariables, path: [], choiceIndices: [], state: 0 });

  interface BeamFrame {
    stateJson: string;
    path: string[];
    choiceIndices: number[];
  }
  interface BeamChild {
    frame: BeamFrame;
    score: number;
    varSig: string;
  }

  let finished = false;
  let frontier: BeamFrame[] = [];
  // Pause state within the current level: children collected so far and the
  // expansion cursor (frame index + choice index within that frame).
  let children: BeamChild[] = [];
  let frameIdx = 0;
  let expansion: { numChoices: number; next: number } | null = null;

  if (rootStep.choicesOffered.length === 0) {
    // Linear story (or immediate end).
    if (s.errors.length === 0) {
      recordEnding(endings, visibleOutcomes, rootStep.text, {
        path: [],
        choiceIndices: [],
        firstDiscoveredAtState: 0,
        finalText: rootStep.text.trim().split(/\n/).slice(-3).join("\n"),
        variables: rootVariables,
        foundBy,
      });
    }
    finished = true;
  } else {
    const rootState = s.story.state.ToJson();
    seenStates.add(stateKey(rootState, stateSensitivity));
    seenVarSignatures.add(JSON.stringify(extractVariables(s.story)));
    seenChoiceSets.add(rootStep.choicesOffered.slice().sort().join(""));
    frontier = [{ stateJson: rootState, path: [], choiceIndices: [] }];
    peakFrontier = 1;
  }
  noteDiscoveryProgress();

  /** Close out a fully expanded level: prune, select, start the next level. */
  const completeLevel = (): void => {
    // Pruning discards reachable states, so the run can no longer claim
    // exhaustive coverage even if the budget is never exhausted.
    if (children.length > beamWidth) {
      truncated = true;
      truncatedBy.beamWidth = true;
      prunes++;
    }
    // Diversity-first selection: round-robin across variable-signature
    // groups (discovery order), novelty-ranked within each group, so one
    // lineage's siblings cannot crowd every other lineage out of the beam.
    const groups = new Map<string, BeamChild[]>();
    for (const child of children) {
      const group = groups.get(child.varSig);
      if (group) group.push(child);
      else groups.set(child.varSig, [child]);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => b.score - a.score); // stable: ties keep discovery order
    }
    const selected: BeamFrame[] = [];
    while (selected.length < beamWidth) {
      let took = false;
      for (const group of groups.values()) {
        if (selected.length >= beamWidth) break;
        const next = group.shift();
        if (next) {
          selected.push(next.frame);
          took = true;
        }
      }
      if (!took) break;
    }
    frontier = selected;
    if (frontier.length > peakFrontier) peakFrontier = frontier.length;
    children = [];
    frameIdx = 0;
    expansion = null;
    if (frontier.length === 0) finished = true;
  };

  /**
   * Process the next unit of work: at most one choice transition. Level
   * bookkeeping steps cost no budget but always make progress.
   */
  const advance = (): boolean => {
    if (finished) return false;
    if (frameIdx >= frontier.length) {
      completeLevel();
      return !finished;
    }
    const frame = frontier[frameIdx];
    if (!expansion) {
      resetSession();
      s.story.state.LoadJson(frame.stateJson);
      expansion = { numChoices: s.story.currentChoices.length, next: 0 };
    }
    if (expansion.next >= expansion.numChoices) {
      frameIdx++;
      expansion = null;
      return true;
    }
    const i = expansion.next++;
    resetSession();
    s.story.state.LoadJson(frame.stateJson);
    const choice = s.story.currentChoices[i] as { text?: string; sourcePath?: string } | undefined;
    const choiceText = choice?.text ?? `#${i}`;
    const path = [...frame.path, choiceText];
    const choiceIndices = [...frame.choiceIndices, i];
    const choiceLocation = sourceLocationForChoiceSourcePath(choice?.sourcePath, knots);
    const assertionCountsBefore = assertionKnotCounts(s.story, opts.assertions);
    try {
      s.story.ChooseChoiceIndex(i);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!runtimeErrors.has(msg)) {
        runtimeErrors.set(msg, { message: msg, path, choiceIndices, firstDiscoveredAtState: statesExplored, sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation, foundBy });
      }
      noteDiscoveryProgress();
      return true;
    }
    const step = continueMaximally(s);
    statesExplored++;
    if (path.length > maxDepthReached) maxDepthReached = path.length;
    const knotsBefore = visitedKnots.size;
    s.errors.forEach((msg) => {
      if (!runtimeErrors.has(msg)) {
        runtimeErrors.set(msg, { message: msg, path, choiceIndices, firstDiscoveredAtState: statesExplored, sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation, foundBy });
      }
    });
    s.warnings.forEach((w) => runtimeWarnings.add(w));
    recordKnotCoverage(s);
    noteDiscoveryProgress();
    const newKnots = visitedKnots.size - knotsBefore;
    if (s.errors.length > 0) return true;

    const ended = !s.story.canContinue && s.story.currentChoices.length === 0;
    const stateVariables = extractVariables(s.story);
    assertions.observe({
      variables: stateVariables,
      terminal: ended,
      knots: enteredAssertionKnots(s.story, assertionCountsBefore),
      path,
      choiceIndices,
      state: statesExplored,
    });
    goals.observe({ variables: stateVariables, path, choiceIndices, state: statesExplored });
    if (ended) {
      const finalText = step.text.trim().split(/\n/).slice(-3).join("\n");
      const key = finalText + "|" + JSON.stringify(stateVariables);
      if (!endings.has(key)) {
        recordEnding(endings, visibleOutcomes, key, { path, choiceIndices, firstDiscoveredAtState: statesExplored, finalText, variables: stateVariables, foundBy });
        noteDiscoveryProgress();
      }
      return true;
    }
    if (path.length >= maxDepth) {
      truncated = true;
      truncatedBy.maxDepth = true;
      return true;
    }
    const nextState = s.story.state.ToJson();
    const key = stateKey(nextState, stateSensitivity);
    if (seenStates.has(key)) {
      dedupeHits++;
      return true; // identical state: subtree already covered
    }
    seenStates.add(key);

    const varSig = JSON.stringify(extractVariables(s.story));
    const choiceSet = s.story.currentChoices
      .map((c: { text: string }) => c.text)
      .sort()
      .join("");
    let score = newKnots * 8;
    if (!seenVarSignatures.has(varSig)) {
      score += 4;
      seenVarSignatures.add(varSig);
    }
    if (!seenChoiceSets.has(choiceSet)) {
      score += 2;
      seenChoiceSets.add(choiceSet);
    }
    children.push({ frame: { stateJson: nextState, path, choiceIndices }, score, varSig });
    return true;
  };

  const buildResult = (): ExploreResult => {
    const exhaustive = finished && !truncated;
    return ({
    statesExplored,
    discoverySummary: discoveryCurve.summary(statesExplored),
    endingsFound: [...endings.values()],
    runtimeErrors: [...runtimeErrors.values()],
    assertionResults: assertions.results(exhaustive),
    ...(opts.goals?.length ? { goalResults: goals.results(exhaustive) } : {}),
    runtimeWarnings: [...runtimeWarnings],
    unvisitedKnots: nonFunctionKnots
      .filter((k) => !visitedKnots.has(k.name))
      .map(({ name, file, line }) => ({ name, file, line })),
    visitedKnots: [...visitedKnots],
    externalFunctionsStubbed: [...externals],
    randomnessDetected: opts.randomnessDetected ?? false,
    truncated,
    truncatedBy,
    exhaustive,
    limits: { maxDepth, maxStates: totalGranted, storySeed: normalizeStorySeed(opts.storySeed) },
    });
  };

  return {
    label: foundBy,
    systematic: true,
    run(grant: number): number {
      totalGranted += grant;
      const start = statesExplored;
      let sinceGuard = 0;
      while (statesExplored - start < grant) {
        if ((memoryGuard || timeGuard) && ++sinceGuard >= guardInterval) {
          sinceGuard = 0;
          if (memoryGuard && !memoryGuard()) {
            memoryStopped = true;
            break;
          }
          if (timeGuard && !timeGuard()) {
            timeStopped = true;
            break;
          }
        }
        if (!advance()) break;
      }
      return statesExplored - start;
    },
    done: () => finished,
    exhaustive: () => finished && !truncated,
    stoppedForMemory: () => memoryStopped,
    stoppedForTime: () => timeStopped,
    snapshot: buildResult,
    finalize(): ExploreResult {
      if (memoryStopped) {
        truncated = true;
        truncatedBy.memory = true;
      } else if (timeStopped) {
        truncated = true;
        truncatedBy.time = true;
      } else if (!finished) {
        truncated = true;
        truncatedBy.maxStates = true;
      }
      return buildResult();
    },
    telemetry(): PassTelemetry {
      return {
        pass: foundBy,
        systematic: true,
        statesExplored,
        granted: totalGranted,
        endingsFound: endings.size,
        runtimeErrorsFound: runtimeErrors.size,
        knotsVisited: visitedKnots.size,
        newEndings: endings.size,
        newKnots: visitedKnots.size,
        newRuntimeErrors: runtimeErrors.size,
        dedupeHits,
        maxDepthReached,
        lastDiscoveryAtState,
        discoveryCurve: discoveryCurve.result(),
        discoverySummary: discoveryCurve.summary(statesExplored),
        truncatedBy: { ...truncatedBy },
        exhaustive: finished && !truncated,
        peakFrontier,
        prunes,
      };
    },
  };
}

export function exploreBeam(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  const maxStates = opts.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 100_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 100000000");
  }
  const engine = createBeamEngine(storyJson, knots, externals, opts);
  return runEngineToBudget(engine, maxStates, opts);
}

/** Deterministic largest-remainder split of `total` units by weight. */
function splitBudget(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const shares = weights.map((w) => (total * w) / sum);
  const grants = shares.map(Math.floor);
  let left = total - grants.reduce((a, b) => a + b, 0);
  const byRemainder = shares
    .map((share, i) => ({ i, frac: share - Math.floor(share) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % byRemainder.length) {
    grants[byRemainder[k].i]++;
    left--;
  }
  return grants;
}

/** Marginal (portfolio-wide first-discovery) counts for one pass snapshot. */
function countMarginalFindings(
  snap: ExploreResult,
  seenEndings: Set<string>,
  seenKnots: Set<string>,
  seenErrors: Set<string>
): { newEndings: number; newKnots: number; newRuntimeErrors: number } {
  let newEndings = 0;
  for (const e of snap.endingsFound) {
    const key = endingKey(e);
    if (!seenEndings.has(key)) {
      seenEndings.add(key);
      newEndings++;
    }
  }
  let newKnots = 0;
  for (const name of snap.visitedKnots) {
    if (!seenKnots.has(name)) {
      seenKnots.add(name);
      newKnots++;
    }
  }
  let newRuntimeErrors = 0;
  for (const err of snap.runtimeErrors) {
    if (!seenErrors.has(err.message)) {
      seenErrors.add(err.message);
      newRuntimeErrors++;
    }
  }
  return { newEndings, newKnots, newRuntimeErrors };
}

/**
 * Adaptive portfolio search (issues #27/#29). The state budget is spent in
 * deterministic rounds across complementary passes; each round's grants are
 * reallocated toward passes whose findings are still growing, with a floor
 * per pass so a discovery dry spell never zeroes a pass out (late
 * discoveries after long dry spells are real). Initial weights come from
 * `opts.weights` — e.g. a story-shape profile — or defaults. The whole
 * portfolio stops the moment any systematic pass proves the reachable space
 * exhausted: every further state would be redundant. The executed schedule
 * is recorded on the merged result.
 */
function explorePortfolioInternal(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {},
  replayShadowAllocation = false
): ExploreResult {
  const maxStates = opts.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 100_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 100000000");
  }
  if (maxStates === 1) {
    const result = explore(storyJson, knots, externals, opts);
    opts.onSnapshot?.(result);
    return result;
  }

  const weights = opts.weights ?? DEFAULT_PORTFOLIO_WEIGHTS;
  const shared = { ...opts };
  const engines: PassEngine[] = [];
  const engineWeights: number[] = [];
  const addEngine = (engine: PassEngine, weight: number) => {
    engines.push(engine);
    engineWeights.push(weight);
  };
  if (weights.last > 0) {
    addEngine(
      createSearchEngine(storyJson, knots, externals, { ...shared, strategy: "dfs", dfsChoicePriority: "last" }),
      weights.last
    );
  }
  if (weights.first > 0) {
    addEngine(
      createSearchEngine(storyJson, knots, externals, { ...shared, strategy: "dfs", dfsChoicePriority: "first" }),
      weights.first
    );
  }
  if (weights.insideOut > 0) {
    addEngine(
      createSearchEngine(storyJson, knots, externals, { ...shared, strategy: "dfs", dfsChoicePriority: "inside-out" }),
      weights.insideOut
    );
  }
  // Sampling/diversity passes earn a slice only when the budget can feed them.
  if (weights.beam > 0 && maxStates >= 10) {
    addEngine(createBeamEngine(storyJson, knots, externals, shared), weights.beam);
  }
  if (weights.random > 0 && maxStates >= 5) {
    addEngine(createRandomEngine(storyJson, knots, externals, shared), weights.random);
  }
  if (engines.length === 0) {
    addEngine(
      createSearchEngine(storyJson, knots, externals, { ...shared, strategy: "dfs", dfsChoicePriority: "last" }),
      1
    );
  }

  const roundSize = Math.max(1, Math.floor(maxStates / 10));
  const minShare = 0.08;
  const schedule: ScheduleRound[] = [];
  const policyReplay: PolicyReplayRound[] = [];
  const seenEndings = new Set<string>();
  const seenKnots = new Set<string>();
  const seenErrors = new Set<string>();
  const seenPolicyErrors = new Set<string>();
  const seenVisibleOutcomes = new Set<string>();
  const seenAssertionViolations = new Set<string>();
  const seenGoals = new Set<string>();
  const seenStages = new Set<string>();
  const portfolioCurve = new DiscoveryCurveRecorder();
  // Live progress reports portfolio-wide cumulative discoveries, not a single
  // pass's snapshot. Per-pass snapshots are each correct but not comparable
  // across the interleaved rounds, so a naive relay makes the counts bounce
  // (endings/errors drop, unvisited knots climb) as passes alternate. The
  // dedup sets above are monotonic by construction, so we drive progress from
  // them: endings/errors only grow, and unvisited knots only shrink.
  const totalNonFunctionKnots = knots.filter((k) => !k.isFunction).length;
  const marginalTotals = engines.map(() => ({
    endings: 0,
    knots: 0,
    errors: 0,
    policyErrors: 0,
    visibleOutcomes: 0,
    assertions: 0,
    goals: 0,
    stages: 0,
  }));
  const marginalCurves = engines.map(() => new DiscoveryCurveRecorder());
  let currentWeights = [...engineWeights];
  let replayFloorAllocator: CumulativeFloorAllocator | undefined;
  let policyControlsCurrentRound = false;
  let remaining = maxStates;
  let exhaustedEarly = false;
  let memoryStopped = false;
  let timeStopped = false;

  const buildPortfolioSnapshot = (): ExploreResult => {
    const snapshots = engines.map((engine) => engine.snapshot());
    const [firstSnapshot, ...otherSnapshots] = snapshots;
    const mergedSnapshot = otherSnapshots.reduce(
      (acc, result) => mergeExploreResults(acc, result),
      firstSnapshot
    );
    mergedSnapshot.limits.maxStates = maxStates;
    mergedSnapshot.discoveryCurve = portfolioCurve.result();
    mergedSnapshot.discoverySummary = portfolioCurve.summary(maxStates - remaining);
    mergedSnapshot.schedule = [...schedule];
    if (replayShadowAllocation) mergedSnapshot.policyReplay = [...policyReplay];
    mergedSnapshot.passes = engines.map((engine, i) => {
      const telemetry = engine.telemetry();
      return {
        ...telemetry,
        newEndings: marginalTotals[i].endings,
        newKnots: marginalTotals[i].knots,
        newRuntimeErrors: marginalTotals[i].errors,
        portfolioMarginalCurve: marginalCurves[i].result(),
        portfolioMarginalSummary: marginalCurves[i].summary(telemetry.statesExplored),
      };
    });
    if (memoryStopped && !mergedSnapshot.exhaustive) {
      mergedSnapshot.truncated = true;
      mergedSnapshot.truncatedBy = { ...mergedSnapshot.truncatedBy, maxStates: false, memory: true };
    } else if (timeStopped && !mergedSnapshot.exhaustive) {
      mergedSnapshot.truncated = true;
      mergedSnapshot.truncatedBy = { ...mergedSnapshot.truncatedBy, maxStates: false, time: true };
    }
    return mergedSnapshot;
  };

  while (remaining > 0 && !exhaustedEarly && !memoryStopped && !timeStopped && engines.some((e) => !e.done())) {
    // Stop before a round begins if a guard has already tripped, so we do not
    // start allocating another round's worth of frontier/state hashes.
    if (opts.memoryGuard && !opts.memoryGuard()) {
      memoryStopped = true;
      break;
    }
    if (opts.timeGuard && !opts.timeGuard()) {
      timeStopped = true;
      break;
    }
    const active = engines
      .map((engine, i) => ({ engine, i }))
      .filter(({ engine }) => !engine.done());
    const roundBudget = Math.min(roundSize, remaining);
    const floorService = replayShadowAllocation && policyControlsCurrentRound
      ? (replayFloorAllocator ??= new CumulativeFloorAllocator(
          engines.map((engine) => engine.label),
          minShare
        )).allocate(roundBudget, currentWeights, engines.map((engine) => !engine.done()))
      : undefined;
    const grants = floorService
      ? active.map(({ i }) => floorService.grants[i])
      : splitBudget(roundBudget, active.map(({ i }) => currentWeights[i]));
    const entries: ScheduleRoundEntry[] = [];
    const scores = new Array<number>(engines.length).fill(0);
    for (let a = 0; a < active.length; a++) {
      const { engine, i } = active[a];
      const consumed = grants[a] > 0 ? engine.run(grants[a]) : 0;
      remaining -= consumed;
      const snapshot = engine.snapshot();
      const marginal = countMarginalFindings(snapshot, seenEndings, seenKnots, seenErrors);
      let newPolicyErrors = 0;
      for (const error of snapshot.runtimeErrors) {
        // Approximate fallback lines can vary by witness path (#84). For budget
        // credit, conservatively collapse them by message/file rather than pay
        // several passes for one semantic failure. Report identity is unchanged.
        const key = portfolioRuntimeErrorKey(error);
        if (!seenPolicyErrors.has(key)) {
          seenPolicyErrors.add(key);
          newPolicyErrors++;
        }
      }
      let newVisibleOutcomes = 0;
      for (const ending of snapshot.endingsFound) {
        const key = visibleOutcomeKey(ending.finalText);
        if (!seenVisibleOutcomes.has(key)) {
          seenVisibleOutcomes.add(key);
          newVisibleOutcomes++;
        }
      }
      let newAssertionViolations = 0;
      for (const assertion of snapshot.assertionResults) {
        for (const violation of assertion.violations) {
          const key = assertionViolationKey(assertion.id, violation.observedValues, violation.choiceIndices);
          if (!seenAssertionViolations.has(key)) {
            seenAssertionViolations.add(key);
            newAssertionViolations++;
          }
        }
      }
      let newGoals = 0;
      let newStages = 0;
      for (const goal of snapshot.goalResults ?? []) {
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
      portfolioCurve.observe(maxStates - remaining, {
        endingsFound: seenEndings.size,
        runtimeErrorsFound: seenErrors.size,
        knotsVisited: seenKnots.size,
        visibleOutcomes: seenVisibleOutcomes.size,
        assertionViolations: seenAssertionViolations.size,
        goalsReached: seenGoals.size,
        stagesReached: seenStages.size,
        uniqueStatesObserved: 0,
      });
      const portfolioSummary = portfolioCurve.summary(maxStates - remaining);
      opts.onProgress?.({
        pass: engine.label,
        statesExplored: maxStates - remaining,
        endingsFound: seenEndings.size,
        runtimeErrorsFound: seenErrors.size,
        unvisitedKnots: totalNonFunctionKnots - seenKnots.size,
        visibleOutcomes: seenVisibleOutcomes.size,
        assertionViolations: seenAssertionViolations.size,
        goalsReached: seenGoals.size,
        stagesReached: seenStages.size,
        discoveryEvents: portfolioSummary.discoveryEvents,
        statesSinceLastDiscovery: portfolioSummary.statesSinceLastDiscovery,
      });
      marginalTotals[i].endings += marginal.newEndings;
      marginalTotals[i].knots += marginal.newKnots;
      marginalTotals[i].errors += marginal.newRuntimeErrors;
      marginalTotals[i].policyErrors += newPolicyErrors;
      marginalTotals[i].visibleOutcomes += newVisibleOutcomes;
      marginalTotals[i].assertions += newAssertionViolations;
      marginalTotals[i].goals += newGoals;
      marginalTotals[i].stages += newStages;
      marginalCurves[i].observe(snapshot.statesExplored, {
        endingsFound: marginalTotals[i].endings,
        runtimeErrorsFound: marginalTotals[i].policyErrors,
        knotsVisited: marginalTotals[i].knots,
        visibleOutcomes: marginalTotals[i].visibleOutcomes,
        assertionViolations: marginalTotals[i].assertions,
        goalsReached: marginalTotals[i].goals,
        stagesReached: marginalTotals[i].stages,
        uniqueStatesObserved: 0,
      });
      entries.push({
        pass: engine.label,
        granted: grants[a],
        consumed,
        ...marginal,
      });
      scores[i] =
        marginal.newRuntimeErrors * 5 + marginal.newEndings * 3 + marginal.newKnots * 2;
      if (engine.stoppedForMemory()) {
        // A guard tripped mid-round; finish recording this round, then stop.
        memoryStopped = true;
      }
      if (engine.stoppedForTime()) {
        timeStopped = true;
      }
      if (memoryStopped || timeStopped) break;
      if (engine.done() && engine.exhaustive()) {
        // The reachable space is proven covered; all further work is redundant.
        exhaustedEarly = true;
        break;
      }
    }
    schedule.push({ round: schedule.length + 1, entries });
    opts.onSnapshot?.(buildPortfolioSnapshot());
    if (memoryStopped || timeStopped) break;
    const totalScore = scores.reduce((a, b) => a + b, 0);
    let legacyWeights = currentWeights;
    if (totalScore > 0) {
      const pool = 1 - minShare * engines.length;
      legacyWeights = currentWeights.map(
        (_, i) => minShare + Math.max(0, pool) * (scores[i] / totalScore)
      );
    }
    if (replayShadowAllocation) {
      const snapshots = engines.map((engine) => engine.snapshot());
      const [firstSnapshot, ...otherSnapshots] = snapshots;
      const policySnapshot = otherSnapshots.reduce(
        (acc, result) => mergeExploreResults(acc, result),
        firstSnapshot
      );
      policySnapshot.limits.maxStates = maxStates;
      policySnapshot.discoveryCurve = portfolioCurve.result();
      policySnapshot.discoverySummary = portfolioCurve.summary(maxStates - remaining);
      policySnapshot.schedule = [...schedule];
      policySnapshot.passes = engines.map((engine, i) => {
        const telemetry = engine.telemetry();
        return {
          ...telemetry,
          newEndings: marginalTotals[i].endings,
          newKnots: marginalTotals[i].knots,
          newRuntimeErrors: marginalTotals[i].errors,
          portfolioMarginalCurve: marginalCurves[i].result(),
          portfolioMarginalSummary: marginalCurves[i].summary(telemetry.statesExplored),
        };
      });
      const decision = recommendShadowDecision(policySnapshot);
      const priorityRenewed = decision.allocation.some((entry) =>
        entry.recency.renewal === "renewed"
          && (entry.recentValue.critical > 0 || entry.recentValue.intent > 0)
      );
      const allocationApplied = decision.action === "reallocate" && schedule.length >= 3 && priorityRenewed;
      const allocationGate = allocationApplied
        ? "applied" as const
        : decision.action !== "reallocate"
          ? "not_reallocate" as const
          : schedule.length < 3
            ? "warmup" as const
            : "priority" as const;
      if (allocationApplied) {
        const suggested = new Map(decision.allocation.map((entry) => [entry.pass, entry.suggestedShare]));
        currentWeights = engines.map((engine, i) =>
          legacyWeights[i] * 0.9 + (suggested.get(engine.label) ?? legacyWeights[i]) * 0.1
        );
      } else {
        currentWeights = legacyWeights;
      }
      // Floors protect policy-controlled discretionary work. Warm-up and
      // gated-off decisions must preserve the production scheduler exactly;
      // otherwise replay changes coverage while claiming no allocation was applied.
      policyControlsCurrentRound = allocationApplied;
      policyReplay.push({
        round: schedule.length,
        decision,
        allocationApplied,
        allocationGate,
        nextRoundWeights: engines.map((engine, i) => ({ pass: engine.label, share: currentWeights[i] })),
        ...(floorService ? { floorService } : {}),
      });
    } else {
      currentWeights = legacyWeights;
    }
  }

  const results = engines.map((engine) => engine.finalize());
  const [firstRun, ...rest] = results;
  const merged = rest.reduce((acc, result) => mergeExploreResults(acc, result), firstRun);
  // Limits report the configured budget; what was actually consumed is in
  // statesExplored and the schedule (early exit can leave budget unspent).
  merged.limits.maxStates = maxStates;
  merged.discoveryCurve = portfolioCurve.result();
  merged.discoverySummary = portfolioCurve.summary(maxStates - remaining);
  // When a guard stopped the run, that guard is the true cause — the budget
  // did not actually run out, so do not also blame maxStates.
  if (memoryStopped && !merged.exhaustive) {
    merged.truncated = true;
    merged.truncatedBy = { ...merged.truncatedBy, maxStates: false, memory: true };
  } else if (timeStopped && !merged.exhaustive) {
    merged.truncated = true;
    merged.truncatedBy = { ...merged.truncatedBy, maxStates: false, time: true };
  }
  merged.schedule = schedule;
  if (replayShadowAllocation) merged.policyReplay = policyReplay;
  // Per-pass lifetime telemetry, with new* replaced by the true
  // portfolio-marginal totals the scheduler measured round by round.
  merged.passes = engines.map((engine, i) => {
    const telemetry = engine.telemetry();
    return {
      ...telemetry,
      newEndings: marginalTotals[i].endings,
      newKnots: marginalTotals[i].knots,
      newRuntimeErrors: marginalTotals[i].errors,
      portfolioMarginalCurve: marginalCurves[i].result(),
      portfolioMarginalSummary: marginalCurves[i].summary(telemetry.statesExplored),
    };
  });
  return merged;
}

export function explorePortfolio(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  return explorePortfolioInternal(storyJson, knots, externals, opts, false);
}

/** Research-only paired candidate for #103; applies reallocation actions but never policy stops. */
export function explorePortfolioShadowReplay(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  return explorePortfolioInternal(storyJson, knots, externals, opts, true);
}

/**
 * Attach inbound-divert triage hints to unvisited knots so reports can
 * separate "nothing in the source diverts here — possible orphan" from
 * "the source diverts here, so this run's limits probably cut it off".
 * A hint, not proof: textual diverts do not establish reachability.
 */
export function classifyUnvisitedKnots(
  result: ExploreResult,
  inboundDiverts: Record<string, number>
): ExploreResult {
  for (const knot of result.unvisitedKnots) {
    const count = inboundDiverts[knot.name] ?? 0;
    knot.inboundDiverts = count;
    knot.staticOrphanCandidate = count === 0;
  }
  return result;
}

function endingKey(e: EndingReport): string {
  return e.finalText + "|" + JSON.stringify(e.variables);
}

export function mergeExploreResults(main: ExploreResult, other: ExploreResult): ExploreResult {
  if (main.limits.storySeed !== other.limits.storySeed) {
    throw new Error(
      `cannot merge runs with different story seeds (${main.limits.storySeed} and ${other.limits.storySeed})`
    );
  }
  // Generic merges do not know the actual interleaving/offset timeline. A
  // caller such as the portfolio scheduler may attach its recorder afterward.
  main.discoveryCurve = undefined;
  main.discoverySummary = undefined;
  for (const err of main.runtimeErrors) {
    const match = other.runtimeErrors.find((e) => e.message === err.message);
    if (match && match.path.length < err.path.length) {
      err.path = match.path;
      err.choiceIndices = match.choiceIndices;
      err.firstDiscoveredAtState = match.firstDiscoveredAtState;
      err.foundBy = match.foundBy;
    }
  }
  const otherEndings = new Map(other.endingsFound.map((e) => [endingKey(e), e]));
  for (const end of main.endingsFound) {
    const match = otherEndings.get(endingKey(end));
    if (match && match.path.length < end.path.length) {
      end.path = match.path;
      end.choiceIndices = match.choiceIndices;
      end.firstDiscoveredAtState = match.firstDiscoveredAtState;
      end.foundBy = match.foundBy;
    }
  }
  // A complementary pass may also have reached endings/errors/knots the first pass missed within limits.
  const mainEndingKeys = new Set(main.endingsFound.map(endingKey));
  for (const e of other.endingsFound) {
    if (!mainEndingKeys.has(endingKey(e))) main.endingsFound.push(e);
  }
  const mainErrs = new Set(main.runtimeErrors.map((e) => e.message));
  for (const e of other.runtimeErrors) {
    if (!mainErrs.has(e.message)) main.runtimeErrors.push(e);
  }
  const assertionsById = new Map(main.assertionResults.map((result) => [result.id, result]));
  for (const result of other.assertionResults) {
    const existing = assertionsById.get(result.id);
    if (!existing) {
      main.assertionResults.push(result);
      assertionsById.set(result.id, result);
      continue;
    }
    existing.observations += result.observations;
    const candidate = result.violations[0];
    const previous = existing.violations[0];
    if (candidate && (!previous || candidate.path.length < previous.path.length)) {
      existing.violations = [candidate];
    }
    if (existing.violations.length) existing.status = "violated";
  }
  const goalsById = new Map((main.goalResults ?? []).map((result) => [result.id, result]));
  for (const result of other.goalResults ?? []) {
    const existing = goalsById.get(result.id);
    if (!existing) {
      (main.goalResults ??= []).push(result);
      goalsById.set(result.id, result);
      continue;
    }
    existing.statesEvaluated += result.statesEvaluated;
    if (result.witness && (!existing.witness || result.witness.path.length < existing.witness.path.length)) {
      existing.witness = result.witness;
    }
    if (existing.witness) existing.status = "reached";
    if (result.closestObserved && (!existing.closestObserved || result.closestObserved.distance < existing.closestObserved.distance)) {
      existing.closestObserved = result.closestObserved;
    }
    const stagesById = new Map((existing.stages ?? []).map((stage) => [stage.id, stage]));
    for (const stage of result.stages ?? []) {
      const current = stagesById.get(stage.id);
      if (!current) {
        (existing.stages ??= []).push(stage);
        stagesById.set(stage.id, stage);
        continue;
      }
      current.statesEvaluated += stage.statesEvaluated;
      if (stage.witness && (!current.witness || stage.witness.path.length < current.witness.path.length)) current.witness = stage.witness;
      if (current.witness) current.status = "reached";
      if (stage.closestObserved && (!current.closestObserved || stage.closestObserved.distance < current.closestObserved.distance)) {
        current.closestObserved = stage.closestObserved;
      }
    }
    const finalStage = existing.stages?.[existing.stages.length - 1];
    if (!existing.witness && finalStage) existing.status = finalStage.status;
  }
  main.runtimeWarnings = [...new Set([...main.runtimeWarnings, ...other.runtimeWarnings])];
  const visited = new Set([...main.visitedKnots, ...other.visitedKnots]);
  main.visitedKnots = [...visited];
  main.unvisitedKnots = main.unvisitedKnots.filter((k) => !visited.has(k.name));
  main.statesExplored += other.statesExplored;
  main.truncated ||= other.truncated;
  main.truncatedBy = {
    maxDepth: main.truncatedBy.maxDepth || other.truncatedBy.maxDepth,
    maxStates: main.truncatedBy.maxStates || other.truncatedBy.maxStates,
    beamWidth: main.truncatedBy.beamWidth || other.truncatedBy.beamWidth,
    memory: main.truncatedBy.memory || other.truncatedBy.memory,
    time: main.truncatedBy.time || other.truncatedBy.time,
  };
  // One systematic pass finishing without truncation proves every reachable
  // state was visited, so partial-coverage flags from budget-bound sampling
  // passes (which resample a space already proven exhausted) are cleared.
  main.exhaustive ||= other.exhaustive;
  if (main.exhaustive) {
    main.truncated = false;
    main.truncatedBy = { maxDepth: false, maxStates: false, beamWidth: false, memory: false, time: false };
  }
  for (const result of main.assertionResults) {
    result.status = result.violations.length
      ? "violated"
      : main.exhaustive
        ? "exhaustively_verified"
        : "not_observed";
  }
  for (const result of main.goalResults ?? []) {
    if (result.stages?.length) {
      for (let index = 0; index < result.stages.length; index++) {
        const stage = result.stages[index];
        const previous = index > 0 ? result.stages[index - 1] : undefined;
        stage.status = stage.witness
          ? "reached"
          : previous && previous.status !== "reached"
            ? "blocked_by_stage"
            : main.exhaustive
              ? "proven_unreachable"
              : "not_reached_within_limits";
        if (stage.status === "blocked_by_stage") stage.blockedBy = previous!.id;
      }
      result.status = result.stages[result.stages.length - 1].status;
    } else {
      result.status = result.witness
        ? "reached"
        : main.exhaustive
          ? "proven_unreachable"
          : "not_reached_within_limits";
    }
  }
  main.externalFunctionsStubbed = [...new Set([...main.externalFunctionsStubbed, ...other.externalFunctionsStubbed])];
  main.randomnessDetected ||= other.randomnessDetected;
  if (other.passes?.length) main.passes = [...(main.passes ?? []), ...other.passes];
  const seed = main.limits.seed ?? other.limits.seed;
  const goalMaxStates = (main.limits.goalMaxStates ?? 0) + (other.limits.goalMaxStates ?? 0);
  const maxStates = main.limits.maxStates + other.limits.maxStates;
  main.limits = {
    maxDepth: Math.max(main.limits.maxDepth, other.limits.maxDepth),
    maxStates,
    storySeed: main.limits.storySeed,
  };
  if (goalMaxStates > 0) {
    main.limits.goalMaxStates = goalMaxStates;
    main.limits.totalMaxStates = maxStates + goalMaxStates;
  }
  if (seed !== undefined) main.limits.seed = seed;
  return main;
}

/**
 * Shorten repro paths in `main` using a BFS pass over the same story. BFS reaches
 * shared findings by their shortest choice trail, and may also contribute extra
 * shallow findings within its own limits.
 */
export function mergeMinRepro(main: ExploreResult, bfs: ExploreResult): ExploreResult {
  return mergeExploreResults(main, bfs);
}
