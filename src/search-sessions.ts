import { createHash, randomBytes, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { recommendNextRun } from "./advice";
import {
  artifactProjectRoot,
  listReportFindings,
  openReportArtifact,
  replayReportFinding,
  saveReportArtifact,
  type FindingPage,
} from "./artifacts";
import { loadCheckpointForResume, saveCheckpointArtifact } from "./checkpoints";
import {
  DEFAULT_STORY_SEED,
  MAX_STORY_SEED,
  classifyUnvisitedKnots,
  exploreGoalProbe,
  exploreSharedResumable,
  validateGoalsForStory,
  type ExploreResult,
  type SharedSearchCheckpoint,
} from "./explore";
import { parseGoalDefinitions, type GoalDefinition, type GoalResult } from "./goals";
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
import {
  checkRegressionPin,
  createRegressionPin,
  type RegressionCheckResult,
  type RegressionPinSummary,
} from "./regressions";
import {
  DEFAULT_MCP_SESSION_WINDOW_STATES,
  MAX_MCP_SESSION_BYTES,
  MAX_MCP_SESSION_EVENTS,
  MAX_MCP_SESSION_FILES,
  MAX_MCP_SESSION_TOTAL_STATES,
  MAX_MCP_SESSION_WINDOW_STATES,
  SEARCH_SESSION_SCHEMA_VERSION,
} from "./search-session-contract";
import { VERSION } from "./version";

export {
  DEFAULT_MCP_SESSION_WINDOW_STATES,
  MAX_MCP_SESSION_BYTES,
  MAX_MCP_SESSION_EVENTS,
  MAX_MCP_SESSION_FILES,
  MAX_MCP_SESSION_TOTAL_STATES,
  MAX_MCP_SESSION_WINDOW_STATES,
  SEARCH_SESSION_SCHEMA_VERSION,
} from "./search-session-contract";

type SessionStatus = "paused" | "complete" | "stopped" | "cancelled";
type SessionEventType = "started" | "continued" | "cancelled" | "replayed" | "regression_pinned" | "regression_checked" | "goal_added";

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
  schemaVersion: 4;
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
    events: SearchSessionEvent[];
    droppedEventCount: number;
  };
  savedFindings: FindingPage;
  nextOperation: {
    tool: "continue_search" | "inspect_search" | "start_search";
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
}

interface FindingOptions {
  findingLimit?: number;
  findingCursor?: string;
}

export interface StartSearchInput extends SearchBindings, FindingOptions {
  file: string;
  maxStates?: number;
}

export interface InspectSearchInput extends FindingOptions {
  file: string;
  sessionCapability: string;
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
  if (sourceSchema !== 1 && sourceSchema !== 2 && sourceSchema !== 3 && sourceSchema !== SEARCH_SESSION_SCHEMA_VERSION) {
    throw new Error(`unsupported search session schema ${String(record.schemaVersion)}; use a compatible Inkcheck version or start a new session`);
  }
  if (sourceSchema !== SEARCH_SESSION_SCHEMA_VERSION) {
    record.directedGranted = 0;
    record.directedStatesExplored = 0;
    record.goalProbes = [];
  }
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
            ? sourceSchema === SEARCH_SESSION_SCHEMA_VERSION
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
      && ["started", "continued", "cancelled", "replayed", "regression_pinned", "regression_checked", "goal_added"].includes(String(item.type))
      && Number.isSafeInteger(item.revision) && (item.revision as number) >= 1
      && Number.isSafeInteger(item.totalGranted) && (item.totalGranted as number) >= 1
      && Number.isSafeInteger(item.statesExplored) && (item.statesExplored as number) >= 0
      && typeof item.reportId === "string" && /^report-[0-9a-f]{24}$/.test(item.reportId)
      && (item.checkpointId === undefined
        || (typeof item.checkpointId === "string" && /^checkpoint-[0-9a-f]{24}$/.test(item.checkpointId)))
      && validDetails;
  };
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
    || !validFindings || !Array.isArray(record.events) || !record.events.every(validEvent)
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

function findingCounts(result: ExploreResult): SearchSessionRecord["findings"] {
  return {
    endings: result.endingsFound.length,
    runtimeErrors: result.runtimeErrors.length,
    assertionViolations: result.assertionResults.reduce((sum, item) => sum + item.violations.length, 0),
    unvisitedKnots: result.unvisitedKnots.length,
  };
}

async function runWindow(
  projectRoot: string,
  file: string,
  totalGrant: number,
  bindings: SearchBindings,
  checkpoint?: SharedSearchCheckpoint
): Promise<{
  result: ExploreResult;
  reportId: string;
  checkpointId?: string;
  bindingLimit: string | null;
}> {
  const compiled = await compile(file);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`Compilation failed; run compile_story and fix ${compiled.issues.length} issue(s) before starting search`);
  }
  const { storyJson, ...compileReport } = compiled;
  const knots = scanKnots(file);
  const externals = scanExternals(file);
  const semantics = scanStorySemantics(file);
  const { memoryGuard } = createResourceGuards();
  const run = exploreSharedResumable(storyJson, knots, externals, {
    maxDepth: bindings.maxDepth,
    maxStates: totalGrant,
    seed: bindings.seed,
    storySeed: bindings.storySeed ?? DEFAULT_STORY_SEED,
    memoryGuard,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    randomnessDetected: semantics.usesRandomness,
    sharedMaxPendingStates: bindings.maxFrontierStates,
    sharedMaxPendingBytes: bindings.maxFrontierMb === undefined ? undefined : bindings.maxFrontierMb * 1024 * 1024,
  }, checkpoint);
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
  const reportReference = saveReportArtifact(projectRoot, file, report);
  const checkpointReference = run.checkpoint
    ? saveCheckpointArtifact(projectRoot, file, run.checkpoint)
    : undefined;
  return {
    result: run.result,
    reportId: reportReference.id,
    ...(checkpointReference ? { checkpointId: checkpointReference.id } : {}),
    bindingLimit: report.bindingLimit,
  };
}

function responseSession(record: SearchSessionRecord): SearchSessionResponse["session"] {
  const campaignGranted = record.totalGranted + record.directedGranted;
  const campaignConsumed = record.statesExplored + record.directedStatesExplored;
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
    goalProbes: record.goalProbes,
    events: record.events,
    droppedEventCount: record.droppedEventCount,
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
    ? { tool: "continue_search" as const, reason: "Exact frontier work remains; raise the total grant by at most 5000000 states." }
    : record.status === "complete"
      ? { tool: "inspect_search" as const, reason: "The systematic shared frontier exhausted within the granted bounds." }
      : { tool: "start_search" as const, reason: `The run stopped at ${record.bindingLimit ?? "a resource boundary"} without a recoverable frontier.` };
  return {
    schemaVersion: SEARCH_SESSION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    ...(capability ? { sessionCapability: capability } : {}),
    session: responseSession(record),
    savedFindings,
    nextOperation,
  };
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

export async function inspectSearchSession(input: InspectSearchInput): Promise<SearchSessionResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  return sessionResponse(projectRoot, record, input);
}

export async function continueSearchSession(input: ContinueSearchInput): Promise<SearchSessionResponse> {
  const loaded = loadSession(input.file, input.sessionCapability);
  const { projectRoot, record } = loaded;
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

export async function addSessionGoal(input: AddGoalInput): Promise<AddGoalResponse> {
  const { projectRoot, record } = loadSession(input.file, input.sessionCapability);
  if (record.revision !== input.revision) {
    throw new Error(`search session revision is ${record.revision}, not ${input.revision}; inspect it before retrying`);
  }
  if (!Number.isSafeInteger(input.maxStates) || input.maxStates < 1 || input.maxStates > MAX_MCP_SESSION_WINDOW_STATES) {
    throw new RangeError(`maxStates must be an integer from 1 to ${MAX_MCP_SESSION_WINDOW_STATES}`);
  }
  if (record.totalGranted + record.directedGranted + input.maxStates > MAX_MCP_SESSION_TOTAL_STATES) {
    throw new RangeError(`base plus directed grants must not exceed ${MAX_MCP_SESSION_TOTAL_STATES} states`);
  }
  const issues: string[] = [];
  const goals = parseGoalDefinitions([input.goal], "goals", issues) ?? [];
  if (issues.length || goals.length !== 1) {
    throw new RangeError(`Invalid goals:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
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
  const baseConfiguration = currentBase.report.effectiveConfiguration as {
    limits?: { maxDepth?: number; seed?: number; storySeed?: number };
    maxFrontierStates?: number | null;
    maxFrontierMb?: number | null;
  };
  const limits = baseConfiguration.limits ?? {};
  const semantics = scanStorySemantics(input.file);
  const { memoryGuard } = createResourceGuards();
  const result = exploreGoalProbe(storyJson, knots, externals, {
    maxDepth: limits.maxDepth ?? DEFAULT_MAX_DEPTH,
    seed: limits.seed,
    storySeed: limits.storySeed ?? DEFAULT_STORY_SEED,
    goalMaxStates: input.maxStates,
    goals,
    memoryGuard,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
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
  const goalHandle = `goal-${randomBytes(12).toString("hex")}`;
  const summary: GoalProbeSummary = {
    goalHandle,
    status: goalResult.status,
    reportId: goalReport.id,
    directedGranted: input.maxStates,
    directedConsumed: result.statesExplored,
  };
  const nextRevision = record.revision + 1;
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
    directedGranted: record.directedGranted + input.maxStates,
    directedStatesExplored: record.directedStatesExplored + result.statesExplored,
    goalProbes: [...record.goalProbes, summary].slice(-MAX_MCP_SESSION_EVENTS),
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
  const updated: SearchSessionRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    revision: nextRevision,
    status: "cancelled",
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
