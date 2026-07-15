import type { SearchBenchmarkSummary } from "./search-benchmark";
import type { AssertionDefinition } from "./assertions";

export const PROMOTION_BENCHMARK_SCHEMA_VERSION = 1;

export interface PromotionSource {
  name: string;
  license: string;
  consent: string;
  repository?: string;
  commit?: string;
  licenseFile?: string;
  redistributionBasis?: string;
  entrypoint?: string;
  requiredExternals?: string[];
  randomness?: "none" | "seeded-runtime" | "uncontrolled-host";
  compileSetup?: string;
  structuralMeasures?: {
    authoredLines: number;
    authoredBytes: number;
    compiledWords: number;
    knots: number;
    stitches: number;
    functions: number;
    choices: number;
    gathers: number;
    diverts: number;
  };
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
  /** Repeat only these budgets; useful when full project high-water repeats are too costly. */
  determinismBudgets?: number[];
  projectSize?: "small" | "medium" | "large";
}

export interface PromotionManifest {
  schemaVersion: 1;
  tier?: "synthetic" | "authored-project";
  cases: PromotionManifestCase[];
}

export interface PromotionObservation {
  elapsedMs: number;
  peakRssBytes: number;
  resourceLimits: {
    memoryCapBytes: number;
    timeLimitMs: number | null;
  };
  workerExit: "completed" | "hard-timeout-snapshot";
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
    runtimeMetadataDrift: {
      baselineOnly: string[];
      candidateOnly: string[];
      drift: boolean;
    };
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
  projects?: PromotionFamilySummary[];
  unavailable?: PromotionUnavailableCell[];
}

export interface PromotionUnavailableCell {
  caseId: string;
  family: string;
  budget: number;
  depth: number;
  seed: number;
  storySeed: number;
  stage: "baseline" | "candidate" | "baseline-repeat" | "candidate-repeat";
  reason: "worker-timeout";
  timeoutMs: number;
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
  const metadataBaselineOnly = difference(
    input.baseline.summary.findings.runtimeErrorMetadata,
    input.candidate.summary.findings.runtimeErrorMetadata
  );
  const metadataCandidateOnly = difference(
    input.candidate.summary.findings.runtimeErrorMetadata,
    input.baseline.summary.findings.runtimeErrorMetadata
  );
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
      runtimeMetadataDrift: {
        baselineOnly: metadataBaselineOnly,
        candidateOnly: metadataCandidateOnly,
        drift: metadataBaselineOnly.length > 0 || metadataCandidateOnly.length > 0,
      },
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
  const authored = manifest.tier === "authored-project";
  if (authored ? manifest.cases.length < 3 : manifest.cases.length < 20) {
    throw new Error(authored ? "authored promotion manifest requires at least 3 projects" : "promotion manifest requires at least 20 cases");
  }
  const ids = new Set<string>();
  for (const entry of manifest.cases) {
    if (!entry.id?.trim() || !entry.family?.trim() || !entry.story?.trim()) throw new Error("case id, family, and story are required");
    if (ids.has(entry.id)) throw new Error(`duplicate promotion case id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.source?.name?.trim() || !entry.source.license?.trim() || !entry.source.consent?.trim()) {
      throw new Error(`${entry.id}: source name, license, and consent are required`);
    }
    if (authored) {
      const source = entry.source;
      if (!entry.projectSize || !source.repository?.trim() || !source.commit?.match(/^[0-9a-f]{40}$/)
        || !source.licenseFile?.trim() || !source.redistributionBasis?.trim() || !source.entrypoint?.trim()
        || !Array.isArray(source.requiredExternals) || !source.randomness || !source.compileSetup?.trim()
        || !source.structuralMeasures) {
        throw new Error(`${entry.id}: authored projects require size, pinned provenance, license, runtime, setup, and structural measures`);
      }
      const measures = Object.values(source.structuralMeasures);
      if (measures.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`${entry.id}: structural measures must be non-negative integers`);
      }
      const m = source.structuralMeasures;
      const measuredSize = m.authoredLines >= 2_500 && m.compiledWords >= 20_000 && (m.stitches >= 150 || m.choices >= 350)
        ? "large"
        : m.authoredLines >= 1_000 || m.compiledWords >= 10_000
          ? "medium"
          : "small";
      if (entry.projectSize !== measuredSize) {
        throw new Error(`${entry.id}: projectSize ${entry.projectSize} does not match documented ${measuredSize} thresholds`);
      }
      if (!entry.budgets.includes(5_000_000)) throw new Error(`${entry.id}: authored projects require a 5M-state rung`);
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
    if (entry.determinismBudgets !== undefined
      && (!Array.isArray(entry.determinismBudgets)
        || entry.determinismBudgets.length === 0
        || entry.determinismBudgets.some((budget) => !entry.budgets.includes(budget)))) {
      throw new Error(`${entry.id}: determinismBudgets must select declared budgets`);
    }
  }
  if (authored) {
    const sizes = new Set(manifest.cases.map((entry) => entry.projectSize));
    if (!sizes.has("medium") || !sizes.has("large")) {
      throw new Error("authored promotion manifest requires medium and large projects");
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

export function summarizePromotionProjects(pairs: PromotionPair[]): PromotionFamilySummary[] {
  return summarizePromotionFamilies(pairs.map((pair) => ({ ...pair, family: pair.caseId })));
}

function countEvidence(delta: EvidenceDelta): string {
  return `E${delta.runtimeErrors.length}/A${delta.assertionViolations.length}/K${delta.visitedKnots.length}/O${delta.visibleEndings.length}/T${delta.terminalStates.length}`;
}

function countSummaryEvidence(summary: SearchBenchmarkSummary): string {
  return `E${summary.findings.runtimeErrors.length}/A${summary.findings.assertionViolations.length}/K${summary.findings.visitedKnots.length}/O${summary.findings.visibleEndings.length}/T${summary.findings.terminalStates.length}`;
}

function proofAndLimits(summary: SearchBenchmarkSummary): string {
  const limits = Object.entries(summary.result.truncatedBy)
    .filter(([, bound]) => bound)
    .map(([name]) => name)
    .join(",");
  return `${summary.result.exhaustive ? "proved" : "partial"}:${limits || "none"}`;
}

function resourceLimits(observation: PromotionObservation): string {
  const memory = `${(observation.resourceLimits.memoryCapBytes / 1_048_576).toFixed(0)}MiB`;
  const time = observation.resourceLimits.timeLimitMs === null
    ? "unlimited"
    : `${(observation.resourceLimits.timeLimitMs / 1000).toFixed(0)}s`;
  return `${memory}/${time}/${observation.workerExit}`;
}

export function renderPromotionMarkdown(report: PromotionBenchmarkReport): string {
  const lines = [
    "# Search promotion benchmark",
    "",
    `> ${report.caveat}`,
    "",
    `Baseline: \`${report.baseline}\`  `,
    `Candidate: \`${report.candidate}\``,
    "",
  ];
  if (report.unavailable?.length) {
    lines.push(
      "## Resource-unavailable cells (worst first)",
      "",
      "| Project | Budget | Depth | Search seed | Story seed | Stage | Reason | Worker limit |",
      "| --- | ---: | ---: | ---: | ---: | --- | --- | ---: |"
    );
    for (const cell of report.unavailable) {
      lines.push(`| ${cell.caseId} | ${cell.budget.toLocaleString("en-US")} | ${cell.depth} | ${cell.seed} | ${cell.storySeed} | ${cell.stage} | ${cell.reason} | ${(cell.timeoutMs / 60_000).toFixed(1)} min |`);
    }
    lines.push("");
  }
  if (report.projects?.length) {
    lines.push(
      "## Worst-project view",
      "",
      "| Project | Pairs | Critical regressions | Authored regressions | Proof regressions | Terminal-only regressions | Baseline nondeterministic | Candidate nondeterministic | Pairs with gains |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
    );
    for (const project of report.projects) {
      lines.push(`| ${project.family} | ${project.pairs} | ${project.criticalRegressions} | ${project.authoredCoverageRegressions} | ${project.proofRegressions} | ${project.terminalOnlyRegressions} | ${project.baselineNondeterministic} | ${project.candidateNondeterministic} | ${project.pairsWithGains} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Matched runs",
    "",
    "| Case | Family | Budget | Depth | Search seed | Story seed | States B/C | Evidence B/C | Proof and limits B/C | Regression | Gain | Baseline-only | Candidate-only | Runtime metadata drift B/C | Repeat B/C | Time B/C | Peak RSS B/C | Worker limits B/C |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- |"
  );
  for (const pair of report.pairs) {
    lines.push(`| ${pair.caseId} | ${pair.family} | ${pair.budget.toLocaleString("en-US")} | ${pair.depth} | ${pair.seed} | ${pair.storySeed} | ${pair.baseline.summary.statesExplored.toLocaleString("en-US")}/${pair.candidate.summary.statesExplored.toLocaleString("en-US")} | ${countSummaryEvidence(pair.baseline.summary)}/${countSummaryEvidence(pair.candidate.summary)} | ${proofAndLimits(pair.baseline.summary)}/${proofAndLimits(pair.candidate.summary)} | ${pair.comparison.regressionRisk} | ${pair.comparison.gainClass} | ${countEvidence(pair.comparison.baselineOnly)} | ${countEvidence(pair.comparison.candidateOnly)} | ${pair.comparison.runtimeMetadataDrift.baselineOnly.length}/${pair.comparison.runtimeMetadataDrift.candidateOnly.length} | ${pair.baseline.deterministicRepeatMatch ?? "n/a"}/${pair.candidate.deterministicRepeatMatch ?? "n/a"} | ${pair.baseline.elapsedMs.toFixed(0)}/${pair.candidate.elapsedMs.toFixed(0)} ms | ${(pair.baseline.peakRssBytes / 1_048_576).toFixed(1)}/${(pair.candidate.peakRssBytes / 1_048_576).toFixed(1)} MiB | ${resourceLimits(pair.baseline)}/${resourceLimits(pair.candidate)} |`);
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
  lines.push("", "Evidence key: E semantic runtime errors, A assertion violations, K authored knots, O visible outcomes, T exact terminal states. Approximate runtime location drift is diagnostic metadata, not critical evidence loss.");
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
      resources: {
        baseline: {
          resourceLimits: pair.baseline.resourceLimits,
          workerExit: pair.baseline.workerExit,
        },
        candidate: {
          resourceLimits: pair.candidate.resourceLimits,
          workerExit: pair.candidate.workerExit,
        },
      },
      comparison: pair.comparison,
    })),
    families: report.families,
    ...(report.projects ? { projects: report.projects } : {}),
    ...(report.unavailable ? { unavailable: report.unavailable } : {}),
  };
}
