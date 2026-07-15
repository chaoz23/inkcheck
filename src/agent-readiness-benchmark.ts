import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { compile, scanExternals, scanKnots, scanStorySemantics } from "./inklecate";
import { explorePortfolio, playtest } from "./explore";
import { enrichAssertionViolation, enrichRuntimeError } from "./report-contract";
import { capabilities } from "./discovery";

export const AGENT_READINESS_BENCHMARK_SCHEMA_VERSION = 1;
export const AGENT_READINESS_RESULT_SCHEMA_VERSION = 1;

interface Manifest {
  schemaVersion: 1;
  benchmarkId: string;
  inkcheckContract: string;
  fixture: {
    entrypoint: string;
    runtimeRepair: string;
    completeRepair: string;
    maxDepth: number;
    maxStates: number;
    searchSeed: number;
    storySeed: number;
  };
  publicPrompt: string;
  approvalPrompt: string;
  approvedAssertion: Record<string, unknown>;
  targets: {
    maxBootstrapTokens: number;
    maxDiscoveryCalls: number;
    maxDeepReferences: number;
    maxCallsFromDiscoveryThroughRuntimeVerification: number;
    requireIndexedReplay: boolean;
    requireNoProseChanges: boolean;
    forbidFalseCompleteness: boolean;
  };
}

interface AgentSubmission {
  schemaVersion: number;
  benchmarkId: string;
  agent: { implementation: string; provider: string; model: string; version: string };
  inkcheck: {
    version: string;
    mcpProfile: "compact";
    capabilitiesSchema: number;
    reportSchema: number;
    projectInspectionSchema: number;
    searchSessionSchema: number;
    campaignPolicySchema: number;
  };
  bootstrap: {
    tokens: number;
    measurement: "provider_usage" | "reproducible_estimate";
    skillBytes: number;
    toolCatalogBytes: number;
    deepReferences: string[];
  };
  trace: Array<{ sequence: number; phase: string; operation: string }>;
  outcomes: {
    runtimeFindingId: string;
    runtimeReplayBeforeRepair: string;
    runtimeRepairVerified: boolean;
    assertionProposedBeforeApproval: boolean;
    assertionAddedAfterApproval: boolean;
    assertionFindingId: string;
    assertionReplayBeforeRepair: string;
    assertionRepairVerified: boolean;
    indexedWitnessReplay: boolean;
    finalCompileSuccess: boolean;
    finalAssertionStatus: string;
    proseChanged: boolean;
    unsafeEditCount: number;
    coverageLanguage: string;
    mentionsNoUniversalGuarantee: boolean;
    callsFromDiscoveryThroughRuntimeVerification: number;
  };
  failures: Array<{
    category: "tool" | "skill" | "model" | "environment";
    criterion: string;
    evidence: string;
  }>;
  evidence: { transcript: string; finalSource: string; evaluator: string };
}

export interface BenchmarkCriterion {
  id: string;
  pass: boolean;
  measured: unknown;
  target: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

export function loadAgentReadinessManifest(root: string): Manifest {
  const file = path.resolve(root, "manifest.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const value = object(raw, "manifest");
  if (value.schemaVersion !== AGENT_READINESS_BENCHMARK_SCHEMA_VERSION) {
    throw new Error(`unsupported agent-readiness benchmark schema ${String(value.schemaVersion)}`);
  }
  const fixture = object(value.fixture, "manifest.fixture");
  const targets = object(value.targets, "manifest.targets");
  const manifest = value as unknown as Manifest;
  for (const [label, relative] of [
    ["entrypoint", fixture.entrypoint],
    ["runtimeRepair", fixture.runtimeRepair],
    ["completeRepair", fixture.completeRepair],
  ]) {
    const item = string(relative, `manifest.fixture.${label}`);
    if (path.isAbsolute(item) || item.split(/[\\/]/).includes("..")) throw new Error(`manifest.fixture.${label} must stay inside the benchmark root`);
    if (!fs.existsSync(path.resolve(root, item))) throw new Error(`missing benchmark fixture: ${item}`);
  }
  for (const field of ["maxDepth", "maxStates", "searchSeed", "storySeed"] as const) {
    integer(fixture[field], `manifest.fixture.${field}`);
  }
  for (const field of ["maxBootstrapTokens", "maxDiscoveryCalls", "maxDeepReferences", "maxCallsFromDiscoveryThroughRuntimeVerification"] as const) {
    integer(targets[field], `manifest.targets.${field}`);
  }
  string(value.benchmarkId, "manifest.benchmarkId");
  string(value.inkcheckContract, "manifest.inkcheckContract");
  string(value.publicPrompt, "manifest.publicPrompt");
  string(value.approvalPrompt, "manifest.approvalPrompt");
  object(value.approvedAssertion, "manifest.approvedAssertion");
  return manifest;
}

function proseFingerprint(source: string): string {
  const prose = source.split(/\r?\n/).flatMap((line) => {
    const choice = line.match(/^\s*[*+]\s*\[([^\]]+)\]/);
    if (choice) return [choice[1].trim()];
    if (/^\s*(?:VAR\b|~|->|<-|={2,}|INCLUDE\b|EXTERNAL\b|CONST\b)/.test(line) || line.trim() === "") return [];
    return [line.trim()];
  });
  return createHash("sha256").update(JSON.stringify(prose)).digest("hex");
}

async function fixtureStage(root: string, relative: string, manifest: Manifest, assertions: Record<string, unknown>[]) {
  const file = path.resolve(root, relative);
  const compiled = await compile(file);
  if (!compiled.success || !compiled.storyJson) {
    return { compileSuccess: false, compileIssueKinds: compiled.issues.map((issue) => issue.severity) };
  }
  const semantics = scanStorySemantics(file);
  const result = explorePortfolio(compiled.storyJson, scanKnots(file), scanExternals(file), {
    maxDepth: manifest.fixture.maxDepth,
    maxStates: manifest.fixture.maxStates,
    seed: manifest.fixture.searchSeed,
    storySeed: manifest.fixture.storySeed,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    assertions: assertions as never[],
  });
  return {
    compileSuccess: true,
    statesExplored: result.statesExplored,
    runtimeFindings: result.runtimeErrors.map((finding) => {
      const enriched = enrichRuntimeError(finding, manifest.fixture.storySeed);
      return { id: enriched.id, kind: enriched.kind, choiceIndices: enriched.choiceIndices };
    }),
    assertionResults: result.assertionResults.map((assertion) => ({
      id: assertion.id,
      status: assertion.status,
      violations: assertion.violations.map((violation) => {
        const enriched = enrichAssertionViolation(violation, manifest.fixture.storySeed);
        return { id: enriched.id, kind: enriched.kind, choiceIndices: enriched.choiceIndices, observedValues: enriched.observedValues };
      }),
    })),
    endingCount: result.endingsFound.length,
    exhaustive: result.exhaustive,
    truncated: result.truncated,
    witnessReplay: playtest(compiled.storyJson, [0], scanExternals(file), manifest.fixture.storySeed).replayStatus,
  };
}

export async function evaluateAgentReadinessFixture(root: string) {
  const manifest = loadAgentReadinessManifest(root);
  const initialFile = path.resolve(root, manifest.fixture.entrypoint);
  const runtimeFile = path.resolve(root, manifest.fixture.runtimeRepair);
  const completeFile = path.resolve(root, manifest.fixture.completeRepair);
  const fingerprints = [initialFile, runtimeFile, completeFile].map((file) => proseFingerprint(fs.readFileSync(file, "utf8")));
  if (new Set(fingerprints).size !== 1) throw new Error("benchmark repair fixtures changed authored prose or choice labels");
  const caps = capabilities();
  return {
    schemaVersion: AGENT_READINESS_RESULT_SCHEMA_VERSION,
    benchmarkId: manifest.benchmarkId,
    inkcheck: {
      version: caps.inkcheckVersion,
      schemas: caps.schemas,
    },
    fixture: {
      proseFingerprint: fingerprints[0],
      initial: await fixtureStage(root, manifest.fixture.entrypoint, manifest, []),
      runtimeFixed: await fixtureStage(root, manifest.fixture.runtimeRepair, manifest, [manifest.approvedAssertion]),
      fullyFixed: await fixtureStage(root, manifest.fixture.completeRepair, manifest, [manifest.approvedAssertion]),
    },
  };
}

function parseSubmission(raw: unknown): AgentSubmission {
  const value = object(raw, "submission");
  if (value.schemaVersion !== AGENT_READINESS_RESULT_SCHEMA_VERSION) throw new Error(`unsupported agent submission schema ${String(value.schemaVersion)}`);
  const agent = object(value.agent, "submission.agent");
  for (const field of ["implementation", "provider", "model", "version"]) string(agent[field], `submission.agent.${field}`);
  const bootstrap = object(value.bootstrap, "submission.bootstrap");
  integer(bootstrap.tokens, "submission.bootstrap.tokens");
  integer(bootstrap.skillBytes, "submission.bootstrap.skillBytes");
  integer(bootstrap.toolCatalogBytes, "submission.bootstrap.toolCatalogBytes");
  if (bootstrap.measurement !== "provider_usage" && bootstrap.measurement !== "reproducible_estimate") throw new Error("submission.bootstrap.measurement is invalid");
  if (!Array.isArray(bootstrap.deepReferences) || !bootstrap.deepReferences.every((item) => typeof item === "string")) throw new Error("submission.bootstrap.deepReferences must be strings");
  if (!Array.isArray(value.trace) || !Array.isArray(value.failures)) throw new Error("submission trace/failures must be arrays");
  value.trace.forEach((rawStep, index) => {
    const step = object(rawStep, `submission.trace[${index}]`);
    if (step.sequence !== index + 1) throw new Error("submission trace sequence must be contiguous from 1");
    string(step.phase, `submission.trace[${index}].phase`);
    string(step.operation, `submission.trace[${index}].operation`);
  });
  object(value.outcomes, "submission.outcomes");
  object(value.inkcheck, "submission.inkcheck");
  object(value.evidence, "submission.evidence");
  return value as unknown as AgentSubmission;
}

export function scoreAgentReadinessSubmission(manifest: Manifest, expected: Awaited<ReturnType<typeof evaluateAgentReadinessFixture>>, raw: unknown) {
  const submission = parseSubmission(raw);
  if (submission.benchmarkId !== manifest.benchmarkId) throw new Error("submission benchmarkId does not match the manifest");
  const initialRuntime = expected.fixture.initial.runtimeFindings?.[0];
  const assertion = expected.fixture.runtimeFixed.assertionResults?.[0]?.violations?.[0];
  if (!initialRuntime || !assertion) throw new Error("benchmark fixture lacks its expected runtime/assertion findings");
  const discoveryCalls = submission.trace.filter((step) => step.operation === "inspect_story").length;
  const contractMatches = submission.inkcheck.version === expected.inkcheck.version
    && submission.inkcheck.mcpProfile === "compact"
    && submission.inkcheck.capabilitiesSchema === 1
    && submission.inkcheck.reportSchema === expected.inkcheck.schemas.report
    && submission.inkcheck.projectInspectionSchema === expected.inkcheck.schemas.projectInspection
    && submission.inkcheck.searchSessionSchema === expected.inkcheck.schemas.searchSession
    && submission.inkcheck.campaignPolicySchema === expected.inkcheck.schemas.campaignPolicy;
  const criteria: BenchmarkCriterion[] = [
    { id: "versioned_contract", pass: contractMatches, measured: submission.inkcheck, target: { version: expected.inkcheck.version, mcpProfile: "compact", capabilitiesSchema: 1, reportSchema: expected.inkcheck.schemas.report, projectInspectionSchema: expected.inkcheck.schemas.projectInspection, searchSessionSchema: expected.inkcheck.schemas.searchSession, campaignPolicySchema: expected.inkcheck.schemas.campaignPolicy } },
    { id: "bootstrap_tokens", pass: submission.bootstrap.tokens <= manifest.targets.maxBootstrapTokens, measured: submission.bootstrap, target: { maxTokens: manifest.targets.maxBootstrapTokens, profile: "compact" } },
    { id: "discovery_calls", pass: discoveryCalls === manifest.targets.maxDiscoveryCalls, measured: discoveryCalls, target: manifest.targets.maxDiscoveryCalls },
    { id: "deep_references", pass: submission.bootstrap.deepReferences.length <= manifest.targets.maxDeepReferences, measured: submission.bootstrap.deepReferences.length, target: manifest.targets.maxDeepReferences },
    { id: "runtime_workflow_calls", pass: submission.outcomes.callsFromDiscoveryThroughRuntimeVerification <= manifest.targets.maxCallsFromDiscoveryThroughRuntimeVerification, measured: submission.outcomes.callsFromDiscoveryThroughRuntimeVerification, target: manifest.targets.maxCallsFromDiscoveryThroughRuntimeVerification },
    { id: "runtime_identity", pass: submission.outcomes.runtimeFindingId === initialRuntime.id, measured: submission.outcomes.runtimeFindingId, target: initialRuntime.id },
    { id: "runtime_replay", pass: submission.outcomes.runtimeReplayBeforeRepair === "runtime_error" && submission.outcomes.runtimeRepairVerified, measured: { before: submission.outcomes.runtimeReplayBeforeRepair, verified: submission.outcomes.runtimeRepairVerified }, target: { before: "runtime_error", verified: true } },
    { id: "approval_boundary", pass: submission.outcomes.assertionProposedBeforeApproval && submission.outcomes.assertionAddedAfterApproval, measured: { proposed: submission.outcomes.assertionProposedBeforeApproval, addedAfter: submission.outcomes.assertionAddedAfterApproval }, target: true },
    { id: "assertion_identity", pass: submission.outcomes.assertionFindingId === assertion.id, measured: submission.outcomes.assertionFindingId, target: assertion.id },
    { id: "assertion_replay", pass: submission.outcomes.assertionReplayBeforeRepair === "completed" && submission.outcomes.indexedWitnessReplay, measured: { replay: submission.outcomes.assertionReplayBeforeRepair, indexed: submission.outcomes.indexedWitnessReplay }, target: { replay: "completed", indexed: true } },
    { id: "final_verification", pass: submission.outcomes.assertionRepairVerified && submission.outcomes.finalCompileSuccess && submission.outcomes.finalAssertionStatus === "exhaustively_verified", measured: { assertion: submission.outcomes.finalAssertionStatus, compile: submission.outcomes.finalCompileSuccess }, target: "exhaustively_verified" },
    { id: "author_safety", pass: !submission.outcomes.proseChanged && submission.outcomes.unsafeEditCount === 0, measured: { proseChanged: submission.outcomes.proseChanged, unsafeEdits: submission.outcomes.unsafeEditCount }, target: { proseChanged: false, unsafeEdits: 0 } },
    { id: "coverage_language", pass: submission.outcomes.coverageLanguage === "exhaustive_under_exact_configuration" && submission.outcomes.mentionsNoUniversalGuarantee, measured: { language: submission.outcomes.coverageLanguage, caveat: submission.outcomes.mentionsNoUniversalGuarantee }, target: "bounded exact-config proof without universal claim" },
  ];
  const failedIds = new Set(criteria.filter((criterion) => !criterion.pass).map((criterion) => criterion.id));
  const attributionComplete = [...failedIds].every((id) => submission.failures.some((failure) => failure.criterion === id
    && ["tool", "skill", "model", "environment"].includes(failure.category) && failure.evidence.length > 0));
  return {
    schemaVersion: AGENT_READINESS_RESULT_SCHEMA_VERSION,
    benchmarkId: manifest.benchmarkId,
    agent: submission.agent,
    inkcheck: submission.inkcheck,
    pass: failedIds.size === 0,
    attributionComplete,
    criteria,
    failures: submission.failures,
    evidence: submission.evidence,
  };
}

export function evaluateAgentReadinessReleaseGate(scored: Array<ReturnType<typeof scoreAgentReadinessSubmission>>) {
  const implementations = new Set(scored.map((result) => `${result.agent.provider}:${result.agent.implementation}`));
  const evidenceSets = new Set(scored.map((result) => `${result.evidence.transcript}\0${result.evidence.finalSource}`));
  const reasons: string[] = [];
  if (scored.length < 2) reasons.push("fewer than two scored agent runs");
  if (implementations.size < 2) reasons.push("fewer than two distinct provider/implementation pairs");
  if (evidenceSets.size !== scored.length) reasons.push("agent runs reuse the same transcript/final-source evidence");
  if (scored.some((result) => !result.pass)) reasons.push("at least one agent run misses a readiness target");
  if (scored.some((result) => !result.attributionComplete)) reasons.push("at least one failed criterion lacks tool/skill/model/environment attribution");
  return {
    schemaVersion: AGENT_READINESS_RESULT_SCHEMA_VERSION,
    gate: "agent_kit_complete",
    pass: reasons.length === 0,
    runCount: scored.length,
    distinctImplementations: implementations.size,
    reasons,
    agents: scored.map((result) => ({ ...result.agent, pass: result.pass })),
  };
}
