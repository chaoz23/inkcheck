import * as fs from "fs";
import * as path from "path";
import type { HostedProgressEvent } from "./web";

export type PersistedHostedJobStatus = "queued" | "running" | "complete" | "cancelled" | "failed";

export interface PersistedHostedJob {
  schemaVersion: 1;
  id: string;
  token: string;
  createdAt: number;
  status: PersistedHostedJobStatus;
  stateBudget: number;
  sourceFingerprint: string;
  events: HostedProgressEvent[];
  nextSequence: number;
  expiresAt?: number;
}

const MAX_RECORD_BYTES = 1_048_576;
const MAX_EVENTS = 160;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const EVENT_TYPES = new Set(["queued", "run_start", "phase_start", "progress", "discovery", "phase_end", "run_end"]);
const STATUSES = new Set<PersistedHostedJobStatus>(["queued", "running", "complete", "cancelled", "failed"]);
const EVENT_STATUSES = new Set(["queued", "running", "complete", "cancelled", "failed", "error"]);
const STOP_REASONS = new Set([
  "exhaustive", "state_budget", "depth_limit", "time_limit", "memory_limit",
  "frontier_limit", "beam_width", "worker_failure", "compile_error", "cancelled",
  "error", "service_restart", "completed",
]);
const OUTCOMES = new Set(["clean", "issues_found", "review_required", "compile_error"]);
const PHASES = new Set(["compile", "source_scan", "explore", "min_repro", "report"]);
const SAFE_PASS = /^[a-z0-9:_=.-]{1,80}$/i;

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function safeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeProgressEvent(value: unknown): HostedProgressEvent {
  if (!value || typeof value !== "object") throw new Error("Hosted job event is invalid");
  const event = value as Partial<HostedProgressEvent>;
  if (
    event.schemaVersion !== 1 ||
    !safeInteger(event.sequence, 1) ||
    typeof event.type !== "string" ||
    !EVENT_TYPES.has(event.type) ||
    !safeInteger(event.elapsedMs) ||
    !safeInteger(event.statesExplored) ||
    !safeInteger(event.stateBudget, 1) ||
    typeof event.budgetFraction !== "number" ||
    !Number.isFinite(event.budgetFraction)
  ) {
    throw new Error("Hosted job event is invalid");
  }
  const discoveries = event.discoveries && typeof event.discoveries === "object"
    ? {
        endings: safeOptionalNumber(event.discoveries.endings) ?? 0,
        runtimeErrors: safeOptionalNumber(event.discoveries.runtimeErrors) ?? 0,
        knotsVisited: safeOptionalNumber(event.discoveries.knotsVisited) ?? 0,
        visibleOutcomes: safeOptionalNumber(event.discoveries.visibleOutcomes) ?? 0,
        assertionViolations: safeOptionalNumber(event.discoveries.assertionViolations) ?? 0,
        goalsReached: safeOptionalNumber(event.discoveries.goalsReached) ?? 0,
        stagesReached: safeOptionalNumber(event.discoveries.stagesReached) ?? 0,
      }
    : undefined;
  const forecast = event.forecast && typeof event.forecast === "object" &&
    ["learning", "active", "quiet"].includes(event.forecast.status) &&
    event.forecast.uncertainty === "high"
    ? {
        status: event.forecast.status,
        uncertainty: "high" as const,
        disclosure: "Discovery pace is a planning signal, not a coverage estimate.",
      }
    : undefined;
  return {
    schemaVersion: 1,
    sequence: event.sequence,
    type: event.type as HostedProgressEvent["type"],
    elapsedMs: event.elapsedMs,
    statesExplored: event.statesExplored,
    stateBudget: event.stateBudget,
    budgetFraction: Math.max(0, Math.min(1, event.budgetFraction)),
    ...(typeof event.phase === "string" && PHASES.has(event.phase)
      ? { phase: event.phase as HostedProgressEvent["phase"] }
      : {}),
    ...(typeof event.pass === "string" && SAFE_PASS.test(event.pass) ? { pass: event.pass } : {}),
    ...(safeOptionalNumber(event.endingsFound) !== undefined ? { endingsFound: event.endingsFound } : {}),
    ...(safeOptionalNumber(event.runtimeErrorsFound) !== undefined ? { runtimeErrorsFound: event.runtimeErrorsFound } : {}),
    ...(safeOptionalNumber(event.assertionViolations) !== undefined ? { assertionViolations: event.assertionViolations } : {}),
    ...(safeOptionalNumber(event.unvisitedKnots) !== undefined ? { unvisitedKnots: event.unvisitedKnots } : {}),
    ...(safeOptionalNumber(event.knotsVisited) !== undefined ? { knotsVisited: event.knotsVisited } : {}),
    ...(safeOptionalNumber(event.visibleOutcomes) !== undefined ? { visibleOutcomes: event.visibleOutcomes } : {}),
    ...(safeOptionalNumber(event.goalsReached) !== undefined ? { goalsReached: event.goalsReached } : {}),
    ...(safeOptionalNumber(event.stagesReached) !== undefined ? { stagesReached: event.stagesReached } : {}),
    ...(safeOptionalNumber(event.meaningfulYield) !== undefined ? { meaningfulYield: event.meaningfulYield } : {}),
    ...(event.statesSinceLastYield === null || safeOptionalNumber(event.statesSinceLastYield) !== undefined
      ? { statesSinceLastYield: event.statesSinceLastYield }
      : {}),
    ...(discoveries ? { discoveries } : {}),
    ...(forecast ? { forecast } : {}),
    ...(typeof event.status === "string" && EVENT_STATUSES.has(event.status) ? { status: event.status as HostedProgressEvent["status"] } : {}),
    ...(typeof event.stopReason === "string" && STOP_REASONS.has(event.stopReason) ? { stopReason: event.stopReason } : {}),
    ...(typeof event.outcome === "string" && OUTCOMES.has(event.outcome) ? { outcome: event.outcome } : {}),
  };
}

function validateRecord(value: unknown): PersistedHostedJob {
  if (!value || typeof value !== "object") throw new Error("Hosted job record is invalid");
  const record = value as Partial<PersistedHostedJob>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.id !== "string" ||
    !UUID.test(record.id) ||
    typeof record.token !== "string" ||
    !UUID.test(record.token) ||
    !safeInteger(record.createdAt) ||
    typeof record.status !== "string" ||
    !STATUSES.has(record.status) ||
    !safeInteger(record.stateBudget, 1) ||
    typeof record.sourceFingerprint !== "string" ||
    !SHA256.test(record.sourceFingerprint) ||
    !Array.isArray(record.events) ||
    record.events.length > MAX_EVENTS ||
    !safeInteger(record.nextSequence) ||
    (record.expiresAt !== undefined && !safeInteger(record.expiresAt))
  ) {
    throw new Error("Hosted job record is invalid");
  }
  const events = record.events.map(safeProgressEvent);
  if (events.some((event, index) => index > 0 && event.sequence <= events[index - 1].sequence)) {
    throw new Error("Hosted job events are out of order");
  }
  if (events.length > 0 && record.nextSequence < events[events.length - 1].sequence) {
    throw new Error("Hosted job sequence is invalid");
  }
  if (["complete", "cancelled", "failed"].includes(record.status) && record.expiresAt === undefined) {
    throw new Error("Terminal hosted job is missing its expiration");
  }
  return {
    schemaVersion: 1,
    id: record.id,
    token: record.token,
    createdAt: record.createdAt,
    status: record.status,
    stateBudget: record.stateBudget,
    sourceFingerprint: record.sourceFingerprint,
    events,
    nextSequence: record.nextSequence,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

export class FileHostedJobStore {
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  load(now = Date.now()): PersistedHostedJob[] {
    const records: PersistedHostedJob[] = [];
    for (const name of fs.readdirSync(this.directory).sort()) {
      if (name.endsWith(".tmp")) {
        fs.rmSync(path.join(this.directory, name), { force: true });
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.directory, name);
      try {
        if (fs.statSync(file).size > MAX_RECORD_BYTES) throw new Error("Hosted job record is too large");
        const record = validateRecord(JSON.parse(fs.readFileSync(file, "utf8")));
        if (`${record.id}.json` !== name || (record.expiresAt !== undefined && record.expiresAt <= now)) {
          fs.rmSync(file, { force: true });
          continue;
        }
        records.push(record);
      } catch {
        fs.rmSync(file, { force: true });
      }
    }
    return records;
  }

  save(record: PersistedHostedJob): void {
    const safe = validateRecord(record);
    const serialized = `${JSON.stringify(safe)}\n`;
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
      throw new Error("Hosted job record exceeds its storage limit");
    }
    const file = path.join(this.directory, `${safe.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  remove(id: string): void {
    if (!UUID.test(id)) return;
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true });
  }
}
