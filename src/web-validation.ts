import * as path from "path";

export interface HostedLimits {
  maxBodyBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxDepth: number;
  maxStates: number;
}

export interface HostedFile {
  name: string;
  content: string;
  bytes: number;
}

export interface HostedSubmission {
  root: string;
  files: HostedFile[];
  maxDepth: number;
  maxStates: number;
}

export class SubmissionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly reason?: "limit_hit"
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

export const LIMIT_HIT_MESSAGE =
  "Our bad — your story is so detailed and long that it hit our current hosted limit. Please file an issue and we’ll raise it.";

// A wall-clock timeout is not a size limit: the story may be perfectly
// ordinary but need more exploration time than the hosted budget allows. The
// graceful --max-time stop normally returns a partial report before this hard
// deadline fires, so this message is only for a genuinely wedged run that had
// to be killed with no report to show. It must not blame the story's size or
// promise that raising a limit will help.
export const TIME_LIMIT_MESSAGE =
  "This check ran out of time before it could return a report. The story likely needs more exploration than the hosted time budget allows — try running inkcheck locally, where you can give it a larger time and state budget.";

function limitHit(message = LIMIT_HIT_MESSAGE, status = 413): SubmissionError {
  return new SubmissionError(message, status, "limit_hit");
}

function safeInkPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240) {
    throw new SubmissionError(`${label} must be a relative .ink path under 240 characters`);
  }
  if (value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new SubmissionError(`${label} must use a safe relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    !normalized.toLowerCase().endsWith(".ink")
  ) {
    throw new SubmissionError(`${label} must use a normalized relative .ink path`);
  }
  return normalized;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new SubmissionError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  if ((value as number) > maximum) throw limitHit();
  return value as number;
}

function validateIncludes(files: HostedFile[]): void {
  const names = new Set(files.map((file) => file.name));
  for (const file of files) {
    for (const line of file.content.split(/\r?\n/)) {
      const code = line.replace(/\/\/.*$/, "");
      const match = code.match(/^\s*INCLUDE\s+(.+?)\s*$/);
      if (!match) continue;
      const include = match[1];
      if (
        !include ||
        include.includes("\\") ||
        include.includes("\0") ||
        path.posix.isAbsolute(include)
      ) {
        throw new SubmissionError(`Unsafe INCLUDE path in ${file.name}: ${include || "empty"}`, 422);
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.name), include));
      if (target === ".." || target.startsWith("../") || !names.has(target)) {
        throw new SubmissionError(
          `INCLUDE in ${file.name} must reference an uploaded file: ${include}`,
          422
        );
      }
    }
  }
}

export function validateSubmission(input: unknown, limits: HostedLimits): HostedSubmission {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SubmissionError("Request body must be a JSON object");
  }
  const body = input as Record<string, unknown>;
  if (body.authorized !== true) {
    throw new SubmissionError("Confirm that you are authorized to upload these files", 422);
  }
  if (body.privacyAcknowledged !== true) {
    throw new SubmissionError("Confirm that you understand the temporary hosted processing", 422);
  }
  if (!body.files || typeof body.files !== "object" || Array.isArray(body.files)) {
    throw new SubmissionError("files must be an object mapping relative .ink paths to text");
  }

  const entries = Object.entries(body.files as Record<string, unknown>);
  if (entries.length < 1 || entries.length > limits.maxFiles) {
    throw limitHit();
  }
  const seen = new Set<string>();
  const files: HostedFile[] = entries.map(([rawName, rawContent]) => {
    const name = safeInkPath(rawName, "File name");
    if (seen.has(name)) throw new SubmissionError(`Duplicate file path: ${name}`);
    seen.add(name);
    if (typeof rawContent !== "string") {
      throw new SubmissionError(`File content must be text: ${name}`);
    }
    if (rawContent.includes("\0")) {
      throw new SubmissionError(`File content contains a null byte: ${name}`);
    }
    const bytes = Buffer.byteLength(rawContent, "utf8");
    if (bytes > limits.maxFileBytes) {
      throw limitHit();
    }
    return { name, content: rawContent, bytes };
  });
  validateIncludes(files);

  const root = safeInkPath(body.root, "root");
  if (!seen.has(root)) throw new SubmissionError("root must name one of the uploaded files", 422);

  return {
    root,
    files,
    maxDepth: boundedInteger(body.maxDepth, limits.maxDepth, 1, limits.maxDepth, "maxDepth"),
    maxStates: boundedInteger(body.maxStates, limits.maxStates, 1, limits.maxStates, "maxStates"),
  };
}
