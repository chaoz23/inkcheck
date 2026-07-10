import { createHash } from "crypto";
import { Story } from "inkjs";
import { KnotInfo } from "./inklecate";

export interface PlaytestStep {
  text: string;
  tags: string[];
  choicesOffered: string[];
  choiceTaken: number | null;
}

export interface PlaytestResult {
  steps: PlaytestStep[];
  ended: boolean;
  /** Choices remaining at the point the transcript stopped (empty if the story ended). */
  pendingChoices: string[];
  variables: Record<string, unknown>;
  runtimeErrors: string[];
  runtimeWarnings: string[];
  /** EXTERNAL functions replaced with zero during this playtest. */
  externalFunctionsStubbed: string[];
}

export interface EndingReport {
  /** Choice-text trail that led here, e.g. ["Pick the lock", "Go north"]. */
  path: string[];
  finalText: string;
  variables: Record<string, unknown>;
  /** Search pass that found this ending, e.g. "dfs:last" or "random:seed=1". */
  foundBy?: string;
}

export interface RuntimeErrorReport {
  message: string;
  path: string[];
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
  limits: { maxDepth: number; maxStates: number; seed?: number };
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
    const state = JSON.parse(story.state.ToJson());
    const vars = state.variablesState ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vars)) out[k] = cleanInkValue(v);
    return out;
  } catch {
    return {};
  }
}

interface StorySession {
  story: InstanceType<typeof Story>;
  errors: string[];
  warnings: string[];
}

function makeStory(storyJson: string, externals: string[]): StorySession {
  const story = new Story(storyJson);
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
  externals: string[] = []
): PlaytestResult {
  const s = makeStory(storyJson, externals);
  const steps: PlaytestStep[] = [];
  let step = continueMaximally(s);
  for (const idx of choices) {
    if (idx < 0 || idx >= s.story.currentChoices.length) {
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
    steps,
    ended,
    pendingChoices: s.story.currentChoices.map((c: { text: string }) => c.text),
    variables: extractVariables(s.story),
    runtimeErrors: s.errors,
    runtimeWarnings: s.warnings,
    externalFunctionsStubbed: [...externals],
  };
}

interface Frame {
  stateJson: string;
  path: string[];
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
  /** Frontier cap per depth level for the novelty beam pass. Default 64. */
  beamWidth?: number;
}

export const DEFAULT_RANDOM_SEED = 1;
export const DEFAULT_BEAM_WIDTH = 64;

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
  const maxDepth = opts.maxDepth ?? 30;
  const maxStates = opts.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
    throw new RangeError("maxDepth must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 1_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 1000000");
  }
  const strategy = opts.strategy ?? "dfs";
  const dfsChoicePriority = opts.dfsChoicePriority ?? "last";
  const foundBy = strategy === "bfs" ? "bfs" : `dfs:${dfsChoicePriority}`;
  const stateSensitivity = {
    turns: opts.preserveTurnState ?? true,
    randomness: opts.preserveRandomState ?? true,
  };

  const endings = new Map<string, EndingReport>();
  const runtimeErrors = new Map<string, RuntimeErrorReport>();
  const runtimeWarnings = new Set<string>();
  const visitedKnots = new Set<string>();
  const seenStates = new Set<string>();
  let statesExplored = 0;
  let truncated = false;
  const truncatedBy: TruncationCauses = { maxDepth: false, maxStates: false, beamWidth: false };

  const nonFunctionKnots = knots.filter((k) => !k.isFunction);

  const recordKnotCoverage = (s: StorySession) => {
    for (const k of nonFunctionKnots) {
      if (visitedKnots.has(k.name)) continue;
      try {
        if (s.story.state.VisitCountAtPathString(k.name) > 0) visitedKnots.add(k.name);
      } catch {
        /* path not addressable */
      }
    }
  };

  // One pooled instance: constructing Story parses the full compiled JSON,
  // so we do it once and rewind between branches with LoadJson.
  const s = makeStory(storyJson, externals);
  const resetSession = () => {
    s.errors.length = 0;
    s.warnings.length = 0;
  };

  // Root: continue the fresh story to the first choice point.
  const rootStep = continueMaximally(s);
  s.errors.forEach((e) =>
    runtimeErrors.set(e, { message: e, path: [], sourceLocation: sourceLocationForRuntimeError(e, knots), foundBy })
  );
  s.warnings.forEach((w) => runtimeWarnings.add(w));
  recordKnotCoverage(s);

  if (rootStep.choicesOffered.length === 0 && s.errors.length === 0) {
    // Linear story (or immediate end).
    endings.set(rootStep.text, {
      path: [],
      finalText: rootStep.text.trim().split(/\n/).slice(-3).join("\n"),
      variables: extractVariables(s.story),
      foundBy,
    });
  }

  const rootState = s.story.state.ToJson();
  seenStates.add(stateKey(rootState, stateSensitivity));
  const frames: Frame[] = [{ stateJson: rootState, path: [], depth: 0 }];
  let head = 0; // BFS read pointer (avoids O(n) shifts)

  while (strategy === "bfs" ? head < frames.length : frames.length > 0) {
    if (statesExplored >= maxStates) {
      truncated = true;
      truncatedBy.maxStates = true;
      break;
    }
    const frame = strategy === "bfs" ? frames[head++] : frames.pop()!;
    resetSession();
    try {
      s.story.state.LoadJson(frame.stateJson);
    } catch (e) {
      runtimeErrors.set(String(e), {
        message: `State restore failed: ${e instanceof Error ? e.message : e}`,
        path: frame.path,
        foundBy,
      });
      continue;
    }
    const numChoices = s.story.currentChoices.length;
    const choiceIndices =
      strategy === "dfs"
        ? dfsPushOrder(numChoices, dfsChoicePriority)
        : Array.from({ length: numChoices }, (_, i) => i);

    for (const i of choiceIndices) {
      if (statesExplored >= maxStates) {
        truncated = true;
        truncatedBy.maxStates = true;
        break;
      }
      resetSession();
      s.story.state.LoadJson(frame.stateJson);
      const choice = s.story.currentChoices[i] as { text?: string; sourcePath?: string } | undefined;
      const choiceText = choice?.text ?? `#${i}`;
      const path = [...frame.path, choiceText];
      const choiceLocation = sourceLocationForChoiceSourcePath(choice?.sourcePath, knots);
      try {
        s.story.ChooseChoiceIndex(i);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        runtimeErrors.set(msg, {
          message: msg,
          path,
          sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation,
          foundBy,
        });
        continue;
      }
      const step = continueMaximally(s);
      statesExplored++;
      s.errors.forEach((msg) => {
        if (!runtimeErrors.has(msg)) {
          runtimeErrors.set(msg, {
            message: msg,
            path,
            sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation,
            foundBy,
          });
        }
      });
      s.warnings.forEach((w) => runtimeWarnings.add(w));
      recordKnotCoverage(s);

      const ended = !s.story.canContinue && s.story.currentChoices.length === 0;
      if (ended && s.errors.length === 0) {
        const finalText = step.text.trim().split(/\n/).slice(-3).join("\n");
        const key = finalText + "|" + JSON.stringify(extractVariables(s.story));
        if (!endings.has(key)) {
          endings.set(key, { path, finalText, variables: extractVariables(s.story), foundBy });
        }
        continue;
      }
      if (path.length >= maxDepth) {
        truncated = true;
        truncatedBy.maxDepth = true;
        continue;
      }
      const nextState = s.story.state.ToJson();
      const key = stateKey(nextState, stateSensitivity);
      if (seenStates.has(key)) continue; // identical state: subtree already covered
      seenStates.add(key);
      frames.push({ stateJson: nextState, path, depth: frame.depth + 1 });
    }
  }

  return {
    statesExplored,
    endingsFound: [...endings.values()],
    runtimeErrors: [...runtimeErrors.values()],
    runtimeWarnings: [...runtimeWarnings],
    unvisitedKnots: nonFunctionKnots
      .filter((k) => !visitedKnots.has(k.name))
      .map(({ name, file, line }) => ({ name, file, line })),
    visitedKnots: [...visitedKnots],
    externalFunctionsStubbed: [...externals],
    randomnessDetected: opts.randomnessDetected ?? false,
    truncated,
    truncatedBy,
    exhaustive: !truncated,
    limits: { maxDepth, maxStates },
  };
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

/**
 * Seeded random playthroughs from the story root. Unlike the systematic DFS
 * passes, each walk re-rolls every choice point, which varies early-choice
 * prefixes instead of exhausting late-choice suffixes. The seed makes runs
 * reproducible; `statesExplored` counts choice transitions across all walks.
 * A `truncated: false` result means every sampled walk reached a natural end
 * within limits — it never implies exhaustive coverage on its own.
 */
export function exploreRandom(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  const maxDepth = opts.maxDepth ?? 30;
  const maxStates = opts.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
    throw new RangeError("maxDepth must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 1_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 1000000");
  }
  const seed = opts.seed ?? DEFAULT_RANDOM_SEED;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError("seed must be an integer from 0 to 4294967295");
  }
  const foundBy = `random:seed=${seed}`;
  const rng = mulberry32(seed);

  const endings = new Map<string, EndingReport>();
  const runtimeErrors = new Map<string, RuntimeErrorReport>();
  const runtimeWarnings = new Set<string>();
  const visitedKnots = new Set<string>();
  let statesExplored = 0;
  let truncated = false;
  const truncatedBy: TruncationCauses = { maxDepth: false, maxStates: false, beamWidth: false };

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

  const s = makeStory(storyJson, externals);
  const resetSession = () => {
    s.errors.length = 0;
    s.warnings.length = 0;
  };

  const rootStep = continueMaximally(s);
  s.errors.forEach((e) =>
    runtimeErrors.set(e, { message: e, path: [], sourceLocation: sourceLocationForRuntimeError(e, knots), foundBy })
  );
  s.warnings.forEach((w) => runtimeWarnings.add(w));
  recordKnotCoverage(s);

  const result = (): ExploreResult => ({
    statesExplored,
    endingsFound: [...endings.values()],
    runtimeErrors: [...runtimeErrors.values()],
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
    limits: { maxDepth, maxStates, seed },
  });

  if (rootStep.choicesOffered.length === 0) {
    // Linear story (or immediate end): a single walk covers it.
    if (s.errors.length === 0) {
      endings.set(rootStep.text, {
        path: [],
        finalText: rootStep.text.trim().split(/\n/).slice(-3).join("\n"),
        variables: extractVariables(s.story),
        foundBy,
      });
    }
    return result();
  }

  const rootState = s.story.state.ToJson();
  while (statesExplored < maxStates) {
    resetSession();
    s.story.state.LoadJson(rootState);
    const path: string[] = [];
    let walkDone = false;
    while (path.length < maxDepth) {
      const numChoices = s.story.currentChoices.length;
      if (numChoices === 0) break;
      const i = Math.floor(rng() * numChoices);
      const choice = s.story.currentChoices[i] as { text?: string; sourcePath?: string } | undefined;
      const choiceText = choice?.text ?? `#${i}`;
      const choiceLocation = sourceLocationForChoiceSourcePath(choice?.sourcePath, knots);
      path.push(choiceText);
      // Count the transition attempt up front so failing walks still consume
      // budget and the sampling loop always terminates.
      statesExplored++;
      try {
        s.story.ChooseChoiceIndex(i);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!runtimeErrors.has(msg)) {
          runtimeErrors.set(msg, { message: msg, path: [...path], sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation, foundBy });
        }
        walkDone = true;
        break;
      }
      const step = continueMaximally(s);
      s.errors.forEach((msg) => {
        if (!runtimeErrors.has(msg)) {
          runtimeErrors.set(msg, { message: msg, path: [...path], sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation, foundBy });
        }
      });
      s.warnings.forEach((w) => runtimeWarnings.add(w));
      recordKnotCoverage(s);
      if (s.errors.length > 0) {
        walkDone = true;
        break;
      }
      const ended = !s.story.canContinue && s.story.currentChoices.length === 0;
      if (ended) {
        const finalText = step.text.trim().split(/\n/).slice(-3).join("\n");
        const key = finalText + "|" + JSON.stringify(extractVariables(s.story));
        if (!endings.has(key)) {
          endings.set(key, { path: [...path], finalText, variables: extractVariables(s.story), foundBy });
        }
        walkDone = true;
        break;
      }
      if (statesExplored >= maxStates) {
        truncated = true;
        truncatedBy.maxStates = true;
        break;
      }
      resetSession();
    }
    if (!walkDone && path.length >= maxDepth) {
      truncated = true;
      truncatedBy.maxDepth = true;
    }
  }
  return result();
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
export function exploreBeam(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  const maxDepth = opts.maxDepth ?? 30;
  const maxStates = opts.maxStates ?? 100_000;
  const beamWidth = opts.beamWidth ?? DEFAULT_BEAM_WIDTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
    throw new RangeError("maxDepth must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 1_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 1000000");
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
  const runtimeErrors = new Map<string, RuntimeErrorReport>();
  const runtimeWarnings = new Set<string>();
  const visitedKnots = new Set<string>();
  const seenStates = new Set<string>();
  const seenVarSignatures = new Set<string>();
  const seenChoiceSets = new Set<string>();
  let statesExplored = 0;
  let truncated = false;
  const truncatedBy: TruncationCauses = { maxDepth: false, maxStates: false, beamWidth: false };

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

  const s = makeStory(storyJson, externals);
  const resetSession = () => {
    s.errors.length = 0;
    s.warnings.length = 0;
  };

  const rootStep = continueMaximally(s);
  s.errors.forEach((e) =>
    runtimeErrors.set(e, { message: e, path: [], sourceLocation: sourceLocationForRuntimeError(e, knots), foundBy })
  );
  s.warnings.forEach((w) => runtimeWarnings.add(w));
  recordKnotCoverage(s);

  const result = (): ExploreResult => ({
    statesExplored,
    endingsFound: [...endings.values()],
    runtimeErrors: [...runtimeErrors.values()],
    runtimeWarnings: [...runtimeWarnings],
    unvisitedKnots: nonFunctionKnots
      .filter((k) => !visitedKnots.has(k.name))
      .map(({ name, file, line }) => ({ name, file, line })),
    visitedKnots: [...visitedKnots],
    externalFunctionsStubbed: [...externals],
    randomnessDetected: opts.randomnessDetected ?? false,
    truncated,
    truncatedBy,
    exhaustive: !truncated,
    limits: { maxDepth, maxStates },
  });

  if (rootStep.choicesOffered.length === 0) {
    // Linear story (or immediate end).
    if (s.errors.length === 0) {
      endings.set(rootStep.text, {
        path: [],
        finalText: rootStep.text.trim().split(/\n/).slice(-3).join("\n"),
        variables: extractVariables(s.story),
        foundBy,
      });
    }
    return result();
  }

  const rootState = s.story.state.ToJson();
  seenStates.add(stateKey(rootState, stateSensitivity));
  seenVarSignatures.add(JSON.stringify(extractVariables(s.story)));
  seenChoiceSets.add(rootStep.choicesOffered.slice().sort().join(""));

  interface BeamFrame {
    stateJson: string;
    path: string[];
  }
  let frontier: BeamFrame[] = [{ stateJson: rootState, path: [] }];

  outer: while (frontier.length > 0) {
    const children: { frame: BeamFrame; score: number; varSig: string }[] = [];
    for (const frame of frontier) {
      resetSession();
      s.story.state.LoadJson(frame.stateJson);
      const numChoices = s.story.currentChoices.length;
      for (let i = 0; i < numChoices; i++) {
        if (statesExplored >= maxStates) {
          truncated = true;
          truncatedBy.maxStates = true;
          break outer;
        }
        resetSession();
        s.story.state.LoadJson(frame.stateJson);
        const choice = s.story.currentChoices[i] as { text?: string; sourcePath?: string } | undefined;
        const choiceText = choice?.text ?? `#${i}`;
        const path = [...frame.path, choiceText];
        const choiceLocation = sourceLocationForChoiceSourcePath(choice?.sourcePath, knots);
        try {
          s.story.ChooseChoiceIndex(i);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!runtimeErrors.has(msg)) {
            runtimeErrors.set(msg, { message: msg, path, sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation, foundBy });
          }
          continue;
        }
        const step = continueMaximally(s);
        statesExplored++;
        const knotsBefore = visitedKnots.size;
        s.errors.forEach((msg) => {
          if (!runtimeErrors.has(msg)) {
            runtimeErrors.set(msg, { message: msg, path, sourceLocation: sourceLocationForRuntimeError(msg, knots) ?? choiceLocation, foundBy });
          }
        });
        s.warnings.forEach((w) => runtimeWarnings.add(w));
        recordKnotCoverage(s);
        const newKnots = visitedKnots.size - knotsBefore;
        if (s.errors.length > 0) continue;

        const ended = !s.story.canContinue && s.story.currentChoices.length === 0;
        if (ended) {
          const finalText = step.text.trim().split(/\n/).slice(-3).join("\n");
          const key = finalText + "|" + JSON.stringify(extractVariables(s.story));
          if (!endings.has(key)) {
            endings.set(key, { path, finalText, variables: extractVariables(s.story), foundBy });
          }
          continue;
        }
        if (path.length >= maxDepth) {
          truncated = true;
          truncatedBy.maxDepth = true;
          continue;
        }
        const nextState = s.story.state.ToJson();
        const key = stateKey(nextState, stateSensitivity);
        if (seenStates.has(key)) continue; // identical state: subtree already covered
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
        children.push({ frame: { stateJson: nextState, path }, score, varSig });
      }
    }
    // Pruning discards reachable states, so the run can no longer claim
    // exhaustive coverage even if the budget is never exhausted.
    if (children.length > beamWidth) {
      truncated = true;
      truncatedBy.beamWidth = true;
    }
    // Diversity-first selection: round-robin across variable-signature
    // groups (discovery order), novelty-ranked within each group, so one
    // lineage's siblings cannot crowd every other lineage out of the beam.
    const groups = new Map<string, typeof children>();
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
  }
  return result();
}

export function explorePortfolio(
  storyJson: string,
  knots: KnotInfo[],
  externals: string[] = [],
  opts: ExploreOptions = {}
): ExploreResult {
  const maxStates = opts.maxStates ?? 100_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 1_000_000) {
    throw new RangeError("maxStates must be an integer from 1 to 1000000");
  }
  if (maxStates === 1) return explore(storyJson, knots, externals, opts);

  // A seeded random-sampling slice varies early-choice prefixes that the
  // deterministic DFS passes tend to repeat (see issues #20/#21), and a
  // frontier-capped novelty beam spreads budget level-by-level like BFS
  // without its unbounded frontier memory (see issue #21).
  const beamBudget = maxStates >= 10 ? Math.floor(maxStates * 0.15) : 0;
  const randomBudget = maxStates >= 5 ? Math.max(1, Math.floor(maxStates * 0.2)) : 0;
  const dfsStates = maxStates - randomBudget - beamBudget;
  const insideBudget = dfsStates >= 3 ? Math.max(1, Math.floor(dfsStates * 0.4)) : 0;
  const edgeBudget = dfsStates - insideBudget;
  const lastBudget = Math.ceil(edgeBudget / 2);
  const firstBudget = edgeBudget - lastBudget;
  const shared = { ...opts };
  const runs = [
    { maxStates: lastBudget, dfsChoicePriority: "last" as const },
    { maxStates: firstBudget, dfsChoicePriority: "first" as const },
    { maxStates: insideBudget, dfsChoicePriority: "inside-out" as const },
  ].filter((run) => run.maxStates > 0);
  const results = runs.map((run) =>
    explore(storyJson, knots, externals, {
      ...shared,
      ...run,
      strategy: "dfs",
    })
  );
  if (beamBudget > 0) {
    results.push(
      exploreBeam(storyJson, knots, externals, { ...shared, maxStates: beamBudget })
    );
  }
  if (randomBudget > 0) {
    results.push(
      exploreRandom(storyJson, knots, externals, { ...shared, maxStates: randomBudget })
    );
  }
  const [firstRun, ...rest] = results;
  return rest.reduce((merged, result) => mergeExploreResults(merged, result), firstRun);
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
  for (const err of main.runtimeErrors) {
    const match = other.runtimeErrors.find((e) => e.message === err.message);
    if (match && match.path.length < err.path.length) {
      err.path = match.path;
      err.foundBy = match.foundBy;
    }
  }
  const otherEndings = new Map(other.endingsFound.map((e) => [endingKey(e), e]));
  for (const end of main.endingsFound) {
    const match = otherEndings.get(endingKey(end));
    if (match && match.path.length < end.path.length) {
      end.path = match.path;
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
  };
  // One systematic pass finishing without truncation proves every reachable
  // state was visited, so partial-coverage flags from budget-bound sampling
  // passes (which resample a space already proven exhausted) are cleared.
  main.exhaustive ||= other.exhaustive;
  if (main.exhaustive) {
    main.truncated = false;
    main.truncatedBy = { maxDepth: false, maxStates: false, beamWidth: false };
  }
  main.externalFunctionsStubbed = [...new Set([...main.externalFunctionsStubbed, ...other.externalFunctionsStubbed])];
  main.randomnessDetected ||= other.randomnessDetected;
  const seed = main.limits.seed ?? other.limits.seed;
  main.limits = {
    maxDepth: Math.max(main.limits.maxDepth, other.limits.maxDepth),
    maxStates: main.limits.maxStates + other.limits.maxStates,
  };
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
