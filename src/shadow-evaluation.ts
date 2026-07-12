import { createHash } from "crypto";
import type { AssertionViolation } from "./assertions";
import type { ExploreResult } from "./explore";
import { recommendShadowDecision, SHADOW_POLICY_VERSION, type ShadowDecision } from "./decision-policy";
import { runtimeErrorKey, terminalStateKey, visibleEndingKey } from "./search-benchmark";

export const SHADOW_EVALUATION_SCHEMA_VERSION = 1;
export const MAX_EVIDENCE_EXAMPLES = 20;

export interface ShadowBudgetRun {
  budget: number;
  elapsedMs?: number;
  report: ExploreResult;
}

export interface ShadowEvaluationCase {
  id: string;
  family: string;
  source: {
    name: string;
    license: string;
    consent: string;
  };
  runs: ShadowBudgetRun[];
}

interface EvidenceSet {
  runtimeErrors: string[];
  assertionViolations: string[];
  authoredKnots: string[];
  visibleOutcomes: string[];
  terminalStates: string[];
}

export interface EvidenceDifference {
  count: number;
  examples: string[];
  examplesTruncated: boolean;
}

export type ShadowStopRisk = "critical" | "authored_coverage" | "terminal_only" | "none";

export interface ShadowEvaluationCheckpoint {
  budget: number;
  statesExplored: number;
  elapsedMs?: number;
  decision: ShadowDecision;
  observed: Record<keyof EvidenceSet, number>;
  highWaterOnly: Record<keyof EvidenceSet, EvidenceDifference>;
  checkpointOnly: Record<keyof EvidenceSet, EvidenceDifference>;
  stopCandidate: boolean;
  stopRisk: ShadowStopRisk;
  highWaterRegressionRisk: ShadowStopRisk;
  workFractionOfHighWater: number;
}

export interface ShadowEvaluationResult {
  schemaVersion: number;
  policyVersion: number;
  case: {
    id: string;
    family: string;
    source: ShadowEvaluationCase["source"];
  };
  highWater: {
    budget: number;
    statesExplored: number;
    exhaustive: boolean;
    bounded: boolean;
  };
  checkpoints: ShadowEvaluationCheckpoint[];
  caveat: string;
}

function stableObject(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

function assertionViolationKey(violation: AssertionViolation): string {
  return `${violation.ruleId}|${stableObject(violation.observedValues)}|${JSON.stringify(violation.choiceIndices)}`;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function terminalStateId(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function evidence(report: ExploreResult): EvidenceSet {
  return {
    runtimeErrors: sortedUnique(report.runtimeErrors.map(runtimeErrorKey)),
    assertionViolations: sortedUnique(report.assertionResults.flatMap((result) => result.violations.map(assertionViolationKey))),
    authoredKnots: sortedUnique(report.visitedKnots),
    visibleOutcomes: sortedUnique(report.endingsFound.map(visibleEndingKey)),
    terminalStates: sortedUnique(report.endingsFound.map((ending) => terminalStateId(terminalStateKey(ending)))),
  };
}

function difference(highWater: string[], observed: string[]): EvidenceDifference {
  const seen = new Set(observed);
  const values = highWater.filter((value) => !seen.has(value));
  return {
    count: values.length,
    examples: values.slice(0, MAX_EVIDENCE_EXAMPLES),
    examplesTruncated: values.length > MAX_EVIDENCE_EXAMPLES,
  };
}

function counts(value: EvidenceSet): Record<keyof EvidenceSet, number> {
  return {
    runtimeErrors: value.runtimeErrors.length,
    assertionViolations: value.assertionViolations.length,
    authoredKnots: value.authoredKnots.length,
    visibleOutcomes: value.visibleOutcomes.length,
    terminalStates: value.terminalStates.length,
  };
}

function risk(delta: ShadowEvaluationCheckpoint["highWaterOnly"]): ShadowStopRisk {
  if (delta.runtimeErrors.count || delta.assertionViolations.count) return "critical";
  if (delta.authoredKnots.count || delta.visibleOutcomes.count) return "authored_coverage";
  if (delta.terminalStates.count) return "terminal_only";
  return "none";
}

function stopCandidate(decision: ShadowDecision): boolean {
  return decision.action === "stop_at_knee"
    || decision.action === "stop_at_deadline"
    || decision.action === "stop_at_resource_limit"
    || decision.action === "stop_exhaustive";
}

function validate(input: ShadowEvaluationCase): ShadowBudgetRun[] {
  if (!input.id.trim() || !input.family.trim()) throw new Error("case id and family are required");
  if (!input.source.name.trim() || !input.source.license.trim() || !input.source.consent.trim()) {
    throw new Error("source name, license, and consent are required");
  }
  if (input.runs.length < 2) throw new Error("at least two budget runs are required");
  const runs = [...input.runs].sort((a, b) => a.budget - b.budget);
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!Number.isSafeInteger(run.budget) || run.budget < 1) throw new Error("budgets must be positive integers");
    if (index > 0 && runs[index - 1].budget === run.budget) throw new Error("budgets must be unique");
    if (run.report.limits.maxStates !== run.budget) {
      throw new Error(`run budget ${run.budget} does not match report maxStates ${run.report.limits.maxStates}`);
    }
  }
  return runs;
}

/** Compare bounded configured reruns; this is not a prefix-continuation or completeness oracle. */
export function evaluateShadowBudgetLadder(input: ShadowEvaluationCase): ShadowEvaluationResult {
  const runs = validate(input);
  const highWaterRun = runs.at(-1)!;
  const highWaterEvidence = evidence(highWaterRun.report);
  return {
    schemaVersion: SHADOW_EVALUATION_SCHEMA_VERSION,
    policyVersion: SHADOW_POLICY_VERSION,
    case: { id: input.id, family: input.family, source: { ...input.source } },
    highWater: {
      budget: highWaterRun.budget,
      statesExplored: highWaterRun.report.statesExplored,
      exhaustive: highWaterRun.report.exhaustive,
      bounded: !highWaterRun.report.exhaustive,
    },
    checkpoints: runs.map((run) => {
      const observed = evidence(run.report);
      const highWaterOnly = {
        runtimeErrors: difference(highWaterEvidence.runtimeErrors, observed.runtimeErrors),
        assertionViolations: difference(highWaterEvidence.assertionViolations, observed.assertionViolations),
        authoredKnots: difference(highWaterEvidence.authoredKnots, observed.authoredKnots),
        visibleOutcomes: difference(highWaterEvidence.visibleOutcomes, observed.visibleOutcomes),
        terminalStates: difference(highWaterEvidence.terminalStates, observed.terminalStates),
      };
      const checkpointOnly = {
        runtimeErrors: difference(observed.runtimeErrors, highWaterEvidence.runtimeErrors),
        assertionViolations: difference(observed.assertionViolations, highWaterEvidence.assertionViolations),
        authoredKnots: difference(observed.authoredKnots, highWaterEvidence.authoredKnots),
        visibleOutcomes: difference(observed.visibleOutcomes, highWaterEvidence.visibleOutcomes),
        terminalStates: difference(observed.terminalStates, highWaterEvidence.terminalStates),
      };
      const decision = recommendShadowDecision(run.report);
      return {
        budget: run.budget,
        statesExplored: run.report.statesExplored,
        ...(run.elapsedMs === undefined ? {} : { elapsedMs: run.elapsedMs }),
        decision,
        observed: counts(observed),
        highWaterOnly,
        checkpointOnly,
        stopCandidate: stopCandidate(decision),
        stopRisk: stopCandidate(decision) ? risk(highWaterOnly) : "none",
        highWaterRegressionRisk: risk(checkpointOnly),
        workFractionOfHighWater: run.report.statesExplored / Math.max(1, highWaterRun.report.statesExplored),
      };
    }),
    caveat: highWaterRun.report.exhaustive
      ? "The high-water run proved reachable-state exhaustion for its configuration. Budget runs are independent deterministic reruns, not prefixes of one continued trajectory."
      : "The high-water run is bounded, not an oracle or coverage proof. Budget runs are independent deterministic reruns, not prefixes of one continued trajectory.",
  };
}

function countDelta(checkpoint: ShadowEvaluationCheckpoint): string {
  const delta = checkpoint.highWaterOnly;
  return `E${delta.runtimeErrors.count}/A${delta.assertionViolations.count}/K${delta.authoredKnots.count}/O${delta.visibleOutcomes.count}/T${delta.terminalStates.count}`;
}

export function renderShadowEvaluationMarkdown(results: ShadowEvaluationResult[]): string {
  const lines = [
    "# Shadow policy budget-ladder evaluation",
    "",
    "> High-water runs are bounded comparison points unless marked exhaustive. Independent budget runs are not prefixes of one continued trajectory.",
    "",
    "| Case | Family | Budget | Action | Stop risk | High-water regression | High-water-only evidence | Checkpoint-only evidence | Work fraction |",
    "| --- | --- | ---: | --- | --- | --- | --- | --- | ---: |",
  ];
  for (const result of results) {
    for (const checkpoint of result.checkpoints) {
      const checkpointOnly = { ...checkpoint, highWaterOnly: checkpoint.checkpointOnly };
      lines.push(`| ${result.case.id} | ${result.case.family} | ${checkpoint.budget.toLocaleString("en-US")} | ${checkpoint.decision.action} | ${checkpoint.stopRisk} | ${checkpoint.highWaterRegressionRisk} | ${countDelta(checkpoint)} | ${countDelta(checkpointOnly)} | ${(checkpoint.workFractionOfHighWater * 100).toFixed(1)}% |`);
    }
  }
  lines.push("", "Evidence key: E runtime errors, A assertion violations, K authored knots, O visible outcomes, T exact terminal states.");
  return `${lines.join("\n")}\n`;
}
