import type { SearchBenchmarkSummary } from "./search-benchmark";
import type { AssertionDefinition } from "./assertions";

export const PROMOTION_BENCHMARK_SCHEMA_VERSION = 1;

export interface PromotionSource {
  name: string;
  license: string;
  consent: string;
}

export interface PromotionManifestCase {
  id: string;
  family: string;
  story: string;
  source: PromotionSource;
  budgets: number[];
  depths: number[];
  seeds: number[];
  /** Initial Ink runtime RNG seed shared by every matched run. Default 1. */
  storySeed?: number;
  assertions?: AssertionDefinition[];
  ci?: boolean;
  determinismCheck?: boolean;
}

export interface PromotionManifest {
  schemaVersion: 1;
  cases: PromotionManifestCase[];
}

export interface PromotionObservation {
  elapsedMs: number;
  peakRssBytes: number;
  summary: SearchBenchmarkSummary;
  deterministicRepeatMatch?: boolean;
}

export type PromotionRisk = "critical" | "authored_coverage" | "proof" | "nondeterministic" | "terminal_only" | "none";

export interface EvidenceDelta {
  runtimeErrors: string[];
  assertionViolations: string[];
  visitedKnots: string[];
  visibleEndings: string[];
  terminalStates: string[];
}

export interface PromotionPair {
  caseId: string;
  family: string;
  source: PromotionSource;
  budget: number;
  depth: number;
  seed: number;
  storySeed: number;
  baseline: PromotionObservation;
  candidate: PromotionObservation;
  comparison: {
    baselineOnly: EvidenceDelta;
    candidateOnly: EvidenceDelta;
    proofLost: boolean;
    honestyMismatch: boolean;
    candidateDeterminismRegression: boolean;
    regressionRisk: PromotionRisk;
    gainClass: PromotionRisk;
  };
}

export interface PromotionFamilySummary {
  family: string;
  pairs: number;
  criticalRegressions: number;
  authoredCoverageRegressions: number;
  proofRegressions: number;
  terminalOnlyRegressions: number;
  baselineNondeterministic: number;
  candidateNondeterministic: number;
  pairsWithGains: number;
}

export interface PromotionBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  candidate: string;
  baseline: string;
  caveat: string;
  pairs: PromotionPair[];
  families: PromotionFamilySummary[];
}

function difference(left: string[], right: string[]): string[] {
  const seen = new Set(right);
  return left.filter((value) => !seen.has(value));
}

function evidenceDifference(left: SearchBenchmarkSummary, right: SearchBenchmarkSummary): EvidenceDelta {
  return {
    runtimeErrors: difference(left.findings.runtimeErrors, right.findings.runtimeErrors),
    assertionViolations: difference(left.findings.assertionViolations, right.findings.assertionViolations),
    visitedKnots: difference(left.findings.visitedKnots, right.findings.visitedKnots),
    visibleEndings: difference(left.findings.visibleEndings, right.findings.visibleEndings),
    terminalStates: difference(left.findings.terminalStates, right.findings.terminalStates),
  };
}

function evidenceRisk(delta: EvidenceDelta, proofLost = false, nondeterministic = false): PromotionRisk {
  if (delta.runtimeErrors.length || delta.assertionViolations.length) return "critical";
  if (delta.visitedKnots.length || delta.visibleEndings.length) return "authored_coverage";
  if (proofLost) return "proof";
  if (nondeterministic) return "nondeterministic";
  if (delta.terminalStates.length) return "terminal_only";
  return "none";
}

export function comparePromotionPair(
  input: Omit<PromotionPair, "comparison">
): PromotionPair {
  const baselineOnly = evidenceDifference(input.baseline.summary, input.candidate.summary);
  const candidateOnly = evidenceDifference(input.candidate.summary, input.baseline.summary);
  const proofLost = input.baseline.summary.result.exhaustive && !input.candidate.summary.result.exhaustive;
  const honestyMismatch = input.baseline.summary.result.truncated !== input.candidate.summary.result.truncated
    || JSON.stringify(input.baseline.summary.result.truncatedBy) !== JSON.stringify(input.candidate.summary.result.truncatedBy);
  const candidateDeterminismRegression = input.baseline.deterministicRepeatMatch === true
    && input.candidate.deterministicRepeatMatch === false;
  return {
    ...input,
    comparison: {
      baselineOnly,
      candidateOnly,
      proofLost,
      honestyMismatch,
      candidateDeterminismRegression,
      regressionRisk: evidenceRisk(baselineOnly, proofLost, candidateDeterminismRegression),
      gainClass: evidenceRisk(candidateOnly),
    },
  };
}

export function validatePromotionManifest(manifest: PromotionManifest): void {
  if (manifest.schemaVersion !== PROMOTION_BENCHMARK_SCHEMA_VERSION || !Array.isArray(manifest.cases)) {
    throw new Error("promotion manifest schemaVersion 1 and cases are required");
  }
  if (manifest.cases.length < 20) throw new Error("promotion manifest requires at least 20 cases");
  const ids = new Set<string>();
  for (const entry of manifest.cases) {
    if (!entry.id?.trim() || !entry.family?.trim() || !entry.story?.trim()) throw new Error("case id, family, and story are required");
    if (ids.has(entry.id)) throw new Error(`duplicate promotion case id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.source?.name?.trim() || !entry.source.license?.trim() || !entry.source.consent?.trim()) {
      throw new Error(`${entry.id}: source name, license, and consent are required`);
    }
    for (const [name, values] of [["budgets", entry.budgets], ["depths", entry.depths], ["seeds", entry.seeds]] as const) {
      if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
        throw new Error(`${entry.id}: ${name} must contain positive integers`);
      }
    }
    if (entry.storySeed !== undefined && (!Number.isSafeInteger(entry.storySeed) || entry.storySeed < 1 || entry.storySeed > 2_147_483_646)) {
      throw new Error(`${entry.id}: storySeed must be an integer from 1 to 2147483646`);
    }
    if (entry.assertions !== undefined && !Array.isArray(entry.assertions)) {
      throw new Error(`${entry.id}: assertions must be an array`);
    }
  }
}

export function summarizePromotionFamilies(pairs: PromotionPair[]): PromotionFamilySummary[] {
  const families = new Map<string, PromotionFamilySummary>();
  for (const pair of pairs) {
    const summary = families.get(pair.family) ?? {
      family: pair.family,
      pairs: 0,
      criticalRegressions: 0,
      authoredCoverageRegressions: 0,
      proofRegressions: 0,
      terminalOnlyRegressions: 0,
      baselineNondeterministic: 0,
      candidateNondeterministic: 0,
      pairsWithGains: 0,
    };
    summary.pairs++;
    if (pair.comparison.regressionRisk === "critical") summary.criticalRegressions++;
    if (pair.comparison.regressionRisk === "authored_coverage") summary.authoredCoverageRegressions++;
    if (pair.comparison.regressionRisk === "proof") summary.proofRegressions++;
    if (pair.comparison.regressionRisk === "terminal_only") summary.terminalOnlyRegressions++;
    if (pair.baseline.deterministicRepeatMatch === false) summary.baselineNondeterministic++;
    if (pair.candidate.deterministicRepeatMatch === false) summary.candidateNondeterministic++;
    if (pair.comparison.gainClass !== "none") summary.pairsWithGains++;
    families.set(pair.family, summary);
  }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
}

function countEvidence(delta: EvidenceDelta): string {
  return `E${delta.runtimeErrors.length}/A${delta.assertionViolations.length}/K${delta.visitedKnots.length}/O${delta.visibleEndings.length}/T${delta.terminalStates.length}`;
}

export function renderPromotionMarkdown(report: PromotionBenchmarkReport): string {
  const lines = [
    "# Search promotion benchmark",
    "",
    `> ${report.caveat}`,
    "",
    "## Matched runs",
    "",
    "| Case | Family | Budget | Depth | Search seed | Story seed | Baseline states | Candidate states | Regression | Gain | Baseline-only | Candidate-only | Repeat B/C | Time B/C | Peak RSS B/C |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | ---: | ---: |",
  ];
  for (const pair of report.pairs) {
    lines.push(`| ${pair.caseId} | ${pair.family} | ${pair.budget.toLocaleString("en-US")} | ${pair.depth} | ${pair.seed} | ${pair.storySeed} | ${pair.baseline.summary.statesExplored.toLocaleString("en-US")} | ${pair.candidate.summary.statesExplored.toLocaleString("en-US")} | ${pair.comparison.regressionRisk} | ${pair.comparison.gainClass} | ${countEvidence(pair.comparison.baselineOnly)} | ${countEvidence(pair.comparison.candidateOnly)} | ${pair.baseline.deterministicRepeatMatch ?? "n/a"}/${pair.candidate.deterministicRepeatMatch ?? "n/a"} | ${pair.baseline.elapsedMs.toFixed(0)}/${pair.candidate.elapsedMs.toFixed(0)} ms | ${(pair.baseline.peakRssBytes / 1_048_576).toFixed(1)}/${(pair.candidate.peakRssBytes / 1_048_576).toFixed(1)} MiB |`);
  }
  lines.push(
    "",
    "## Worst-family view",
    "",
    "| Family | Pairs | Critical regressions | Authored regressions | Proof regressions | Terminal-only regressions | Baseline nondeterministic | Candidate nondeterministic | Pairs with gains |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const family of report.families) {
    lines.push(`| ${family.family} | ${family.pairs} | ${family.criticalRegressions} | ${family.authoredCoverageRegressions} | ${family.proofRegressions} | ${family.terminalOnlyRegressions} | ${family.baselineNondeterministic} | ${family.candidateNondeterministic} | ${family.pairsWithGains} |`);
  }
  lines.push("", "Evidence key: E runtime errors, A assertion violations, K authored knots, O visible outcomes, T exact terminal states.");
  return `${lines.join("\n")}\n`;
}

export function deterministicPromotionView(report: PromotionBenchmarkReport): unknown {
  return {
    schemaVersion: report.schemaVersion,
    candidate: report.candidate,
    baseline: report.baseline,
    pairs: report.pairs.map((pair) => ({
      caseId: pair.caseId,
      family: pair.family,
      budget: pair.budget,
      depth: pair.depth,
      seed: pair.seed,
      storySeed: pair.storySeed,
      baseline: pair.baseline.summary,
      candidate: pair.candidate.summary,
      comparison: pair.comparison,
    })),
    families: report.families,
  };
}
