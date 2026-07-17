#!/usr/bin/env node
import { spawn, ChildProcess } from "child_process";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import * as fs from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import * as os from "os";
import * as path from "path";
import { VERSION } from "./version";
import { BrowserUsageEvent, FileUsageStore, UsageRecorder } from "./usage";
import { buildHumanFindings, HumanFinding } from "./human-report";
import { FileHostedJobStore, PersistedHostedJob } from "./hosted-job-store";
import type { ProgressOutcome, ProgressStopReason } from "./terminal-progress";
import {
  HostedLimits,
  HostedSubmission,
  LIMIT_HIT_MESSAGE,
  TIME_LIMIT_MESSAGE,
  SubmissionError,
  validateSubmission,
} from "./web-validation";

export interface WebConfig extends HostedLimits {
  host: string;
  port: number;
  concurrency: number;
  /** Per-job portfolio worker ceiling, independent of hosted job concurrency. */
  portfolioConcurrency: number;
  timeoutMs: number;
  maxReportBytes: number;
  rateLimit: number;
  globalRateLimit: number;
  rateWindowMs: number;
  accessCode?: string;
  allowedOrigins: string[];
  trustProxy: boolean;
  staticDir: string;
  usageFile?: string;
  jobStoreDir?: string;
  jobTtlMs: number;
}

export interface HostedCheckResponse {
  report: unknown;
  humanFindings?: HumanFinding[];
  resultWindow?: HostedResultWindow;
  meta: {
    durationMs: number;
    uploadedFiles: number;
    uploadedBytes: number;
    retained: false;
    runIntent?: HostedSubmission["runIntent"];
    coverageLimitHit?: boolean;
  };
}

export interface HostedResultWindow {
  schemaVersion: 1;
  id: string;
  sourceFingerprint: unknown;
  trigger: "compile_error" | "actionable_evidence" | "review_interval" | "exhaustive" | "deadline" | "resource_ceiling" | "cancelled";
  searchContinuing: false;
  work: { statesExplored: number; stateCeiling: number; elapsedMs: number };
  yield: { meaningfulFindings: number; compileErrors: number; runtimeErrors: number; assertionViolations: number; endings: number };
  stableFindingIds: string[];
  omittedFindingCount: number;
  uncertainty: "bounded_partial" | "exhaustive";
}

export interface HostedProgressEvent {
  schemaVersion: 1;
  sequence: number;
  type: "queued" | "run_start" | "phase_start" | "progress" | "discovery" | "phase_end" | "run_end";
  phase?: "compile" | "source_scan" | "explore" | "min_repro" | "report";
  pass?: string;
  elapsedMs: number;
  statesExplored: number;
  stateBudget: number;
  budgetFraction: number;
  endingsFound?: number;
  runtimeErrorsFound?: number;
  assertionViolations?: number;
  unvisitedKnots?: number;
  knotsVisited?: number;
  visibleOutcomes?: number;
  goalsReached?: number;
  stagesReached?: number;
  discoveries?: {
    endings: number;
    runtimeErrors: number;
    knotsVisited: number;
    visibleOutcomes: number;
    assertionViolations: number;
    goalsReached: number;
    stagesReached: number;
  };
  meaningfulYield?: number;
  statesSinceLastYield?: number | null;
  forecast?: {
    status: "learning" | "active" | "quiet";
    uncertainty: "high";
    disclosure: string;
  };
  status?: "queued" | "running" | "complete" | "cancelled" | "failed" | "error";
  stopReason?: ProgressStopReason;
  outcome?: ProgressOutcome;
}

export interface SubmissionRunOptions {
  onProgress?: (event: HostedProgressEvent) => void;
  signal?: AbortSignal;
}

export type SubmissionRunner = (
  submission: HostedSubmission,
  config: WebConfig,
  options?: SubmissionRunOptions
) => Promise<HostedCheckResponse>;

async function removeJobDirectory(jobDir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 50 || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function allowedOriginsFromEnv(): string[] {
  const raw = process.env.INKCHECK_WEB_ALLOWED_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const value = entry.trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("INKCHECK_WEB_ALLOWED_ORIGINS must contain comma-separated http(s) origins");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== value ||
      url.username ||
      url.password ||
      value === "*"
    ) {
      throw new Error("INKCHECK_WEB_ALLOWED_ORIGINS must contain exact http(s) origins without paths");
    }
    return url.origin;
  });
}

export function webConfigFromEnv(): WebConfig {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: integerEnv("PORT", 8080, 1, 65535),
    concurrency: integerEnv("INKCHECK_WEB_CONCURRENCY", 1, 1, 4),
    portfolioConcurrency: integerEnv("INKCHECK_WEB_PORTFOLIO_CONCURRENCY", 1, 1, 4),
    timeoutMs: integerEnv("INKCHECK_WEB_TIMEOUT_MS", 300_000, 1_000, 900_000),
    maxBodyBytes: integerEnv("INKCHECK_WEB_MAX_BODY_BYTES", 5_242_880, 1_024, 20_971_520),
    maxFiles: integerEnv("INKCHECK_WEB_MAX_FILES", 200, 1, 500),
    maxFileBytes: integerEnv("INKCHECK_WEB_MAX_FILE_BYTES", 2_621_440, 1_024, 10_485_760),
    maxDepth: integerEnv("INKCHECK_WEB_MAX_DEPTH", 100, 1, 2_000),
    maxStates: integerEnv("INKCHECK_WEB_MAX_STATES", 1_000_000, 1, 1_000_000),
    maxReportBytes: integerEnv("INKCHECK_WEB_MAX_REPORT_BYTES", 83_886_080, 65_536, 209_715_200),
    rateLimit: integerEnv("INKCHECK_WEB_RATE_LIMIT", 10, 1, 1_000),
    globalRateLimit: integerEnv("INKCHECK_WEB_GLOBAL_RATE_LIMIT", 60, 1, 10_000),
    rateWindowMs: integerEnv("INKCHECK_WEB_RATE_WINDOW_MS", 3_600_000, 1_000, 86_400_000),
    accessCode: process.env.INKCHECK_WEB_ACCESS_CODE || undefined,
    allowedOrigins: allowedOriginsFromEnv(),
    trustProxy: process.env.INKCHECK_WEB_TRUST_PROXY === "1",
    staticDir: process.env.INKCHECK_WEB_STATIC_DIR ?? path.join(__dirname, "..", "web"),
    usageFile: process.env.INKCHECK_WEB_USAGE_FILE || undefined,
    jobStoreDir: process.env.INKCHECK_WEB_JOB_STORE_DIR || undefined,
    jobTtlMs: integerEnv("INKCHECK_WEB_JOB_TTL_MS", 900_000, 60_000, 3_600_000),
  };
}

/**
 * Wall-clock seconds handed to the CLI's own `--max-time`, kept below the hard
 * SIGKILL deadline so the CLI can stop cleanly, finish min_repro, serialize the
 * report, and flush stdout before the kill fires. A fixed 10s margin was too
 * tight: on a loaded host the report (which can be several MB) did not flush in
 * time, so the hard timer fired first and the partial report the engine had
 * already computed was discarded with a misleading "story too detailed" error
 * (#71). Reserve 15% of the budget, and never less than 30s.
 */
export function gracefulTimeoutSeconds(timeoutMs: number): number {
  const totalSeconds = timeoutMs / 1000;
  const margin = Math.max(30, totalSeconds * 0.15);
  return Math.max(1, Math.floor(totalSeconds - margin));
}

function hostedIntentTimeoutSeconds(submission: HostedSubmission, timeoutMs: number): number {
  const graceful = gracefulTimeoutSeconds(timeoutMs);
  return submission.runIntent === "quick" ? Math.min(60, graceful) : graceful;
}

function numberArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hostedResultWindow(
  report: unknown,
  findings: HumanFinding[],
  submission: HostedSubmission,
  elapsedMs: number
): HostedResultWindow {
  const envelope = report && typeof report === "object" ? report as Record<string, unknown> : {};
  const explore = envelope.explore && typeof envelope.explore === "object"
    ? envelope.explore as Record<string, unknown>
    : {};
  const runtimeErrors = numberArray(explore.runtimeErrors).length;
  const endings = numberArray(explore.endingsFound).length;
  const assertionResults = numberArray(explore.assertionResults);
  const assertionViolations = assertionResults.filter((value) =>
    value && typeof value === "object" && (value as { status?: unknown }).status === "violated"
  ).length;
  const compile = envelope.compile && typeof envelope.compile === "object"
    ? envelope.compile as Record<string, unknown>
    : {};
  const compileErrors = typeof compile.errors === "number" ? compile.errors : 0;
  const exhaustive = explore.exhaustive === true;
  const truncatedBy = explore.truncatedBy && typeof explore.truncatedBy === "object"
    ? explore.truncatedBy as Record<string, unknown>
    : {};
  const trigger: HostedResultWindow["trigger"] = compileErrors > 0
    ? "compile_error"
    : runtimeErrors + assertionViolations > 0
      ? "actionable_evidence"
    : exhaustive
      ? "exhaustive"
      : truncatedBy.time === true
        ? "deadline"
        : explore.truncated === true
          ? "resource_ceiling"
          : "review_interval";
  const keyed = findings.map((finding) => ({
    id: `finding-${createHash("sha256").update(JSON.stringify(finding)).digest("hex").slice(0, 24)}`,
    finding,
  }));
  const stableFindingIds = keyed.slice(0, 100).map((item) => item.id);
  const sourceFingerprint = envelope.storyFingerprint ?? null;
  const statesExplored = typeof explore.statesExplored === "number" ? explore.statesExplored : 0;
  return {
    schemaVersion: 1,
    id: `window-${createHash("sha256").update(JSON.stringify({ sourceFingerprint, statesExplored, stableFindingIds })).digest("hex").slice(0, 24)}`,
    sourceFingerprint,
    trigger,
    searchContinuing: false,
    work: { statesExplored, stateCeiling: submission.maxStates, elapsedMs },
    yield: {
      meaningfulFindings: compileErrors + runtimeErrors + assertionViolations,
      compileErrors,
      runtimeErrors,
      assertionViolations,
      endings,
    },
    stableFindingIds,
    omittedFindingCount: Math.max(0, keyed.length - stableFindingIds.length),
    uncertainty: exhaustive ? "exhaustive" : "bounded_partial",
  };
}

function submissionSourceFingerprint(submission: HostedSubmission): string {
  const root = submission.files.find((file) => file.name === submission.root);
  return createHash("sha256").update(root?.content ?? "").digest("hex");
}

function cancelledResultWindow(
  sourceFingerprintValue: string,
  stateCeiling: number,
  event: HostedProgressEvent
): HostedResultWindow {
  const sourceFingerprint = {
    algorithm: "sha256" as const,
    source: "entry-source" as const,
    value: sourceFingerprintValue,
  };
  const runtimeErrors = event.runtimeErrorsFound ?? 0;
  const assertionViolations = event.assertionViolations ?? 0;
  const endings = event.endingsFound ?? 0;
  const omittedFindingCount = runtimeErrors + assertionViolations + (event.unvisitedKnots ?? 0);
  return {
    schemaVersion: 1,
    id: `window-${createHash("sha256").update(JSON.stringify({ sourceFingerprint, statesExplored: event.statesExplored, trigger: "cancelled" })).digest("hex").slice(0, 24)}`,
    sourceFingerprint,
    trigger: "cancelled",
    searchContinuing: false,
    work: { statesExplored: event.statesExplored, stateCeiling, elapsedMs: event.elapsedMs },
    yield: {
      meaningfulFindings: runtimeErrors + assertionViolations,
      compileErrors: 0,
      runtimeErrors,
      assertionViolations,
      endings,
    },
    stableFindingIds: [],
    omittedFindingCount,
    uncertainty: "bounded_partial",
  };
}

function stopProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function scrubPaths(value: unknown, jobDir: string): unknown {
  if (typeof value === "string") {
    return value.split(jobDir).join("[uploaded-story]");
  }
  if (Array.isArray(value)) return value.map((item) => scrubPaths(item, jobDir));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        scrubPaths(item, jobDir),
      ])
    );
  }
  return value;
}

function childEnvironment(jobDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? jobDir,
    TMPDIR: jobDir,
    PATH: process.env.PATH,
    INKLECATE_PATH: process.env.INKLECATE_PATH,
    NODE_ENV: "production",
  };
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot;
    env.ComSpec = process.env.ComSpec;
    env.PATHEXT = process.env.PATHEXT;
  }
  return env;
}

export async function runSubmission(
  submission: HostedSubmission,
  config: WebConfig,
  options: SubmissionRunOptions = {}
): Promise<HostedCheckResponse> {
  const started = Date.now();
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-web-"));
  fs.chmodSync(jobDir, 0o700);
  try {
    for (const file of submission.files) {
      const destination = path.join(jobDir, ...file.name.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, file.content, { encoding: "utf8", mode: 0o600 });
    }
    if (submission.assertions?.length) {
      // JSON is valid YAML. This private, temporary project config reuses the
      // CLI's existing typed-rule validation and report contract, then leaves
      // with the uploaded files in the finally block below.
      fs.writeFileSync(
        path.join(jobDir, "inkcheck.yml"),
        JSON.stringify({ schemaVersion: 1, entrypoint: submission.root, assertions: submission.assertions }),
        { encoding: "utf8", mode: 0o600 }
      );
    }
    const root = path.join(jobDir, ...submission.root.split("/"));
    const cli = path.join(__dirname, "cli.js");
    // Give the CLI a wall-clock budget a bit under the hard SIGKILL deadline so
    // it stops cleanly and prints a partial report (truncatedBy.time) before the
    // backstop kill fires; the kill only ever triggers for a genuinely wedged run.
    const gracefulSeconds = hostedIntentTimeoutSeconds(submission, config.timeoutMs);
    const args = [
      "--max-old-space-size=768",
      cli,
      root,
      "--json",
      "--progress=ndjson",
      "--max-depth",
      String(submission.maxDepth),
      "--max-states",
      String(submission.maxStates),
      "--concurrency",
      String(config.portfolioConcurrency),
      "--max-time",
      String(gracefulSeconds),
    ];

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: jobDir,
        env: childEnvironment(jobDir),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let progressBuffer = "";
      let finished = false;

      const finish = (error?: Error, text?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(text ?? "");
      };
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>
      ): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > config.maxReportBytes) {
          stopProcessTree(child);
          finish(new SubmissionError(LIMIT_HIT_MESSAGE, 413, "limit_hit"));
        }
        return next;
      };
      child.stdout?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
        if (!finished) stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer<ArrayBufferLike>) => {
        if (finished) return;
        stderr = append(stderr, chunk);
        progressBuffer += chunk.toString("utf8");
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as HostedProgressEvent;
            if (event.schemaVersion === 1 && typeof event.type === "string") options.onProgress?.(event);
          } catch {
            // Keep non-progress stderr available for a concise failure message.
          }
        }
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (finished) return;
        if (code === 0 || code === 1) finish(undefined, stdout.toString("utf8"));
        else {
          const detail = stderr
            .toString("utf8")
            .split(jobDir)
            .join("[uploaded-story]")
            .trim()
            .slice(0, 600);
          finish(
            new SubmissionError(
              detail ? `Inkcheck could not process this story: ${detail}` : "Inkcheck could not process this story",
              422
            )
          );
        }
      });
      const timer = setTimeout(() => {
        // The CLI's own --max-time should have stopped it and flushed a partial
        // report well before this. Reaching here means a genuinely wedged run:
        // kill it and say so honestly, without blaming the story's size.
        stopProcessTree(child);
        finish(new SubmissionError(TIME_LIMIT_MESSAGE, 504, "limit_hit"));
      }, config.timeoutMs);
      timer.unref();
      const cancel = () => {
        stopProcessTree(child);
        finish(new SubmissionError("This check was cancelled", 499));
      };
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener("abort", cancel, { once: true });
    });

    let report: unknown;
    try {
      report = scrubPaths(JSON.parse(output), jobDir);
    } catch {
      throw new SubmissionError("Inkcheck returned an unreadable report", 500);
    }
    const coverageLimitHit =
      report &&
      typeof report === "object" &&
      "explore" in report &&
      (report as { explore?: { truncated?: unknown } }).explore?.truncated === true;
    const humanFindings = buildHumanFindings(report as Parameters<typeof buildHumanFindings>[0], {
      audience: "hosted",
    });
    const durationMs = Date.now() - started;
    return {
      report,
      humanFindings,
      resultWindow: hostedResultWindow(report, humanFindings, submission, durationMs),
      meta: {
        durationMs,
        uploadedFiles: submission.files.length,
        uploadedBytes: submission.files.reduce((sum, file) => sum + file.bytes, 0),
        retained: false,
        runIntent: submission.runIntent,
        ...(coverageLimitHit ? { coverageLimitHit: true } : {}),
      },
    };
  } finally {
    // Windows can briefly retain a child process handle after `close`, making
    // immediate recursive deletion fail with EBUSY/EPERM. A bounded explicit
    // retry keeps the no-retention guarantee across Node and OS versions.
    await removeJobDirectory(jobDir);
  }
}

class RateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  take(key: string): boolean {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + this.windowMs };
    if (entry.count >= this.limit) return false;
    entry.count++;
    this.entries.set(key, entry);
    if (this.entries.size > 10_000) {
      for (const [storedKey, stored] of this.entries) {
        if (stored.resetAt <= now) this.entries.delete(storedKey);
      }
    }
    return true;
  }
}

type HostedJobStatus = "queued" | "running" | "complete" | "cancelled" | "failed";

interface HostedJob {
  id: string;
  token: string;
  createdAt: number;
  status: HostedJobStatus;
  events: HostedProgressEvent[];
  nextSequence: number;
  controller: AbortController;
  stateBudget: number;
  sourceFingerprint: string;
  submission?: HostedSubmission;
  result?: HostedCheckResponse;
  error?: string;
  expiresAt?: number;
}

class HostedJobManager {
  private readonly jobs = new Map<string, HostedJob>();
  private active = 0;
  private readonly store?: FileHostedJobStore;

  constructor(
    private readonly config: WebConfig,
    private readonly runner: SubmissionRunner,
    private readonly onComplete: (job: HostedJob) => void
  ) {
    if (!config.jobStoreDir) return;
    this.store = new FileHostedJobStore(config.jobStoreDir);
    for (const record of this.store.load()) {
      const job: HostedJob = {
        id: record.id,
        token: record.token,
        createdAt: record.createdAt,
        status: record.status,
        events: record.events,
        nextSequence: record.nextSequence,
        controller: new AbortController(),
        stateBudget: record.stateBudget,
        sourceFingerprint: record.sourceFingerprint,
        expiresAt: record.expiresAt,
      };
      this.jobs.set(job.id, job);
      if (["queued", "running", "complete"].includes(job.status)) {
        const completedBeforeRestart = job.status === "complete";
        job.status = "failed";
        job.error = completedBeforeRestart
          ? "This check completed before the service restarted, but reports are never retained. Run the check again."
          : "The hosted service restarted before this check completed. Run the check again.";
        job.expiresAt = Date.now() + config.jobTtlMs;
        this.emit(job, { type: "run_end", status: "failed", stopReason: "service_restart" });
      } else if (job.status === "failed") {
        job.error = "This check did not complete. Run the check again.";
      }
    }
  }

  create(submission: HostedSubmission): HostedJob {
    const job: HostedJob = {
      id: randomUUID(),
      token: randomUUID(),
      createdAt: Date.now(),
      status: "queued",
      events: [],
      nextSequence: 0,
      controller: new AbortController(),
      stateBudget: submission.maxStates,
      sourceFingerprint: submissionSourceFingerprint(submission),
      submission,
    };
    this.jobs.set(job.id, job);
    this.emit(job, { type: "queued", status: "queued" });
    void this.pump();
    return job;
  }

  get(id: string, token: string | null): HostedJob | undefined {
    this.cleanup();
    const job = this.jobs.get(id);
    return job && token === job.token ? job : undefined;
  }

  cancel(job: HostedJob): boolean {
    if (job.status === "complete" || job.status === "cancelled" || job.status === "failed") return false;
    job.status = "cancelled";
    job.controller.abort();
    job.submission = undefined;
    job.expiresAt = Date.now() + this.config.jobTtlMs;
    this.emit(job, { type: "run_end", status: "cancelled", stopReason: "cancelled" });
    return true;
  }

  snapshot(job: HostedJob): Record<string, unknown> {
    const latest = job.events[job.events.length - 1];
    return {
      job: {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        ...(latest ? { progress: latest } : {}),
        ...(job.result ? { result: job.result } : {}),
        ...(job.status === "cancelled" && latest
          ? { resultWindow: cancelledResultWindow(job.sourceFingerprint, job.stateBudget, latest) }
          : {}),
        ...(job.error ? { error: job.error } : {}),
      },
    };
  }

  eventsAfter(job: HostedJob, sequence: number): HostedProgressEvent[] {
    return job.events.filter((event) => event.sequence > sequence);
  }

  private emit(job: HostedJob, patch: Omit<HostedProgressEvent, "schemaVersion" | "sequence" | "elapsedMs" | "statesExplored" | "stateBudget" | "budgetFraction"> & Partial<HostedProgressEvent>): void {
    const previous = job.events[job.events.length - 1];
    const statesExplored = patch.statesExplored ?? previous?.statesExplored ?? 0;
    const meaningfulYield = (patch.endingsFound ?? previous?.endingsFound ?? 0)
      + (patch.runtimeErrorsFound ?? previous?.runtimeErrorsFound ?? 0)
      + (patch.assertionViolations ?? previous?.assertionViolations ?? 0);
    const previousYield = previous?.meaningfulYield ?? 0;
    const statesSinceLastYield = meaningfulYield > previousYield
      ? 0
      : previous?.statesSinceLastYield === null || previous?.statesSinceLastYield === undefined
        ? statesExplored
        : previous.statesSinceLastYield + Math.max(0, statesExplored - (previous.statesExplored ?? 0));
    const forecastStatus = statesExplored === 0
      ? "learning"
      : meaningfulYield > previousYield
        ? "active"
        : statesSinceLastYield > Math.max(10_000, job.stateBudget * 0.1)
          ? "quiet"
          : "learning";
    const event: HostedProgressEvent = {
      ...patch,
      schemaVersion: 1,
      sequence: ++job.nextSequence,
      elapsedMs: patch.elapsedMs ?? Date.now() - job.createdAt,
      statesExplored,
      stateBudget: patch.stateBudget ?? previous?.stateBudget ?? job.stateBudget,
      budgetFraction: patch.budgetFraction ?? previous?.budgetFraction ?? 0,
      endingsFound: patch.endingsFound ?? previous?.endingsFound,
      runtimeErrorsFound: patch.runtimeErrorsFound ?? previous?.runtimeErrorsFound,
      assertionViolations: patch.assertionViolations ?? previous?.assertionViolations,
      unvisitedKnots: patch.unvisitedKnots ?? previous?.unvisitedKnots,
      knotsVisited: patch.knotsVisited ?? previous?.knotsVisited,
      visibleOutcomes: patch.visibleOutcomes ?? previous?.visibleOutcomes,
      goalsReached: patch.goalsReached ?? previous?.goalsReached,
      stagesReached: patch.stagesReached ?? previous?.stagesReached,
      stopReason: patch.stopReason ?? previous?.stopReason,
      outcome: patch.outcome ?? previous?.outcome,
      meaningfulYield,
      statesSinceLastYield,
      forecast: {
        status: forecastStatus,
        uncertainty: "high",
        disclosure: "Discovery pace is a planning signal, not a coverage estimate.",
      },
    } as HostedProgressEvent;
    job.events.push(event);
    if (job.events.length > 160) job.events.shift();
    this.persist(job);
  }

  private async pump(): Promise<void> {
    while (this.active < this.config.concurrency) {
      const job = [...this.jobs.values()].find((candidate) => candidate.status === "queued");
      if (!job) return;
      this.active++;
      job.status = "running";
      this.emit(job, { type: "run_start", status: "running" });
      void this.run(job).finally(() => {
        this.active--;
        void this.pump();
      });
    }
  }

  private async run(job: HostedJob): Promise<void> {
    try {
      const submission = job.submission;
      if (!submission) throw new Error("Persisted jobs cannot restart source processing");
      const result = await this.runner(submission, this.config, {
        signal: job.controller.signal,
        onProgress: (event) => this.emit(job, { ...event, status: "running" }),
      });
      if (job.status === "cancelled") return;
      job.result = result;
      job.status = "complete";
      job.expiresAt = Date.now() + this.config.jobTtlMs;
      this.emit(job, {
        type: "run_end",
        status: "complete",
        stopReason: job.events.at(-1)?.stopReason ?? "completed",
      });
      this.onComplete(job);
    } catch (error) {
      if (job.status !== "cancelled") {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : "Unexpected service error";
        job.expiresAt = Date.now() + this.config.jobTtlMs;
        this.emit(job, { type: "run_end", status: "failed", stopReason: "error" });
      }
    } finally {
      job.submission = undefined;
      if (job.expiresAt === undefined) {
        job.expiresAt = Date.now() + this.config.jobTtlMs;
        this.persist(job);
      }
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt && job.expiresAt <= now) {
        this.jobs.delete(id);
        this.store?.remove(id);
      }
    }
  }

  private persist(job: HostedJob): void {
    if (!this.store) return;
    const record: PersistedHostedJob = {
      schemaVersion: 1,
      id: job.id,
      token: job.token,
      createdAt: job.createdAt,
      status: job.status,
      stateBudget: job.stateBudget,
      sourceFingerprint: job.sourceFingerprint,
      events: job.events,
      nextSequence: job.nextSequence,
      ...(job.expiresAt === undefined ? {} : { expiresAt: job.expiresAt }),
    };
    try {
      this.store.save(record);
    } catch {
      console.warn(JSON.stringify({ event: "hosted_job_persist_failed", jobId: job.id }));
    }
  }
}

function requestIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first?.trim()) return first.trim().slice(0, 80);
  }
  return req.socket.remoteAddress ?? "unknown";
}

function validAccessCode(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return true;
  const provided = req.headers["x-inkcheck-access-code"];
  if (typeof provided !== "string") return false;
  const actualBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function readRequestBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw new SubmissionError(LIMIT_HIT_MESSAGE, 413, "limit_hit");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > limit) throw new SubmissionError(LIMIT_HIT_MESSAGE, 413, "limit_hit");
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

async function readMultipart(req: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new SubmissionError("Content-Type must be multipart/form-data", 415);
  }
  const body = await readRequestBody(req, limit);
  return parseMultipartBody(contentType, body);
}

async function readBrowserUsageEvent(req: IncomingMessage): Promise<BrowserUsageEvent> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new SubmissionError("Content-Type must be application/json", 415);
  }
  const body = await readRequestBody(req, 256);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new SubmissionError("Usage event must be valid JSON", 400);
  }
  const event = value && typeof value === "object"
    ? (value as { event?: unknown }).event
    : undefined;
  if (event !== "page_view" && event !== "support_click") {
    throw new SubmissionError("Usage event is not supported", 400);
  }
  return event;
}

export async function parseMultipartBody(contentType: string, body: Buffer): Promise<unknown> {
  try {
    const form = await new Request("http://localhost/api/check", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    }).formData();
    const fields = new Map<string, string>();
    const files: Record<string, string> = {};
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const [key, value] of form.entries()) {
      if (key.startsWith("ink:")) {
        const name = key.slice(4);
        if (typeof value === "string") {
          throw new SubmissionError(`Uploaded story part must be a file: ${name}`);
        }
        if (Object.hasOwn(files, name)) throw new SubmissionError(`Duplicate file path: ${name}`);
        files[name] = decoder.decode(await value.arrayBuffer());
      } else if (typeof value === "string") {
        fields.set(key, value);
      }
    }
    const optionalNumber = (name: string): number | undefined => {
      const value = fields.get(name);
      return value === undefined || value === "" ? undefined : Number(value);
    };
    let assertions: unknown;
    const rawAssertions = fields.get("assertions");
    if (rawAssertions !== undefined && rawAssertions !== "") {
      try {
        assertions = JSON.parse(rawAssertions);
      } catch {
        throw new SubmissionError("Story rules could not be read", 422);
      }
    }
    return {
      root: fields.get("root"),
      files,
      ...(assertions !== undefined ? { assertions } : {}),
      runIntent: fields.get("runIntent"),
      maxDepth: optionalNumber("maxDepth"),
      maxStates: optionalNumber("maxStates"),
      authorized: fields.get("authorized") === "true",
      privacyAcknowledged: fields.get("privacyAcknowledged") === "true",
    };
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError("The uploaded form could not be read; select the original .ink files and try again");
  }
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

export function applyBrowserOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: readonly string[]
): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) {
    throw new SubmissionError("This browser origin is not allowed to use the checker", 403);
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inkcheck-Access-Code, X-Inkcheck-Async");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  securityHeaders(res);
  res.statusCode = 204;
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

function sendSse(res: ServerResponse, event: HostedProgressEvent): void {
  res.write(`id: ${event.sequence}\n`);
  res.write("event: progress\n");
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function sendAsset(res: ServerResponse, file: string, contentType: string): void {
  securityHeaders(res);
  try {
    const data = fs.readFileSync(file);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", contentType.startsWith("text/html") ? "no-store" : "public, max-age=300");
    res.end(data);
  } catch {
    sendJson(res, 500, { error: "Web assets are unavailable" });
  }
}

export function createInkcheckWebServer(options: {
  config?: WebConfig;
  runner?: SubmissionRunner;
  usage?: UsageRecorder;
} = {}): Server {
  const config = options.config ?? webConfigFromEnv();
  const runner = options.runner ?? runSubmission;
  const usage = options.usage ?? (config.usageFile ? new FileUsageStore(config.usageFile) : undefined);
  const limiter = new RateLimiter(config.rateLimit, config.rateWindowMs);
  const globalLimiter = new RateLimiter(config.globalRateLimit, config.rateWindowMs);
  const browserEventLimiter = new RateLimiter(120, config.rateWindowMs);

  const recordUsage = (event: Parameters<UsageRecorder["record"]>[0], details?: { durationMs?: number }) => {
    try {
      usage?.record(event, details);
    } catch {
      console.warn(JSON.stringify({ event: "usage_write_failed" }));
    }
  };
  const jobs = new HostedJobManager(config, runner, (job) => {
    const result = job.result!;
    console.log(JSON.stringify({
      event: "check_complete",
      jobId: job.id,
      files: result.meta.uploadedFiles,
      bytes: result.meta.uploadedBytes,
      durationMs: result.meta.durationMs,
      coverageLimitHit: result.meta.coverageLimitHit === true,
    }));
    recordUsage("check_complete", { durationMs: result.meta.durationMs });
    if (result.meta.coverageLimitHit === true) {
      console.warn(JSON.stringify({ event: "check_limit_hit", jobId: job.id, status: 200 }));
      recordUsage("check_limit_hit");
    }
  });

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    let pathname = "";
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      pathname = url.pathname;
      if (url.pathname === "/api/check" || url.pathname === "/api/event" || url.pathname.startsWith("/api/jobs/")) {
        applyBrowserOrigin(req, res, config.allowedOrigins);
        if (req.method === "OPTIONS") {
          sendNoContent(res);
          return;
        }
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, version: VERSION });
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        sendAsset(res, path.join(config.staticDir, "index.html"), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        sendAsset(res, path.join(config.staticDir, "app.js"), "text/javascript; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/style.css") {
        sendAsset(res, path.join(config.staticDir, "style.css"), "text/css; charset=utf-8");
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/event") {
        if (!browserEventLimiter.take(requestIp(req, config.trustProxy))) {
          sendNoContent(res);
          return;
        }
        recordUsage(await readBrowserUsageEvent(req));
        sendNoContent(res);
        return;
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(events|cancel))?$/i);
      if (jobMatch) {
        const [, id, action] = jobMatch;
        const job = jobs.get(id, url.searchParams.get("token"));
        if (!job) throw new SubmissionError("This check is unavailable or has expired", 404);
        if (req.method === "GET" && !action) {
          sendJson(res, 200, jobs.snapshot(job));
          return;
        }
        if (req.method === "POST" && action === "cancel") {
          const cancelled = jobs.cancel(job);
          sendJson(res, cancelled ? 202 : 409, jobs.snapshot(job));
          return;
        }
        if (req.method === "GET" && action === "events") {
          securityHeaders(res);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders();
          const last = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
          let lastSequence = Number.isSafeInteger(last) ? last : 0;
          for (const event of jobs.eventsAfter(job, lastSequence)) {
            lastSequence = event.sequence;
            sendSse(res, event);
          }
          const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
          const watch = setInterval(() => {
            const events = jobs.eventsAfter(job, lastSequence);
            for (const event of events) {
              lastSequence = event.sequence;
              sendSse(res, event);
            }
            if (["complete", "cancelled", "failed"].includes(job.status)) {
              clearInterval(watch);
              clearInterval(heartbeat);
              res.end();
            }
          }, 500);
          req.on("close", () => {
            clearInterval(watch);
            clearInterval(heartbeat);
          });
          return;
        }
      }
      if (req.method === "POST" && url.pathname === "/api/check") {
        if (!validAccessCode(req, config.accessCode)) {
          throw new SubmissionError("A valid pilot access code is required", 401);
        }
        if (!globalLimiter.take("all")) {
          throw new SubmissionError("The hosted service has reached its hourly capacity", 429);
        }
        if (!limiter.take(requestIp(req, config.trustProxy))) {
          throw new SubmissionError("Rate limit reached; try again later", 429);
        }
        const body = await readMultipart(req, config.maxBodyBytes);
        const submission = validateSubmission(body, config);
        if (req.headers["x-inkcheck-async"] !== "1") {
          const result = await runner(submission, config);
          console.log(JSON.stringify({
            event: "check_complete",
            requestId,
            files: result.meta.uploadedFiles,
            bytes: result.meta.uploadedBytes,
            durationMs: result.meta.durationMs,
            coverageLimitHit: result.meta.coverageLimitHit === true,
          }));
          recordUsage("check_complete", { durationMs: result.meta.durationMs });
          sendJson(res, 200, { requestId, ...result });
          return;
        }
        const job = jobs.create(submission);
        const base = `/api/jobs/${job.id}?token=${job.token}`;
        sendJson(res, 202, {
          requestId,
          job: {
            id: job.id,
            status: job.status,
            statusUrl: base,
            eventUrl: `/api/jobs/${job.id}/events?token=${job.token}`,
            cancelUrl: `/api/jobs/${job.id}/cancel?token=${job.token}`,
          },
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof SubmissionError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unexpected service error";
      if (pathname === "/api/check" && req.method === "POST") {
        if (error instanceof SubmissionError && error.reason === "limit_hit") {
          console.warn(JSON.stringify({ event: "check_limit_hit", requestId, status }));
          recordUsage("check_limit_hit");
        }
        console.warn(JSON.stringify({ event: "check_rejected", requestId, status }));
        recordUsage("check_rejected");
      }
      sendJson(res, status, {
        requestId,
        error: message,
        ...(error instanceof SubmissionError && error.reason === "limit_hit"
          ? { issueUrl: "https://github.com/chaoz23/inkcheck/issues" }
          : {}),
      });
    }
  });
}

if (require.main === module) {
  const config = webConfigFromEnv();
  const server = createInkcheckWebServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(`inkcheck web listening on http://${config.host}:${config.port}`);
  });
}
