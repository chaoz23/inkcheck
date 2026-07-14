import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { compile } from "./inklecate";
import { ARTIFACT_SCHEMA_VERSION, REPORT_SCHEMA_VERSION } from "./discovery";
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
  report: Record<string, unknown>
): ArtifactReference {
  const root = path.resolve(projectRoot);
  const absoluteSource = path.resolve(entrypoint);
  const relativeSource = path.relative(root, absoluteSource).split(path.sep).join("/");
  sourcePath(root, relativeSource);
  const id = reportId(relativeSource, report);
  const directory = reportsDirectory(root);
  const destination = artifactFile(root, id);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(destination)) {
    parseArtifact(fs.readFileSync(destination, "utf8"), id);
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
  const temporary = path.join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { id, path: artifactRelativePath(id) };
}

export function listReportArtifacts(projectRoot: string): ReportArtifactSummary[] {
  const directory = reportsDirectory(projectRoot);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^report-[0-9a-f]{24}\.json$/.test(name))
    .map((name) => {
      const id = name.slice(0, -5);
      const artifact = loadArtifact(projectRoot, id);
      return {
        id,
        path: artifactRelativePath(id),
        artifactType: "report" as const,
        createdAt: artifact.createdAt,
        inkcheckVersion: artifact.inkcheckVersion,
        reportSchemaVersion: artifact.reportSchemaVersion,
        entrypoint: artifact.source.entrypoint,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
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
      id: artifact.id,
      path: artifactRelativePath(artifact.id),
      artifactType: "report",
      createdAt: artifact.createdAt,
      inkcheckVersion: artifact.inkcheckVersion,
      reportSchemaVersion: artifact.reportSchemaVersion,
      entrypoint: artifact.source.entrypoint,
      freshness,
      ...(currentFingerprint ? { currentFingerprint } : {}),
    },
    report: artifact.report,
  };
}
