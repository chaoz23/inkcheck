import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGzip, gunzipSync } from "zlib";
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
  storageEncoding: "json" | "gzip";
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

function checkpointRelativePath(id: string, encoding: "json" | "gzip" = "gzip"): string {
  return path.posix.join(".inkcheck", "checkpoints", `${id}.${encoding === "gzip" ? "json.gz" : "json"}`);
}

function validateId(id: string): void {
  if (!/^checkpoint-[0-9a-f]{24}$/.test(id)) {
    throw new Error("checkpoint ID must look like checkpoint- followed by 24 lowercase hex characters");
  }
}

function checkpointDestination(projectRoot: string, id: string): string {
  validateId(id);
  return path.join(checkpointsDirectory(projectRoot), `${id}.json.gz`);
}

function checkpointFile(projectRoot: string, id: string): string {
  validateId(id);
  const compressed = checkpointDestination(projectRoot, id);
  if (fs.existsSync(compressed)) return compressed;
  const legacy = path.join(checkpointsDirectory(projectRoot), `${id}.json`);
  if (fs.existsSync(legacy)) return legacy;
  return compressed;
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

function *jsonChunks(value: unknown, ancestors = new Set<object>()): Generator<string> {
  if (value === null) {
    yield "null";
    return;
  }
  if (typeof value === "string") {
    yield JSON.stringify(value);
    return;
  }
  if (typeof value === "number") {
    yield Number.isFinite(value) ? String(value) : "null";
    return;
  }
  if (typeof value === "boolean") {
    yield value ? "true" : "false";
    return;
  }
  if (typeof value !== "object") throw new TypeError(`checkpoint contains a non-JSON ${typeof value} value`);
  if (ancestors.has(value)) throw new TypeError("checkpoint contains a circular reference");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length; index++) {
        if (index > 0) yield ",";
        const item = value[index];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") yield "null";
        else yield *jsonChunks(item, ancestors);
      }
      yield "]";
      return;
    }
    yield "{";
    let first = true;
    for (const key of Object.keys(value)) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(key);
      yield ":";
      yield *jsonChunks(item, ancestors);
    }
    yield "}";
  } finally {
    ancestors.delete(value);
  }
}

function checkpointId(entrypoint: string, checkpoint: SharedSearchCheckpoint): string {
  const hash = createHash("sha256").update(entrypoint).update("\0");
  for (const chunk of jsonChunks(checkpoint)) hash.update(chunk);
  return `checkpoint-${hash.digest("hex").slice(0, 24)}`;
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
  if (file.endsWith(".gz")) {
    let raw: string;
    try {
      raw = gunzipSync(fs.readFileSync(file)).toString("utf8");
    } catch {
      throw new Error("checkpoint artifact is corrupt gzip; remove it or restore a valid copy before reopening it");
    }
    return parseArtifact(raw, id);
  }
  return parseArtifact(fs.readFileSync(file, "utf8"), id);
}

function summary(projectRoot: string, artifact: CheckpointArtifact): CheckpointArtifactSummary {
  const file = checkpointFile(projectRoot, artifact.id);
  const storageEncoding = file.endsWith(".gz") ? "gzip" : "json";
  return {
    id: artifact.id,
    path: checkpointRelativePath(artifact.id, storageEncoding),
    artifactType: "shared-search-checkpoint",
    createdAt: artifact.createdAt,
    inkcheckVersion: artifact.inkcheckVersion,
    checkpointSchemaVersion: artifact.checkpointSchemaVersion,
    entrypoint: artifact.source.entrypoint,
    engine: artifact.checkpoint.engine,
    totalGranted: artifact.checkpoint.state.totalGranted,
    statesExplored: artifact.checkpoint.state.statesExplored,
    sizeBytes: fs.statSync(file).size,
    storageEncoding,
  };
}

function checkpointRecords(projectRoot: string): Array<CheckpointArtifactSummary & { file: string }> {
  const directory = checkpointsDirectory(projectRoot);
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory)
    .filter((name) => /^checkpoint-[0-9a-f]{24}\.json(?:\.gz)?$/.test(name));
  const ids = new Set<string>();
  return names.map((name) => {
      const id = name.slice(0, name.indexOf(".json"));
      if (ids.has(id)) throw new Error(`checkpoint ${id} has duplicate JSON and gzip artifacts; retain only one valid copy`);
      ids.add(id);
      return { ...summary(projectRoot, loadArtifact(projectRoot, id)), file: checkpointFile(projectRoot, id) };
    });
}

export class CheckpointSizeLimitError extends Error {
  constructor(
    public readonly kind: "single" | "project",
    public readonly observedBytes: number,
    public readonly limitBytes: number
  ) {
    super(kind === "single"
      ? `checkpoint exceeded the ${limitBytes}-byte single-checkpoint limit after ${observedBytes} durable bytes`
      : `checkpoint exceeded the ${limitBytes}-byte project checkpoint quota after ${observedBytes} durable bytes`);
    this.name = "CheckpointSizeLimitError";
  }
}

class ByteLimitTransform extends Transform {
  bytes = 0;

  constructor(private readonly kind: "single" | "project", private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(new CheckpointSizeLimitError(this.kind, this.bytes, this.limit));
      return;
    }
    callback(null, chunk);
  }
}

async function writeCompressedArtifact(
  temporary: string,
  artifact: CheckpointArtifact,
  limits: Required<CheckpointStorageLimits>
): Promise<void> {
  const kind = limits.maxCheckpointBytes <= limits.maxProjectBytes ? "single" : "project";
  const limit = Math.min(limits.maxCheckpointBytes, limits.maxProjectBytes);
  const limiter = new ByteLimitTransform(kind, limit);
  await pipeline(
    Readable.from(jsonChunks(artifact)),
    // Checkpoints favor fast commits over archival density. Their repeated Ink
    // state still compresses heavily at level 1, while users and agents wait at
    // this durable result-window boundary.
    createGzip({ level: 1 }),
    limiter,
    fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 })
  );
  // Windows requires a writable handle for fsync even after the stream has
  // closed; reopening r+ preserves the same durability step on every platform.
  const fd = fs.openSync(temporary, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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

export async function saveCheckpointArtifact(
  projectRoot: string,
  entrypoint: string,
  checkpoint: SharedSearchCheckpoint,
  inputLimits: CheckpointStorageLimits = {}
): Promise<CheckpointArtifactReference> {
  const root = path.resolve(projectRoot);
  const relative = relativeEntrypoint(root, entrypoint);
  const id = checkpointId(relative, checkpoint);
  const directory = checkpointsDirectory(root);
  const destination = checkpointDestination(root, id);
  const limits = storageLimits(inputLimits);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const existing = checkpointFile(root, id);
  if (fs.existsSync(existing)) {
    loadArtifact(root, id);
    if (process.platform !== "win32") fs.chmodSync(existing, 0o600);
    const bytes = fs.statSync(existing).size;
    if (bytes > limits.maxCheckpointBytes) {
      throw new Error(`checkpoint is ${bytes} bytes, above the ${limits.maxCheckpointBytes}-byte single-checkpoint limit`);
    }
    if (bytes > limits.maxProjectBytes) {
      throw new Error(`checkpoint is ${bytes} bytes, above the ${limits.maxProjectBytes}-byte project checkpoint quota`);
    }
    const pruned = pruneCheckpoints(root, id, limits);
    if (pruned.length > 0) syncDirectory(directory);
    const encoding = checkpointFile(root, id).endsWith(".gz") ? "gzip" : "json";
    return { id, path: checkpointRelativePath(id, encoding), pruned };
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
  const temporary = path.join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeCompressedArtifact(temporary, artifact, limits);
    fs.renameSync(temporary, destination);
    syncDirectory(directory);
  } finally {
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
