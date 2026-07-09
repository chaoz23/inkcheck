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
}

export interface RuntimeErrorReport {
  message: string;
  path: string[];
}

export interface ExploreResult {
  statesExplored: number;
  endingsFound: EndingReport[];
  runtimeErrors: RuntimeErrorReport[];
  runtimeWarnings: string[];
  /** Authored knots never visited on any explored path (functions excluded). */
  unvisitedKnots: { name: string; file: string; line: number }[];
  visitedKnots: string[];
  /** EXTERNAL functions that were replaced with a constant zero during exploration. */
  externalFunctionsStubbed: string[];
  /** Whether Ink random functions or shuffle sequences occur in the source. */
  randomnessDetected: boolean;
  truncated: boolean;
  limits: { maxDepth: number; maxStates: number };
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

export interface ExploreOptions {
  maxDepth?: number;
  maxStates?: number;
  /** "dfs" (default) surfaces endings early; "bfs" yields shortest paths. */
  strategy?: "dfs" | "bfs";
  /** Preserve turn counters when the source uses TURNS()/TURNS_SINCE(). Default true. */
  preserveTurnState?: boolean;
  /** Preserve RNG bookkeeping when the source uses random behavior. Default true. */
  preserveRandomState?: boolean;
  /** Report that the source scanner found random behavior. */
  randomnessDetected?: boolean;
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
  const maxDepth = opts.maxDepth ?? 30;
  const maxStates = opts.maxStates ?? 500;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
    throw new RangeError("maxDepth must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 50_000) {
    throw new RangeError("maxStates must be an integer from 1 to 50000");
  }
  const strategy = opts.strategy ?? "dfs";
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
  s.errors.forEach((e) => runtimeErrors.set(e, { message: e, path: [] }));
  s.warnings.forEach((w) => runtimeWarnings.add(w));
  recordKnotCoverage(s);

  if (rootStep.choicesOffered.length === 0 && s.errors.length === 0) {
    // Linear story (or immediate end).
    endings.set(rootStep.text, {
      path: [],
      finalText: rootStep.text.trim().split(/\n/).slice(-3).join("\n"),
      variables: extractVariables(s.story),
    });
  }

  const rootState = s.story.state.ToJson();
  seenStates.add(stateKey(rootState, stateSensitivity));
  const frames: Frame[] = [{ stateJson: rootState, path: [], depth: 0 }];
  let head = 0; // BFS read pointer (avoids O(n) shifts)

  while (strategy === "bfs" ? head < frames.length : frames.length > 0) {
    if (statesExplored >= maxStates) {
      truncated = true;
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
      });
      continue;
    }
    const numChoices = s.story.currentChoices.length;

    for (let i = 0; i < numChoices; i++) {
      if (statesExplored >= maxStates) {
        truncated = true;
        break;
      }
      resetSession();
      s.story.state.LoadJson(frame.stateJson);
      const choiceText = s.story.currentChoices[i]?.text ?? `#${i}`;
      const path = [...frame.path, choiceText];
      try {
        s.story.ChooseChoiceIndex(i);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        runtimeErrors.set(msg, { message: msg, path });
        continue;
      }
      const step = continueMaximally(s);
      statesExplored++;
      s.errors.forEach((msg) => {
        if (!runtimeErrors.has(msg)) runtimeErrors.set(msg, { message: msg, path });
      });
      s.warnings.forEach((w) => runtimeWarnings.add(w));
      recordKnotCoverage(s);

      const ended = !s.story.canContinue && s.story.currentChoices.length === 0;
      if (ended && s.errors.length === 0) {
        const finalText = step.text.trim().split(/\n/).slice(-3).join("\n");
        const key = finalText + "|" + JSON.stringify(extractVariables(s.story));
        if (!endings.has(key)) {
          endings.set(key, { path, finalText, variables: extractVariables(s.story) });
        }
        continue;
      }
      if (path.length >= maxDepth) {
        truncated = true;
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
    limits: { maxDepth, maxStates },
  };
}

function endingKey(e: EndingReport): string {
  return e.finalText + "|" + JSON.stringify(e.variables);
}

/**
 * Shorten the repro paths in `main` (a DFS result) using a BFS pass over the
 * same story: BFS reaches everything by its shortest choice trail, so any
 * error or ending both passes found gets the minimal reproduction.
 */
export function mergeMinRepro(main: ExploreResult, bfs: ExploreResult): ExploreResult {
  for (const err of main.runtimeErrors) {
    const match = bfs.runtimeErrors.find((e) => e.message === err.message);
    if (match && match.path.length < err.path.length) err.path = match.path;
  }
  const bfsEndings = new Map(bfs.endingsFound.map((e) => [endingKey(e), e]));
  for (const end of main.endingsFound) {
    const match = bfsEndings.get(endingKey(end));
    if (match && match.path.length < end.path.length) end.path = match.path;
  }
  // BFS may also have reached endings/errors/knots DFS missed within limits.
  const mainEndingKeys = new Set(main.endingsFound.map(endingKey));
  for (const e of bfs.endingsFound) {
    if (!mainEndingKeys.has(endingKey(e))) main.endingsFound.push(e);
  }
  const mainErrs = new Set(main.runtimeErrors.map((e) => e.message));
  for (const e of bfs.runtimeErrors) {
    if (!mainErrs.has(e.message)) main.runtimeErrors.push(e);
  }
  main.runtimeWarnings = [...new Set([...main.runtimeWarnings, ...bfs.runtimeWarnings])];
  const visited = new Set([...main.visitedKnots, ...bfs.visitedKnots]);
  main.visitedKnots = [...visited];
  main.unvisitedKnots = main.unvisitedKnots.filter((k) => !visited.has(k.name));
  return main;
}
