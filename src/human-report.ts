import { CompileResult, Issue } from "./inklecate";
import { ExploreResult, RuntimeErrorReport } from "./explore";

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
    findings.push({
      severity: "warning",
      category: "Unvisited content",
      title: `No explored path reached ${knot.name}`,
      message: `The knot ${knot.name} was not visited by any explored path.`,
      file: knot.file,
      line: knot.line,
      action: "If this scene should be reachable, add or repair a divert/choice that leads here. If it is intentionally unused, mark it for yourself or remove it.",
    });
  }

  if (input.explore?.truncated) {
    const limits = input.explore.limits;
    findings.push({
      severity: "warning",
      category: "Coverage limit",
      title: "Inkcheck stopped before covering every reachable state",
      message: limits
        ? `The check stopped at max depth ${limits.maxDepth} or max states ${limits.maxStates}.`
        : "The check stopped at its configured traversal limit.",
      action: "Treat this as a partial report. Increase limits locally or file an issue if the hosted checker needs more room.",
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
