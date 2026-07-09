#!/usr/bin/env node
import { spawn, ChildProcess } from "child_process";
import { randomUUID, timingSafeEqual } from "crypto";
import * as fs from "fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import * as os from "os";
import * as path from "path";
import { VERSION } from "./version";
import { BrowserUsageEvent, FileUsageStore, UsageRecorder } from "./usage";
import { buildHumanFindings, HumanFinding } from "./human-report";
import {
  HostedLimits,
  HostedSubmission,
  LIMIT_HIT_MESSAGE,
  SubmissionError,
  validateSubmission,
} from "./web-validation";

export interface WebConfig extends HostedLimits {
  host: string;
  port: number;
  concurrency: number;
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
}

export interface HostedCheckResponse {
  report: unknown;
  humanFindings?: HumanFinding[];
  meta: {
    durationMs: number;
    uploadedFiles: number;
    uploadedBytes: number;
    retained: false;
    coverageLimitHit?: boolean;
  };
}

export type SubmissionRunner = (
  submission: HostedSubmission,
  config: WebConfig
) => Promise<HostedCheckResponse>;

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
    timeoutMs: integerEnv("INKCHECK_WEB_TIMEOUT_MS", 450_000, 1_000, 900_000),
    maxBodyBytes: integerEnv("INKCHECK_WEB_MAX_BODY_BYTES", 5_242_880, 1_024, 20_971_520),
    maxFiles: integerEnv("INKCHECK_WEB_MAX_FILES", 200, 1, 500),
    maxFileBytes: integerEnv("INKCHECK_WEB_MAX_FILE_BYTES", 2_621_440, 1_024, 10_485_760),
    maxDepth: integerEnv("INKCHECK_WEB_MAX_DEPTH", 1_000, 1, 2_000),
    maxStates: integerEnv("INKCHECK_WEB_MAX_STATES", 100_000, 1, 1_000_000),
    maxReportBytes: integerEnv("INKCHECK_WEB_MAX_REPORT_BYTES", 83_886_080, 65_536, 209_715_200),
    rateLimit: integerEnv("INKCHECK_WEB_RATE_LIMIT", 10, 1, 1_000),
    globalRateLimit: integerEnv("INKCHECK_WEB_GLOBAL_RATE_LIMIT", 60, 1, 10_000),
    rateWindowMs: integerEnv("INKCHECK_WEB_RATE_WINDOW_MS", 3_600_000, 1_000, 86_400_000),
    accessCode: process.env.INKCHECK_WEB_ACCESS_CODE || undefined,
    allowedOrigins: allowedOriginsFromEnv(),
    trustProxy: process.env.INKCHECK_WEB_TRUST_PROXY === "1",
    staticDir: process.env.INKCHECK_WEB_STATIC_DIR ?? path.join(__dirname, "..", "web"),
    usageFile: process.env.INKCHECK_WEB_USAGE_FILE || undefined,
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
  config: WebConfig
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
    const root = path.join(jobDir, ...submission.root.split("/"));
    const cli = path.join(__dirname, "cli.js");
    const args = [
      "--max-old-space-size=768",
      cli,
      root,
      "--json",
      "--max-depth",
      String(submission.maxDepth),
      "--max-states",
      String(submission.maxStates),
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
        if (!finished) stderr = append(stderr, chunk);
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
        stopProcessTree(child);
        finish(new SubmissionError(LIMIT_HIT_MESSAGE, 504, "limit_hit"));
      }, config.timeoutMs);
      timer.unref();
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
    return {
      report,
      humanFindings: buildHumanFindings(report as Parameters<typeof buildHumanFindings>[0]),
      meta: {
        durationMs: Date.now() - started,
        uploadedFiles: submission.files.length,
        uploadedBytes: submission.files.reduce((sum, file) => sum + file.bytes, 0),
        retained: false,
        ...(coverageLimitHit ? { coverageLimitHit: true } : {}),
      },
    };
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
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
    return {
      root: fields.get("root"),
      files,
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inkcheck-Access-Code");
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
  let active = 0;

  const recordUsage = (event: Parameters<UsageRecorder["record"]>[0], details?: { durationMs?: number }) => {
    try {
      usage?.record(event, details);
    } catch {
      console.warn(JSON.stringify({ event: "usage_write_failed" }));
    }
  };

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    let pathname = "";
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      pathname = url.pathname;
      if (url.pathname === "/api/check" || url.pathname === "/api/event") {
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
        if (active >= config.concurrency) {
          throw new SubmissionError("The checker is busy; try again shortly", 503);
        }
        active++;
        try {
          const body = await readMultipart(req, config.maxBodyBytes);
          const submission = validateSubmission(body, config);
          const result = await runner(submission, config);
          console.log(
            JSON.stringify({
              event: "check_complete",
              requestId,
              files: result.meta.uploadedFiles,
              bytes: result.meta.uploadedBytes,
              durationMs: result.meta.durationMs,
              coverageLimitHit: result.meta.coverageLimitHit === true,
            })
          );
          recordUsage("check_complete", { durationMs: result.meta.durationMs });
          if (result.meta.coverageLimitHit === true) {
            console.warn(JSON.stringify({ event: "check_limit_hit", requestId, status: 200 }));
            recordUsage("check_limit_hit");
          }
          sendJson(res, 200, { requestId, ...result });
        } finally {
          active--;
        }
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
