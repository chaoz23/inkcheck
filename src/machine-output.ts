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
  return {
    mode: execution.mode,
    requestedConcurrency: execution.requestedConcurrency,
    effectiveConcurrency: execution.effectiveConcurrency,
    ...(execution.fallbackReason === undefined ? {} : { fallbackReason: execution.fallbackReason }),
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

function explorationSummary(explore: Record<string, unknown> | undefined) {
  if (!explore) return undefined;
  const assertionResults = array(explore.assertionResults).map(record).filter(Boolean) as Record<string, unknown>[];
  const assertionViolationCount = assertionResults.reduce(
    (total, result) => total + array(result.violations).length,
    0
  );
  return {
    statesExplored: explore.statesExplored,
    runtimeErrorCount: array(explore.runtimeErrors).length,
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
