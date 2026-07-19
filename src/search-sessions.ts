import { createHash, randomBytes, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { recommendNextRun } from "./advice";
import {
  artifactProjectRoot,
  listReportFindings,
  openReportArtifact,
  openReportFinding,
  replayReportFinding,
  saveReportArtifact,
  type FindingPage,
} from "./artifacts";
import {
  CheckpointSizeLimitError,
  DEFAULT_MAX_CHECKPOINT_BYTES,
  loadCheckpointForResume,
  saveCheckpointArtifact,
} from "./checkpoints";
import {
  DEFAULT_STORY_SEED,
  MAX_STORY_SEED,
  classifyUnvisitedKnots,
  exploreGoalProbe,
  exploreShared,
  exploreSharedResumable,
  validateAssertionsForStory,
  validateGoalsForStory,
  type ExploreResult,
  type SharedSearchCheckpoint,
} from "./explore";
import { explorePortfolioPilotHandoffConcurrent } from "./concurrent-portfolio";
import { parseAssertionDefinitions, type AssertionDefinition, type AssertionResult } from "./assertions";
import { parseGoalDefinitions, type GoalDefinition, type GoalResult } from "./goals";
import { selectGateProbe, type GateProbePlan } from "./discovery";
import {
  compile,
  DEFAULT_MAX_DEPTH,
  scanExternals,
  scanInboundDiverts,
  scanKnots,
  scanShapeProfile,
  scanStorySemantics,
} from "./inklecate";
import { buildReportEnvelope, type EffectiveReportConfiguration } from "./report-contract";
import { createResourceGuards } from "./resource-guards";
import { runtimeFindingIdentity } from "./runtime-identity";
import {
  allocateDirectedCampaignRun,
  campaignLedgerDigest,
  commitCampaignRun,
  createCampaignLedger,
  createCampaignPolicy,
  deriveIndependentLongTailPartition,
  finishCampaignLedger,
  planCampaignRun,
  type CampaignAllocation,
  type CampaignIntent,
  type CampaignLedger,
  type CampaignMode,
  type CampaignStopPolicy,
  type CampaignValuePreference,
} from "./campaign-policy";
import {
  campaignPolicyInput,
  campaignRecommendation,
  explainCampaignDecision,
  resolveCampaignControl,
  type CampaignDecisionExplanation,
} from "./campaign-controls";
import {
  checkRegressionPin,
  createRegressionPin,
  type RegressionCheckResult,
  type RegressionPinSummary,
} from "./regressions";
import {
  DEFAULT_MCP_SESSION_WINDOW_STATES,
  DEFAULT_MCP_SESSION_EVENT_PAGE_SIZE,
  DEFAULT_MCP_SESSION_GOAL_PAGE_SIZE,
  MAX_MCP_SESSION_BYTES,
  MAX_MCP_SESSION_EVENTS,
  MAX_MCP_SESSION_RESPONSE_BYTES,
  MAX_MCP_SESSION_FILES,
  MAX_MCP_SESSION_TOTAL_STATES,
  MAX_MCP_SESSION_WINDOW_STATES,
  MAX_MCP_CAMPAIGN_WINDOWS,
  SEARCH_SESSION_SCHEMA_VERSION,
} from "./search-session-contract";
import { VERSION } from "./version";

const CAMPAIGN_RUN_MEMORY_SHARE = 0.9;

function campaignRunMemoryMb(maxMemoryBytes: number): number {
  return Math.max(1, Math.floor(maxMemoryBytes / (1024 * 1024) * CAMPAIGN_RUN_MEMORY_SHARE));
}

export {
  DEFAULT_MCP_SESSION_WINDOW_STATES,
  MAX_MCP_SESSION_BYTES,
  MAX_MCP_SESSION_EVENTS,
  MAX_MCP_SESSION_FILES,
  MAX_MCP_SESSION_TOTAL_STATES,
  MAX_MCP_SESSION_WINDOW_STATES,
  MAX_MCP_CAMPAIGN_WINDOWS,
  SEARCH_SESSION_SCHEMA_VERSION,
} from "./search-session-contract";

type SessionStatus = "paused" | "complete" | "stopped" | "cancelled";
type SessionEventType = "started" | "continued" | "cancelled" | "replayed" | "regression_pinned" | "regression_checked" | "goal_added" | "assertions_added";

interface GoalProbeSummary {
  goalHandle: string;
  status: GoalResult["status"];
  reportId: string;
  directedGranted: number;
  directedConsumed: number;
}

interface SearchSessionEvent {
  sequence: number;
  type: SessionEventType;
  revision: number;
  totalGranted: number;
  statesExplored: number;
  reportId: string;
  checkpointId?: string;
  findingId?: string;
  replayStatus?: "completed" | "runtime_error" | "path_changed";
  pinId?: string;
  regressionStatus?: "fixed" | "still_failing" | "path_changed";
  goalHandle?: string;
  goalStatus?: GoalResult["status"];
  directedGranted?: number;
  directedConsumed?: number;
}

interface SearchSessionRecord {
  schemaVersion: 5;
  artifactType: "mcp-search-session";
  inkcheckVersion: string;
  capabilityHash: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  source: { entrypoint: string };
  status: SessionStatus;
  recoverable: boolean;
  totalGranted: number;
  statesExplored: number;
  directedGranted: number;
  directedStatesExplored: number;
  goalProbes: GoalProbeSummary[];
  latestReportId: string;
  latestCheckpointId?: string;
  bindingLimit: string | null;
  findings: {
    endings: number;
    runtimeErrors: number;
    assertionViolations: number;
    unvisitedKnots: number;
  };
  events: SearchSessionEvent[];
  droppedEventCount: number;
  campaign?: {
    digest: string;
    ledger: CampaignLedger;
  };
}

export interface SearchSessionResponse {
  schemaVersion: number;
  inkcheckVersion: string;
  sessionCapability?: string;
  session: {
    revision: number;
    status: SessionStatus;
    recoverable: boolean;
    totalGranted: number;
    statesExplored: number;
    latestReportId: string;
    latestCheckpointId?: string;
    bindingLimit: string | null;
    findings: SearchSessionRecord["findings"];
    budget: {
      base: { granted: number; consumed: number };
      directed: { granted: number; consumed: number };
      total: { granted: number; consumed: number };
    };
    goalProbes: GoalProbeSummary[];
    goalProbePage: { returned: number; total: number; omitted: number };
    events: SearchSessionEvent[];
    droppedEventCount: number;
    eventPage: {
      returned: number;
      latestSequence: number;
      droppedBeforeSequence: number;
      omittedBeforeSequence: number;
      historyGap: boolean;
      nextSince: string;
    };
  };
  campaign?: {
    campaignId: string;
    intent: CampaignIntent;
    status: CampaignLedger["status"];
    stopReason: CampaignLedger["stopReason"];
    spend: CampaignLedger["spend"];
    ceilings: CampaignLedger["policy"]["ceilings"];
    unusedStates: number;
    windows: number;
    disclosure: string;
    decision: CampaignDecisionExplanation;
    latestWindow?: {
      purpose: CampaignLedger["allocations"][number]["purpose"];
      reportId: string;
      checkpointId?: string;
      stopReason: string;
      partition: CampaignLedger["allocations"][number]["partition"];
      yield: NonNullable<CampaignLedger["allocations"][number]["yield"]>;
      observability?: NonNullable<CampaignLedger["allocations"][number]["observability"]>;
    };
  };
  savedFindings: FindingPage;
  nextOperation: {
    tool: "continue_search" | "continue_campaign" | "inspect_search" | "start_search" | "start_campaign";
    reason: string;
  };
}

export type CancelSearchResponse = SearchSessionResponse | {
  schemaVersion: number;
  inkcheckVersion: string;
  discarded: true;
  recoverable: false;
  message: string;
};

interface SearchBindings {
  maxDepth?: number;
  seed?: number;
  storySeed?: number;
  maxFrontierStates?: number;
  maxFrontierMb?: number;
  maxMemoryMb?: number;
  maxTimeMs?: number;
  maxArtifactBytes?: number;
}

interface WindowBindings extends SearchBindings {
  commitMemoryBytes?: number;
}

interface FindingOptions {
  findingLimit?: number;
  findingCursor?: string;
  since?: string;
}

export interface StartSearchInput extends SearchBindings, FindingOptions {
  file: string;
  maxStates?: number;
}

export interface StartCampaignInput extends SearchBindings, FindingOptions {
  file: string;
  mode?: CampaignMode;
  intent?: CampaignIntent;
  resourcePreference?: CampaignIntent;
  valuePreference?: CampaignValuePreference;
  stopPolicy?: CampaignStopPolicy;
  totalStates?: number;
  windowStates?: number;
  maxElapsedSeconds?: number;
  maxDiskMb?: number;
  deadlineAt?: string;
  longTailShare?: number;
  minLongTailProbes?: number;
  regressionReserveStates?: number;
}

export interface ContinueCampaignInput extends FindingOptions {
  file: string;
  sessionCapability: string;
  revision: number;
}

export interface InspectSearchInput extends FindingOptions {
  file: string;
  sessionCapability: string;
}

export interface OpenSessionReportInput {
  file: string;
  sessionCapability: string;
  reportId: string;
}

export interface OpenSessionFindingInput extends OpenSessionReportInput {
  findingId: string;
}

export interface ContinueSearchInput extends FindingOptions {
  file: string;
  sessionCapability: string;
  revision: number;
  maxStates: number;
}

export interface CancelSearchInput {
  file: string;
  sessionCapability: string;
  revision: number;
  discard?: boolean;
}

export interface ReplayWitnessInput {
  file: string;
  sessionCapability: string;
  revision: number;
  findingId: string;
}

export interface ReplayWitnessResponse {
  schemaVersion: number;
  inkcheckVersion: string;
  session: SearchSessionResponse["session"];
  reportId: string;
  finding: Awaited<ReturnType<typeof replayReportFinding>>["finding"];
  replay: Awaited<ReturnType<typeof replayReportFinding>>["replay"];
  disclosure: string;
  nextOperation: { tool: "inspect_search"; reason: string };
}

export interface PinRegressionInput {
  file: string;
  sessionCapability: string;
  revision: number;
  findingId: string;
}

export interface CheckRegressionInput {
  file: string;
  sessionCapability: string;
  revision: number;
  pinId: string;
}

export interface AddGoalInput {
  file: string;
  sessionCapability: string;
  revision: number;
  goal: unknown;
  maxStates: number;
}

export interface AddGoalResponse {
  schemaVersion: number;
  inkcheckVersion: string;
  session: SearchSessionResponse["session"];
  goalHandle: string;
  goalReportId: string;
  goal: GoalDefinition;
  result: GoalResult;
  budget: {
    directedGranted: number;
    directedConsumed: number;
    campaignGranted: number;
    campaignConsumed: number;
  };
  disclosure: string;
  semantics: string;
  nextOperation: { tool: "inspect_search"; reason: string };
}

export interface ProbeGateInput {
  file: string;
  sessionCapability: string;
  revision: number;
  gate: { file: string; line: number };
  maxStates: number;
}

export interface ProbeGateResponse extends AddGoalResponse {
  gate: GateProbePlan["gate"];
  probe: {
    source: "static_gate_inspection";
    disclosure: string;
  };
}

export interface AddAssertionsInput {
  file: string;
  sessionCapability: string;
  revision: number;
  assertions: unknown[];
  maxStates: number;
}

export interface AddAssertionsResponse {
  schemaVersion: number;
  inkcheckVersion: string;
  session: SearchSessionResponse["session"];
  assertionReportId: string;
  assertions: AssertionDefinition[];
  results: AssertionResult[];
  budget: {
    directedGranted: number;
    directedConsumed: number;
    campaignGranted: number;
    campaignConsumed: number;
  };
  disclosure: string;
  semantics: string;
  nextOperation: { tool: "inspect_search"; reason: string };
}

export interface PinRegressionResponse {
  schemaVersion: number;
  inkcheckVersion: string;
  session: SearchSessionResponse["session"];
  pin: RegressionPinSummary;
  nextOperation: { tool: "check_regression"; reason: string };
}

export interface CheckRegressionResponse {
  schemaVersion: number;
  inkcheckVersion: string;
  session: SearchSessionResponse["session"];
  check: RegressionCheckResult;
  nextOperation: { tool: "cancel_search" | "check_regression"; reason: string };
}

function sessionsDirectory(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".inkcheck", "sessions");
}

function capabilityHash(capability: string): string {
  if (!/^mcp-session-[A-Za-z0-9_-]{43}$/.test(capability)) {
    throw new Error("invalid search session capability");
  }
  return createHash("sha256").update(capability).digest("hex");
}

function sessionFile(projectRoot: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("invalid search session capability hash");
  return path.join(sessionsDirectory(projectRoot), `session-${hash}.json`);
}

function relativeEntrypoint(projectRoot: string, entrypoint: string): string {
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, path.resolve(entrypoint));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("search session entrypoint must stay inside its project root");
  }
  return relative.split(path.sep).join("/");
}

function parseRecord(raw: string, expectedHash?: string): SearchSessionRecord {
  if (Buffer.byteLength(raw, "utf8") > MAX_MCP_SESSION_BYTES) {
    throw new Error(`search session metadata exceeds the ${MAX_MCP_SESSION_BYTES}-byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("search session metadata is corrupt JSON; discard it and start a new session");
  }
  if (!value || typeof value !== "object") throw new Error("search session metadata must be a JSON object");
  const record = value as Partial<SearchSessionRecord>;
  const sourceSchema = (record as { schemaVersion?: unknown }).schemaVersion;
  if (sourceSchema !== 1 && sourceSchema !== 2 && sourceSchema !== 3 && sourceSchema !== 4 && sourceSchema !== SEARCH_SESSION_SCHEMA_VERSION) {
    throw new Error(`unsupported search session schema ${String(record.schemaVersion)}; use a compatible Inkcheck version or start a new session`);
  }
  if (sourceSchema === 1 || sourceSchema === 2 || sourceSchema === 3) {
    record.directedGranted = 0;
    record.directedStatesExplored = 0;
    record.goalProbes = [];
  }
  if (sourceSchema !== SEARCH_SESSION_SCHEMA_VERSION) record.campaign = undefined;
  const goalProbes = record.goalProbes as Array<Partial<GoalProbeSummary>> | undefined;
  const validGoalProbes = Array.isArray(goalProbes) && goalProbes.length <= MAX_MCP_SESSION_EVENTS
    && goalProbes.every((probe) => probe && typeof probe === "object"
      && Object.keys(probe).sort().join(",") === "directedConsumed,directedGranted,goalHandle,reportId,status"
      && typeof probe.goalHandle === "string" && /^goal-[0-9a-f]{24}$/.test(probe.goalHandle)
      && ["reached", "not_reached_within_limits", "proven_unreachable", "blocked_by_stage"].includes(String(probe.status))
      && typeof probe.reportId === "string" && /^report-[0-9a-f]{24}$/.test(probe.reportId)
      && Number.isSafeInteger(probe.directedGranted) && (probe.directedGranted as number) >= 1
      && (probe.directedGranted as number) <= MAX_MCP_SESSION_WINDOW_STATES
      && Number.isSafeInteger(probe.directedConsumed) && (probe.directedConsumed as number) >= 0
      && (probe.directedConsumed as number) <= (probe.directedGranted as number));
  const findings = record.findings as Partial<SearchSessionRecord["findings"]> | undefined;
  const validFindings = findings
    && Object.keys(findings).sort().join(",") === "assertionViolations,endings,runtimeErrors,unvisitedKnots"
    && [findings.endings, findings.runtimeErrors, findings.assertionViolations, findings.unvisitedKnots]
      .every((item) => Number.isSafeInteger(item) && (item as number) >= 0);
  const validEvent = (event: unknown): boolean => {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const item = event as Partial<SearchSessionEvent>;
    const allowed = ["checkpointId", "directedConsumed", "directedGranted", "findingId", "goalHandle", "goalStatus", "pinId", "regressionStatus", "replayStatus", "reportId", "revision", "sequence", "statesExplored", "totalGranted", "type"];
    if (Object.keys(item).some((key) => !allowed.includes(key))) return false;
    const replayEvent = item.type === "replayed";
    const pinEvent = item.type === "regression_pinned";
    const checkEvent = item.type === "regression_checked";
    const goalEvent = item.type === "goal_added";
    const noGoalDetails = item.goalHandle === undefined && item.goalStatus === undefined
      && item.directedGranted === undefined && item.directedConsumed === undefined;
    const validDetails = replayEvent
      ? (sourceSchema === 2 || sourceSchema === 3 || sourceSchema === SEARCH_SESSION_SCHEMA_VERSION)
        && typeof item.findingId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(item.findingId)
        && ["completed", "runtime_error", "path_changed"].includes(String(item.replayStatus))
        && item.pinId === undefined && item.regressionStatus === undefined && noGoalDetails
      : pinEvent
        ? (sourceSchema === 3 || sourceSchema === SEARCH_SESSION_SCHEMA_VERSION)
          && typeof item.findingId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(item.findingId)
          && typeof item.pinId === "string" && /^regression-[0-9a-f]{24}$/.test(item.pinId)
          && item.replayStatus === undefined && item.regressionStatus === undefined && noGoalDetails
        : checkEvent
          ? (sourceSchema === 3 || sourceSchema === SEARCH_SESSION_SCHEMA_VERSION)
            && typeof item.pinId === "string" && /^regression-[0-9a-f]{24}$/.test(item.pinId)
            && ["fixed", "still_failing", "path_changed"].includes(String(item.regressionStatus))
            && item.findingId === undefined && item.replayStatus === undefined && noGoalDetails
          : goalEvent
            ? (sourceSchema === 4 || sourceSchema === SEARCH_SESSION_SCHEMA_VERSION)
              && typeof item.goalHandle === "string" && /^goal-[0-9a-f]{24}$/.test(item.goalHandle)
              && ["reached", "not_reached_within_limits", "proven_unreachable", "blocked_by_stage"].includes(String(item.goalStatus))
              && Number.isSafeInteger(item.directedGranted) && (item.directedGranted as number) >= 1
              && Number.isSafeInteger(item.directedConsumed) && (item.directedConsumed as number) >= 0
              && (item.directedConsumed as number) <= (item.directedGranted as number)
              && item.findingId === undefined && item.pinId === undefined
              && item.replayStatus === undefined && item.regressionStatus === undefined
            : item.findingId === undefined && item.pinId === undefined
              && item.replayStatus === undefined && item.regressionStatus === undefined && noGoalDetails;
    return Number.isSafeInteger(item.sequence) && (item.sequence as number) >= 1
      && ["started", "continued", "cancelled", "replayed", "regression_pinned", "regression_checked", "goal_added", "assertions_added"].includes(String(item.type))
      && Number.isSafeInteger(item.revision) && (item.revision as number) >= 1
      && Number.isSafeInteger(item.totalGranted) && (item.totalGranted as number) >= 1
      && Number.isSafeInteger(item.statesExplored) && (item.statesExplored as number) >= 0
      && typeof item.reportId === "string" && /^report-[0-9a-f]{24}$/.test(item.reportId)
      && (item.checkpointId === undefined
        || (typeof item.checkpointId === "string" && /^checkpoint-[0-9a-f]{24}$/.test(item.checkpointId)))
      && validDetails;
  };
  const campaign = record.campaign as SearchSessionRecord["campaign"] | undefined;
  const persistedLedgerVersion = Number((campaign?.ledger as unknown as { policyVersion?: unknown } | undefined)?.policyVersion);
  const persistedPolicyVersion = Number((campaign?.ledger?.policy as unknown as { policyVersion?: unknown } | undefined)?.policyVersion);
  const validCampaign = campaign === undefined || (sourceSchema === SEARCH_SESSION_SCHEMA_VERSION
    && campaign && typeof campaign === "object"
    && Object.keys(campaign).sort().join(",") === "digest,ledger"
    && typeof campaign.digest === "string" && /^[0-9a-f]{64}$/.test(campaign.digest)
    && campaign.ledger && typeof campaign.ledger === "object"
    && campaignLedgerDigest(campaign.ledger) === campaign.digest
    && campaign.ledger.schemaVersion === 1
    && [1, 2].includes(persistedLedgerVersion)
    && persistedPolicyVersion === persistedLedgerVersion
    && (persistedLedgerVersion === 1 || (campaign.ledger.policy
      && persistedPolicyVersion === 2
      && campaign.ledger.policy.control
      && ["quick", "balanced", "deep", "overnight", "campaign", "fixed"].includes(campaign.ledger.policy.control.mode)
      && ["scarce", "balanced", "abundant"].includes(campaign.ledger.policy.control.resourcePreference)
      && ["broad_qa", "runtime_assertions", "outcomes", "approved_goals"].includes(campaign.ledger.policy.control.valuePreference)
      && ["ceilings", "knee"].includes(campaign.ledger.policy.control.stopPolicy)
      && Array.isArray(campaign.ledger.policy.control.overrideKeys)))
    && /^campaign-[0-9a-f]{24}$/.test(campaign.ledger.campaignId)
    && campaign.ledger.bindingFingerprint.length >= 8
    && campaign.ledger.bindingFingerprint.length <= 256
    && ["active", "complete", "invalidated"].includes(campaign.ledger.status)
    && Array.isArray(campaign.ledger.allocations)
    && Array.isArray(campaign.ledger.events));
  if (record.artifactType !== "mcp-search-session" || typeof record.inkcheckVersion !== "string"
    || typeof record.capabilityHash !== "string" || !/^[0-9a-f]{64}$/.test(record.capabilityHash)
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1
    || !record.source || typeof record.source.entrypoint !== "string"
    || !["paused", "complete", "stopped", "cancelled"].includes(String(record.status))
    || typeof record.recoverable !== "boolean"
    || !Number.isSafeInteger(record.totalGranted) || (record.totalGranted as number) < 1
    || (record.totalGranted as number) > MAX_MCP_SESSION_TOTAL_STATES
    || !Number.isSafeInteger(record.statesExplored) || (record.statesExplored as number) < 0
    || (record.statesExplored as number) > (record.totalGranted as number)
    || !Number.isSafeInteger(record.directedGranted) || (record.directedGranted as number) < 0
    || !Number.isSafeInteger(record.directedStatesExplored) || (record.directedStatesExplored as number) < 0
    || (record.directedStatesExplored as number) > (record.directedGranted as number)
    || (record.totalGranted as number) + (record.directedGranted as number) > MAX_MCP_SESSION_TOTAL_STATES
    || !validGoalProbes
    || typeof record.latestReportId !== "string" || !/^report-[0-9a-f]{24}$/.test(record.latestReportId)
    || (record.latestCheckpointId !== undefined && !/^checkpoint-[0-9a-f]{24}$/.test(record.latestCheckpointId))
    || (record.bindingLimit !== null && typeof record.bindingLimit !== "string")
    || !validFindings || !Array.isArray(record.events) || !record.events.every(validEvent) || !validCampaign
    || !Number.isSafeInteger(record.droppedEventCount) || (record.droppedEventCount as number) < 0) {
    throw new Error("search session metadata is missing required bounded fields; discard it and start a new session");
  }
  if (expectedHash !== undefined && record.capabilityHash !== expectedHash) {
    throw new Error("search session capability does not match its metadata");
  }
  if (record.events.length > MAX_MCP_SESSION_EVENTS) {
    throw new Error("search session event history exceeds its bounded contract");
  }
  if (record.recoverable !== Boolean(record.latestCheckpointId)
    || (record.status === "paused" && !record.recoverable)
    || (record.status === "complete" && record.recoverable)
    || (record.status === "stopped" && record.recoverable)) {
    throw new Error("search session recoverability does not match its status and checkpoint metadata");
  }
  return { ...(record as Omit<SearchSessionRecord, "schemaVersion">), schemaVersion: SEARCH_SESSION_SCHEMA_VERSION };
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR"
      && code !== "EPERM" && code !== "EACCES" && code !== "EBADF") throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function records(projectRoot: string): SearchSessionRecord[] {
  const directory = sessionsDirectory(projectRoot);
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory).filter((name) => /^session-[0-9a-f]{64}\.json$/.test(name));
  if (names.length > MAX_MCP_SESSION_FILES) {
    throw new Error(`project has more than ${MAX_MCP_SESSION_FILES} search session files; discard old sessions before starting another`);
  }
  return names.map((name) => parseRecord(fs.readFileSync(path.join(directory, name), "utf8"), name.slice(8, -5)));
}

function writeRecord(projectRoot: string, record: SearchSessionRecord, expectedRevision?: number): void {
  const directory = sessionsDirectory(projectRoot);
  const destination = sessionFile(projectRoot, record.capabilityHash);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  if (expectedRevision !== undefined) {
    if (!fs.existsSync(destination)) throw new Error("search session no longer exists");
    const current = parseRecord(fs.readFileSync(destination, "utf8"), record.capabilityHash);
    if (current.revision !== expectedRevision) {
      throw new Error(`search session revision changed from ${expectedRevision} to ${current.revision}; inspect it before retrying`);
    }
  } else if (fs.existsSync(destination)) {
    throw new Error("search session capability collision; retry start_search");
  }
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_MCP_SESSION_BYTES) {
    throw new Error(`search session metadata exceeds the ${MAX_MCP_SESSION_BYTES}-byte limit`);
  }
  const temporary = path.join(directory, `.session.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, destination);
    if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function loadSession(file: string, capability: string): {
  projectRoot: string;
  hash: string;
  record: SearchSessionRecord;
} {
  const projectRoot = artifactProjectRoot(file);
  const hash = capabilityHash(capability);
  const target = sessionFile(projectRoot, hash);
  if (!fs.existsSync(target)) throw new Error("search session not found for this capability and project");
  const record = parseRecord(fs.readFileSync(target, "utf8"), hash);
  if (record.source.entrypoint !== relativeEntrypoint(projectRoot, file)) {
    throw new Error("search session capability belongs to a different story entrypoint");
  }
  return { projectRoot, hash, record };
}

function validateGrant(total: number, prior = 0): void {
  if (!Number.isSafeInteger(total) || total < 1 || total > MAX_MCP_SESSION_TOTAL_STATES) {
    throw new RangeError(`maxStates must be an integer from 1 to ${MAX_MCP_SESSION_TOTAL_STATES}`);
  }
  if (total <= prior) throw new RangeError(`maxStates must be greater than the prior total grant ${prior}`);
  if (total - prior > MAX_MCP_SESSION_WINDOW_STATES) {
    throw new RangeError(`one result window may add at most ${MAX_MCP_SESSION_WINDOW_STATES} states`);
  }
}

function appendEvent(record: SearchSessionRecord, event: Omit<SearchSessionEvent, "sequence">): void {
  const sequence = record.droppedEventCount + record.events.length + 1;
  record.events.push({ sequence, ...event });
  if (record.events.length > MAX_MCP_SESSION_EVENTS) {
    const remove = record.events.length - MAX_MCP_SESSION_EVENTS;
    record.events.splice(0, remove);
    record.droppedEventCount += remove;
  }
}

function persistedCampaign(ledger: CampaignLedger): SearchSessionRecord["campaign"] {
  return { ledger, digest: campaignLedgerDigest(ledger) };
}

function findingCounts(result: ExploreResult): SearchSessionRecord["findings"] {
  return {
    endings: result.endingsFound.length,
    runtimeErrors: result.runtimeErrors.length,
    assertionViolations: result.assertionResults.reduce((sum, item) => sum + item.violations.length, 0),
    unvisitedKnots: result.unvisitedKnots.length,
  };
}

async function campaignBindingFingerprint(
  file: string,
  bindings: SearchBindings,
  policy: CampaignLedger["policy"]
): Promise<string> {
  const compiled = await compile(file);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`Compilation failed; run compile_story and fix ${compiled.issues.length} issue(s) before using a campaign`);
  }
  const configuration = {
    maxDepth: bindings.maxDepth ?? DEFAULT_MAX_DEPTH,
    seed: bindings.seed ?? 1,
    storySeed: bindings.storySeed ?? DEFAULT_STORY_SEED,
    maxFrontierStates: bindings.maxFrontierStates ?? null,
    maxFrontierMb: bindings.maxFrontierMb ?? null,
    policy,
  };
  return `campaign-binding-${createHash("sha256")
    .update(compiled.storyJson)
    .update("\0")
    .update(JSON.stringify(configuration))
    .digest("hex")}`;
}

function campaignDiskBytes(
  projectRoot: string,
  ledger: CampaignLedger,
  reportId?: string,
  checkpointId?: string
): number {
  const reports = new Set<string>();
  const checkpoints = new Set<string>();
  for (const allocation of ledger.allocations) {
    if (allocation.provenance?.reportId) reports.add(allocation.provenance.reportId);
    if (allocation.provenance?.checkpointId) checkpoints.add(allocation.provenance.checkpointId);
  }
  if (reportId) reports.add(reportId);
  if (checkpointId) checkpoints.add(checkpointId);
  const files = [
    ...[...reports].map((id) => path.join(projectRoot, ".inkcheck", "reports", `${id}.json`)),
    ...[...checkpoints].flatMap((id) => [
      path.join(projectRoot, ".inkcheck", "checkpoints", `${id}.json`),
      path.join(projectRoot, ".inkcheck", "checkpoints", `${id}.json.gz`),
    ]),
  ];
  return files.reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
}

function campaignSummary(record: SearchSessionRecord): SearchSessionResponse["campaign"] {
  if (!record.campaign) return undefined;
  const ledger = record.campaign.ledger;
  const latest = [...ledger.allocations].reverse().find((allocation) => allocation.provenance);
  return {
    campaignId: ledger.campaignId,
    intent: ledger.policy.intent,
    status: ledger.status,
    stopReason: ledger.stopReason,
    spend: ledger.spend,
    ceilings: ledger.policy.ceilings,
    unusedStates: Math.max(0, ledger.policy.ceilings.totalStates - ledger.spend.states),
    windows: ledger.allocations.filter((allocation) => allocation.status === "completed").length,
    disclosure: ledger.policy.disclosure,
    decision: explainCampaignDecision(ledger),
    ...(latest?.provenance ? {
      latestWindow: {
        purpose: latest.purpose,
        reportId: latest.provenance.reportId,
        ...(latest.provenance.checkpointId ? { checkpointId: latest.provenance.checkpointId } : {}),
        stopReason: latest.stopReason ?? "window_complete",
        partition: latest.partition,
        yield: latest.yield ?? { critical: 0, intent: 0, authoredCoverage: 0, terminalVariants: 0 },
        ...(latest.observability ? { observability: latest.observability } : {}),
      },
    } : {}),
  };
}

async function runWindow(
  projectRoot: string,
  file: string,
  totalGrant: number,
  bindings: WindowBindings,
  checkpoint?: SharedSearchCheckpoint
): Promise<{
  result: ExploreResult;
  reportId: string;
  checkpointId?: string;
  bindingLimit: string | null;
  elapsedMs: number;
  peakMemoryBytes: number;
  artifactBytes: number;
  diskLimited: boolean;
}> {
  const startedAtMs = Date.now();
  const compiled = await compile(file);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`Compilation failed; run compile_story and fix ${compiled.issues.length} issue(s) before starting search`);
  }
  const { storyJson, ...compileReport } = compiled;
  const knots = scanKnots(file);
  const externals = scanExternals(file);
  const semantics = scanStorySemantics(file);
  const guards = createResourceGuards({
    maxMemoryMb: bindings.maxMemoryMb,
    maxTimeMs: bindings.maxTimeMs,
    startedAtMs,
  });
  const run = exploreSharedResumable(storyJson, knots, externals, {
    maxDepth: bindings.maxDepth,
    maxStates: totalGrant,
    seed: bindings.seed,
    storySeed: bindings.storySeed ?? DEFAULT_STORY_SEED,
    memoryGuard: guards.memoryGuard,
    timeGuard: guards.timeGuard,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    detectLoopRisks: !semantics.usesTurns && !semantics.usesRandomness && !semantics.usesVisitCounts && externals.length === 0,
    randomnessDetected: semantics.usesRandomness,
    sharedMaxPendingStates: bindings.maxFrontierStates,
    sharedMaxPendingBytes: bindings.maxFrontierMb === undefined ? undefined : bindings.maxFrontierMb * 1024 * 1024,
  }, checkpoint);
  let checkpointCandidate = run.checkpoint;
  let memoryLimited = bindings.commitMemoryBytes !== undefined
    && guards.peakMemoryBytes() > bindings.commitMemoryBytes;
  if (memoryLimited) {
    checkpointCandidate = undefined;
    run.result.truncated = true;
    run.result.exhaustive = false;
    run.result.truncatedBy.memory = true;
    run.result.truncatedBy.maxStates = false;
  }
  classifyUnvisitedKnots(run.result, scanInboundDiverts(file));
  const configuration: EffectiveReportConfiguration = {
    search: "shared",
    minRepro: false,
    strict: false,
    maxMemoryMb: null,
    maxTimeSec: null,
    maxFrontierStates: bindings.maxFrontierStates ?? null,
    maxFrontierMb: bindings.maxFrontierMb ?? null,
    goalMaxStates: 0,
    storySeed: bindings.storySeed ?? DEFAULT_STORY_SEED,
  };
  const report = buildReportEnvelope({
    compile: compileReport,
    explore: run.result,
    nextRun: recommendNextRun(run.result, scanShapeProfile(file)),
    storyJson,
    configuration,
  });
  const relative = relativeEntrypoint(projectRoot, file);
  const estimate = (value: unknown): number => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const reportEstimate = estimate({
    artifactSchemaVersion: 1,
    artifactType: "report",
    id: "report-000000000000000000000000",
    createdAt: new Date().toISOString(),
    inkcheckVersion: VERSION,
    reportSchemaVersion: report.schemaVersion,
    source: { entrypoint: relative },
    storyFingerprint: report.storyFingerprint,
    effectiveConfiguration: report.effectiveConfiguration,
    report,
  });
  if (bindings.maxArtifactBytes !== undefined && reportEstimate > bindings.maxArtifactBytes) {
    throw new Error("campaign disk ceiling cannot retain the next partial report; raise maxDiskMb before starting more work");
  }
  const reportReference = saveReportArtifact(projectRoot, file, report);
  const reportBytes = fs.statSync(path.resolve(projectRoot, reportReference.path)).size;
  let diskLimited = false;
  if (bindings.commitMemoryBytes !== undefined && guards.peakMemoryBytes() > bindings.commitMemoryBytes) {
    memoryLimited = true;
  }
  let persistedCheckpointReference;
  if (checkpointCandidate && !memoryLimited) {
    const availableBytes = bindings.maxArtifactBytes === undefined
      ? DEFAULT_MAX_CHECKPOINT_BYTES
      : Math.min(DEFAULT_MAX_CHECKPOINT_BYTES, bindings.maxArtifactBytes - reportBytes);
    if (availableBytes < 1) {
      diskLimited = true;
    } else {
      try {
        persistedCheckpointReference = await saveCheckpointArtifact(projectRoot, file, checkpointCandidate, {
          maxCheckpointBytes: availableBytes,
        });
      } catch (error) {
        if (!(error instanceof CheckpointSizeLimitError)) throw error;
        diskLimited = true;
      }
    }
  }
  let checkpointReference = persistedCheckpointReference;
  const peakMemoryBytes = guards.peakMemoryBytes();
  if (bindings.commitMemoryBytes !== undefined && peakMemoryBytes > bindings.commitMemoryBytes) {
    memoryLimited = true;
    checkpointReference = undefined;
  }
  const artifactBytes = [reportReference.path, persistedCheckpointReference?.path]
    .filter((value): value is string => Boolean(value))
    .reduce((total, relative) => total + fs.statSync(path.resolve(projectRoot, relative)).size, 0);
  return {
    result: run.result,
    reportId: reportReference.id,
    ...(checkpointReference ? { checkpointId: checkpointReference.id } : {}),
    bindingLimit: memoryLimited ? "maxMemory" : diskLimited ? "maxDiskBytes" : report.bindingLimit,
    elapsedMs: Date.now() - startedAtMs,
    peakMemoryBytes,
    artifactBytes,
    diskLimited,
  };
}

async function runIndependentLongTailWindow(
  projectRoot: string,
  file: string,
  grantedStates: number,
  partition: CampaignLedger["allocations"][number]["partition"],
  bindings: WindowBindings
): Promise<{
  result: ExploreResult;
  reportId: string;
  bindingLimit: string | null;
  elapsedMs: number;
  peakMemoryBytes: number;
  artifactBytes: number;
}> {
  const startedAtMs = Date.now();
  const compiled = await compile(file);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`Compilation failed; run compile_story and fix ${compiled.issues.length} issue(s) before starting search`);
  }
  const { storyJson, ...compileReport } = compiled;
  const knots = scanKnots(file);
  const externals = scanExternals(file);
  const semantics = scanStorySemantics(file);
  const guards = createResourceGuards({
    maxMemoryMb: bindings.maxMemoryMb,
    maxTimeMs: bindings.maxTimeMs,
    startedAtMs,
  });
  const result = explorePortfolioPilotHandoffConcurrent(storyJson, knots, externals, {
    maxDepth: partition.maxDepth ?? bindings.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxStates: grantedStates,
    seed: partition.seed ?? bindings.seed ?? 1,
    storySeed: bindings.storySeed ?? DEFAULT_STORY_SEED,
    concurrency: 4,
    memoryCapBytes: guards.memoryCapBytes,
    deadlineMs: guards.deadlineMs,
    memoryGuard: guards.memoryGuard,
    timeGuard: guards.timeGuard,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    detectLoopRisks: !semantics.usesTurns && !semantics.usesRandomness && !semantics.usesVisitCounts && externals.length === 0,
    randomnessDetected: semantics.usesRandomness,
    sharedMaxPendingStates: bindings.maxFrontierStates,
    sharedMaxPendingBytes: bindings.maxFrontierMb === undefined ? undefined : bindings.maxFrontierMb * 1024 * 1024,
  });
  classifyUnvisitedKnots(result, scanInboundDiverts(file));
  const configuration: EffectiveReportConfiguration = {
    search: "portfolio",
    concurrency: 4,
    concurrencyMode: "auto",
    executionScope: "long-tail-probe",
    minRepro: false,
    strict: false,
    maxMemoryMb: bindings.maxMemoryMb ?? null,
    maxTimeSec: bindings.maxTimeMs === undefined ? null : bindings.maxTimeMs / 1_000,
    maxFrontierStates: bindings.maxFrontierStates ?? null,
    maxFrontierMb: bindings.maxFrontierMb ?? null,
    goalMaxStates: 0,
    storySeed: bindings.storySeed ?? DEFAULT_STORY_SEED,
  };
  const report = buildReportEnvelope({
    compile: compileReport,
    explore: result,
    nextRun: recommendNextRun(result, scanShapeProfile(file)),
    storyJson,
    configuration,
  });
  const estimatedArtifactBytes = Buffer.byteLength(JSON.stringify({
    artifactSchemaVersion: 1,
    artifactType: "report",
    id: "report-000000000000000000000000",
    createdAt: new Date().toISOString(),
    inkcheckVersion: VERSION,
    reportSchemaVersion: report.schemaVersion,
    source: { entrypoint: relativeEntrypoint(projectRoot, file) },
    storyFingerprint: report.storyFingerprint,
    effectiveConfiguration: report.effectiveConfiguration,
    report,
  }, null, 2) + "\n", "utf8");
  if (bindings.maxArtifactBytes !== undefined && estimatedArtifactBytes > bindings.maxArtifactBytes) {
    throw new Error("campaign disk ceiling cannot retain the independent long-tail report; raise maxDiskMb before starting more work");
  }
  const reportReference = saveReportArtifact(projectRoot, file, report);
  const artifactBytes = fs.statSync(path.resolve(projectRoot, reportReference.path)).size;
  return {
    result,
    reportId: reportReference.id,
    bindingLimit: result.truncatedBy.memory ? "maxMemory" : report.bindingLimit,
    elapsedMs: Date.now() - startedAtMs,
    peakMemoryBytes: guards.peakMemoryBytes(),
    artifactBytes,
  };
}

function eventCursor(record: SearchSessionRecord, sequence: number): string {
  return `session-event-cursor-${Buffer.from(JSON.stringify({
    v: 1,
    capabilityHash: record.capabilityHash,
    sequence,
  }), "utf8").toString("base64url")}`;
}

function eventSequence(record: SearchSessionRecord, since?: string): number {
  if (!since) return Math.max(record.droppedEventCount, record.droppedEventCount + record.events.length - DEFAULT_MCP_SESSION_EVENT_PAGE_SIZE);
  if (!since.startsWith("session-event-cursor-")) throw new Error("invalid search-session event cursor");
  try {
    const value = JSON.parse(Buffer.from(since.slice("session-event-cursor-".length), "base64url").toString("utf8")) as {
      v?: unknown; capabilityHash?: unknown; sequence?: unknown;
    };
    const latest = record.droppedEventCount + record.events.length;
    if (value.v !== 1 || value.capabilityHash !== record.capabilityHash
      || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
      || (value.sequence as number) > latest) throw new Error();
    return value.sequence as number;
  } catch {
    throw new Error("invalid, stale, or foreign search-session event cursor");
  }
}

function responseSession(record: SearchSessionRecord, since?: string): SearchSessionResponse["session"] {
  const campaignGranted = record.totalGranted + record.directedGranted;
  const campaignConsumed = record.statesExplored + record.directedStatesExplored;
  const afterSequence = eventSequence(record, since);
  const events = record.events.filter((event) => event.sequence > afterSequence);
  const latestSequence = record.droppedEventCount + record.events.length;
  const goalProbes = record.goalProbes.slice(-DEFAULT_MCP_SESSION_GOAL_PAGE_SIZE);
  return {
    revision: record.revision,
    status: record.status,
    recoverable: record.recoverable,
    totalGranted: record.totalGranted,
    statesExplored: record.statesExplored,
    latestReportId: record.latestReportId,
    ...(record.latestCheckpointId ? { latestCheckpointId: record.latestCheckpointId } : {}),
    bindingLimit: record.bindingLimit,
    findings: record.findings,
    budget: {
      base: { granted: record.totalGranted, consumed: record.statesExplored },
      directed: { granted: record.directedGranted, consumed: record.directedStatesExplored },
      total: { granted: campaignGranted, consumed: campaignConsumed },
    },
    goalProbes,
    goalProbePage: {
      returned: goalProbes.length,
      total: record.goalProbes.length,
      omitted: record.goalProbes.length - goalProbes.length,
    },
    events,
    droppedEventCount: record.droppedEventCount,
    eventPage: {
      returned: events.length,
      latestSequence,
      droppedBeforeSequence: record.droppedEventCount,
      omittedBeforeSequence: afterSequence,
      historyGap: afterSequence > 0,
      nextSince: eventCursor(record, latestSequence),
    },
  };
}

async function sessionResponse(
  projectRoot: string,
  record: SearchSessionRecord,
  findings: FindingOptions,
  capability?: string
): Promise<SearchSessionResponse> {
  const savedFindings = await listReportFindings(projectRoot, record.latestReportId, {
    limit: findings.findingLimit,
    cursor: findings.findingCursor,
  });
  const nextOperation = record.recoverable
    ? record.campaign
      ? { tool: "continue_campaign" as const, reason: "Exact frontier work remains; the campaign policy will allocate the next bounded window." }
      : { tool: "continue_search" as const, reason: "Exact frontier work remains; raise the total grant by at most 5000000 states." }
    : record.status === "complete"
      ? { tool: "inspect_search" as const, reason: "The systematic shared frontier exhausted within the granted bounds." }
      : record.campaign
        ? { tool: "start_campaign" as const, reason: `The campaign stopped at ${record.campaign.ledger.stopReason ?? record.bindingLimit ?? "a resource boundary"}; its latest partial report remains available.` }
        : { tool: "start_search" as const, reason: `The run stopped at ${record.bindingLimit ?? "a resource boundary"} without a recoverable frontier.` };
  const response: SearchSessionResponse = {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    ...(capability ? { sessionCapability: capability } : {}),
    session: responseSession(record, findings.since),
    ...(record.campaign ? { campaign: campaignSummary(record) } : {}),
    savedFindings,
    nextOperation,
  };
  const bytes = Buffer.byteLength(JSON.stringify(response), "utf8");
  if (bytes > MAX_MCP_SESSION_RESPONSE_BYTES) {
    throw new Error(`bounded search-session response exceeded ${MAX_MCP_SESSION_RESPONSE_BYTES} bytes`);
  }
  return response;
}

export async function startSearchSession(input: StartSearchInput): Promise<SearchSessionResponse> {
  const totalGrant = input.maxStates ?? DEFAULT_MCP_SESSION_WINDOW_STATES;
  validateGrant(totalGrant);
  const storySeed = input.storySeed ?? DEFAULT_STORY_SEED;
  if (!Number.isSafeInteger(storySeed) || storySeed < 1 || storySeed > MAX_STORY_SEED) {
    throw new RangeError(`storySeed must be an integer from 1 to ${MAX_STORY_SEED}`);
  }
  const projectRoot = artifactProjectRoot(input.file);
  const entrypoint = relativeEntrypoint(projectRoot, input.file);
  const existing = records(projectRoot);
  if (existing.length >= MAX_MCP_SESSION_FILES) {
    throw new Error(`project already has ${MAX_MCP_SESSION_FILES} search session files; discard one before starting another`);
  }
  if (existing.some((record) => record.source.entrypoint === entrypoint && record.recoverable)) {
    throw new Error("this story already has a recoverable search session; continue or discard it before starting another");
  }
  const capability = `mcp-session-${randomBytes(32).toString("base64url")}`;
  const hash = capabilityHash(capability);
  const run = await runWindow(projectRoot, input.file, totalGrant, input);
  const now = new Date().toISOString();
  const status: SessionStatus = run.checkpointId ? "paused" : run.result.exhaustive ? "complete" : "stopped";
  const record: SearchSessionRecord = {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    artifactType: "mcp-search-session",
    inkcheckVersion: VERSION,
    capabilityHash: hash,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    source: { entrypoint },
    status,
    recoverable: Boolean(run.checkpointId),
    totalGranted: totalGrant,
    statesExplored: run.result.statesExplored,
    directedGranted: 0,
    directedStatesExplored: 0,
    goalProbes: [],
    latestReportId: run.reportId,
    ...(run.checkpointId ? { latestCheckpointId: run.checkpointId } : {}),
    bindingLimit: run.bindingLimit,
    findings: findingCounts(run.result),
    events: [],
    droppedEventCount: 0,
  };
  appendEvent(record, {
    type: "started",
    revision: record.revision,
    totalGranted: record.totalGranted,
    statesExplored: record.statesExplored,
    reportId: record.latestReportId,
    ...(record.latestCheckpointId ? { checkpointId: record.latestCheckpointId } : {}),
  });
  writeRecord(projectRoot, record);
  return sessionResponse(projectRoot, record, input, capability);
}

function campaignRunBindings(input: StartCampaignInput, policy: CampaignLedger["policy"], remainingMs: number): WindowBindings {
  return {
    maxDepth: input.maxDepth,
    seed: input.seed,
    storySeed: input.storySeed,
    maxFrontierStates: input.maxFrontierStates,
    maxFrontierMb: input.maxFrontierMb,
    maxMemoryMb: campaignRunMemoryMb(policy.ceilings.maxMemoryBytes),
    maxTimeMs: Math.max(1, remainingMs - 100),
    maxArtifactBytes: policy.ceilings.maxDiskBytes,
    commitMemoryBytes: policy.ceilings.maxMemoryBytes,
  };
}

function campaignYield(
  result: ExploreResult,
  prior?: SearchSessionRecord["findings"]
): NonNullable<Parameters<typeof commitCampaignRun>[1]["yield"]> {
  const assertionViolations = result.assertionResults.reduce((sum, item) => sum + item.violations.length, 0);
  return {
    critical: Math.max(0, result.runtimeErrors.length + assertionViolations
      - (prior ? prior.runtimeErrors + prior.assertionViolations : 0)),
    intent: (result.goalResults ?? []).filter((goal) => goal.status === "reached").length,
    authoredCoverage: prior
      ? Math.max(0, prior.unvisitedKnots - result.unvisitedKnots.length)
      : result.visitedKnots.length + new Set(result.endingsFound.map((ending) => ending.finalText)).size,
    terminalVariants: Math.max(0, result.endingsFound.length - (prior?.endings ?? 0)),
  };
}

interface CampaignEvidence {
  critical: Set<string>;
  goals: Set<string>;
  authoredCoverage: Set<string>;
  terminalVariants: Set<string>;
}

function campaignEvidence(result: ExploreResult): CampaignEvidence {
  const directed = directedEvidence(result);
  const authoredCoverage = new Set(result.visitedKnots.map((name) => `knot:${name}`));
  for (const ending of result.endingsFound) {
    authoredCoverage.add(`outcome:${ending.finalText.trim().replace(/\s+/g, " ")}`);
  }
  return {
    critical: directed.critical,
    goals: directed.goals,
    authoredCoverage,
    terminalVariants: new Set(result.endingsFound.map((ending) => `ending:${createHash("sha256")
      .update(JSON.stringify({ finalText: ending.finalText, variables: ending.variables }))
      .digest("hex")}`)),
  };
}

function evidenceCounts(evidence: CampaignEvidence): NonNullable<CampaignAllocation["yield"]> {
  return {
    critical: evidence.critical.size,
    intent: evidence.goals.size,
    authoredCoverage: evidence.authoredCoverage.size,
    terminalVariants: evidence.terminalVariants.size,
  };
}

function campaignObservability(
  result: ExploreResult,
  observedYield: NonNullable<CampaignAllocation["yield"]>,
  marginalYield: NonNullable<CampaignAllocation["yield"]>
): NonNullable<CampaignAllocation["observability"]> {
  const spacing = result.discoverySummary ?? {
    discoveryEvents: 0,
    firstDiscoveryAtState: null,
    lastDiscoveryAtState: null,
    statesSinceLastDiscovery: null,
    latestDiscoveryGap: null,
    longestObservedDiscoveryGap: null,
  };
  return {
    schemaVersion: 1,
    observedYield,
    rediscoveredYield: {
      critical: observedYield.critical - marginalYield.critical,
      intent: observedYield.intent - marginalYield.intent,
      authoredCoverage: observedYield.authoredCoverage - marginalYield.authoredCoverage,
      terminalVariants: observedYield.terminalVariants - marginalYield.terminalVariants,
    },
    discoverySpacing: {
      scope: "report_meaningful_events",
      ...spacing,
    },
  };
}

async function marginalCampaignEvidence(
  projectRoot: string,
  ledger: CampaignLedger,
  result: ExploreResult
): Promise<{
  yield: NonNullable<Parameters<typeof commitCampaignRun>[1]["yield"]>;
  observability: NonNullable<Parameters<typeof commitCampaignRun>[1]["observability"]>;
}> {
  const prior: CampaignEvidence = {
    critical: new Set(),
    goals: new Set(),
    authoredCoverage: new Set(),
    terminalVariants: new Set(),
  };
  for (const allocation of ledger.allocations) {
    const reportId = allocation.provenance?.reportId;
    if (!reportId) continue;
    const artifact = await openReportArtifact(projectRoot, reportId);
    const explore = (artifact.report as { explore?: ExploreResult }).explore;
    if (!explore) continue;
    const evidence = campaignEvidence(explore);
    evidence.critical.forEach((value) => prior.critical.add(value));
    evidence.goals.forEach((value) => prior.goals.add(value));
    evidence.authoredCoverage.forEach((value) => prior.authoredCoverage.add(value));
    evidence.terminalVariants.forEach((value) => prior.terminalVariants.add(value));
  }
  const current = campaignEvidence(result);
  const yieldValue = {
    critical: [...current.critical].filter((value) => !prior.critical.has(value)).length,
    intent: [...current.goals].filter((value) => !prior.goals.has(value)).length,
    authoredCoverage: [...current.authoredCoverage].filter((value) => !prior.authoredCoverage.has(value)).length,
    terminalVariants: [...current.terminalVariants].filter((value) => !prior.terminalVariants.has(value)).length,
  };
  return {
    yield: yieldValue,
    observability: campaignObservability(result, evidenceCounts(current), yieldValue),
  };
}

function directedEvidence(result: ExploreResult): { critical: Set<string>; goals: Set<string> } {
  const critical = new Set<string>();
  for (const error of result.runtimeErrors) {
    critical.add(`runtime:${createHash("sha256").update(JSON.stringify(runtimeFindingIdentity(error))).digest("hex")}`);
  }
  for (const assertion of result.assertionResults) {
    for (const violation of assertion.violations) {
      critical.add(`assertion:${createHash("sha256").update(JSON.stringify({
        ruleId: violation.ruleId,
        choiceIndices: violation.choiceIndices,
        observedValues: violation.observedValues,
      })).digest("hex")}`);
    }
  }
  const goals = new Set((result.goalResults ?? [])
    .filter((goal) => goal.status === "reached")
    .map((goal) => goal.id));
  return { critical, goals };
}

async function directedCampaignYield(
  projectRoot: string,
  ledger: CampaignLedger,
  result: ExploreResult
): Promise<NonNullable<Parameters<typeof commitCampaignRun>[1]["yield"]>> {
  const priorCritical = new Set<string>();
  const priorGoals = new Set<string>();
  for (const allocation of ledger.allocations) {
    const reportId = allocation.provenance?.reportId;
    if (!reportId) continue;
    const artifact = await openReportArtifact(projectRoot, reportId);
    const explore = (artifact.report as { explore?: ExploreResult }).explore;
    if (!explore) continue;
    const evidence = directedEvidence(explore);
    evidence.critical.forEach((value) => priorCritical.add(value));
    evidence.goals.forEach((value) => priorGoals.add(value));
  }
  const current = directedEvidence(result);
  return {
    critical: [...current.critical].filter((value) => !priorCritical.has(value)).length,
    intent: [...current.goals].filter((value) => !priorGoals.has(value)).length,
    authoredCoverage: 0,
    terminalVariants: 0,
  };
}

function terminalCampaignReason(
  result: ExploreResult,
  diskLimited = false,
  memoryLimited = false
): Parameters<typeof finishCampaignLedger>[1]["reason"] {
  if (diskLimited) return "disk_ceiling";
  if (memoryLimited) return "memory_ceiling";
  if (result.exhaustive) return "exhaustive";
  if (result.truncatedBy.memory) return "memory_ceiling";
  if (result.truncatedBy.time) return "time_ceiling";
  if (result.truncatedBy.frontier) return "frontier_ceiling";
  return "state_ceiling";
}

function terminalCampaignMessage(result: ExploreResult, diskLimited = false): string {
  if (diskLimited) return "campaign disk ceiling retained the latest report but not the next checkpoint";
  if (result.exhaustive) return "systematic shared search proved the configured reachable space exhaustive";
  const reason = result.truncatedBy.memory ? "memory"
    : result.truncatedBy.time ? "time"
      : result.truncatedBy.frontier ? "frontier"
        : result.truncatedBy.maxDepth ? "depth"
          : "state";
  return `campaign stopped at the ${reason} boundary; the latest partial report remains available`;
}

export async function startCampaign(input: StartCampaignInput): Promise<SearchSessionResponse> {
  const defaultMemoryMb = Math.max(1, Math.floor(createResourceGuards().memoryCapBytes / (1024 * 1024)));
  const control = resolveCampaignControl({
    mode: input.mode,
    resourcePreference: input.resourcePreference,
    legacyIntent: input.intent,
    valuePreference: input.valuePreference,
    stopPolicy: input.stopPolicy,
    totalStates: input.totalStates,
    windowStates: input.windowStates,
    maxElapsedSeconds: input.maxElapsedSeconds,
    maxMemoryMb: input.maxMemoryMb,
    maxDiskMb: input.maxDiskMb,
    deadlineAt: input.deadlineAt,
    longTailShare: input.longTailShare,
    minLongTailProbes: input.minLongTailProbes,
    regressionReserveStates: input.regressionReserveStates,
  }, defaultMemoryMb);
  if (!Number.isSafeInteger(control.totalStates) || control.totalStates < 10 || control.totalStates > MAX_MCP_SESSION_TOTAL_STATES) {
    throw new RangeError(`totalStates must be an integer from 10 to ${MAX_MCP_SESSION_TOTAL_STATES}`);
  }
  if (!Number.isSafeInteger(control.maxElapsedSeconds) || control.maxElapsedSeconds < 1 || control.maxElapsedSeconds > 604_800) {
    throw new RangeError("maxElapsedSeconds must be an integer from 1 to 604800");
  }
  if (!Number.isSafeInteger(control.maxDiskMb) || control.maxDiskMb < 1 || control.maxDiskMb > 1_000_000) {
    throw new RangeError("maxDiskMb must be an integer from 1 to 1000000");
  }
  if (!Number.isSafeInteger(control.windowStates) || control.windowStates < 1 || control.windowStates > MAX_MCP_SESSION_WINDOW_STATES) {
    throw new RangeError(`windowStates must be an integer from 1 to ${MAX_MCP_SESSION_WINDOW_STATES}`);
  }
  const memoryMb = control.maxMemoryMb;
  if (!Number.isSafeInteger(memoryMb) || memoryMb < 1 || memoryMb > 1_000_000) {
    throw new RangeError("maxMemoryMb must be an integer from 1 to 1000000");
  }
  if (process.memoryUsage().heapUsed >= memoryMb * 1024 * 1024) {
    throw new Error("campaign memory ceiling is already below current heap use; raise it before starting work");
  }
  const createdAt = new Date().toISOString();
  const policy = createCampaignPolicy(campaignPolicyInput(control));
  if (policy.typicalWindowStates > MAX_MCP_SESSION_WINDOW_STATES) {
    throw new RangeError(`campaign window must not exceed ${MAX_MCP_SESSION_WINDOW_STATES} states`);
  }
  if (Math.ceil(policy.ceilings.totalStates / policy.typicalWindowStates) + policy.longTail.minProbes > MAX_MCP_CAMPAIGN_WINDOWS) {
    throw new RangeError(`campaign policy may require more than ${MAX_MCP_CAMPAIGN_WINDOWS} durable windows; increase windowStates or reduce totalStates/minLongTailProbes`);
  }
  const projectRoot = artifactProjectRoot(input.file);
  const entrypoint = relativeEntrypoint(projectRoot, input.file);
  const existing = records(projectRoot);
  if (existing.length >= MAX_MCP_SESSION_FILES) {
    throw new Error(`project already has ${MAX_MCP_SESSION_FILES} search session files; discard one before starting another`);
  }
  if (existing.some((record) => record.source.entrypoint === entrypoint && record.recoverable)) {
    throw new Error("this story already has a recoverable search session or campaign; continue or discard it before starting another");
  }
  const binding = await campaignBindingFingerprint(input.file, input, policy);
  let ledger = createCampaignLedger(policy, binding, createdAt);
  const plan = planCampaignRun(ledger, {
    now: new Date().toISOString(),
    bindingFingerprint: binding,
    recommendation: "continue",
    partition: { strategy: "shared", seed: input.seed ?? 1, maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH },
  });
  if (plan.action !== "allocate") throw new Error(`campaign could not allocate its first window: ${plan.reason}`);
  const remainingMs = policy.ceilings.maxElapsedMs - plan.ledger.spend.elapsedMs;
  const run = await runWindow(projectRoot, input.file, plan.allocation.grantedStates, campaignRunBindings(input, policy, remainingMs));
  const completedAt = new Date().toISOString();
  const diskBytes = campaignDiskBytes(projectRoot, ledger, run.reportId, run.checkpointId);
  ledger = commitCampaignRun(plan.ledger, {
    now: completedAt,
    bindingFingerprint: binding,
    allocationId: plan.allocation.id,
    consumedStates: run.result.statesExplored,
    peakMemoryBytes: run.peakMemoryBytes,
    currentDiskBytes: diskBytes,
    stopReason: run.bindingLimit ?? (run.result.exhaustive ? "exhaustive" : "window_complete"),
    yield: campaignYield(run.result),
    reportId: run.reportId,
    checkpointId: run.checkpointId,
    windowElapsedMs: run.elapsedMs,
  });
  if (!run.checkpointId) {
    ledger = finishCampaignLedger(ledger, {
      now: completedAt,
      bindingFingerprint: binding,
      reason: terminalCampaignReason(run.result, run.diskLimited, run.bindingLimit === "maxMemory"),
      message: terminalCampaignMessage(run.result, run.diskLimited),
    });
  }
  const capability = `mcp-session-${randomBytes(32).toString("base64url")}`;
  const hash = capabilityHash(capability);
  const status: SessionStatus = run.checkpointId ? "paused" : run.result.exhaustive ? "complete" : "stopped";
  const record: SearchSessionRecord = {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    artifactType: "mcp-search-session",
    inkcheckVersion: VERSION,
    capabilityHash: hash,
    createdAt,
    updatedAt: completedAt,
    revision: 1,
    source: { entrypoint },
    status,
    recoverable: Boolean(run.checkpointId),
    totalGranted: plan.allocation.grantedStates,
    statesExplored: run.result.statesExplored,
    directedGranted: 0,
    directedStatesExplored: 0,
    goalProbes: [],
    latestReportId: run.reportId,
    ...(run.checkpointId ? { latestCheckpointId: run.checkpointId } : {}),
    bindingLimit: run.bindingLimit,
    findings: findingCounts(run.result),
    events: [],
    droppedEventCount: 0,
    campaign: persistedCampaign(ledger),
  };
  appendEvent(record, {
    type: "started",
    revision: 1,
    totalGranted: record.totalGranted,
    statesExplored: record.statesExplored,
    reportId: record.latestReportId,
    ...(record.latestCheckpointId ? { checkpointId: record.latestCheckpointId } : {}),
  });
  writeRecord(projectRoot, record);
  return sessionResponse(projectRoot, record, input, capability);
}

export async function inspectSearchSession(input: InspectSearchInput): Promise<SearchSessionResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  return sessionResponse(projectRoot, record, input);
}

function sessionReportIds(record: SearchSessionRecord): Set<string> {
  return new Set([
    record.latestReportId,
    ...record.goalProbes.map((probe) => probe.reportId),
    ...(record.campaign?.ledger.allocations.flatMap((allocation) => allocation.provenance?.reportId
      ? [allocation.provenance.reportId]
      : []) ?? []),
  ]);
}

export async function openSessionReport(input: OpenSessionReportInput): Promise<Awaited<ReturnType<typeof openReportArtifact>>> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (!sessionReportIds(record).has(input.reportId)) throw new Error("report ID is not owned by this search session");
  return openReportArtifact(projectRoot, input.reportId);
}

export async function openSessionFinding(input: OpenSessionFindingInput): Promise<Awaited<ReturnType<typeof openReportFinding>>> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (!sessionReportIds(record).has(input.reportId)) throw new Error("report ID is not owned by this search session");
  return openReportFinding(projectRoot, input.reportId, input.findingId);
}

export async function continueSearchSession(input: ContinueSearchInput): Promise<SearchSessionResponse> {
  const loaded = loadSession(input.file, input.sessionCapability);
  const { projectRoot, record } = loaded;
  if (record.campaign) throw new Error("campaign sessions must use continue_campaign so aggregate policy cannot be bypassed");
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  if (!record.recoverable || !record.latestCheckpointId) {
    throw new Error("search session has no recoverable frontier; inspect its terminal status or start a new session");
  }
  validateGrant(input.maxStates, record.totalGranted);
  if (input.maxStates + record.directedGranted > MAX_MCP_SESSION_TOTAL_STATES) {
    throw new RangeError(`base plus directed grants must not exceed ${MAX_MCP_SESSION_TOTAL_STATES} states`);
  }
  const resumed = await loadCheckpointForResume(projectRoot, record.latestCheckpointId);
  const saved = resumed.checkpoint.configuration;
  const run = await runWindow(projectRoot, input.file, input.maxStates, {
    maxDepth: saved.maxDepth,
    seed: saved.seed,
    storySeed: saved.storySeed,
    ...(saved.maxPendingStates === null ? {} : { maxFrontierStates: saved.maxPendingStates }),
    ...(saved.maxPendingBytes === null ? {} : { maxFrontierMb: saved.maxPendingBytes / (1024 * 1024) }),
  }, resumed.checkpoint);
  const nextRevision = record.revision + 1;
  const status: SessionStatus = run.checkpointId ? "paused" : run.result.exhaustive ? "complete" : "stopped";
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
    status,
    recoverable: Boolean(run.checkpointId),
    totalGranted: input.maxStates,
    statesExplored: run.result.statesExplored,
    latestReportId: run.reportId,
    ...(run.checkpointId ? { latestCheckpointId: run.checkpointId } : { latestCheckpointId: undefined }),
    bindingLimit: run.bindingLimit,
    findings: findingCounts(run.result),
  };
  appendEvent(updated, {
    type: "continued",
    revision: nextRevision,
    totalGranted: updated.totalGranted,
    statesExplored: updated.statesExplored,
    reportId: updated.latestReportId,
    ...(updated.latestCheckpointId ? { checkpointId: updated.latestCheckpointId } : {}),
  });
  writeRecord(projectRoot, updated, record.revision);
  return sessionResponse(projectRoot, updated, input);
}

function stopCampaignRecord(
  projectRoot: string,
  record: SearchSessionRecord,
  ledger: CampaignLedger
): SearchSessionRecord {
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: record.revision + 1,
    status: ledger.status === "complete" && ledger.stopReason === "exhaustive" ? "complete" : "stopped",
    recoverable: false,
    latestCheckpointId: undefined,
    campaign: persistedCampaign(ledger),
  };
  writeRecord(projectRoot, updated, record.revision);
  return updated;
}

export async function continueCampaign(input: ContinueCampaignInput): Promise<SearchSessionResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  if (!record.campaign) throw new Error("search session is not managed by a campaign; use continue_search with an explicit cumulative grant");
  if (!record.recoverable || !record.latestCheckpointId) {
    throw new Error("campaign has no recoverable frontier; inspect its terminal status or start a new campaign");
  }
  const ledger = record.campaign.ledger;
  const currentReport = await openReportArtifact(projectRoot, record.latestReportId);
  if (currentReport.artifact.freshness !== "current") {
    const invalid = planCampaignRun(ledger, {
      now: new Date().toISOString(),
      bindingFingerprint: `${ledger.bindingFingerprint}-stale`,
      recommendation: "continue",
    });
    if (invalid.action !== "stop" || invalid.reason !== "source_changed") {
      throw new Error("campaign source invalidation did not produce a terminal decision");
    }
    const updated = stopCampaignRecord(projectRoot, record, invalid.ledger);
    return sessionResponse(projectRoot, updated, input);
  }
  const plan = planCampaignRun(ledger, {
    now: new Date().toISOString(),
    bindingFingerprint: ledger.bindingFingerprint,
    recommendation: campaignRecommendation(ledger),
    partition: { strategy: "shared" },
    longTailPartition: deriveIndependentLongTailPartition(
      ledger,
      (currentReport.report.effectiveConfiguration as { limits?: { maxDepth?: number } }).limits?.maxDepth ?? DEFAULT_MAX_DEPTH
    ),
  });
  if (plan.action === "stop") {
    const updated = stopCampaignRecord(projectRoot, record, plan.ledger);
    return sessionResponse(projectRoot, updated, input);
  }
  if (plan.action === "wait") throw new Error("campaign concurrency ceiling is occupied; inspect the active window before retrying");
  const resumed = await loadCheckpointForResume(projectRoot, record.latestCheckpointId);
  const saved = resumed.checkpoint.configuration;
  const remainingMs = Math.max(1, ledger.policy.ceilings.maxElapsedMs - plan.ledger.spend.elapsedMs);
  if (plan.allocation.purpose === "long_tail") {
    const run = await runIndependentLongTailWindow(
      projectRoot,
      input.file,
      plan.allocation.grantedStates,
      plan.allocation.partition,
      {
        maxDepth: plan.allocation.partition.maxDepth ?? saved.maxDepth,
        seed: plan.allocation.partition.seed ?? saved.seed,
        storySeed: saved.storySeed,
        ...(saved.maxPendingStates === null ? {} : { maxFrontierStates: saved.maxPendingStates }),
        ...(saved.maxPendingBytes === null ? {} : { maxFrontierMb: saved.maxPendingBytes / (1024 * 1024) }),
        maxMemoryMb: campaignRunMemoryMb(ledger.policy.ceilings.maxMemoryBytes),
        maxTimeMs: Math.max(1, remainingMs - 100),
        maxArtifactBytes: Math.max(0, ledger.policy.ceilings.maxDiskBytes - ledger.spend.currentDiskBytes),
      }
    );
    const completedAt = new Date().toISOString();
    const diskBytes = campaignDiskBytes(projectRoot, plan.ledger, run.reportId);
    const evidence = await marginalCampaignEvidence(projectRoot, ledger, run.result);
    const completedLedger = commitCampaignRun(plan.ledger, {
      now: completedAt,
      bindingFingerprint: ledger.bindingFingerprint,
      allocationId: plan.allocation.id,
      consumedStates: run.result.statesExplored,
      peakMemoryBytes: run.peakMemoryBytes,
      currentDiskBytes: diskBytes,
      stopReason: run.bindingLimit ?? (run.result.exhaustive ? "exhaustive" : "window_complete"),
      yield: evidence.yield,
      observability: evidence.observability,
      reportId: run.reportId,
      windowElapsedMs: run.elapsedMs,
    });
    const updated: SearchSessionRecord = {
      ...record,
      updatedAt: completedAt,
      revision: record.revision + 1,
      status: "paused",
      recoverable: true,
      campaign: persistedCampaign(completedLedger),
    };
    appendEvent(updated, {
      type: "continued",
      revision: updated.revision,
      totalGranted: updated.totalGranted,
      statesExplored: updated.statesExplored,
      reportId: run.reportId,
    });
    writeRecord(projectRoot, updated, record.revision);
    return sessionResponse(projectRoot, updated, input);
  }
  const nextGrant = record.totalGranted + plan.allocation.grantedStates;
  validateGrant(nextGrant, record.totalGranted);
  if (nextGrant + record.directedGranted > MAX_MCP_SESSION_TOTAL_STATES) {
    throw new RangeError(`base plus directed grants must not exceed ${MAX_MCP_SESSION_TOTAL_STATES} states`);
  }
  const run = await runWindow(projectRoot, input.file, nextGrant, {
    maxDepth: saved.maxDepth,
    seed: saved.seed,
    storySeed: saved.storySeed,
    ...(saved.maxPendingStates === null ? {} : { maxFrontierStates: saved.maxPendingStates }),
    ...(saved.maxPendingBytes === null ? {} : { maxFrontierMb: saved.maxPendingBytes / (1024 * 1024) }),
    maxMemoryMb: campaignRunMemoryMb(ledger.policy.ceilings.maxMemoryBytes),
    maxTimeMs: Math.max(1, remainingMs - 100),
    maxArtifactBytes: Math.max(0, ledger.policy.ceilings.maxDiskBytes - ledger.spend.currentDiskBytes),
    commitMemoryBytes: ledger.policy.ceilings.maxMemoryBytes,
  }, resumed.checkpoint);
  const completedAt = new Date().toISOString();
  const diskBytes = campaignDiskBytes(projectRoot, plan.ledger, run.reportId, run.checkpointId);
  const consumedStates = Math.max(0, run.result.statesExplored - record.statesExplored);
  let completedLedger = commitCampaignRun(plan.ledger, {
    now: completedAt,
    bindingFingerprint: ledger.bindingFingerprint,
    allocationId: plan.allocation.id,
    consumedStates,
    peakMemoryBytes: run.peakMemoryBytes,
    currentDiskBytes: diskBytes,
    stopReason: run.bindingLimit ?? (run.result.exhaustive ? "exhaustive" : "window_complete"),
    yield: campaignYield(run.result, record.findings),
    reportId: run.reportId,
    checkpointId: run.checkpointId,
    windowElapsedMs: run.elapsedMs,
  });
  if (!run.checkpointId) {
    completedLedger = finishCampaignLedger(completedLedger, {
      now: completedAt,
      bindingFingerprint: ledger.bindingFingerprint,
      reason: terminalCampaignReason(run.result, run.diskLimited, run.bindingLimit === "maxMemory"),
      message: terminalCampaignMessage(run.result, run.diskLimited),
    });
  }
  const nextRevision = record.revision + 1;
  const status: SessionStatus = run.checkpointId ? "paused" : run.result.exhaustive ? "complete" : "stopped";
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: completedAt,
    revision: nextRevision,
    status,
    recoverable: Boolean(run.checkpointId),
    totalGranted: nextGrant,
    statesExplored: run.result.statesExplored,
    latestReportId: run.reportId,
    ...(run.checkpointId ? { latestCheckpointId: run.checkpointId } : { latestCheckpointId: undefined }),
    bindingLimit: run.bindingLimit,
    findings: findingCounts(run.result),
    campaign: persistedCampaign(completedLedger),
  };
  appendEvent(updated, {
    type: "continued",
    revision: nextRevision,
    totalGranted: updated.totalGranted,
    statesExplored: updated.statesExplored,
    reportId: updated.latestReportId,
    ...(updated.latestCheckpointId ? { checkpointId: updated.latestCheckpointId } : {}),
  });
  writeRecord(projectRoot, updated, record.revision);
  return sessionResponse(projectRoot, updated, input);
}

export async function addSessionGoal(input: AddGoalInput): Promise<AddGoalResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  if (!Number.isSafeInteger(input.maxStates) || input.maxStates < 1 || input.maxStates > MAX_MCP_SESSION_WINDOW_STATES) {
    throw new RangeError(`maxStates must be an integer from 1 to ${MAX_MCP_SESSION_WINDOW_STATES}`);
  }
  const protectedBaseGrant = record.campaign?.ledger.policy.ceilings.totalStates ?? record.totalGranted;
  if (protectedBaseGrant + record.directedGranted + input.maxStates > MAX_MCP_SESSION_TOTAL_STATES) {
    throw new RangeError(`base plus directed grants must not exceed ${MAX_MCP_SESSION_TOTAL_STATES} states`);
  }
  const issues: string[] = [];
  const goals = parseGoalDefinitions([input.goal], "goals", issues) ?? [];
  if (issues.length || goals.length !== 1) {
    throw new RangeError(`Invalid goals:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }
  if (record.campaign && record.campaign.ledger.policy.control.valuePreference !== "approved_goals") {
    throw new Error("campaign add_goal requires valuePreference=approved_goals so directed intent is explicit");
  }
  const currentBase = await openReportArtifact(projectRoot, record.latestReportId);
  if (currentBase.artifact.freshness !== "current") {
    throw new Error("add_goal requires the exact source used by the session's latest base report; start a fresh search after source changes");
  }
  const compiled = await compile(input.file);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`Compilation failed; run compile_story and fix ${compiled.issues.length} issue(s) before adding a goal`);
  }
  const { storyJson, ...compileReport } = compiled;
  const knots = scanKnots(input.file);
  const externals = scanExternals(input.file);
  validateGoalsForStory(storyJson, knots, externals, goals);
  const startedAtMs = Date.now();
  const campaignAllocation = record.campaign
    ? allocateDirectedCampaignRun(record.campaign.ledger, {
      now: new Date(startedAtMs).toISOString(),
      bindingFingerprint: record.campaign.ledger.bindingFingerprint,
      purpose: "approved_goal",
      grantedStates: input.maxStates,
      partition: {
        strategy: "shared",
        goalId: `goal-${createHash("sha256").update(JSON.stringify(goals[0])).digest("hex").slice(0, 24)}`,
        maxDepth: (currentBase.report.effectiveConfiguration as { limits?: { maxDepth?: number } }).limits?.maxDepth ?? DEFAULT_MAX_DEPTH,
      },
    })
    : undefined;
  const baseConfiguration = currentBase.report.effectiveConfiguration as {
    limits?: { maxDepth?: number; seed?: number; storySeed?: number };
    maxFrontierStates?: number | null;
    maxFrontierMb?: number | null;
  };
  const limits = baseConfiguration.limits ?? {};
  const semantics = scanStorySemantics(input.file);
  const campaignRemainingMs = campaignAllocation && record.campaign
    ? Math.max(1, record.campaign.ledger.policy.ceilings.maxElapsedMs - campaignAllocation.ledger.spend.elapsedMs - 100)
    : undefined;
  const guards = createResourceGuards({
    ...(record.campaign ? { maxMemoryMb: campaignRunMemoryMb(record.campaign.ledger.policy.ceilings.maxMemoryBytes) } : {}),
    ...(campaignRemainingMs === undefined ? {} : { maxTimeMs: campaignRemainingMs }),
    startedAtMs,
  });
  const result = exploreGoalProbe(storyJson, knots, externals, {
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
    seed: limits.seed,
    storySeed: limits.storySeed ?? DEFAULT_STORY_SEED,
    goalMaxStates: input.maxStates,
    goals,
    memoryGuard: guards.memoryGuard,
    timeGuard: guards.timeGuard,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    detectLoopRisks: !semantics.usesTurns && !semantics.usesRandomness && !semantics.usesVisitCounts && externals.length === 0,
    randomnessDetected: semantics.usesRandomness,
    sharedMaxPendingStates: baseConfiguration.maxFrontierStates ?? undefined,
    sharedMaxPendingBytes: baseConfiguration.maxFrontierMb === null || baseConfiguration.maxFrontierMb === undefined
      ? undefined
      : baseConfiguration.maxFrontierMb * 1024 * 1024,
  });
  classifyUnvisitedKnots(result, scanInboundDiverts(input.file));
  const configuration: EffectiveReportConfiguration = {
    search: "shared",
    executionScope: "goal-probe",
    minRepro: false,
    strict: false,
    maxMemoryMb: null,
    maxTimeSec: null,
    maxFrontierStates: baseConfiguration.maxFrontierStates ?? null,
    maxFrontierMb: baseConfiguration.maxFrontierMb ?? null,
    goalMaxStates: input.maxStates,
    storySeed: limits.storySeed ?? DEFAULT_STORY_SEED,
    goals,
  };
  const report = buildReportEnvelope({
    compile: compileReport,
    explore: result,
    nextRun: {
      recommendation: "investigate",
      stop: true,
      flags: {
        maxDepth: result.limits.maxDepth,
        maxStates: input.maxStates,
        ...(result.limits.seed === undefined ? {} : { seed: result.limits.seed }),
      },
      rationale: "This report is one additive goal probe from the story root, not the resumable base search.",
      expectedGain: "Inspect the goal result, then explicitly choose whether to add another directed probe or continue the protected base search.",
    },
    storyJson,
    configuration,
  });
  const goalReport = saveReportArtifact(projectRoot, input.file, report);
  const goalResult = result.goalResults?.[0];
  if (!goalResult) throw new Error("goal probe completed without a goal result");
  const goalHandle = record.campaign
    ? `goal-${createHash("sha256").update(`${record.campaign.ledger.campaignId}\0${JSON.stringify(goals[0])}`).digest("hex").slice(0, 24)}`
    : `goal-${randomBytes(12).toString("hex")}`;
  const summary: GoalProbeSummary = {
    goalHandle,
    status: goalResult.status,
    reportId: goalReport.id,
    directedGranted: input.maxStates,
    directedConsumed: result.statesExplored,
  };
  const childYield = campaignAllocation && record.campaign
    ? await directedCampaignYield(projectRoot, record.campaign.ledger, result)
    : undefined;
  const nextRevision = record.revision + 1;
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
    directedGranted: record.directedGranted + input.maxStates,
    directedStatesExplored: record.directedStatesExplored + result.statesExplored,
    goalProbes: [...record.goalProbes, summary].slice(-MAX_MCP_SESSION_EVENTS),
    ...(campaignAllocation && record.campaign ? {
      campaign: persistedCampaign(commitCampaignRun(campaignAllocation.ledger, {
        now: new Date().toISOString(),
        bindingFingerprint: record.campaign.ledger.bindingFingerprint,
        allocationId: campaignAllocation.allocation.id,
        consumedStates: result.statesExplored,
        peakMemoryBytes: guards.peakMemoryBytes(),
        currentDiskBytes: campaignDiskBytes(projectRoot, campaignAllocation.ledger, goalReport.id),
        stopReason: result.truncatedBy.memory ? "memory_ceiling"
          : result.truncatedBy.time ? "time_ceiling"
            : result.truncatedBy.frontier ? "frontier_ceiling"
              : result.exhaustive ? "exhaustive" : "window_complete",
        yield: childYield,
        reportId: goalReport.id,
        windowElapsedMs: Date.now() - startedAtMs,
      })),
    } : {}),
  };
  appendEvent(updated, {
    type: "goal_added",
    revision: nextRevision,
    totalGranted: updated.totalGranted,
    statesExplored: updated.statesExplored,
    reportId: goalReport.id,
    ...(updated.latestCheckpointId ? { checkpointId: updated.latestCheckpointId } : {}),
    goalHandle,
    goalStatus: goalResult.status,
    directedGranted: input.maxStates,
    directedConsumed: result.statesExplored,
  });
  writeRecord(projectRoot, updated, record.revision);
  return {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    session: responseSession(updated),
    goalHandle,
    goalReportId: goalReport.id,
    goal: goals[0],
    result: goalResult,
    budget: {
      directedGranted: input.maxStates,
      directedConsumed: result.statesExplored,
      campaignGranted: updated.totalGranted + updated.directedGranted,
      campaignConsumed: updated.statesExplored + updated.directedStatesExplored,
    },
    disclosure: "This explicit goal response may include variable names and values, choice text, and an indexed witness. Ordinary inspect_search metadata remains privacy-minimal.",
    semantics: "The directed work started at the story root and was additive. It did not resume, reduce, reorder, or mutate the exact base-search frontier.",
    nextOperation: {
      tool: "inspect_search",
      reason: "Inspect the committed revision and separate base/directed totals before choosing the next bounded operation.",
    },
  };
}

/**
 * Convert one explicitly selected source gate into the existing additive goal
 * probe. The selected source condition and its assignment sites are disclosed
 * in the response; neither is treated as a proof of reachability.
 */
export async function probeSessionGate(input: ProbeGateInput): Promise<ProbeGateResponse> {
  const plan = selectGateProbe(input.file, input.gate);
  const result = await addSessionGoal({
    file: input.file,
    sessionCapability: input.sessionCapability,
    revision: input.revision,
    maxStates: input.maxStates,
    goal: plan.goal,
  });
  return {
    ...result,
    gate: plan.gate,
    probe: {
      source: "static_gate_inspection",
      disclosure: plan.disclosure,
    },
    semantics: "This explicit gate probe started from the story root and was additive. It did not resume, reduce, reorder, or mutate the exact base-search frontier. Its static source hints do not prove the gate is reachable.",
  };
}

export async function addCampaignAssertions(input: AddAssertionsInput): Promise<AddAssertionsResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  if (!record.campaign) throw new Error("add_assertions requires a campaign; ordinary runs can pass assertions directly to check_story");
  if (record.campaign.ledger.policy.control.valuePreference !== "runtime_assertions") {
    throw new Error("campaign add_assertions requires valuePreference=runtime_assertions so directed intent is explicit");
  }
  if (!Number.isSafeInteger(input.maxStates) || input.maxStates < 1 || input.maxStates > MAX_MCP_SESSION_WINDOW_STATES) {
    throw new RangeError(`maxStates must be an integer from 1 to ${MAX_MCP_SESSION_WINDOW_STATES}`);
  }
  if (record.campaign.ledger.policy.ceilings.totalStates + record.directedGranted + input.maxStates > MAX_MCP_SESSION_TOTAL_STATES) {
    throw new RangeError(`protected base plus directed grants must not exceed ${MAX_MCP_SESSION_TOTAL_STATES} states`);
  }
  const issues: string[] = [];
  const assertions = parseAssertionDefinitions(input.assertions, "assertions", issues) ?? [];
  if (issues.length || assertions.length === 0) {
    throw new RangeError(`Invalid assertions:\n${issues.length ? issues.map((issue) => `- ${issue}`).join("\n") : "- assertions: expected at least one rule"}`);
  }
  const currentBase = await openReportArtifact(projectRoot, record.latestReportId);
  if (currentBase.artifact.freshness !== "current") {
    throw new Error("add_assertions requires the exact source used by the campaign's latest base report; start a fresh campaign after source changes");
  }
  const compiled = await compile(input.file);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`Compilation failed; run compile_story and fix ${compiled.issues.length} issue(s) before adding assertions`);
  }
  const { storyJson, ...compileReport } = compiled;
  const knots = scanKnots(input.file);
  const externals = scanExternals(input.file);
  validateAssertionsForStory(storyJson, knots, externals, assertions);
  const baseConfiguration = currentBase.report.effectiveConfiguration as {
    limits?: { maxDepth?: number; seed?: number; storySeed?: number };
    maxFrontierStates?: number | null;
    maxFrontierMb?: number | null;
  };
  const limits = baseConfiguration.limits ?? {};
  const definitionHash = createHash("sha256").update(JSON.stringify(assertions)).digest("hex");
  const startedAtMs = Date.now();
  const allocation = allocateDirectedCampaignRun(record.campaign.ledger, {
    now: new Date(startedAtMs).toISOString(),
    bindingFingerprint: record.campaign.ledger.bindingFingerprint,
    purpose: "assertion",
    grantedStates: input.maxStates,
    partition: {
      strategy: "shared",
      frontier: `assertions-${definitionHash.slice(0, 24)}`,
      maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
    },
  });
  const semantics = scanStorySemantics(input.file);
  const remainingMs = Math.max(1, record.campaign.ledger.policy.ceilings.maxElapsedMs - allocation.ledger.spend.elapsedMs - 100);
  const guards = createResourceGuards({
    maxMemoryMb: campaignRunMemoryMb(record.campaign.ledger.policy.ceilings.maxMemoryBytes),
    maxTimeMs: remainingMs,
    startedAtMs,
  });
  const result = exploreShared(storyJson, knots, externals, {
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxStates: input.maxStates,
    seed: limits.seed,
    storySeed: limits.storySeed ?? DEFAULT_STORY_SEED,
    assertions,
    memoryGuard: guards.memoryGuard,
    timeGuard: guards.timeGuard,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    detectLoopRisks: !semantics.usesTurns && !semantics.usesRandomness && !semantics.usesVisitCounts && externals.length === 0,
    randomnessDetected: semantics.usesRandomness,
    sharedMaxPendingStates: baseConfiguration.maxFrontierStates ?? undefined,
    sharedMaxPendingBytes: baseConfiguration.maxFrontierMb === null || baseConfiguration.maxFrontierMb === undefined
      ? undefined
      : baseConfiguration.maxFrontierMb * 1024 * 1024,
  });
  classifyUnvisitedKnots(result, scanInboundDiverts(input.file));
  const configuration: EffectiveReportConfiguration = {
    search: "shared",
    executionScope: "assertion-probe",
    minRepro: false,
    strict: false,
    maxMemoryMb: null,
    maxTimeSec: null,
    maxFrontierStates: baseConfiguration.maxFrontierStates ?? null,
    maxFrontierMb: baseConfiguration.maxFrontierMb ?? null,
    goalMaxStates: 0,
    storySeed: limits.storySeed ?? DEFAULT_STORY_SEED,
    assertions,
  };
  const report = buildReportEnvelope({
    compile: compileReport,
    explore: result,
    nextRun: {
      recommendation: "investigate",
      stop: true,
      flags: { maxDepth: result.limits.maxDepth, maxStates: input.maxStates, ...(result.limits.seed === undefined ? {} : { seed: result.limits.seed }) },
      rationale: "This report is one additive assertion window from the story root, not the resumable base search.",
      expectedGain: "Inspect new assertion/runtime evidence, then explicitly choose another specialist window or continue protected broad QA.",
    },
    storyJson,
    configuration,
  });
  const assertionReport = saveReportArtifact(projectRoot, input.file, report);
  const childYield = await directedCampaignYield(projectRoot, record.campaign.ledger, result);
  const completedLedger = commitCampaignRun(allocation.ledger, {
    now: new Date().toISOString(),
    bindingFingerprint: record.campaign.ledger.bindingFingerprint,
    allocationId: allocation.allocation.id,
    consumedStates: result.statesExplored,
    peakMemoryBytes: guards.peakMemoryBytes(),
    currentDiskBytes: campaignDiskBytes(projectRoot, allocation.ledger, assertionReport.id),
    stopReason: result.truncatedBy.memory ? "memory_ceiling"
      : result.truncatedBy.time ? "time_ceiling"
        : result.truncatedBy.frontier ? "frontier_ceiling"
          : result.exhaustive ? "exhaustive" : "window_complete",
    yield: childYield,
    reportId: assertionReport.id,
    windowElapsedMs: Date.now() - startedAtMs,
  });
  const nextRevision = record.revision + 1;
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
    directedGranted: record.directedGranted + input.maxStates,
    directedStatesExplored: record.directedStatesExplored + result.statesExplored,
    campaign: persistedCampaign(completedLedger),
  };
  appendEvent(updated, {
    type: "assertions_added",
    revision: nextRevision,
    totalGranted: updated.totalGranted,
    statesExplored: updated.statesExplored,
    reportId: assertionReport.id,
    ...(updated.latestCheckpointId ? { checkpointId: updated.latestCheckpointId } : {}),
  });
  writeRecord(projectRoot, updated, record.revision);
  return {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    session: responseSession(updated),
    assertionReportId: assertionReport.id,
    assertions,
    results: result.assertionResults,
    budget: {
      directedGranted: input.maxStates,
      directedConsumed: result.statesExplored,
      campaignGranted: updated.totalGranted + updated.directedGranted,
      campaignConsumed: updated.statesExplored + updated.directedStatesExplored,
    },
    disclosure: "This explicit assertion response may include variable names and observed values plus witness paths. Ordinary inspect_search metadata remains privacy-minimal.",
    semantics: "The assertion work started at the story root and was additive. It did not resume, reduce, reorder, or mutate the exact base-search frontier.",
    nextOperation: { tool: "inspect_search", reason: "Inspect the committed revision and separate base/directed totals before choosing the next bounded operation." },
  };
}

export async function cancelSearchSession(input: CancelSearchInput): Promise<CancelSearchResponse> {
  const { projectRoot, hash, record } = loadSession(input.file, input.sessionCapability);
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  if (input.discard) {
    const target = sessionFile(projectRoot, hash);
    const current = parseRecord(fs.readFileSync(target, "utf8"), hash);
    if (current.revision !== input.revision) throw new Error("search session changed before discard; inspect it before retrying");
    fs.rmSync(target);
    syncDirectory(sessionsDirectory(projectRoot));
    return {
      schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
      inkcheckVersion: VERSION,
      discarded: true,
      recoverable: false,
      message: "Session metadata and its bearer capability were forgotten. Existing report/checkpoint artifacts keep their normal local retention lifecycle.",
    };
  }
  if (!record.recoverable) throw new Error("search session is already terminal and has no recoverable frontier");
  const nextRevision = record.revision + 1;
  const cancelledCampaign = record.campaign
    ? persistedCampaign(finishCampaignLedger(record.campaign.ledger, {
      now: new Date().toISOString(),
      bindingFingerprint: record.campaign.ledger.bindingFingerprint,
      reason: "cancelled",
      message: "campaign cancelled between result windows; the latest partial report remains available",
    }))
    : undefined;
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
    status: "cancelled",
    ...(cancelledCampaign ? { recoverable: false, latestCheckpointId: undefined, campaign: cancelledCampaign } : {}),
  };
  appendEvent(updated, {
    type: "cancelled",
    revision: nextRevision,
    totalGranted: updated.totalGranted,
    statesExplored: updated.statesExplored,
    reportId: updated.latestReportId,
    ...(updated.latestCheckpointId ? { checkpointId: updated.latestCheckpointId } : {}),
  });
  writeRecord(projectRoot, updated, record.revision);
  return sessionResponse(projectRoot, updated, {});
}

export async function replaySessionWitness(input: ReplayWitnessInput): Promise<ReplayWitnessResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.findingId)) {
    throw new Error("findingId must be a stable Inkcheck finding ID");
  }
  const replayed = await replayReportFinding(projectRoot, record.latestReportId, input.findingId);
  const nextRevision = record.revision + 1;
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
  };
  appendEvent(updated, {
    type: "replayed",
    revision: nextRevision,
    totalGranted: updated.totalGranted,
    statesExplored: updated.statesExplored,
    reportId: updated.latestReportId,
    ...(updated.latestCheckpointId ? { checkpointId: updated.latestCheckpointId } : {}),
    findingId: replayed.finding.id,
    replayStatus: replayed.replay.replayStatus,
  });
  writeRecord(projectRoot, updated, record.revision);
  return {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    session: responseSession(updated),
    reportId: updated.latestReportId,
    finding: replayed.finding,
    replay: replayed.replay,
    disclosure: "Explicit witness replay includes story transcript, choice text, and final variables. Session inspection and metadata remain privacy-minimal.",
    nextOperation: {
      tool: "inspect_search",
      reason: "Inspect the updated revision before continuing, cancelling, or replaying another finding.",
    },
  };
}

export async function pinSessionRegression(input: PinRegressionInput): Promise<PinRegressionResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.findingId)) {
    throw new Error("findingId must be a stable Inkcheck finding ID");
  }
  const pin = await createRegressionPin(
    projectRoot,
    input.file,
    record.capabilityHash,
    record.latestReportId,
    input.findingId
  );
  const nextRevision = record.revision + 1;
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
  };
  appendEvent(updated, {
    type: "regression_pinned",
    revision: nextRevision,
    totalGranted: updated.totalGranted,
    statesExplored: updated.statesExplored,
    reportId: updated.latestReportId,
    ...(updated.latestCheckpointId ? { checkpointId: updated.latestCheckpointId } : {}),
    findingId: pin.findingId,
    pinId: pin.id,
  });
  writeRecord(projectRoot, updated, record.revision);
  return {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    session: responseSession(updated),
    pin,
    nextOperation: {
      tool: "check_regression",
      reason: "After editing the story, recheck this private pin without spending the search budget again.",
    },
  };
}

export async function checkSessionRegression(input: CheckRegressionInput): Promise<CheckRegressionResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  const check = await checkRegressionPin(projectRoot, input.file, record.capabilityHash, input.pinId);
  const nextRevision = record.revision + 1;
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
  };
  appendEvent(updated, {
    type: "regression_checked",
    revision: nextRevision,
    totalGranted: updated.totalGranted,
    statesExplored: updated.statesExplored,
    reportId: updated.latestReportId,
    ...(updated.latestCheckpointId ? { checkpointId: updated.latestCheckpointId } : {}),
    pinId: check.pin.id,
    regressionStatus: check.status,
  });
  writeRecord(projectRoot, updated, record.revision);
  const fixed = check.status === "fixed";
  return {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    session: responseSession(updated),
    check,
    nextOperation: fixed
      ? { tool: "cancel_search", reason: "The pinned failure is fixed. Discard this now-stale session, then start a fresh broader search on edited source." }
      : { tool: "check_regression", reason: "The pin is not fixed. Edit the story again, then recheck this same pin without spending search states." },
  };
}
