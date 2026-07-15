import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { compile, scanExternals } from "./inklecate";
import { playtest, type PlaytestResult } from "./explore";
import {
  ARTIFACT_SCHEMA_VERSION,
  DEFAULT_MAX_PROJECT_REPORT_BYTES,
  DEFAULT_MAX_REPORT_BYTES,
  MAX_REPORT_PRUNE_PER_RUN,
  REPORT_SCHEMA_VERSION,
} from "./discovery";
export { DEFAULT_MAX_PROJECT_REPORT_BYTES, DEFAULT_MAX_REPORT_BYTES, MAX_REPORT_PRUNE_PER_RUN } from "./discovery";
import { VERSION } from "./version";

export type ArtifactFreshness = "current" | "stale" | "path_changed";

interface StoryFingerprint {
  algorithm: "sha256";
  source: "entry-source" | "compiled-story";
  value: string;
}

export interface ReportArtifact {
  artifactSchemaVersion: 1;
  artifactType: "report";
  id: string;
  createdAt: string;
  inkcheckVersion: string;
  reportSchemaVersion: number;
  source: {
    entrypoint: string;
  };
  storyFingerprint: StoryFingerprint;
  effectiveConfiguration: unknown;
  report: Record<string, unknown>;
}

export interface ArtifactReference {
  id: string;
  path: string;
}

export interface ReportArtifactSummary extends ArtifactReference {
  artifactType: "report";
  createdAt: string;
  inkcheckVersion: string;
  reportSchemaVersion: number;
  entrypoint: string;
  sizeBytes: number;
}

export const DEFAULT_FINDING_PAGE_SIZE = 20;
export const MAX_FINDING_PAGE_SIZE = 100;
export interface ReportStorageLimits {
  maxReportBytes?: number;
  maxProjectBytes?: number;
}

export interface ReportLifecycleResult {
  operation: "delete" | "prune";
  applied: boolean;
  keepPerEntrypoint?: number;
  candidateCount: number;
  selectedCount: number;
  remainingCandidates: number;
  bytes: number;
  candidates: ReportArtifactSummary[];
}

export interface SavedFindingSummary {
  id: string;
  kind: string;
  section: string;
  hasWitness: boolean;
  hasReplay: boolean;
  sourceLocation?: { file: string; line: number | null; approximate?: boolean; pathTruncated?: boolean };
}

interface SavedFindingRecord {
  summary: SavedFindingSummary;
  finding: Record<string, unknown>;
}

export interface FindingPage {
  artifact: ReportArtifactSummary & { freshness: ArtifactFreshness; currentFingerprint?: StoryFingerprint };
  findings: SavedFindingSummary[];
  page: { limit: number; returned: number; total: number; nextCursor: string | null };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function reportId(entrypoint: string, report: Record<string, unknown>): string {
  const identity = canonical({ entrypoint, report });
  return `report-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function reportsDirectory(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".inkcheck", "reports");
}

function artifactRelativePath(id: string): string {
  return path.posix.join(".inkcheck", "reports", `${id}.json`);
}

function artifactFile(projectRoot: string, id: string): string {
  if (!/^report-[0-9a-f]{24}$/.test(id)) {
    throw new Error("report artifact ID must look like report- followed by 24 lowercase hex characters");
  }
  return path.join(reportsDirectory(projectRoot), `${id}.json`);
}

function fingerprintFromReport(report: Record<string, unknown>): StoryFingerprint {
  const value = report.storyFingerprint as Partial<StoryFingerprint> | undefined;
  if (value?.algorithm !== "sha256"
    || (value.source !== "entry-source" && value.source !== "compiled-story")
    || typeof value.value !== "string"
    || !/^[0-9a-f]{64}$/.test(value.value)) {
    throw new Error("report is missing a supported SHA-256 story fingerprint");
  }
  return value as StoryFingerprint;
}

function sourcePath(projectRoot: string, entrypoint: string): string {
  if (!entrypoint || path.isAbsolute(entrypoint)) {
    throw new Error("report artifact entrypoint must be a project-relative path");
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, entrypoint);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("report artifact entrypoint escapes the project root");
  }
  return resolved;
}

function parseArtifact(raw: string, expectedId?: string): ReportArtifact {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("report artifact is corrupt JSON; remove it or restore a valid copy before reopening it");
  }
  if (!value || typeof value !== "object") {
    throw new Error("report artifact must be a JSON object");
  }
  const artifact = value as Partial<ReportArtifact>;
  if (artifact.artifactSchemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`unsupported report artifact schema ${String(artifact.artifactSchemaVersion)}; use a compatible Inkcheck version or migrate the artifact`);
  }
  if (artifact.artifactType !== "report" || typeof artifact.id !== "string"
    || typeof artifact.createdAt !== "string" || typeof artifact.inkcheckVersion !== "string"
    || typeof artifact.reportSchemaVersion !== "number" || !artifact.source
    || typeof artifact.source.entrypoint !== "string" || !artifact.report
    || typeof artifact.report !== "object") {
    throw new Error("report artifact is missing required metadata; regenerate it with Inkcheck");
  }
  if (artifact.reportSchemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new Error(`unsupported saved report schema ${artifact.reportSchemaVersion}; use a compatible Inkcheck version or migrate the artifact`);
  }
  const report = artifact.report as Record<string, unknown>;
  const actualId = reportId(artifact.source.entrypoint, report);
  if (artifact.id !== actualId || (expectedId !== undefined && expectedId !== artifact.id)) {
    throw new Error("report artifact content does not match its stable ID; restore or regenerate the artifact");
  }
  const fingerprint = fingerprintFromReport(report);
  if (canonical(artifact.storyFingerprint) !== canonical(fingerprint)
    || canonical(artifact.effectiveConfiguration) !== canonical(report.effectiveConfiguration)) {
    throw new Error("report artifact metadata does not match its saved report; restore or regenerate the artifact");
  }
  return artifact as ReportArtifact;
}

function loadArtifact(projectRoot: string, id: string): ReportArtifact {
  const file = artifactFile(projectRoot, id);
  if (!fs.existsSync(file)) throw new Error(`report artifact not found: ${id}`);
  return parseArtifact(fs.readFileSync(file, "utf8"), id);
}

function artifactSummary(projectRoot: string, artifact: ReportArtifact): ReportArtifactSummary {
  return {
    id: artifact.id,
    path: artifactRelativePath(artifact.id),
    artifactType: "report",
    createdAt: artifact.createdAt,
    inkcheckVersion: artifact.inkcheckVersion,
    reportSchemaVersion: artifact.reportSchemaVersion,
    entrypoint: artifact.source.entrypoint,
    sizeBytes: fs.statSync(artifactFile(projectRoot, artifact.id)).size,
  };
}

function reportRecords(projectRoot: string): Array<ReportArtifactSummary & { file: string }> {
  const directory = reportsDirectory(projectRoot);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^report-[0-9a-f]{24}\.json$/.test(name))
    .map((name) => {
      const id = name.slice(0, -5);
      const artifact = loadArtifact(projectRoot, id);
      return { ...artifactSummary(projectRoot, artifact), file: artifactFile(projectRoot, id) };
    });
}

function reportStorageLimits(input: ReportStorageLimits): Required<ReportStorageLimits> {
  const limits = {
    maxReportBytes: input.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES,
    maxProjectBytes: input.maxProjectBytes ?? DEFAULT_MAX_PROJECT_REPORT_BYTES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  return limits;
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

function recordsFromReport(report: Record<string, unknown>): SavedFindingRecord[] {
  const records: SavedFindingRecord[] = [];
  const push = (value: unknown, section: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const finding = value as Record<string, unknown>;
    if (typeof finding.id !== "string" || typeof finding.kind !== "string") return;
    const witness = finding.witness;
    const replay = finding.replay;
    const rawLocation = (finding.sourceLocation ?? (witness && typeof witness === "object"
      ? (witness as Record<string, unknown>).triggeringSourceLocation
      : undefined) ?? (typeof finding.file === "string"
      ? { file: finding.file, line: finding.line ?? null }
      : undefined)) as Record<string, unknown> | undefined;
    const locationFile = typeof rawLocation?.file === "string" ? rawLocation.file : undefined;
    const sourceLocation = rawLocation && locationFile
      && (rawLocation.line === null || Number.isSafeInteger(rawLocation.line))
      ? {
          file: locationFile.length <= 256 ? locationFile : `...${locationFile.slice(-253)}`,
          line: rawLocation.line as number | null,
          ...(typeof rawLocation.approximate === "boolean" ? { approximate: rawLocation.approximate } : {}),
          ...(locationFile.length > 256 ? { pathTruncated: true as const } : {}),
        }
      : undefined;
    records.push({
      summary: {
        id: finding.id,
        kind: finding.kind,
        section,
        hasWitness: Boolean(witness && typeof witness === "object"),
        hasReplay: Boolean(replay && typeof replay === "object"),
        ...(sourceLocation ? { sourceLocation } : {}),
      },
      finding,
    });
  };
  const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
  const compileReport = report.compile as Record<string, unknown> | undefined;
  array(compileReport?.issues).forEach((finding, index) => push(finding, `compile.issues[${index}]`));
  const explore = report.explore as Record<string, unknown> | undefined;
  array(explore?.runtimeErrors).forEach((finding, index) => push(finding, `explore.runtimeErrors[${index}]`));
  array(explore?.endingsFound).forEach((finding, index) => push(finding, `explore.endingsFound[${index}]`));
  array(explore?.assertionResults).forEach((result, resultIndex) => {
    const value = result as Record<string, unknown> | undefined;
    array(value?.violations).forEach((finding, index) => push(
      finding,
      `explore.assertionResults[${resultIndex}].violations[${index}]`
    ));
  });
  array(explore?.goalResults).forEach((result, resultIndex) => {
    const value = result as Record<string, unknown> | undefined;
    push(value?.witness, `explore.goalResults[${resultIndex}].witness`);
    array(value?.stages).forEach((stage, stageIndex) => {
      const stageValue = stage as Record<string, unknown> | undefined;
      push(stageValue?.witness, `explore.goalResults[${resultIndex}].stages[${stageIndex}].witness`);
    });
  });
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.summary.id)) {
      throw new Error(`saved report contains ambiguous duplicate finding ID: ${record.summary.id}`);
    }
    seen.add(record.summary.id);
  }
  return records;
}

function findingRecord(report: Record<string, unknown>, findingId: string): SavedFindingRecord {
  const found = recordsFromReport(report).find((record) => record.summary.id === findingId);
  if (!found) throw new Error(`finding not found in saved report: ${findingId}`);
  return found;
}

function encodeCursor(reportId: string, offset: number): string {
  return `finding-cursor-${Buffer.from(JSON.stringify({ v: 1, reportId, offset }), "utf8").toString("base64url")}`;
}

function decodeCursor(reportId: string, cursor?: string): number {
  if (!cursor) return 0;
  if (!cursor.startsWith("finding-cursor-")) throw new Error("invalid saved-finding cursor");
  try {
    const value = JSON.parse(Buffer.from(cursor.slice("finding-cursor-".length), "base64url").toString("utf8")) as {
      v?: unknown; reportId?: unknown; offset?: unknown;
    };
    if (value.v !== 1 || value.reportId !== reportId || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) {
      throw new Error();
    }
    return value.offset as number;
  } catch {
    throw new Error("invalid or foreign saved-finding cursor");
  }
}

export function artifactProjectRoot(entrypoint: string, configFile?: string): string {
  if (configFile) return path.dirname(path.resolve(configFile));
  const cwd = path.resolve(process.cwd());
  const source = path.resolve(entrypoint);
  const relative = path.relative(cwd, source);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? cwd
    : path.dirname(source);
}

export function saveReportArtifact(
  projectRoot: string,
  entrypoint: string,
  report: Record<string, unknown>,
  inputLimits: ReportStorageLimits = {}
): ArtifactReference {
  const root = path.resolve(projectRoot);
  const absoluteSource = path.resolve(entrypoint);
  const relativeSource = path.relative(root, absoluteSource).split(path.sep).join("/");
  sourcePath(root, relativeSource);
  const id = reportId(relativeSource, report);
  const directory = reportsDirectory(root);
  const destination = artifactFile(root, id);
  const limits = reportStorageLimits(inputLimits);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  if (fs.existsSync(destination)) {
    parseArtifact(fs.readFileSync(destination, "utf8"), id);
    if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
    return { id, path: artifactRelativePath(id) };
  }
  const fingerprint = fingerprintFromReport(report);
  const artifact: ReportArtifact = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactType: "report",
    id,
    createdAt: new Date().toISOString(),
    inkcheckVersion: VERSION,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    source: { entrypoint: relativeSource },
    storyFingerprint: fingerprint,
    effectiveConfiguration: report.effectiveConfiguration,
    report,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.maxReportBytes) {
    throw new Error(`report is ${bytes} bytes, above the ${limits.maxReportBytes}-byte single-report limit`);
  }
  const existingBytes = reportRecords(root).reduce((total, item) => total + item.sizeBytes, 0);
  if (existingBytes + bytes > limits.maxProjectBytes) {
    throw new Error(`saving this report would use ${existingBytes + bytes} bytes, above the ${limits.maxProjectBytes}-byte project report quota; delete or prune reports explicitly`);
  }
  const temporary = path.join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, destination);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  return { id, path: artifactRelativePath(id) };
}

export function listReportArtifacts(projectRoot: string): ReportArtifactSummary[] {
  return reportRecords(projectRoot)
    .map(({ file: _file, ...artifact }) => artifact)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function deleteReportArtifact(projectRoot: string, id: string, apply = false): ReportLifecycleResult {
  const artifact = artifactSummary(projectRoot, loadArtifact(projectRoot, id));
  if (apply) {
    fs.rmSync(artifactFile(projectRoot, id));
    syncDirectory(reportsDirectory(projectRoot));
  }
  return {
    operation: "delete",
    applied: apply,
    candidateCount: 1,
    selectedCount: 1,
    remainingCandidates: 0,
    bytes: artifact.sizeBytes,
    candidates: [artifact],
  };
}

export function pruneReportArtifacts(
  projectRoot: string,
  keepPerEntrypoint: number,
  apply = false
): ReportLifecycleResult {
  if (!Number.isSafeInteger(keepPerEntrypoint) || keepPerEntrypoint < 0) {
    throw new RangeError("keepPerEntrypoint must be a non-negative safe integer");
  }
  const records = reportRecords(projectRoot);
  const entrypoints = [...new Set(records.map((record) => record.entrypoint))].sort();
  const candidates = entrypoints.flatMap((entrypoint) => records
    .filter((record) => record.entrypoint === entrypoint)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(keepPerEntrypoint))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)
      || a.entrypoint.localeCompare(b.entrypoint) || a.id.localeCompare(b.id));
  const selected = candidates.slice(0, MAX_REPORT_PRUNE_PER_RUN);
  if (apply && selected.length > 0) {
    for (const artifact of selected) fs.rmSync(artifact.file);
    syncDirectory(reportsDirectory(projectRoot));
  }
  return {
    operation: "prune",
    applied: apply,
    keepPerEntrypoint,
    candidateCount: candidates.length,
    selectedCount: selected.length,
    remainingCandidates: candidates.length - selected.length,
    bytes: selected.reduce((total, artifact) => total + artifact.sizeBytes, 0),
    candidates: selected.map(({ file: _file, ...artifact }) => artifact),
  };
}

export async function openReportArtifact(projectRoot: string, id: string): Promise<{
  artifact: ReportArtifactSummary & { freshness: ArtifactFreshness; currentFingerprint?: StoryFingerprint };
  report: Record<string, unknown>;
}> {
  const artifact = loadArtifact(projectRoot, id);
  const entrypoint = sourcePath(projectRoot, artifact.source.entrypoint);
  let freshness: ArtifactFreshness = "path_changed";
  let currentFingerprint: StoryFingerprint | undefined;
  if (fs.existsSync(entrypoint)) {
    if (artifact.storyFingerprint.source === "entry-source") {
      currentFingerprint = {
        algorithm: "sha256",
        source: "entry-source",
        value: createHash("sha256").update(fs.readFileSync(entrypoint)).digest("hex"),
      };
    } else {
      const compiled = await compile(entrypoint);
      if (compiled.success && compiled.storyJson) {
        currentFingerprint = {
          algorithm: "sha256",
          source: "compiled-story",
          value: createHash("sha256").update(compiled.storyJson).digest("hex"),
        };
      }
    }
    freshness = currentFingerprint?.value === artifact.storyFingerprint.value ? "current" : "stale";
  }
  return {
    artifact: {
      ...artifactSummary(projectRoot, artifact),
      freshness,
      ...(currentFingerprint ? { currentFingerprint } : {}),
    },
    report: artifact.report,
  };
}

export async function listReportFindings(
  projectRoot: string,
  id: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<FindingPage> {
  const limit = options.limit ?? DEFAULT_FINDING_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FINDING_PAGE_SIZE) {
    throw new RangeError(`finding page limit must be an integer from 1 to ${MAX_FINDING_PAGE_SIZE}`);
  }
  const opened = await openReportArtifact(projectRoot, id);
  const records = recordsFromReport(opened.report);
  const offset = decodeCursor(id, options.cursor);
  if (offset > records.length) throw new Error("saved-finding cursor is beyond the immutable report");
  const findings = records.slice(offset, offset + limit).map((record) => record.summary);
  const nextOffset = offset + findings.length;
  return {
    artifact: opened.artifact,
    findings,
    page: {
      limit,
      returned: findings.length,
      total: records.length,
      nextCursor: nextOffset < records.length ? encodeCursor(id, nextOffset) : null,
    },
  };
}

export async function openReportFinding(projectRoot: string, id: string, findingId: string): Promise<{
  artifact: FindingPage["artifact"];
  summary: SavedFindingSummary;
  finding: Record<string, unknown>;
}> {
  const opened = await openReportArtifact(projectRoot, id);
  const record = findingRecord(opened.report, findingId);
  return { artifact: opened.artifact, summary: record.summary, finding: record.finding };
}

export async function replayReportFinding(projectRoot: string, id: string, findingId: string): Promise<{
  artifact: FindingPage["artifact"];
  finding: SavedFindingSummary;
  replay: PlaytestResult;
}> {
  const opened = await openReportFinding(projectRoot, id, findingId);
  if (opened.artifact.freshness !== "current") {
    throw new Error(`saved-finding replay requires current source; report is ${opened.artifact.freshness}`);
  }
  const replay = opened.finding.replay as Record<string, unknown> | undefined;
  const choices = replay?.choices;
  if (!Array.isArray(choices) || !choices.every((choice) => Number.isSafeInteger(choice) && (choice as number) >= 0)) {
    throw new Error(`finding has no supported indexed replay witness: ${findingId}`);
  }
  const rawStorySeed = replay?.storySeed;
  const storySeed = rawStorySeed === undefined ? undefined : rawStorySeed;
  if (storySeed !== undefined && !Number.isSafeInteger(storySeed)) {
    throw new Error(`finding has an invalid saved story seed: ${findingId}`);
  }
  const entrypoint = sourcePath(projectRoot, opened.artifact.entrypoint);
  const compiled = await compile(entrypoint);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error("current story no longer compiles; fix compilation before replaying the saved witness");
  }
  const replayFingerprint = createHash("sha256").update(compiled.storyJson).digest("hex");
  if (replayFingerprint !== opened.artifact.currentFingerprint?.value) {
    throw new Error("story source changed while preparing the saved witness replay; reopen the report and try again");
  }
  return {
    artifact: opened.artifact,
    finding: opened.summary,
    replay: playtest(compiled.storyJson, choices as number[], scanExternals(entrypoint), storySeed as number | undefined),
  };
}
