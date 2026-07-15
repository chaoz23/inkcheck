#!/usr/bin/env node
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openReportArtifact } from "./artifacts";
import type { AssertionDefinition, AssertionResult } from "./assertions";
import type { CampaignAllocation, CampaignLedger, CampaignValuePreference } from "./campaign-policy";
import type { ExploreResult } from "./explore";
import type { GoalDefinition, GoalResult } from "./goals";
import {
  addCampaignAssertions,
  addSessionGoal,
  startCampaign,
  type SearchSessionResponse,
} from "./search-sessions";
import { summarizeSearchResult, type SearchBenchmarkSummary } from "./search-benchmark";
import { VERSION } from "./version";

interface EvaluationSource {
  name: string;
  license: string;
  commit: string;
  licenseFile: string | null;
}

interface EvaluationCase {
  id: string;
  story: string;
  source: EvaluationSource;
  baseStates: number;
  specialistStates: number;
  maxDepth: number;
  seed: number;
  storySeed: number;
  maxElapsedSeconds: number;
  maxDiskMb: number;
  goal: GoalDefinition;
  assertions: AssertionDefinition[];
}

interface EvaluationManifest {
  schemaVersion: 1;
  cases: EvaluationCase[];
}

interface EvidenceDelta {
  runtimeErrors: string[];
  assertionViolations: string[];
  visitedKnots: string[];
  visibleEndings: string[];
  terminalStates: string[];
}

interface IdentityDigest {
  count: number;
  sha256: string;
  examples: string[];
}

interface LedgerObservation {
  purpose: CampaignAllocation["purpose"];
  grantedStates: number;
  consumedStates: number;
  yield: NonNullable<CampaignAllocation["yield"]>;
  elapsedMs: number;
  peakMemoryBytes: number;
  campaignBaseStates: number;
  campaignStatus: CampaignLedger["status"];
  campaignStopReason: CampaignLedger["stopReason"];
  ceilings: {
    totalStates: number;
    maxElapsedMs: number;
    maxMemoryBytes: number;
    maxDiskBytes: number;
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, label: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
}

function validateManifest(value: unknown): asserts value is EvaluationManifest {
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("campaign-child manifest requires schemaVersion 1 and a non-empty cases list");
  }
  const ids = new Set<string>();
  value.cases.forEach((raw, index) => {
    if (!object(raw)) throw new Error(`cases[${index}] must be an object`);
    const entry = raw as unknown as EvaluationCase;
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`cases[${index}].id must be unique lowercase kebab case`);
    }
    ids.add(entry.id);
    if (typeof entry.story !== "string" || !entry.story.endsWith(".ink")) throw new Error(`${entry.id}.story must be an .ink path`);
    if (!object(entry.source) || typeof entry.source.name !== "string" || typeof entry.source.license !== "string"
      || typeof entry.source.commit !== "string" || (entry.source.licenseFile !== null && typeof entry.source.licenseFile !== "string")) {
      throw new Error(`${entry.id}.source is incomplete`);
    }
    integer(entry.baseStates, `${entry.id}.baseStates`, 1, 100_000_000);
    integer(entry.specialistStates, `${entry.id}.specialistStates`, 1, 5_000_000);
    if (entry.baseStates + entry.specialistStates > 100_000_000) throw new Error(`${entry.id}: base plus specialist states exceed 100000000`);
    integer(entry.maxDepth, `${entry.id}.maxDepth`, 1, 1_000);
    integer(entry.seed, `${entry.id}.seed`, 1, 0xffffffff);
    integer(entry.storySeed, `${entry.id}.storySeed`, 1, 2_147_483_646);
    integer(entry.maxElapsedSeconds, `${entry.id}.maxElapsedSeconds`, 1, 604_800);
    integer(entry.maxDiskMb, `${entry.id}.maxDiskMb`, 1, 1_000_000);
    if (!object(entry.goal) || typeof entry.goal.id !== "string") throw new Error(`${entry.id}.goal is required`);
    if (!Array.isArray(entry.assertions) || entry.assertions.length === 0) throw new Error(`${entry.id}.assertions must be non-empty`);
  });
}

function sha256File(file: string): string | null {
  return fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
}

function difference(current: string[], base: string[]): string[] {
  const prior = new Set(base);
  return current.filter((value) => !prior.has(value));
}

function delta(base: SearchBenchmarkSummary, child: SearchBenchmarkSummary): EvidenceDelta {
  return {
    runtimeErrors: difference(child.findings.runtimeErrors, base.findings.runtimeErrors),
    assertionViolations: difference(child.findings.assertionViolations, base.findings.assertionViolations),
    visitedKnots: difference(child.findings.visitedKnots, base.findings.visitedKnots),
    visibleEndings: difference(child.findings.visibleEndings, base.findings.visibleEndings),
    terminalStates: difference(child.findings.terminalStates, base.findings.terminalStates),
  };
}

function identityDigest(values: string[]): IdentityDigest {
  const ordered = [...values].sort();
  return {
    count: ordered.length,
    sha256: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
    examples: ordered.slice(0, 20),
  };
}

function compactEvidence(value: EvidenceDelta) {
  return Object.fromEntries(Object.entries(value).map(([key, identities]) => [key, identityDigest(identities)]));
}

function compactSummary(value: SearchBenchmarkSummary) {
  return {
    strategy: value.strategy,
    statesExplored: value.statesExplored,
    configuration: value.configuration,
    findings: {
      runtimeErrors: identityDigest(value.findings.runtimeErrors),
      assertionViolations: identityDigest(value.findings.assertionViolations),
      visitedKnots: identityDigest(value.findings.visitedKnots),
      visibleEndings: identityDigest(value.findings.visibleEndings),
      terminalStates: identityDigest(value.findings.terminalStates),
      externalFunctionsStubbed: identityDigest(value.findings.externalFunctionsStubbed),
    },
    stateSpace: {
      terminalStates: value.stateSpace.terminalStates,
      terminalVariableStates: value.stateSpace.terminalVariableStates,
      dedupeHits: value.stateSpace.dedupeHits,
      maxDepthReached: value.stateSpace.maxDepthReached,
      peakFrontier: value.stateSpace.peakFrontier,
      peakPendingStates: value.stateSpace.peakPendingStates,
      peakPendingBytes: value.stateSpace.peakPendingBytes,
    },
    result: value.result,
    passes: value.passes,
  };
}

function sessionMetadata(projectRoot: string): { ledger: CampaignLedger; latest: CampaignAllocation } {
  const directory = path.join(projectRoot, ".inkcheck", "sessions");
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  if (files.length !== 1) throw new Error(`expected one campaign session in ${projectRoot}, found ${files.length}`);
  const raw = JSON.parse(fs.readFileSync(path.join(directory, files[0]), "utf8")) as { campaign?: { ledger?: CampaignLedger } };
  const ledger = raw.campaign?.ledger;
  if (!ledger) throw new Error("campaign session omitted its ledger");
  const latest = ledger.allocations.at(-1);
  if (!latest?.provenance || latest.status !== "completed" || latest.consumedStates === undefined || !latest.yield) {
    throw new Error("campaign child allocation is incomplete");
  }
  return { ledger, latest };
}

function ledgerObservation(ledger: CampaignLedger, latest: CampaignAllocation): LedgerObservation {
  return {
    purpose: latest.purpose,
    grantedStates: latest.grantedStates,
    consumedStates: latest.consumedStates!,
    yield: latest.yield!,
    elapsedMs: latest.provenance!.elapsedMs,
    peakMemoryBytes: latest.provenance!.peakMemoryBytes,
    campaignBaseStates: ledger.spend.states,
    campaignStatus: ledger.status,
    campaignStopReason: ledger.stopReason,
    ceilings: {
      totalStates: ledger.policy.ceilings.totalStates,
      maxElapsedMs: ledger.policy.ceilings.maxElapsedMs,
      maxMemoryBytes: ledger.policy.ceilings.maxMemoryBytes,
      maxDiskBytes: ledger.policy.ceilings.maxDiskBytes,
    },
  };
}

function directedBlock(response: SearchSessionResponse): { status: "blocked"; reason: string; baseStopReason: string } | undefined {
  const status = response.campaign?.status;
  const stopReason = response.campaign?.stopReason;
  if (status === "active" || stopReason === "exhaustive" || stopReason === "state_ceiling") return undefined;
  return {
    status: "blocked",
    reason: `base campaign stopped at ${stopReason ?? "an unknown boundary"}; directed work cannot bypass a hard campaign resource boundary`,
    baseStopReason: stopReason ?? "unknown",
  };
}

function campaignInput(file: string, entry: EvaluationCase, valuePreference: CampaignValuePreference) {
  return {
    file,
    mode: "fixed" as const,
    valuePreference,
    totalStates: entry.baseStates,
    windowStates: entry.baseStates,
    maxElapsedSeconds: entry.maxElapsedSeconds,
    maxDiskMb: entry.maxDiskMb,
    maxDepth: entry.maxDepth,
    seed: entry.seed,
    storySeed: entry.storySeed,
    longTailShare: 0,
    minLongTailProbes: 0,
    regressionReserveStates: 0,
  };
}

async function reportSummary(projectRoot: string, reportId: string, label: string): Promise<SearchBenchmarkSummary> {
  const artifact = await openReportArtifact(projectRoot, reportId);
  return summarizeSearchResult(label, (artifact.report as { explore: ExploreResult }).explore);
}

function checkpointFile(projectRoot: string, response: SearchSessionResponse): string | undefined {
  return response.session.latestCheckpointId
    ? path.join(projectRoot, ".inkcheck", "checkpoints", `${response.session.latestCheckpointId}.json`)
    : undefined;
}

function copyStory(source: string, root: string): string {
  const target = path.join(root, "story.ink");
  fs.copyFileSync(source, target);
  return target;
}

async function runGoalCampaign(source: string, entry: EvaluationCase, root: string) {
  const file = copyStory(source, root);
  const baseStarted = Date.now();
  const base = await startCampaign(campaignInput(file, entry, "approved_goals"));
  const baseElapsedMs = Date.now() - baseStarted;
  process.stderr.write(`completed ${entry.id} goal base: status=${base.session.status} stop=${base.campaign?.stopReason ?? "none"} states=${base.session.statesExplored} checkpoint=${base.session.latestCheckpointId ? "yes" : "no"}\n`);
  if (!base.sessionCapability) throw new Error("start_campaign omitted its capability");
  const baseReport = await reportSummary(root, base.session.latestReportId, "campaign-base");
  const baseMetadata = sessionMetadata(root);
  const baseResult = {
    grant: entry.baseStates,
    consumed: base.session.statesExplored,
    elapsedMs: baseElapsedMs,
    reportId: base.session.latestReportId,
    checkpointId: base.session.latestCheckpointId ?? null,
    summary: compactSummary(baseReport),
    ledger: ledgerObservation(baseMetadata.ledger, baseMetadata.latest),
  };
  const blocked = directedBlock(base);
  if (blocked) return { base: baseResult, child: blocked };
  const checkpoint = checkpointFile(root, base);
  const checkpointBefore = checkpoint ? sha256File(checkpoint) : null;
  const childStarted = Date.now();
  const child = await addSessionGoal({
    file,
    sessionCapability: base.sessionCapability,
    revision: base.session.revision,
    goal: entry.goal,
    maxStates: entry.specialistStates,
  });
  const childElapsedMs = Date.now() - childStarted;
  const childReport = await reportSummary(root, child.goalReportId, "approved-goal-child");
  const metadata = sessionMetadata(root);
  const checkpointAfter = checkpoint ? sha256File(checkpoint) : null;
  const goal = child.result;
  return {
    base: baseResult,
    child: {
      grant: entry.specialistStates,
      consumed: child.budget.directedConsumed,
      elapsedMs: childElapsedMs,
      reportId: child.goalReportId,
      goal: compactGoal(goal),
      summary: compactSummary(childReport),
      newEvidence: compactEvidence(delta(baseReport, childReport)),
      ledger: ledgerObservation(metadata.ledger, metadata.latest),
    },
    invariants: {
      baseReportPreserved: child.session.latestReportId === base.session.latestReportId,
      baseCheckpointPreserved: child.session.latestCheckpointId === base.session.latestCheckpointId
        && checkpointBefore === checkpointAfter,
      protectedBaseGrantPreserved: metadata.ledger.policy.ceilings.totalStates === entry.baseStates
        && metadata.ledger.spend.states === base.session.statesExplored,
      specialistClaimsNoBroadYield: metadata.latest.yield?.authoredCoverage === 0
        && metadata.latest.yield?.terminalVariants === 0,
    },
  };
}

function compactGoal(goal: GoalResult) {
  return {
    id: goal.id,
    status: goal.status,
    statesEvaluated: goal.statesEvaluated,
    ...(goal.witness ? {
      witness: {
        firstDiscoveredAtState: goal.witness.firstDiscoveredAtState,
        pathLength: goal.witness.choiceIndices.length,
        observedValues: goal.witness.observedValues,
      },
    } : {}),
    ...(goal.closestObserved ? {
      closestObserved: {
        distance: goal.closestObserved.distance,
        pathLength: goal.closestObserved.choiceIndices.length,
        observedValues: goal.closestObserved.observedValues,
      },
    } : {}),
    ...(goal.stages ? {
      stages: goal.stages.map((stage) => ({
        id: stage.id,
        status: stage.status,
        statesEvaluated: stage.statesEvaluated,
        ...(stage.blockedBy ? { blockedBy: stage.blockedBy } : {}),
        ...(stage.witness ? { firstDiscoveredAtState: stage.witness.firstDiscoveredAtState, pathLength: stage.witness.choiceIndices.length } : {}),
        ...(stage.closestObserved ? { closestDistance: stage.closestObserved.distance } : {}),
      })),
    } : {}),
  };
}

function compactAssertions(results: AssertionResult[]) {
  return results.map((result) => ({
    id: result.id,
    status: result.status,
    observations: result.observations,
    violations: result.violations.length,
    firstViolationAtState: result.violations[0]?.firstDiscoveredAtState ?? null,
  }));
}

async function runAssertionCampaign(source: string, entry: EvaluationCase, root: string) {
  const file = copyStory(source, root);
  const baseStarted = Date.now();
  const base = await startCampaign(campaignInput(file, entry, "runtime_assertions"));
  const baseElapsedMs = Date.now() - baseStarted;
  process.stderr.write(`completed ${entry.id} assertion base: status=${base.session.status} stop=${base.campaign?.stopReason ?? "none"} states=${base.session.statesExplored} checkpoint=${base.session.latestCheckpointId ? "yes" : "no"}\n`);
  if (!base.sessionCapability) throw new Error("start_campaign omitted its capability");
  const baseReport = await reportSummary(root, base.session.latestReportId, "campaign-base");
  const baseMetadata = sessionMetadata(root);
  const baseResult = {
    grant: entry.baseStates,
    consumed: base.session.statesExplored,
    elapsedMs: baseElapsedMs,
    reportId: base.session.latestReportId,
    checkpointId: base.session.latestCheckpointId ?? null,
    summary: compactSummary(baseReport),
    ledger: ledgerObservation(baseMetadata.ledger, baseMetadata.latest),
  };
  const blocked = directedBlock(base);
  if (blocked) return { base: baseResult, child: blocked };
  const checkpoint = checkpointFile(root, base);
  const checkpointBefore = checkpoint ? sha256File(checkpoint) : null;
  const childStarted = Date.now();
  const child = await addCampaignAssertions({
    file,
    sessionCapability: base.sessionCapability,
    revision: base.session.revision,
    assertions: entry.assertions,
    maxStates: entry.specialistStates,
  });
  const childElapsedMs = Date.now() - childStarted;
  const childReport = await reportSummary(root, child.assertionReportId, "assertion-child");
  const metadata = sessionMetadata(root);
  const checkpointAfter = checkpoint ? sha256File(checkpoint) : null;
  return {
    base: baseResult,
    child: {
      grant: entry.specialistStates,
      consumed: child.budget.directedConsumed,
      elapsedMs: childElapsedMs,
      reportId: child.assertionReportId,
      assertions: compactAssertions(child.results),
      summary: compactSummary(childReport),
      newEvidence: compactEvidence(delta(baseReport, childReport)),
      ledger: ledgerObservation(metadata.ledger, metadata.latest),
    },
    invariants: {
      baseReportPreserved: child.session.latestReportId === base.session.latestReportId,
      baseCheckpointPreserved: child.session.latestCheckpointId === base.session.latestCheckpointId
        && checkpointBefore === checkpointAfter,
      protectedBaseGrantPreserved: metadata.ledger.policy.ceilings.totalStates === entry.baseStates
        && metadata.ledger.spend.states === base.session.statesExplored,
      specialistClaimsNoBroadYield: metadata.latest.yield?.authoredCoverage === 0
        && metadata.latest.yield?.terminalVariants === 0,
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const caseIndex = args.indexOf("--case");
  const expectedLength = caseIndex === -1 ? 3 : 5;
  if (args.length !== expectedLength || outputIndex !== 1 || (caseIndex !== -1 && caseIndex !== 3)
    || !args[outputIndex + 1] || (caseIndex !== -1 && !args[caseIndex + 1])) {
    throw new Error("usage: inkcheck-campaign-child-eval manifest.json --output result.json [--case ID]");
  }
  const manifestFile = path.resolve(args[0]);
  const outputFile = path.resolve(args[outputIndex + 1]);
  const selectedCase = caseIndex === -1 ? undefined : args[caseIndex + 1];
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as unknown;
  validateManifest(manifest);
  const manifestRoot = path.dirname(manifestFile);
  const report = {
    schemaVersion: 1,
    inkcheckVersion: VERSION,
    manifestSha256: createHash("sha256").update(fs.readFileSync(manifestFile)).digest("hex"),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    cases: [] as unknown[],
  };
  const cases = selectedCase ? manifest.cases.filter((entry) => entry.id === selectedCase) : manifest.cases;
  if (cases.length === 0) throw new Error(`unknown campaign-child case: ${selectedCase}`);
  for (const entry of cases) {
    const source = path.resolve(manifestRoot, entry.story);
    if (!fs.existsSync(source)) throw new Error(`${entry.id}: story not found: ${source}`);
    const goalRoot = fs.mkdtempSync(path.join(os.tmpdir(), `inkcheck-goal-${entry.id}-`));
    const assertionRoot = fs.mkdtempSync(path.join(os.tmpdir(), `inkcheck-assertion-${entry.id}-`));
    try {
      process.stderr.write(`starting ${entry.id} goal campaign: ${entry.baseStates}+${entry.specialistStates} states\n`);
      const goalCampaign = await runGoalCampaign(source, entry, goalRoot);
      process.stderr.write(`starting ${entry.id} assertion campaign: ${entry.baseStates}+${entry.specialistStates} states\n`);
      const assertionCampaign = await runAssertionCampaign(source, entry, assertionRoot);
      report.cases.push({
        id: entry.id,
        source: entry.source,
        configuration: {
          baseStates: entry.baseStates,
          specialistStates: entry.specialistStates,
          maxDepth: entry.maxDepth,
          seed: entry.seed,
          storySeed: entry.storySeed,
        },
        goalCampaign,
        assertionCampaign,
      });
    } finally {
      fs.rmSync(goalRoot, { recursive: true, force: true });
      fs.rmSync(assertionRoot, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, outputFile);
  process.stdout.write(`${outputFile}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
