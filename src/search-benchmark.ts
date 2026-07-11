import type {
  EndingReport,
  ExploreResult,
  PassTelemetry,
  RuntimeErrorReport,
} from "./explore";

/** Exact terminal-state identity retained by Inkcheck's report. */
export function terminalStateKey(ending: EndingReport): string {
  return `${ending.finalText}|${JSON.stringify(ending.variables)}`;
}

/**
 * User-visible ending outcome. This intentionally ignores final variables.
 * It is a fallback for authored-ending identity, not proof that two source
 * locations with the same final text are semantically equivalent.
 */
export function visibleEndingKey(ending: EndingReport): string {
  return ending.finalText.trim().replace(/\s+/g, " ");
}

export function runtimeErrorKey(error: RuntimeErrorReport): string {
  const location = error.sourceLocation
    ? `${error.sourceLocation.file}:${error.sourceLocation.line}`
    : "unknown";
  return `${error.message}|${location}`;
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

/** Stable identity for a variable snapshot, independent of object key order. */
export function variableStateKey(variables: Record<string, unknown>): string {
  return Object.keys(variables)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${stableValue(variables[name])}`)
    .join("|");
}

export interface VariableChange {
  name: string;
  before: unknown;
  after: unknown;
}

/** Identify the variables causally changed by one observed transition. */
export function variableChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): VariableChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((name) => stableValue(before[name]) !== stableValue(after[name]))
    .map((name) => ({ name, before: before[name], after: after[name] }));
}

export function variableTransitionKey(change: VariableChange): string {
  return `${change.name}:${stableValue(change.before)}->${stableValue(change.after)}`;
}

/** A simple deterministic rarity signal for future variable-aware strategies. */
export function rarityWeight(previousObservations: number): number {
  if (!Number.isSafeInteger(previousObservations) || previousObservations < 0) {
    throw new RangeError("previousObservations must be a non-negative integer");
  }
  return 1 / Math.sqrt(previousObservations + 1);
}

export interface SearchBenchmarkSummary {
  strategy: string;
  statesExplored: number;
  findings: {
    runtimeErrors: string[];
    visitedKnots: string[];
    visibleEndings: string[];
  };
  stateSpace: {
    terminalStates: number;
    terminalVariableStates: number;
    terminalVariableValues: Record<string, Record<string, number>>;
    dedupeHits: number;
    maxDepthReached: number;
    peakFrontier: number | null;
  };
  result: {
    exhaustive: boolean;
    truncated: boolean;
    truncatedBy: ExploreResult["truncatedBy"];
  };
  passes: Array<
    Pick<
      PassTelemetry,
      | "pass"
      | "systematic"
      | "statesExplored"
      | "newEndings"
      | "newKnots"
      | "newRuntimeErrors"
      | "dedupeHits"
      | "maxDepthReached"
      | "lastDiscoveryAtState"
      | "exhaustive"
    >
  >;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function terminalVariableValues(
  endings: EndingReport[]
): Record<string, Record<string, number>> {
  const values: Record<string, Record<string, number>> = {};
  const names = [...new Set(endings.flatMap((ending) => Object.keys(ending.variables)))].sort();
  for (const ending of endings) {
    for (const name of names) {
      // inkjs may omit an unchanged declaration default from variablesState.
      // Keep absence explicit; interpreting it requires source declaration data.
      const value = Object.prototype.hasOwnProperty.call(ending.variables, name)
        ? stableValue(ending.variables[name])
        : "<absent>";
      values[name] ??= {};
      values[name][value] = (values[name][value] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, counts]) => [
        name,
        Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      ])
  );
}

/** Build a deterministic, timing-free comparison record for one search run. */
export function summarizeSearchResult(
  strategy: string,
  report: ExploreResult
): SearchBenchmarkSummary {
  const passes = report.passes ?? [];
  return {
    strategy,
    statesExplored: report.statesExplored,
    findings: {
      runtimeErrors: sortedUnique(report.runtimeErrors.map(runtimeErrorKey)),
      visitedKnots: sortedUnique(report.visitedKnots),
      visibleEndings: sortedUnique(report.endingsFound.map(visibleEndingKey)),
    },
    stateSpace: {
      terminalStates: new Set(report.endingsFound.map(terminalStateKey)).size,
      terminalVariableStates: new Set(
        report.endingsFound.map((ending) => variableStateKey(ending.variables))
      ).size,
      terminalVariableValues: terminalVariableValues(report.endingsFound),
      dedupeHits: passes.reduce((sum, pass) => sum + pass.dedupeHits, 0),
      maxDepthReached: passes.reduce(
        (deepest, pass) => Math.max(deepest, pass.maxDepthReached),
        0
      ),
      peakFrontier:
        passes.reduce<number | null>(
          (peak, pass) =>
            pass.peakFrontier === undefined
              ? peak
              : Math.max(peak ?? 0, pass.peakFrontier),
          null
        ),
    },
    result: {
      exhaustive: report.exhaustive,
      truncated: report.truncated,
      truncatedBy: { ...report.truncatedBy },
    },
    passes: passes.map((pass) => ({
      pass: pass.pass,
      systematic: pass.systematic,
      statesExplored: pass.statesExplored,
      newEndings: pass.newEndings,
      newKnots: pass.newKnots,
      newRuntimeErrors: pass.newRuntimeErrors,
      dedupeHits: pass.dedupeHits,
      maxDepthReached: pass.maxDepthReached,
      lastDiscoveryAtState: pass.lastDiscoveryAtState,
      exhaustive: pass.exhaustive,
    })),
  };
}

export interface TimedSearchBenchmark {
  elapsedMs: number;
  summary: SearchBenchmarkSummary;
}

/** Time a strategy while keeping wall-clock data outside deterministic output. */
export function runSearchBenchmark(
  strategy: string,
  run: () => ExploreResult
): TimedSearchBenchmark {
  const started = process.hrtime.bigint();
  const report = run();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { elapsedMs, summary: summarizeSearchResult(strategy, report) };
}
