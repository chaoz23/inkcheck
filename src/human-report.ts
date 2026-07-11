import { CompileResult, Issue } from "./inklecate";
import { ExploreResult, RuntimeErrorReport, UnvisitedKnotReport } from "./explore";

/** One-line triage hint for an unvisited knot, based on the inbound-divert scan. */
export function unvisitedKnotHint(knot: Partial<UnvisitedKnotReport>): string {
  if (knot.staticOrphanCandidate) {
    return "no authored divert points here — possible orphan";
  }
  if (typeof knot.inboundDiverts === "number" && knot.inboundDiverts > 0) {
    return `${knot.inboundDiverts} inbound divert(s) in source — likely beyond this run's limits`;
  }
  return "not reached within this run's limits";
}

/** Targeted advice naming the limit(s) that actually cut coverage. */
export function truncationAdvice(
  result: Pick<Partial<ExploreResult>, "truncatedBy" | "limits">
): string {
  const causes = result.truncatedBy;
  const hints: string[] = [];
  if (causes?.memory) {
    // Memory is the binding constraint — do not suggest a bigger budget.
    return "exploration stopped early to stay under the memory guard; raise --max-old-space-size for more headroom or lower --max-states, then rerun";
  }
  if (causes?.time) {
    // Time is the binding constraint — a bigger budget would run out sooner.
    return "exploration stopped at its time budget; raise --max-time, or run locally without a wall-clock limit, for broader coverage";
  }
  if (causes?.maxDepth) {
    hints.push(
      `paths were cut at ${result.limits?.maxDepth ?? "the configured"} choices deep; raise --max-depth to follow longer trails`
    );
  }
  if (causes?.maxStates) {
    hints.push(
      `the ${result.limits?.maxStates ?? "configured"}-state budget ran out; raise --max-states for broader coverage`
    );
  }
  // The beam's internal frontier cap is not a reader-facing lever — a pure
  // beam prune still means the story is bigger than this run covered, which
  // the depth/state hints and the states-explored count already convey, so we
  // never surface "beam width" / "frontier cap" jargon in a human report.
  if (!hints.length) hints.push("raise --max-states for broader coverage");
  return hints.join("; ");
}

export type HumanFindingSeverity = "error" | "warning" | "note";

export interface HumanFinding {
  severity: HumanFindingSeverity;
  category: string;
  title: string;
  message: string;
  file?: string;
  line?: number;
  approximateLocation?: boolean;
  path?: string[];
  action: string;
}

export interface HumanReportInput {
  compile?: Partial<CompileResult>;
  explore?: Partial<ExploreResult>;
}

const SEVERITY_ORDER: Record<HumanFindingSeverity, number> = {
  error: 0,
  warning: 1,
  note: 2,
};

function issueSeverity(issue: Partial<Issue>): HumanFindingSeverity {
  if (issue.severity === "ERROR" || issue.severity === "RUNTIME ERROR") return "error";
  if (issue.severity === "WARNING") return "warning";
  return "note";
}

function issueCategory(issue: Partial<Issue>): string {
  if (issue.severity === "ERROR") return "Compiler error";
  if (issue.severity === "WARNING") return "Compiler warning";
  if (issue.severity === "TODO") return "Author TODO";
  if (issue.severity === "RUNTIME ERROR") return "Runtime error";
  return "Compiler note";
}

function compareFindings(a: HumanFinding, b: HumanFinding): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
    a.category.localeCompare(b.category) ||
    a.message.localeCompare(b.message)
  );
}

function runtimeTitle(error: RuntimeErrorReport): string {
  const message = error.message.replace(/\s*\(at [^)]+\)\s*$/, "");
  return message || "Runtime error";
}

export function buildHumanFindings(input: HumanReportInput): HumanFinding[] {
  const findings: HumanFinding[] = [];
  const compileIssues = Array.isArray(input.compile?.issues) ? input.compile.issues : [];
  for (const issue of compileIssues) {
    findings.push({
      severity: issueSeverity(issue),
      category: issueCategory(issue),
      title: issue.message ?? issue.raw ?? "Compiler finding",
      message: issue.message ?? issue.raw ?? "Compiler returned a finding without details.",
      file: issue.file || undefined,
      line: issue.line ?? undefined,
      action:
        issueSeverity(issue) === "error"
          ? "Fix this source line first; Inkcheck cannot explore the story until it compiles."
          : "Review this compiler note and decide whether the story should change.",
    });
  }

  const runtimeErrors = Array.isArray(input.explore?.runtimeErrors)
    ? input.explore.runtimeErrors
    : [];
  for (const error of runtimeErrors) {
    findings.push({
      severity: "error",
      category: "Runtime error",
      title: runtimeTitle(error),
      message: error.message,
      file: error.sourceLocation?.file,
      line: error.sourceLocation?.line,
      approximateLocation: error.sourceLocation?.approximate,
      path: error.path,
      action: "Follow the choice path, then inspect the source near this location for a bad divert, variable, expression, or runtime-only edge case.",
    });
  }

  const assertionResults = Array.isArray(input.explore?.assertionResults)
    ? input.explore.assertionResults
    : [];
  for (const result of assertionResults) {
    for (const violation of result.violations) {
      findings.push({
        severity: "error",
        category: "Story assertion",
        title: result.description ?? `Assertion ${result.id} was violated`,
        message: `Observed values: ${JSON.stringify(violation.observedValues)}`,
        path: violation.path,
        action: "Replay the indexed choice witness, then inspect where these variables changed before adjusting story logic or the approved rule.",
      });
    }
  }

  const runtimeWarnings = Array.isArray(input.explore?.runtimeWarnings)
    ? input.explore.runtimeWarnings
    : [];
  for (const warning of runtimeWarnings) {
    findings.push({
      severity: "warning",
      category: "Runtime warning",
      title: warning,
      message: warning,
      action: "Review the warning and test the nearby choice path manually.",
    });
  }

  const unvisitedKnots = Array.isArray(input.explore?.unvisitedKnots)
    ? input.explore.unvisitedKnots
    : [];
  for (const knot of unvisitedKnots) {
    const orphan = knot.staticOrphanCandidate === true;
    const hasInbound = typeof knot.inboundDiverts === "number" && knot.inboundDiverts > 0;
    findings.push({
      severity: "warning",
      category: "Unvisited content",
      title: `No explored path reached ${knot.name}`,
      message: orphan
        ? `No authored divert to ${knot.name} was found in the source, so it may be orphaned. Unreached within this run is not proof it is unreachable.`
        : hasInbound
          ? `${knot.name} has ${knot.inboundDiverts} inbound divert(s) in the source but was not reached within this run's limits, so it may simply sit behind longer choice trails.`
          : `The knot ${knot.name} was not visited by any explored path within this run's limits.`,
      file: knot.file,
      line: knot.line,
      action: orphan
        ? "If this scene should be reachable, add a divert/choice that leads here. If it is intentionally unused, mark it for yourself or remove it."
        : "Try a deeper or larger run (raise --max-depth and/or --max-states) before treating this as unreachable; if it still is not reached, check the conditions guarding the diverts that point here.",
    });
  }

  const externalFunctions = Array.isArray(input.explore?.externalFunctionsStubbed)
    ? input.explore.externalFunctionsStubbed
    : [];
  if (externalFunctions.length) {
    findings.push({
      severity: "note",
      category: "Coverage note",
      title: "EXTERNAL functions were stubbed",
      message: `Inkcheck replaced these host-game functions with zero: ${externalFunctions.join(", ")}.`,
      action: "Manually test paths that depend on these host functions in the real game integration.",
    });
  }

  if (input.explore?.randomnessDetected) {
    findings.push({
      severity: "note",
      category: "Coverage note",
      title: "Random behavior detected",
      message: "The story uses Ink randomness, so another run or the real game may follow different random branches.",
      action: "Manually spot-check random-heavy paths, especially if player-facing outcomes depend on them.",
    });
  }

  return findings.sort(compareFindings);
}

function locationText(finding: HumanFinding): string {
  if (!finding.file) return "";
  const location = `${finding.file}${finding.line ? ` line ${finding.line}` : ""}`;
  return finding.approximateLocation ? `${location} (approx.)` : location;
}

export function renderHumanFindings(findings: HumanFinding[]): string {
  if (!findings.length) return "No compiler errors, runtime errors, or unreachable knots were found in this check.";
  const lines: string[] = [];
  let currentSeverity: HumanFindingSeverity | undefined;
  for (const finding of findings) {
    if (finding.severity !== currentSeverity) {
      currentSeverity = finding.severity;
      lines.push(lines.length ? "\n" : "", `${currentSeverity.toUpperCase()}S`);
    }
    const location = locationText(finding);
    lines.push(`- [${finding.category}] ${location ? `${location} — ` : ""}${finding.title}`);
    if (finding.path?.length) lines.push(`  Path: ${finding.path.join(" → ")}`);
    lines.push(`  Why it matters: ${finding.message}`);
    lines.push(`  Next step: ${finding.action}`);
  }
  return lines.join("\n").replace(/\n\n\n/g, "\n\n");
}
