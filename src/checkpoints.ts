import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { compile, scanKnots } from "./inklecate";
import {
  SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION,
  type SharedSearchCheckpoint,
} from "./explore";
import { VERSION } from "./version";

export const CHECKPOINT_ARTIFACT_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_PROJECT_CHECKPOINT_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_GENERATIONS = 3;

export type CheckpointFreshness = "current" | "stale" | "path_changed";

export interface CheckpointArtifactReference {
  id: string;
  path: string;
  pruned: string[];
}

export interface CheckpointArtifactSummary {
  id: string;
  path: string;
  artifactType: "shared-search-checkpoint";
  createdAt: string;
  inkcheckVersion: string;
  checkpointSchemaVersion: number;
  entrypoint: string;
  engine: string;
  totalGranted: number;
  statesExplored: number;
  sizeBytes: number;
}

export interface CheckpointStorageLimits {
  maxCheckpointBytes?: number;
  maxProjectBytes?: number;
  maxGenerationsPerEntrypoint?: number;
}

interface CheckpointArtifact {
  artifactSchemaVersion: 1;
  artifactType: "shared-search-checkpoint";
  id: string;
  createdAt: string;
  inkcheckVersion: string;
  checkpointSchemaVersion: number;
  source: { entrypoint: string };
  storySha256: string;
  knotsSha256: string;
  configuration: SharedSearchCheckpoint["configuration"];
  checkpoint: SharedSearchCheckpoint;
}

function checkpointsDirectory(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".inkcheck", "checkpoints");
}

function checkpointRelativePath(id: string): string {
  return path.posix.join(".inkcheck", "checkpoints", `${id}.json`);
}

function validateId(id: string): void {
  if (!/^checkpoint-[0-9a-f]{24}$/.test(id)) {
    throw new Error("checkpoint ID must look like checkpoint- followed by 24 lowercase hex characters");
  }
}

function checkpointFile(projectRoot: string, id: string): string {
  validateId(id);
  return path.join(checkpointsDirectory(projectRoot), `${id}.json`);
}

function sourcePath(projectRoot: string, entrypoint: string): string {
  if (!entrypoint || path.isAbsolute(entrypoint)) {
    throw new Error("checkpoint entrypoint must be a project-relative path");
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, entrypoint);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("checkpoint entrypoint escapes the project root");
  }
  return resolved;
}

function relativeEntrypoint(projectRoot: string, entrypoint: string): string {
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, path.resolve(entrypoint)).split(path.sep).join("/");
  sourcePath(root, relative);
  return relative;
}

function checkpointId(entrypoint: string, checkpoint: SharedSearchCheckpoint): string {
  const content = JSON.stringify(checkpoint);
  return `checkpoint-${createHash("sha256").update(entrypoint).update("\0").update(content).digest("hex").slice(0, 24)}`;
}

function parseArtifact(raw: string, expectedId?: string): CheckpointArtifact {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("checkpoint artifact is corrupt JSON; remove it or restore a valid copy before reopening it");
  }
  if (!value || typeof value !== "object") throw new Error("checkpoint artifact must be a JSON object");
  const artifact = value as Partial<CheckpointArtifact>;
  if (artifact.artifactSchemaVersion !== CHECKPOINT_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`unsupported checkpoint artifact schema ${String(artifact.artifactSchemaVersion)}; use a compatible Inkcheck version or migrate the artifact`);
  }
  if (artifact.artifactType !== "shared-search-checkpoint" || typeof artifact.id !== "string"
    || typeof artifact.createdAt !== "string" || !Number.isFinite(Date.parse(artifact.createdAt))
    || typeof artifact.inkcheckVersion !== "string"
    || artifact.checkpointSchemaVersion !== SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION
    || !artifact.source || typeof artifact.source.entrypoint !== "string"
    || typeof artifact.storySha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.storySha256)
    || typeof artifact.knotsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.knotsSha256)
    || !artifact.configuration || typeof artifact.configuration !== "object"
    || !artifact.checkpoint || typeof artifact.checkpoint !== "object"
    || !artifact.checkpoint.configuration || typeof artifact.checkpoint.configuration !== "object"
    || !artifact.checkpoint.state || typeof artifact.checkpoint.state !== "object"
    || !Number.isSafeInteger(artifact.checkpoint.state.totalGranted)
    || !Number.isSafeInteger(artifact.checkpoint.state.statesExplored)) {
    throw new Error("checkpoint artifact is missing required metadata; regenerate it with Inkcheck");
  }
  if (artifact.checkpoint.schemaVersion !== SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`unsupported shared checkpoint schema ${String(artifact.checkpoint.schemaVersion)}; use a compatible Inkcheck version or migrate the checkpoint`);
  }
  const actualId = checkpointId(artifact.source.entrypoint, artifact.checkpoint);
  if (artifact.id !== actualId || (expectedId !== undefined && artifact.id !== expectedId)) {
    throw new Error("checkpoint artifact content does not match its stable ID; restore or regenerate the artifact");
  }
  const configuration = artifact.checkpoint.configuration;
  if (artifact.storySha256 !== configuration.storySha256
    || artifact.knotsSha256 !== configuration.knotsSha256
    || JSON.stringify(artifact.configuration) !== JSON.stringify(configuration)) {
    throw new Error("checkpoint artifact metadata does not match its saved frontier; restore or regenerate the artifact");
  }
  return artifact as CheckpointArtifact;
}

function loadArtifact(projectRoot: string, id: string): CheckpointArtifact {
  const file = checkpointFile(projectRoot, id);
  if (!fs.existsSync(file)) throw new Error(`checkpoint not found: ${id}`);
  return parseArtifact(fs.readFileSync(file, "utf8"), id);
}

function summary(projectRoot: string, artifact: CheckpointArtifact): CheckpointArtifactSummary {
  const file = checkpointFile(projectRoot, artifact.id);
  return {
    id: artifact.id,
    path: checkpointRelativePath(artifact.id),
    artifactType: "shared-search-checkpoint",
    createdAt: artifact.createdAt,
    inkcheckVersion: artifact.inkcheckVersion,
    checkpointSchemaVersion: artifact.checkpointSchemaVersion,
    entrypoint: artifact.source.entrypoint,
    engine: artifact.checkpoint.engine,
    totalGranted: artifact.checkpoint.state.totalGranted,
    statesExplored: artifact.checkpoint.state.statesExplored,
    sizeBytes: fs.statSync(file).size,
  };
}

function checkpointRecords(projectRoot: string): Array<CheckpointArtifactSummary & { file: string }> {
  const directory = checkpointsDirectory(projectRoot);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^checkpoint-[0-9a-f]{24}\.json$/.test(name))
    .map((name) => {
      const id = name.slice(0, -5);
      return { ...summary(projectRoot, loadArtifact(projectRoot, id)), file: checkpointFile(projectRoot, id) };
    });
}

function oldestFirst<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function pruneCheckpoints(
  projectRoot: string,
  protectedId: string,
  limits: Required<CheckpointStorageLimits>
): string[] {
  let records = checkpointRecords(projectRoot);
  const removed: string[] = [];
  const remove = (record: CheckpointArtifactSummary & { file: string }) => {
    fs.rmSync(record.file);
    removed.push(record.id);
    records = records.filter((candidate) => candidate.id !== record.id);
  };
  const entrypoints = [...new Set(records.map((record) => record.entrypoint))].sort();
  for (const entrypoint of entrypoints) {
    let candidates = records.filter((record) => record.entrypoint === entrypoint).sort(oldestFirst);
    while (candidates.length > limits.maxGenerationsPerEntrypoint) {
      const candidate = candidates.find((record) => record.id !== protectedId);
      if (!candidate) break;
      remove(candidate);
      candidates = records.filter((record) => record.entrypoint === entrypoint).sort(oldestFirst);
    }
  }
  while (records.reduce((total, record) => total + record.sizeBytes, 0) > limits.maxProjectBytes) {
    const candidate = records.filter((record) => record.id !== protectedId).sort(oldestFirst)[0];
    if (!candidate) break;
    remove(candidate);
  }
  return removed;
}

function storageLimits(input: CheckpointStorageLimits): Required<CheckpointStorageLimits> {
  const limits = {
    maxCheckpointBytes: input.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES,
    maxProjectBytes: input.maxProjectBytes ?? DEFAULT_MAX_PROJECT_CHECKPOINT_BYTES,
    maxGenerationsPerEntrypoint: input.maxGenerationsPerEntrypoint ?? DEFAULT_CHECKPOINT_GENERATIONS,
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

export function saveCheckpointArtifact(
  projectRoot: string,
  entrypoint: string,
  checkpoint: SharedSearchCheckpoint,
  inputLimits: CheckpointStorageLimits = {}
): CheckpointArtifactReference {
  const root = path.resolve(projectRoot);
  const relative = relativeEntrypoint(root, entrypoint);
  const id = checkpointId(relative, checkpoint);
  const directory = checkpointsDirectory(root);
  const destination = checkpointFile(root, id);
  const limits = storageLimits(inputLimits);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  if (fs.existsSync(destination)) {
    loadArtifact(root, id);
    if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
    const bytes = fs.statSync(destination).size;
    if (bytes > limits.maxCheckpointBytes) {
      throw new Error(`checkpoint is ${bytes} bytes, above the ${limits.maxCheckpointBytes}-byte single-checkpoint limit`);
    }
    if (bytes > limits.maxProjectBytes) {
      throw new Error(`checkpoint is ${bytes} bytes, above the ${limits.maxProjectBytes}-byte project checkpoint quota`);
    }
    const pruned = pruneCheckpoints(root, id, limits);
    if (pruned.length > 0) syncDirectory(directory);
    return { id, path: checkpointRelativePath(id), pruned };
  }
  // Validate the existing retention set before creating a new durable file.
  // Corrupt old state must not turn a successful write into a partial cleanup.
  checkpointRecords(root);
  const artifact: CheckpointArtifact = {
    artifactSchemaVersion: CHECKPOINT_ARTIFACT_SCHEMA_VERSION,
    artifactType: "shared-search-checkpoint",
    id,
    createdAt: new Date().toISOString(),
    inkcheckVersion: VERSION,
    checkpointSchemaVersion: SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION,
    source: { entrypoint: relative },
    storySha256: checkpoint.configuration.storySha256,
    knotsSha256: checkpoint.configuration.knotsSha256,
    configuration: checkpoint.configuration,
    checkpoint,
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.maxCheckpointBytes) {
    throw new Error(`checkpoint is ${bytes} bytes, above the ${limits.maxCheckpointBytes}-byte single-checkpoint limit`);
  }
  if (bytes > limits.maxProjectBytes) {
    throw new Error(`checkpoint is ${bytes} bytes, above the ${limits.maxProjectBytes}-byte project checkpoint quota`);
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
  const pruned = pruneCheckpoints(root, id, limits);
  if (pruned.length > 0) syncDirectory(directory);
  return { id, path: checkpointRelativePath(id), pruned };
}

export function listCheckpointArtifacts(projectRoot: string): CheckpointArtifactSummary[] {
  return checkpointRecords(projectRoot)
    .map(({ file: _file, ...record }) => record)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

async function freshness(
  projectRoot: string,
  artifact: CheckpointArtifact
): Promise<{ freshness: CheckpointFreshness; entrypoint: string }> {
  const entrypoint = sourcePath(projectRoot, artifact.source.entrypoint);
  if (!fs.existsSync(entrypoint)) return { freshness: "path_changed", entrypoint };
  const compiled = await compile(entrypoint);
  if (!compiled.success || !compiled.storyJson) return { freshness: "stale", entrypoint };
  const storySha256 = createHash("sha256").update(compiled.storyJson).digest("hex");
  const knotsSha256 = createHash("sha256").update(JSON.stringify(scanKnots(entrypoint))).digest("hex");
  return {
    freshness: storySha256 === artifact.storySha256 && knotsSha256 === artifact.knotsSha256 ? "current" : "stale",
    entrypoint,
  };
}

export async function openCheckpointArtifact(projectRoot: string, id: string): Promise<{
  artifact: CheckpointArtifactSummary & { freshness: CheckpointFreshness };
}> {
  const artifact = loadArtifact(projectRoot, id);
  const current = await freshness(projectRoot, artifact);
  return { artifact: { ...summary(projectRoot, artifact), freshness: current.freshness } };
}

export async function loadCheckpointForResume(projectRoot: string, id: string): Promise<{
  artifact: CheckpointArtifactSummary & { freshness: "current" };
  checkpoint: SharedSearchCheckpoint;
  entrypoint: string;
}> {
  const artifact = loadArtifact(projectRoot, id);
  const current = await freshness(projectRoot, artifact);
  if (current.freshness !== "current") {
    throw new Error(`checkpoint ${id} is ${current.freshness}; resume requires the exact source and knot map used to create it`);
  }
  return {
    artifact: { ...summary(projectRoot, artifact), freshness: "current" },
    checkpoint: artifact.checkpoint,
    entrypoint: current.entrypoint,
  };
}
