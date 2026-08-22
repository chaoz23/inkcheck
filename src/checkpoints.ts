import { createHash, randomUUID } from "crypto";
import { constants as bufferConstants } from "buffer";
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
export const CHECKPOINT_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_STORED_CHECKPOINT_READ_BYTES = DEFAULT_MAX_CHECKPOINT_BYTES;
export const DEFAULT_MAX_DECOMPRESSED_CHECKPOINT_READ_BYTES = Math.min(
  DEFAULT_MAX_CHECKPOINT_BYTES,
  bufferConstants.MAX_STRING_LENGTH
);

const MAX_CHECKPOINT_MANIFEST_BYTES = 64 * 1024;
const MAX_CHECKPOINT_RECOVERY_MANIFESTS = 32;
const CHECKPOINT_RECOVERY_SLOT_WIDTH = String(MAX_CHECKPOINT_RECOVERY_MANIFESTS - 1).length;

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
  payloadSizeBytes: number;
  metadataSizeBytes: number;
  sizeBytes: number;
  storageEncoding: "json" | "gzip";
}

export interface CheckpointStorageLimits {
  maxCheckpointBytes?: number;
  maxProjectBytes?: number;
  maxGenerationsPerEntrypoint?: number;
}

export interface CheckpointReadLimits {
  maxStoredBytes?: number;
  maxDecompressedBytes?: number;
}

export type CheckpointReadErrorKind = "corrupt" | "resource_limit" | "unsupported";
export type CheckpointReadStage = "manifest" | "storage" | "decompression" | "json" | "envelope";

export class CheckpointReadError extends Error {
  payloadVerified = false;

  constructor(
    public readonly kind: CheckpointReadErrorKind,
    public readonly stage: CheckpointReadStage,
    message: string,
    public readonly observedBytes?: number,
    public readonly limitBytes?: number
  ) {
    super(message);
    this.name = "CheckpointReadError";
  }
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

interface CheckpointArtifactManifest {
  manifestSchemaVersion: 1;
  artifactSchemaVersion: 1;
  artifactType: "shared-search-checkpoint";
  id: string;
  createdAt: string;
  inkcheckVersion: string;
  checkpointSchemaVersion: number;
  entrypoint: string;
  engine: string;
  totalGranted: number;
  statesExplored: number;
  storageEncoding: "json" | "gzip";
  artifactSizeBytes: number;
  artifactSha256: string;
  manifestSha256: string;
}

interface CheckpointRecord extends CheckpointArtifactSummary {
  file: string;
  manifestFile?: string;
}

interface LoadedCheckpointArtifact {
  artifact: CheckpointArtifact;
  file: string;
  storageEncoding: "json" | "gzip";
  payloadSizeBytes: number;
  payloadSha256: string;
}

interface StoredCheckpointManifest {
  file: string;
  raw: string;
  manifest: CheckpointArtifactManifest;
  sizeBytes: number;
}

interface RecoveryManifest extends StoredCheckpointManifest {
  slot: number;
}

interface RecoveredCheckpointPair {
  manifest: CheckpointArtifactManifest;
  metadataSizeBytes: number;
  payloadSizeBytes: number;
  payloadSha256: string;
}

interface CheckpointPayloadDigest {
  sizeBytes: number;
  sha256: string;
  device: number;
  inode: number;
}

interface CheckpointRecoveryClaim {
  schemaVersion: 1;
  pid: number;
  nonce?: string;
}

interface CheckpointRecoveryRelease {
  schemaVersion: 1;
  nonce: string;
}

interface CheckpointRecoveryCleaningClaim {
  schemaVersion: 1;
  pid: number;
  nonce: string;
}

interface CheckpointTransaction {
  slot: number;
  nonce: string;
  temporary: string;
}

const activeCheckpointTransactions = new Set<string>();
const retiredCheckpointTransactions = new Set<string>();

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

function checkpointManifestFile(projectRoot: string, id: string): string {
  validateId(id);
  return path.join(checkpointsDirectory(projectRoot), `${id}.meta.json`);
}

function checkpointRecoveryManifestFile(projectRoot: string, id: string, slot: number): string {
  validateId(id);
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= MAX_CHECKPOINT_RECOVERY_MANIFESTS) {
    throw new RangeError("checkpoint recovery manifest slot is out of range");
  }
  return path.join(
    checkpointsDirectory(projectRoot),
    `.${id}.recovery-${String(slot).padStart(CHECKPOINT_RECOVERY_SLOT_WIDTH, "0")}.meta.json`
  );
}

function checkpointRecoveryClaimFile(projectRoot: string, id: string, slot: number): string {
  return `${checkpointRecoveryManifestFile(projectRoot, id, slot)}.claim`;
}

function checkpointRecoveryReleaseFile(projectRoot: string, id: string, slot: number): string {
  return `${checkpointRecoveryClaimFile(projectRoot, id, slot)}.released`;
}

function checkpointRecoveryCleaningFile(projectRoot: string, id: string, slot: number): string {
  return `${checkpointRecoveryClaimFile(projectRoot, id, slot)}.cleaning`;
}

function checkpointRecoveryPromotionFile(projectRoot: string, id: string, slot: number): string {
  return `${checkpointRecoveryManifestFile(projectRoot, id, slot)}.promote`;
}

function checkpointRecoveryDisplacedFile(projectRoot: string, id: string, slot: number): string {
  return `${checkpointRecoveryManifestFile(projectRoot, id, slot)}.displaced`;
}

function checkpointRecoveryPayloadTemporaryFile(projectRoot: string, id: string, slot: number): string {
  return `${checkpointRecoveryManifestFile(projectRoot, id, slot)}.payload.tmp`;
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

function corrupt(stage: CheckpointReadStage, message: string): CheckpointReadError {
  return new CheckpointReadError("corrupt", stage, message);
}

function unsupported(stage: CheckpointReadStage, message: string): CheckpointReadError {
  return new CheckpointReadError("unsupported", stage, message);
}

function resourceLimit(
  stage: CheckpointReadStage,
  message: string,
  observedBytes: number | undefined,
  limitBytes: number
): CheckpointReadError {
  return new CheckpointReadError("resource_limit", stage, message, observedBytes, limitBytes);
}

function validateStoredEntrypoint(projectRoot: string, entrypoint: string, stage: "manifest" | "envelope"): void {
  try {
    sourcePath(projectRoot, entrypoint);
  } catch {
    throw corrupt(stage, "checkpoint metadata contains an invalid project-relative entrypoint");
  }
}

function checkpointReadLimits(input: CheckpointReadLimits): Required<CheckpointReadLimits> {
  const requestedStored = input.maxStoredBytes ?? DEFAULT_MAX_STORED_CHECKPOINT_READ_BYTES;
  const requestedDecompressed = input.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_CHECKPOINT_READ_BYTES;
  for (const [name, value] of Object.entries({
    maxStoredBytes: requestedStored,
    maxDecompressedBytes: requestedDecompressed,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  // Schema v1 is one JSON value. Even an explicitly larger caller limit cannot
  // make V8 construct a string beyond its platform ceiling.
  return {
    maxStoredBytes: Math.min(requestedStored, bufferConstants.MAX_LENGTH),
    maxDecompressedBytes: Math.min(requestedDecompressed, bufferConstants.MAX_STRING_LENGTH),
  };
}

function readBoundedBuffer(
  file: string,
  limitBytes: number,
  stage: CheckpointReadStage,
  description: string
): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw corrupt(stage, `${description} must be a regular file`);
    }
    const size = stat.size;
    if (size > limitBytes) {
      throw resourceLimit(
        stage,
        `${description} is ${size} bytes, above the ${limitBytes}-byte readback limit`,
        size,
        limitBytes
      );
    }
    const value = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, value, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extra, 0, 1, offset) !== 0) {
      throw corrupt(stage, `${description} changed while it was being read; retry from a stable copy`);
    }
    return offset === size ? value : value.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function readLegacyJsonBuffer(
  file: string,
  limits: Required<CheckpointReadLimits>
): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw corrupt("storage", "stored checkpoint artifact must be a regular file");
    }
    const size = stat.size;
    if (size > limits.maxStoredBytes) {
      throw resourceLimit(
        "storage",
        `stored checkpoint artifact is ${size} bytes, above the ${limits.maxStoredBytes}-byte readback limit`,
        size,
        limits.maxStoredBytes
      );
    }
    if (size > limits.maxDecompressedBytes) {
      throw resourceLimit(
        "decompression",
        `schema-v1 JSON checkpoint is ${size} bytes, above the ${limits.maxDecompressedBytes}-byte readback limit`,
        size,
        limits.maxDecompressedBytes
      );
    }
    const value = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, value, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extra, 0, 1, offset) !== 0) {
      const observed = Math.max(size + 1, fs.fstatSync(fd).size);
      if (observed > limits.maxStoredBytes) {
        throw resourceLimit(
          "storage",
          `stored checkpoint artifact grew to ${observed} bytes, above the ${limits.maxStoredBytes}-byte readback limit`,
          observed,
          limits.maxStoredBytes
        );
      }
      if (observed > limits.maxDecompressedBytes) {
        throw resourceLimit(
          "decompression",
          `schema-v1 JSON checkpoint grew to ${observed} bytes, above the ${limits.maxDecompressedBytes}-byte readback limit`,
          observed,
          limits.maxDecompressedBytes
        );
      }
      throw corrupt(
        "storage",
        "stored checkpoint artifact changed while it was being read; retry from a stable copy"
      );
    }
    return offset === size ? value : value.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

function decompressCheckpointJson(compressed: Buffer, limits: Required<CheckpointReadLimits>): string {
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(compressed, { maxOutputLength: limits.maxDecompressedBytes });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw resourceLimit(
        "decompression",
        `decompressed checkpoint exceeds the ${limits.maxDecompressedBytes}-byte schema-v1 readback limit; a framed checkpoint format is required to reopen it safely`,
        undefined,
        limits.maxDecompressedBytes
      );
    }
    throw corrupt("decompression", "checkpoint artifact is corrupt gzip; remove it or restore a valid copy before reopening it");
  }
  try {
    return decompressed.toString("utf8");
  } catch (error) {
    if (error instanceof RangeError) {
      throw resourceLimit(
        "decompression",
        `decompressed checkpoint exceeds the ${limits.maxDecompressedBytes}-byte schema-v1 string limit; a framed checkpoint format is required to reopen it safely`,
        decompressed.length,
        limits.maxDecompressedBytes
      );
    }
    throw error;
  }
}

function fileDigest(
  file: string,
  maxStoredBytes = DEFAULT_MAX_STORED_CHECKPOINT_READ_BYTES
): CheckpointPayloadDigest {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw corrupt("storage", "checkpoint artifact must be a regular file");
    }
    const sizeBytes = stat.size;
    if (sizeBytes > maxStoredBytes) {
      throw resourceLimit(
        "storage",
        `stored checkpoint artifact is ${sizeBytes} bytes, above the ${maxStoredBytes}-byte checksum limit`,
        sizeBytes,
        maxStoredBytes
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, sizeBytes)));
    let offset = 0;
    while (offset < sizeBytes) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, sizeBytes - offset), offset);
      if (read === 0) {
        throw corrupt("storage", "checkpoint artifact changed while its metadata checksum was being read");
      }
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    if (fs.readSync(fd, buffer, 0, 1, offset) !== 0) {
      const observed = Math.max(sizeBytes + 1, fs.fstatSync(fd).size);
      if (observed > maxStoredBytes) {
        throw resourceLimit(
          "storage",
          `stored checkpoint artifact grew to ${observed} bytes, above the ${maxStoredBytes}-byte checksum limit`,
          observed,
          maxStoredBytes
        );
      }
      throw corrupt("storage", "checkpoint artifact changed while its metadata checksum was being read");
    }
    return {
      sizeBytes,
      sha256: hash.digest("hex"),
      device: stat.dev,
      inode: stat.ino,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function samePayloadDigest(left: CheckpointPayloadDigest, right: CheckpointPayloadDigest): boolean {
  const identityMatches = left.inode === 0 || right.inode === 0
    || (left.device === right.device && left.inode === right.inode);
  return identityMatches
    && left.sizeBytes === right.sizeBytes
    && left.sha256 === right.sha256;
}

function parseArtifact(raw: string, expectedId?: string): CheckpointArtifact {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corrupt("json", "checkpoint artifact is corrupt JSON; remove it or restore a valid copy before reopening it");
  }
  if (!value || typeof value !== "object") {
    throw corrupt("envelope", "checkpoint artifact must be a JSON object");
  }
  const artifact = value as Partial<CheckpointArtifact>;
  if (artifact.artifactSchemaVersion !== CHECKPOINT_ARTIFACT_SCHEMA_VERSION) {
    throw unsupported(
      "envelope",
      `unsupported checkpoint artifact schema ${String(artifact.artifactSchemaVersion)}; use a compatible Inkcheck version or migrate the artifact`
    );
  }
  if (typeof artifact.checkpointSchemaVersion === "number"
    && artifact.checkpointSchemaVersion !== SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION) {
    throw unsupported(
      "envelope",
      `unsupported shared checkpoint schema ${String(artifact.checkpointSchemaVersion)}; use a compatible Inkcheck version or migrate the checkpoint`
    );
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
    throw corrupt("envelope", "checkpoint artifact is missing required metadata; regenerate it with Inkcheck");
  }
  if (artifact.checkpoint.schemaVersion !== SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION) {
    throw unsupported(
      "envelope",
      `unsupported shared checkpoint schema ${String(artifact.checkpoint.schemaVersion)}; use a compatible Inkcheck version or migrate the checkpoint`
    );
  }
  const actualId = checkpointId(artifact.source.entrypoint, artifact.checkpoint);
  if (artifact.id !== actualId || (expectedId !== undefined && artifact.id !== expectedId)) {
    throw corrupt("envelope", "checkpoint artifact content does not match its stable ID; restore or regenerate the artifact");
  }
  const configuration = artifact.checkpoint.configuration;
  if (artifact.storySha256 !== configuration.storySha256
    || artifact.knotsSha256 !== configuration.knotsSha256
    || JSON.stringify(artifact.configuration) !== JSON.stringify(configuration)) {
    throw corrupt("envelope", "checkpoint artifact metadata does not match its saved frontier; restore or regenerate the artifact");
  }
  return artifact as CheckpointArtifact;
}

function loadArtifactDetailed(
  projectRoot: string,
  id: string,
  inputLimits: CheckpointReadLimits = {}
): LoadedCheckpointArtifact {
  const file = checkpointFile(projectRoot, id);
  if (!fs.existsSync(file)) throw new Error(`checkpoint not found: ${id}`);
  const limits = checkpointReadLimits(inputLimits);
  const storageEncoding = file.endsWith(".gz") ? "gzip" : "json";
  let storedManifest: CheckpointArtifactManifest | undefined;
  const manifestFile = checkpointManifestFile(projectRoot, id);
  if (fs.existsSync(manifestFile)) {
    storedManifest = readCheckpointManifest(projectRoot, id).manifest;
    validateManifestStorage(projectRoot, id, file, storedManifest);
  }
  let raw: string;
  let payloadSizeBytes: number;
  let payloadSha256: string;
  if (storageEncoding === "gzip") {
    const stored = readBoundedBuffer(file, limits.maxStoredBytes, "storage", "stored checkpoint artifact");
    payloadSizeBytes = stored.length;
    payloadSha256 = createHash("sha256").update(stored).digest("hex");
    if (storedManifest && storedManifest.artifactSha256 !== payloadSha256) {
      throw corrupt("storage", "checkpoint artifact bytes do not match its metadata checksum; restore or regenerate it");
    }
    try {
      raw = decompressCheckpointJson(stored, limits);
    } catch (error) {
      if (storedManifest && error instanceof CheckpointReadError && error.kind === "resource_limit") {
        error.payloadVerified = true;
      }
      throw error;
    }
  } else {
    const stored = readLegacyJsonBuffer(file, limits);
    raw = stored.toString("utf8");
    payloadSizeBytes = stored.length;
    payloadSha256 = createHash("sha256").update(stored).digest("hex");
    if (storedManifest && storedManifest.artifactSha256 !== payloadSha256) {
      throw corrupt("storage", "checkpoint artifact bytes do not match its metadata checksum; restore or regenerate it");
    }
  }
  const artifact = parseArtifact(raw, id);
  validateStoredEntrypoint(projectRoot, artifact.source.entrypoint, "envelope");
  const loaded: LoadedCheckpointArtifact = {
    artifact,
    file,
    storageEncoding,
    payloadSizeBytes,
    payloadSha256,
  };
  validateManifestForLoaded(projectRoot, loaded, storedManifest);
  return loaded;
}

function summary(projectRoot: string, loaded: LoadedCheckpointArtifact): CheckpointArtifactSummary {
  const { artifact } = loaded;
  const manifestFile = checkpointManifestFile(projectRoot, artifact.id);
  const metadataSizeBytes = fs.existsSync(manifestFile) ? fs.statSync(manifestFile).size : 0;
  return {
    id: artifact.id,
    path: checkpointRelativePath(artifact.id, loaded.storageEncoding),
    artifactType: "shared-search-checkpoint",
    createdAt: artifact.createdAt,
    inkcheckVersion: artifact.inkcheckVersion,
    checkpointSchemaVersion: artifact.checkpointSchemaVersion,
    entrypoint: artifact.source.entrypoint,
    engine: artifact.checkpoint.engine,
    totalGranted: artifact.checkpoint.state.totalGranted,
    statesExplored: artifact.checkpoint.state.statesExplored,
    payloadSizeBytes: loaded.payloadSizeBytes,
    metadataSizeBytes,
    sizeBytes: loaded.payloadSizeBytes + metadataSizeBytes,
    storageEncoding: loaded.storageEncoding,
  };
}

function manifestForArtifact(
  artifact: CheckpointArtifact,
  storageEncoding: "json" | "gzip",
  artifactSizeBytes: number,
  artifactSha256: string
): CheckpointArtifactManifest {
  const body: Omit<CheckpointArtifactManifest, "manifestSha256"> = {
    manifestSchemaVersion: CHECKPOINT_MANIFEST_SCHEMA_VERSION,
    artifactSchemaVersion: CHECKPOINT_ARTIFACT_SCHEMA_VERSION,
    artifactType: "shared-search-checkpoint",
    id: artifact.id,
    createdAt: artifact.createdAt,
    inkcheckVersion: artifact.inkcheckVersion,
    checkpointSchemaVersion: artifact.checkpointSchemaVersion,
    entrypoint: artifact.source.entrypoint,
    engine: artifact.checkpoint.engine,
    totalGranted: artifact.checkpoint.state.totalGranted,
    statesExplored: artifact.checkpoint.state.statesExplored,
    storageEncoding,
    artifactSizeBytes,
    artifactSha256,
  };
  return { ...body, manifestSha256: manifestDigest(body) };
}

function manifestBody(
  manifest: CheckpointArtifactManifest
): Omit<CheckpointArtifactManifest, "manifestSha256"> {
  // Property order is the manifest schema's canonical byte order. Keeping this
  // explicit also ensures newly added fields cannot silently escape binding.
  return {
    manifestSchemaVersion: manifest.manifestSchemaVersion,
    artifactSchemaVersion: manifest.artifactSchemaVersion,
    artifactType: manifest.artifactType,
    id: manifest.id,
    createdAt: manifest.createdAt,
    inkcheckVersion: manifest.inkcheckVersion,
    checkpointSchemaVersion: manifest.checkpointSchemaVersion,
    entrypoint: manifest.entrypoint,
    engine: manifest.engine,
    totalGranted: manifest.totalGranted,
    statesExplored: manifest.statesExplored,
    storageEncoding: manifest.storageEncoding,
    artifactSizeBytes: manifest.artifactSizeBytes,
    artifactSha256: manifest.artifactSha256,
  };
}

function manifestDigest(
  manifest: Omit<CheckpointArtifactManifest, "manifestSha256">
): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function serializedManifest(manifest: CheckpointArtifactManifest): string {
  return JSON.stringify(manifest);
}

function parseManifest(raw: string, expectedId: string): CheckpointArtifactManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corrupt("manifest", "checkpoint metadata manifest is corrupt JSON; restore or regenerate it");
  }
  if (!value || typeof value !== "object") {
    throw corrupt("manifest", "checkpoint metadata manifest must be a JSON object");
  }
  const manifest = value as Partial<CheckpointArtifactManifest>;
  if (typeof manifest.manifestSchemaVersion === "number"
    && manifest.manifestSchemaVersion !== CHECKPOINT_MANIFEST_SCHEMA_VERSION) {
    throw unsupported(
      "manifest",
      `unsupported checkpoint metadata manifest schema ${String(manifest.manifestSchemaVersion)}; use a compatible Inkcheck version`
    );
  }
  const expectedKeys: Array<keyof CheckpointArtifactManifest> = [
    "manifestSchemaVersion", "artifactSchemaVersion", "artifactType", "id", "createdAt",
    "inkcheckVersion", "checkpointSchemaVersion", "entrypoint", "engine", "totalGranted",
    "statesExplored", "storageEncoding", "artifactSizeBytes", "artifactSha256", "manifestSha256",
  ];
  const actualKeys = Object.keys(manifest).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== [...expectedKeys].sort()[index])) {
    throw corrupt("manifest", "checkpoint metadata manifest fields do not match its schema");
  }
  if (manifest.manifestSchemaVersion !== CHECKPOINT_MANIFEST_SCHEMA_VERSION) {
    throw corrupt("manifest", "checkpoint metadata manifest is missing its schema version");
  }
  if (manifest.artifactSchemaVersion !== CHECKPOINT_ARTIFACT_SCHEMA_VERSION
    || manifest.checkpointSchemaVersion !== SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION) {
    throw unsupported(
      "manifest",
      `unsupported checkpoint schema in metadata manifest; use a compatible Inkcheck version or migrate the artifact`
    );
  }
  if (manifest.artifactType !== "shared-search-checkpoint" || manifest.id !== expectedId
    || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))
    || typeof manifest.inkcheckVersion !== "string" || typeof manifest.entrypoint !== "string"
    || typeof manifest.engine !== "string"
    || !Number.isSafeInteger(manifest.totalGranted) || !Number.isSafeInteger(manifest.statesExplored)
    || (manifest.storageEncoding !== "json" && manifest.storageEncoding !== "gzip")
    || !Number.isSafeInteger(manifest.artifactSizeBytes) || (manifest.artifactSizeBytes ?? 0) < 1
    || typeof manifest.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.artifactSha256)
    || typeof manifest.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.manifestSha256)) {
    throw corrupt("manifest", "checkpoint metadata manifest is missing required fields; restore or regenerate it");
  }
  const complete = manifest as CheckpointArtifactManifest;
  if (manifestDigest(manifestBody(complete)) !== complete.manifestSha256) {
    throw corrupt("manifest", "checkpoint metadata manifest content does not match its canonical checksum");
  }
  return complete;
}

function readCheckpointManifest(projectRoot: string, id: string): {
  manifest: CheckpointArtifactManifest;
  sizeBytes: number;
} {
  const manifestFile = checkpointManifestFile(projectRoot, id);
  const stored = readBoundedBuffer(
    manifestFile,
    MAX_CHECKPOINT_MANIFEST_BYTES,
    "manifest",
    "checkpoint metadata manifest"
  );
  return { manifest: parseManifest(stored.toString("utf8"), id), sizeBytes: stored.length };
}

function validateManifestStorage(
  projectRoot: string,
  id: string,
  file: string,
  manifest: CheckpointArtifactManifest
): void {
  validateStoredEntrypoint(projectRoot, manifest.entrypoint, "manifest");
  const storageEncoding = file.endsWith(".gz") ? "gzip" : "json";
  if (manifest.storageEncoding !== storageEncoding) {
    throw corrupt("manifest", `checkpoint ${id} metadata does not match its storage encoding`);
  }
  if (manifest.artifactSizeBytes !== fs.statSync(file).size) {
    throw corrupt(
      "storage",
      `checkpoint artifact bytes do not match its metadata checksum; content does not match its stable ID or was modified`
    );
  }
}

function verifyManifestPayload(
  file: string,
  manifest: CheckpointArtifactManifest,
  maxStoredBytes: number
): void {
  const digest = fileDigest(file, maxStoredBytes);
  if (manifest.artifactSha256 !== digest.sha256) {
    throw corrupt(
      "storage",
      `checkpoint artifact bytes do not match its metadata checksum; content does not match its stable ID or was modified`
    );
  }
}

function validateManifestForLoaded(
  projectRoot: string,
  loaded: LoadedCheckpointArtifact,
  alreadyRead?: CheckpointArtifactManifest
): void {
  const manifestFile = checkpointManifestFile(projectRoot, loaded.artifact.id);
  if (!alreadyRead && !fs.existsSync(manifestFile)) return;
  const manifest = alreadyRead ?? readCheckpointManifest(projectRoot, loaded.artifact.id).manifest;
  validateManifestStorage(projectRoot, loaded.artifact.id, loaded.file, manifest);
  const artifact = loaded.artifact;
  if (manifest.artifactSizeBytes !== loaded.payloadSizeBytes
    || manifest.artifactSha256 !== loaded.payloadSha256
    || manifest.createdAt !== artifact.createdAt
    || manifest.inkcheckVersion !== artifact.inkcheckVersion
    || manifest.checkpointSchemaVersion !== artifact.checkpointSchemaVersion
    || manifest.entrypoint !== artifact.source.entrypoint
    || manifest.engine !== artifact.checkpoint.engine
    || manifest.totalGranted !== artifact.checkpoint.state.totalGranted
    || manifest.statesExplored !== artifact.checkpoint.state.statesExplored) {
    throw corrupt("manifest", "checkpoint metadata manifest does not match its saved payload");
  }
}

function recordFromManifest(projectRoot: string, id: string, file: string): CheckpointRecord {
  const manifestFile = checkpointManifestFile(projectRoot, id);
  const { manifest, sizeBytes: metadataSizeBytes } = readCheckpointManifest(projectRoot, id);
  validateManifestStorage(projectRoot, id, file, manifest);
  const storageEncoding = file.endsWith(".gz") ? "gzip" : "json";
  const payloadSizeBytes = manifest.artifactSizeBytes;
  return {
    id,
    path: checkpointRelativePath(id, storageEncoding),
    artifactType: "shared-search-checkpoint",
    createdAt: manifest.createdAt,
    inkcheckVersion: manifest.inkcheckVersion,
    checkpointSchemaVersion: manifest.checkpointSchemaVersion,
    entrypoint: manifest.entrypoint,
    engine: manifest.engine,
    totalGranted: manifest.totalGranted,
    statesExplored: manifest.statesExplored,
    payloadSizeBytes,
    metadataSizeBytes,
    sizeBytes: payloadSizeBytes + metadataSizeBytes,
    storageEncoding,
    file,
    manifestFile,
  };
}

function checkpointRecords(
  projectRoot: string,
  inputLimits: CheckpointReadLimits = {}
): CheckpointRecord[] {
  const directory = checkpointsDirectory(projectRoot);
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory)
    .filter((name) => /^checkpoint-[0-9a-f]{24}\.json(?:\.gz)?$/.test(name));
  const ids = new Set<string>();
  return names.map((name) => {
    const id = name.slice(0, name.indexOf(".json"));
    if (ids.has(id)) {
      throw corrupt("storage", `checkpoint ${id} has duplicate JSON and gzip artifacts; retain only one valid copy`);
    }
    ids.add(id);
    const file = path.join(directory, name);
    const manifestFile = checkpointManifestFile(projectRoot, id);
    if (fs.existsSync(manifestFile)) return recordFromManifest(projectRoot, id, file);
    return { ...summary(projectRoot, loadArtifactDetailed(projectRoot, id, inputLimits)), file };
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
  private readonly hash = createHash("sha256");

  constructor(private readonly kind: "single" | "project", private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(new CheckpointSizeLimitError(this.kind, this.bytes, this.limit));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  digest(): string {
    return this.hash.digest("hex");
  }
}

async function writeCompressedArtifact(
  temporary: string,
  artifact: CheckpointArtifact,
  limits: Required<CheckpointStorageLimits>,
  precreated = false
): Promise<{ sizeBytes: number; sha256: string }> {
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
    fs.createWriteStream(temporary, { flags: precreated ? "r+" : "wx", mode: 0o600 })
  );
  // Windows requires a writable handle for fsync even after the stream has
  // closed; reopening r+ preserves the same durability step on every platform.
  const fd = fs.openSync(temporary, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { sizeBytes: limiter.bytes, sha256: limiter.digest() };
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
  const remove = (record: CheckpointRecord) => {
    fs.rmSync(record.file, { force: true });
    if (record.manifestFile) fs.rmSync(record.manifestFile, { force: true });
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

function writePrivateManifestFile(file: string, raw: string): void {
  if (Buffer.byteLength(raw) > MAX_CHECKPOINT_MANIFEST_BYTES) {
    throw new Error("checkpoint metadata manifest exceeded its fixed 64-KiB limit");
  }
  fs.writeFileSync(file, raw, { flag: "wx", mode: 0o600 });
  const fd = fs.openSync(file, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function recoveryManifestSourceFiles(projectRoot: string, id: string): Array<{
  slot: number;
  file: string;
}> {
  return Array.from({ length: MAX_CHECKPOINT_RECOVERY_MANIFESTS }, (_unused, slot) => [
    { slot, file: checkpointRecoveryManifestFile(projectRoot, id, slot) },
    { slot, file: checkpointRecoveryPromotionFile(projectRoot, id, slot) },
  ]).flat();
}

function hasRecoveryManifest(projectRoot: string, id: string): boolean {
  return recoveryManifestSourceFiles(projectRoot, id).some(({ file }) => fs.existsSync(file));
}

function readRecoveryClaim(projectRoot: string, id: string, slot: number): CheckpointRecoveryClaim | undefined {
  const file = checkpointRecoveryClaimFile(projectRoot, id, slot);
  let raw: Buffer;
  try {
    raw = readBoundedBuffer(file, 1024, "manifest", "checkpoint recovery claim");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw corrupt("manifest", "checkpoint recovery claim is corrupt JSON");
  }
  if (!value || typeof value !== "object") {
    throw corrupt("manifest", "checkpoint recovery claim must be a JSON object");
  }
  const claim = value as Partial<CheckpointRecoveryClaim>;
  if (claim.schemaVersion !== 1 || !Number.isSafeInteger(claim.pid) || (claim.pid ?? 0) < 1
    || (claim.nonce !== undefined
      && (typeof claim.nonce !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(claim.nonce)))) {
    throw corrupt("manifest", "checkpoint recovery claim fields are invalid");
  }
  return claim as CheckpointRecoveryClaim;
}

function readRecoveryRelease(
  projectRoot: string,
  id: string,
  slot: number
): CheckpointRecoveryRelease | undefined {
  const file = checkpointRecoveryReleaseFile(projectRoot, id, slot);
  let raw: Buffer;
  try {
    raw = readBoundedBuffer(file, 1024, "manifest", "checkpoint recovery release");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw corrupt("manifest", "checkpoint recovery release is corrupt JSON");
  }
  if (!value || typeof value !== "object") {
    throw corrupt("manifest", "checkpoint recovery release must be a JSON object");
  }
  const release = value as Partial<CheckpointRecoveryRelease>;
  if (release.schemaVersion !== 1 || typeof release.nonce !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(release.nonce)) {
    throw corrupt("manifest", "checkpoint recovery release fields are invalid");
  }
  return release as CheckpointRecoveryRelease;
}

function checkpointTransactionKey(
  projectRoot: string,
  id: string,
  slot: number,
  nonce: string
): string {
  return `${checkpointRecoveryClaimFile(projectRoot, id, slot)}\0${nonce}`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

function recoveryClaimIsActive(
  projectRoot: string,
  id: string,
  slot: number,
  claim: CheckpointRecoveryClaim
): boolean {
  if (claim.nonce !== undefined) {
    const key = checkpointTransactionKey(projectRoot, id, slot, claim.nonce);
    if (retiredCheckpointTransactions.has(key)) return false;
    let release: CheckpointRecoveryRelease | undefined;
    try {
      release = readRecoveryRelease(projectRoot, id, slot);
    } catch (error) {
      // A malformed unowned release marker cannot prove abandonment. Keep a
      // live/unknown owner conservative, but a definitely dead foreign PID is
      // still safe to recover and must not wedge portable replacement forever.
      if (error instanceof CheckpointReadError) return processIsAlive(claim.pid);
      throw error;
    }
    if (release?.nonce === claim.nonce) return false;
    if (activeCheckpointTransactions.has(key)) return true;
    // Worker threads share process.pid but have isolate-local module state.
    // A current-PID nonce unknown to this isolate therefore remains active
    // unless its exact durable release marker was observed above.
    if (claim.pid === process.pid) return true;
  }
  return processIsAlive(claim.pid);
}

function releaseCheckpointTransaction(
  projectRoot: string,
  id: string,
  transaction: CheckpointTransaction
): void {
  const key = checkpointTransactionKey(projectRoot, id, transaction.slot, transaction.nonce);
  const claim = readRecoveryClaim(projectRoot, id, transaction.slot);
  if (!claim || claim.pid !== process.pid || claim.nonce !== transaction.nonce) {
    activeCheckpointTransactions.delete(key);
    retiredCheckpointTransactions.delete(key);
    return;
  }
  const releaseFile = checkpointRecoveryReleaseFile(projectRoot, id, transaction.slot);
  const raw = JSON.stringify({ schemaVersion: 1, nonce: transaction.nonce });
  let durableRelease = false;
  try {
    try {
      writePrivateManifestFile(releaseFile, raw);
      syncDirectory(checkpointsDirectory(projectRoot));
      durableRelease = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readRecoveryRelease(projectRoot, id, transaction.slot);
      if (current?.nonce !== transaction.nonce) {
        throw corrupt("manifest", `checkpoint ${id} recovery slot was released by a different transaction`);
      }
      durableRelease = true;
    }
  } finally {
    // Even a failed durable-release write ends this synchronous operation.
    // Same-process retries may reclaim the exact nonce from the registry;
    // other processes still conservatively honor the live PID until a marker
    // is durable or that process exits.
    activeCheckpointTransactions.delete(key);
    if (durableRelease) retiredCheckpointTransactions.delete(key);
    else retiredCheckpointTransactions.add(key);
  }
}

function acquireRecoverySlotCleaning(
  projectRoot: string,
  id: string,
  slot: number
): string | undefined {
  const file = checkpointRecoveryCleaningFile(projectRoot, id, slot);
  const claim: CheckpointRecoveryCleaningClaim = {
    schemaVersion: 1,
    pid: process.pid,
    nonce: randomUUID(),
  };
  try {
    writePrivateManifestFile(file, JSON.stringify(claim));
    syncDirectory(checkpointsDirectory(projectRoot));
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

function releaseRecoverySlotCleaning(projectRoot: string, file: string): void {
  try {
    fs.rmSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    // Any failed release consumes this one fixed slot rather than throwing
    // after reservation has already created an active transaction and losing
    // the caller's only handle to release it safely.
    return;
  }
  try {
    syncDirectory(checkpointsDirectory(projectRoot));
  } catch {
    // Namespace sync failure is likewise fail-closed at this slot. It must not
    // override a completed reservation or cleanup operation.
  }
}

function recoverySlotHasPrivateState(projectRoot: string, id: string, slot: number): boolean {
  return [
    checkpointRecoveryClaimFile(projectRoot, id, slot),
    checkpointRecoveryReleaseFile(projectRoot, id, slot),
    checkpointRecoveryManifestFile(projectRoot, id, slot),
    checkpointRecoveryPromotionFile(projectRoot, id, slot),
    checkpointRecoveryDisplacedFile(projectRoot, id, slot),
    checkpointRecoveryPayloadTemporaryFile(projectRoot, id, slot),
  ].some((file) => fs.existsSync(file));
}

function reserveCheckpointTransaction(projectRoot: string, id: string): CheckpointTransaction {
  const directory = checkpointsDirectory(projectRoot);
  for (let slot = 0; slot < MAX_CHECKPOINT_RECOVERY_MANIFESTS; slot++) {
    const cleaning = acquireRecoverySlotCleaning(projectRoot, id, slot);
    if (!cleaning) continue;
    try {
      // A returned failure is normally durably released even while its
      // process continues running. Reclaim only that exact release (or an
      // exact nonce retired by this isolate). Markerless crash records stay
      // intact until a canonical pair has been verified.
      let existingClaim: CheckpointRecoveryClaim | undefined;
      try {
        existingClaim = readRecoveryClaim(projectRoot, id, slot);
      } catch (error) {
        if (error instanceof CheckpointReadError) continue;
        throw error;
      }
      if (existingClaim) {
        let explicitlyReleased = false;
        if (existingClaim.nonce !== undefined) {
          const key = checkpointTransactionKey(projectRoot, id, slot, existingClaim.nonce);
          explicitlyReleased = retiredCheckpointTransactions.has(key);
          if (!explicitlyReleased) {
            try {
              explicitlyReleased = readRecoveryRelease(projectRoot, id, slot)?.nonce === existingClaim.nonce;
            } catch (error) {
              // A corrupt/torn release marker quarantines this one slot.
              if (error instanceof CheckpointReadError) continue;
              throw error;
            }
          }
        }
        if (!explicitlyReleased) continue;
        cleanupRecoverySlotLocked(projectRoot, id, slot);
        if (recoverySlotHasPrivateState(projectRoot, id, slot)) continue;
      } else {
        cleanupRecoverySlotLocked(projectRoot, id, slot);
        if (recoverySlotHasPrivateState(projectRoot, id, slot)) continue;
      }

      const claimFile = checkpointRecoveryClaimFile(projectRoot, id, slot);
      const temporary = checkpointRecoveryPayloadTemporaryFile(projectRoot, id, slot);
      const nonce = randomUUID();
      try {
        writePrivateManifestFile(claimFile, JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce }));
        syncDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        continue;
      }
      try {
        fs.writeFileSync(temporary, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
        syncDirectory(directory);
        activeCheckpointTransactions.add(checkpointTransactionKey(projectRoot, id, slot, nonce));
        return { slot, nonce, temporary };
      } catch (error) {
        fs.rmSync(claimFile, { force: true });
        syncDirectory(directory);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      releaseRecoverySlotCleaning(projectRoot, cleaning);
    }
  }
  throw new CheckpointReadError(
    "resource_limit",
    "manifest",
    `checkpoint ${id} has reached its bounded ${MAX_CHECKPOINT_RECOVERY_MANIFESTS}-file recovery-manifest limit; complete or remove the stale transaction before retrying`,
    MAX_CHECKPOINT_RECOVERY_MANIFESTS,
    MAX_CHECKPOINT_RECOVERY_MANIFESTS
  );
}

function writeRecoveryManifest(
  projectRoot: string,
  id: string,
  slot: number,
  raw: string
): void {
  const file = checkpointRecoveryManifestFile(projectRoot, id, slot);
  writePrivateManifestFile(file, raw);
  syncDirectory(checkpointsDirectory(projectRoot));
}

function readRecoveryManifest(file: string, id: string, slot: number): RecoveryManifest {
  const stored = readBoundedBuffer(
    file,
    MAX_CHECKPOINT_MANIFEST_BYTES,
    "manifest",
    "checkpoint recovery manifest"
  );
  const raw = stored.toString("utf8");
  return { slot, file, raw, manifest: parseManifest(raw, id), sizeBytes: stored.length };
}

function manifestMatchesVisiblePayload(
  projectRoot: string,
  id: string,
  file: string,
  manifest: CheckpointArtifactManifest,
  payload: { sizeBytes: number; sha256: string },
  relative: string,
  checkpoint: SharedSearchCheckpoint
): boolean {
  const storageEncoding = file.endsWith(".gz") ? "gzip" : "json";
  try {
    validateStoredEntrypoint(projectRoot, manifest.entrypoint, "manifest");
  } catch {
    return false;
  }
  return manifest.id === id
    && manifest.storageEncoding === storageEncoding
    && manifest.artifactSizeBytes === payload.sizeBytes
    && manifest.artifactSha256 === payload.sha256
    && expectedManifestMatchesCheckpoint(manifest, relative, checkpoint);
}

function matchingRecoveryManifest(
  projectRoot: string,
  id: string,
  file: string,
  payload: { sizeBytes: number; sha256: string },
  relative: string,
  checkpoint: SharedSearchCheckpoint
): RecoveryManifest | undefined {
  for (const candidate of recoveryManifestSourceFiles(projectRoot, id)) {
    try {
      const recovery = readRecoveryManifest(candidate.file, id, candidate.slot);
      if (manifestMatchesVisiblePayload(
        projectRoot,
        id,
        file,
        recovery.manifest,
        payload,
        relative,
        checkpoint
      )) return recovery;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof CheckpointReadError) continue;
      throw error;
    }
  }
  return undefined;
}

function readMatchingCanonicalManifest(
  projectRoot: string,
  id: string,
  file: string,
  payload: { sizeBytes: number; sha256: string },
  relative: string,
  checkpoint: SharedSearchCheckpoint,
  expectedRaw?: string
): StoredCheckpointManifest | undefined {
  const manifestFile = checkpointManifestFile(projectRoot, id);
  try {
    const stored = readBoundedBuffer(
      manifestFile,
      MAX_CHECKPOINT_MANIFEST_BYTES,
      "manifest",
      "checkpoint metadata manifest"
    );
    const raw = stored.toString("utf8");
    const manifest = parseManifest(raw, id);
    // Parse/classify the canonical sidecar before comparing it with a v1
    // recovery record. A valid future schema is authoritative and must surface
    // as unsupported rather than being overwritten as an apparent mismatch.
    if (expectedRaw !== undefined && raw !== expectedRaw) return undefined;
    if (!manifestMatchesVisiblePayload(
      projectRoot,
      id,
      file,
      manifest,
      payload,
      relative,
      checkpoint
    )) return undefined;
    return { file: manifestFile, raw, manifest, sizeBytes: stored.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof CheckpointReadError) {
      if (error.kind !== "corrupt") throw error;
      return undefined;
    }
    throw error;
  }
}

function promoteRecoveryManifest(
  projectRoot: string,
  id: string,
  file: string,
  payload: { sizeBytes: number; sha256: string },
  relative: string,
  checkpoint: SharedSearchCheckpoint,
  recovery: RecoveryManifest
): StoredCheckpointManifest {
  const directory = checkpointsDirectory(projectRoot);
  const destination = checkpointManifestFile(projectRoot, id);
  const promotion = checkpointRecoveryPromotionFile(projectRoot, id, recovery.slot);
  const displaced = checkpointRecoveryDisplacedFile(projectRoot, id, recovery.slot);
  const matches = () => readMatchingCanonicalManifest(
    projectRoot,
    id,
    file,
    payload,
    relative,
    checkpoint,
    recovery.raw
  );
  const alreadyPublished = matches();
  if (alreadyPublished) return alreadyPublished;

  try {
    fs.linkSync(recovery.file, destination);
    syncDirectory(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const concurrent = matches();
    if (concurrent) return concurrent;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
    try {
      if (recovery.file !== promotion) {
        try {
          fs.linkSync(recovery.file, promotion);
          syncDirectory(directory);
        } catch (linkError) {
          const linkCode = (linkError as NodeJS.ErrnoException).code;
          if (linkCode === "ENOENT") {
            const completed = matches();
            if (completed) return completed;
          }
          if (linkCode !== "EEXIST") throw linkError;
          const held = readRecoveryManifest(promotion, id, recovery.slot);
          if (held.raw !== recovery.raw) {
            throw corrupt("manifest", `checkpoint ${id} recovery promotion slot contains different metadata`);
          }
        }
      }
      try {
        // POSIX atomically replaces an orphan/corrupt sidecar here. Some
        // Windows filesystems reject rename-over-existing, so the fallback
        // below preserves the durable recovery file across its replace gap.
        if (process.env.NODE_ENV === "test"
          && process.env.INKCHECK_TEST_CHECKPOINT_FORCE_WINDOWS_REPLACE === "1") {
          const forced = new Error("simulated Windows rename-over-existing rejection") as NodeJS.ErrnoException;
          forced.code = "EPERM";
          throw forced;
        }
        fs.renameSync(promotion, destination);
      } catch (renameError) {
        const completed = matches();
        if (completed) return completed;
        const renameCode = (renameError as NodeJS.ErrnoException).code;
        if (renameCode !== "EEXIST" && renameCode !== "EPERM" && renameCode !== "EACCES") {
          throw renameError;
        }
        checkpointTestBarrier("before-manifest-displacement");
        if (fs.existsSync(displaced)) {
          const ownerClaim = readRecoveryClaim(projectRoot, id, recovery.slot);
          const ownerIsActive = ownerClaim !== undefined
            && recoveryClaimIsActive(projectRoot, id, recovery.slot, ownerClaim);
          if (ownerIsActive) {
            if (process.env.NODE_ENV === "test"
              && process.env.INKCHECK_TEST_CHECKPOINT_JOIN_MARKER) {
              fs.writeFileSync(process.env.INKCHECK_TEST_CHECKPOINT_JOIN_MARKER, "joined");
            }
            // Another portable promoter owns the same bounded replace gap.
            // Join it by publishing from the shared durable promotion link;
            // if it wins first, strict canonical reread accepts the same bytes.
            try {
              fs.linkSync(promotion, destination);
              syncDirectory(directory);
            } catch (joinError) {
              const joinCode = (joinError as NodeJS.ErrnoException).code;
              const joined = matches();
              if (joined) return joined;
              if (joinCode !== "EEXIST" && joinCode !== "ENOENT") throw joinError;
              for (let attempt = 0; attempt < 80; attempt++) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
                const completedJoin = matches();
                if (completedJoin) return completedJoin;
              }
              throw corrupt(
                "manifest",
                `checkpoint ${id} bounded manifest replacement did not complete; retry from its recovery record`
              );
            }
            const joined = matches();
            if (joined) return joined;
            throw corrupt(
              "manifest",
              `checkpoint ${id} joined manifest replacement does not match its visible payload`
            );
          }
          // A returned failure durably releases its nonce even if that process
          // stays alive. Its restored canonical sidecar plus stale displaced
          // link is therefore safe to take over instead of being mistaken for
          // a live portable promoter forever.
          try {
            fs.rmSync(displaced);
            syncDirectory(directory);
          } catch (staleError) {
            if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
          }
          if (process.env.NODE_ENV === "test"
            && process.env.INKCHECK_TEST_CHECKPOINT_STALE_DISPLACED_MARKER) {
            fs.writeFileSync(process.env.INKCHECK_TEST_CHECKPOINT_STALE_DISPLACED_MARKER, "taken-over");
          }
        }
        try {
          fs.renameSync(destination, displaced);
          syncDirectory(directory);
        } catch (displaceError) {
          if ((displaceError as NodeJS.ErrnoException).code !== "ENOENT") throw displaceError;
        }
        checkpointTestBarrier("after-manifest-displacement");
        checkpointTestCrash("after-manifest-displacement");
        try {
          // Publish from the already-created private hard link. Another
          // promoter may have removed the original recovery pathname while
          // this writer held the replace gap.
          fs.linkSync(promotion, destination);
          syncDirectory(directory);
        } catch (publishError) {
          const raced = matches();
          if (!raced) {
            if (!fs.existsSync(destination) && fs.existsSync(displaced)) {
              try {
                fs.linkSync(displaced, destination);
                syncDirectory(directory);
                fs.rmSync(displaced, { force: true });
                syncDirectory(directory);
              } catch {
                // Preserve both bounded files if restoration races or fails.
              }
            }
            throw publishError;
          }
        }
      }
      syncDirectory(directory);
      const published = matches();
      if (!published) {
        throw corrupt(
          "manifest",
          `checkpoint ${id} recovery metadata could not be verified after publication`
        );
      }
      return published;
    } catch (promotionError) {
      const completed = matches();
      if (completed) return completed;
      throw promotionError;
    }
  }

  const published = matches();
  if (!published) {
    throw corrupt("manifest", `checkpoint ${id} recovery metadata does not match its visible payload`);
  }
  return published;
}

function cleanupRecoverySlotLocked(
  projectRoot: string,
  id: string,
  slot: number,
  expectedTransaction?: CheckpointTransaction
): void {
  const directory = checkpointsDirectory(projectRoot);
  let claim: CheckpointRecoveryClaim | undefined;
  try {
    claim = readRecoveryClaim(projectRoot, id, slot);
  } catch (error) {
    // An unowned corrupt claim cannot be safely attributed or released.
    if (!expectedTransaction) return;
    throw error;
  }
  if (!claim) {
    // The fixed cleaning claim excludes reservation, so claimless companions
    // are abandoned state and cannot be replaced underneath this cleanup.
    let removed = false;
    for (const candidate of [
      checkpointRecoveryManifestFile(projectRoot, id, slot),
      checkpointRecoveryPromotionFile(projectRoot, id, slot),
      checkpointRecoveryDisplacedFile(projectRoot, id, slot),
      checkpointRecoveryPayloadTemporaryFile(projectRoot, id, slot),
      checkpointRecoveryReleaseFile(projectRoot, id, slot),
    ]) {
      try {
        fs.rmSync(candidate);
        removed = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EPERM" || code === "EBUSY" || code === "EACCES") continue;
        throw error;
      }
    }
    if (expectedTransaction) {
      const key = checkpointTransactionKey(
        projectRoot,
        id,
        slot,
        expectedTransaction.nonce
      );
      activeCheckpointTransactions.delete(key);
      retiredCheckpointTransactions.delete(key);
    }
    if (removed) syncDirectory(directory);
    return;
  }
  if (expectedTransaction) {
    if (claim.pid !== process.pid || claim.nonce !== expectedTransaction.nonce
      || slot !== expectedTransaction.slot) return;
  } else if (recoveryClaimIsActive(projectRoot, id, slot, claim)) {
    return;
  }

  let removed = false;
  let complete = true;
  for (const candidate of [
    checkpointRecoveryManifestFile(projectRoot, id, slot),
    checkpointRecoveryPromotionFile(projectRoot, id, slot),
    checkpointRecoveryDisplacedFile(projectRoot, id, slot),
    checkpointRecoveryPayloadTemporaryFile(projectRoot, id, slot),
  ]) {
    try {
      fs.rmSync(candidate);
      removed = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      // Windows can refuse to unlink a still-open slot. Keep its claim so the
      // pathname cannot be reused until the owner or a later recovery succeeds.
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        complete = false;
        continue;
      }
      throw error;
    }
  }
  if (complete) {
    try {
      fs.rmSync(checkpointRecoveryClaimFile(projectRoot, id, slot));
      removed = true;
      if (claim.nonce !== undefined) {
        const key = checkpointTransactionKey(projectRoot, id, slot, claim.nonce);
        activeCheckpointTransactions.delete(key);
        retiredCheckpointTransactions.delete(key);
      }
      try {
        fs.rmSync(checkpointRecoveryReleaseFile(projectRoot, id, slot));
        removed = true;
      } catch (releaseError) {
        const releaseCode = (releaseError as NodeJS.ErrnoException).code;
        if (releaseCode !== "ENOENT" && releaseCode !== "EPERM"
          && releaseCode !== "EBUSY" && releaseCode !== "EACCES") throw releaseError;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
      // The release marker, when present, stays beside a claim that could not
      // be removed. A later cleanup can retry without misclassifying the live
      // PID as a new transaction.
    }
  }
  if (removed) syncDirectory(directory);
}

function cleanupRecoverySlot(
  projectRoot: string,
  id: string,
  slot: number,
  expectedTransaction?: CheckpointTransaction
): void {
  const cleaning = acquireRecoverySlotCleaning(projectRoot, id, slot);
  if (!cleaning) return;
  try {
    cleanupRecoverySlotLocked(projectRoot, id, slot, expectedTransaction);
  } finally {
    releaseRecoverySlotCleaning(projectRoot, cleaning);
  }
}

function cleanupRecoveryManifests(
  projectRoot: string,
  id: string,
  expectedTransaction?: CheckpointTransaction
): void {
  for (let slot = 0; slot < MAX_CHECKPOINT_RECOVERY_MANIFESTS; slot++) {
    cleanupRecoverySlot(
      projectRoot,
      id,
      slot,
      slot === expectedTransaction?.slot ? expectedTransaction : undefined
    );
  }
}

function recoverPublishedCheckpoint(
  projectRoot: string,
  relative: string,
  id: string,
  checkpoint: SharedSearchCheckpoint,
  limits: Required<CheckpointStorageLimits>,
  expectedTransaction?: CheckpointTransaction
): RecoveredCheckpointPair | undefined {
  // Healthy canonical pairs stay metadata-only here. Probe the fixed slot set
  // before opening or hashing a potentially very large payload.
  if (!hasRecoveryManifest(projectRoot, id)) return undefined;
  const file = checkpointFile(projectRoot, id);
  if (!fs.existsSync(file)) return undefined;
  const digestLimit = Math.min(
    limits.maxCheckpointBytes,
    limits.maxProjectBytes
  );
  const payload = fileDigest(file, digestLimit);
  const recovery = matchingRecoveryManifest(
    projectRoot,
    id,
    file,
    payload,
    relative,
    checkpoint
  );
  if (!recovery) return undefined;
  promoteRecoveryManifest(
    projectRoot,
    id,
    file,
    payload,
    relative,
    checkpoint,
    recovery
  );
  // Reopen and hash the payload after manifest publication. This closes the
  // prune/replacement window: recovery metadata is retained if the path now
  // names different bytes (or a different regular file where inode identity
  // is available), even when the first digest happened to match.
  const verifiedPayload = fileDigest(file, digestLimit);
  if (!samePayloadDigest(payload, verifiedPayload)) {
    throw corrupt(
      "storage",
      `checkpoint ${id} payload changed while its recovery metadata was being published; retry from the durable recovery record`
    );
  }
  const verifiedManifest = readMatchingCanonicalManifest(
    projectRoot,
    id,
    file,
    verifiedPayload,
    relative,
    checkpoint,
    recovery.raw
  );
  if (!verifiedManifest) {
    throw corrupt(
      "manifest",
      `checkpoint ${id} metadata changed before its recovered pair could be verified`
    );
  }
  // The canonical manifest has now been reread, parsed, checksum-checked, and
  // matched against the rehashed visible payload. Only this point permits
  // recovery cleanup; a crash before it leaves enough durable metadata to retry.
  cleanupRecoveryManifests(projectRoot, id, expectedTransaction);
  return {
    manifest: verifiedManifest.manifest,
    metadataSizeBytes: verifiedManifest.sizeBytes,
    payloadSizeBytes: verifiedPayload.sizeBytes,
    payloadSha256: verifiedPayload.sha256,
  };
}

type CheckpointTestStage =
  | "after-recovery-manifest"
  | "after-payload-publication"
  | "after-legacy-manifest-temporary"
  | "before-manifest-displacement"
  | "after-manifest-displacement";

function checkpointTestBarrier(stage: CheckpointTestStage): void {
  const gate = process.env.INKCHECK_TEST_CHECKPOINT_GATE;
  if (process.env.NODE_ENV !== "test" || !gate
    || process.env.INKCHECK_TEST_CHECKPOINT_GATE_STAGE !== stage) return;
  fs.writeFileSync(`${gate}.${process.pid}.ready`, stage);
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(gate)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for checkpoint test gate at ${stage}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}

function checkpointTestCrash(stage: CheckpointTestStage): void {
  if (process.env.NODE_ENV === "test"
    && process.env.INKCHECK_TEST_CHECKPOINT_CRASH_STAGE === stage) {
    process.exit(86);
  }
}

function publishCheckpointManifest(
  projectRoot: string,
  id: string,
  raw: string
): void {
  const directory = checkpointsDirectory(projectRoot);
  const destination = checkpointManifestFile(projectRoot, id);
  const bytes = Buffer.from(raw);
  if (bytes.length > MAX_CHECKPOINT_MANIFEST_BYTES) {
    throw new Error("checkpoint metadata manifest exceeded its fixed 64-KiB limit");
  }
  // Sidecar-free v1 compatibility publication shares the same fixed 32-slot
  // namespace as new checkpoint transactions. A crash can therefore leave at
  // most one bounded private file per claimed slot, never UUID-named debris.
  const transaction = reserveCheckpointTransaction(projectRoot, id);
  try {
    const fd = fs.openSync(transaction.temporary, "r+");
    try {
      fs.ftruncateSync(fd, 0);
      let offset = 0;
      while (offset < bytes.length) {
        offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDirectory(directory);
    checkpointTestCrash("after-legacy-manifest-temporary");
    try {
      fs.linkSync(transaction.temporary, destination);
      syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readBoundedBuffer(
        destination,
        MAX_CHECKPOINT_MANIFEST_BYTES,
        "manifest",
        "checkpoint metadata manifest"
      ).toString("utf8");
      if (current !== raw) {
        throw corrupt("manifest", `checkpoint ${id} already has different metadata; reopen it before saving`);
      }
    }
  } finally {
    releaseCheckpointTransaction(projectRoot, id, transaction);
    cleanupRecoverySlot(projectRoot, id, transaction.slot, transaction);
  }
}

function enforceDurableCheckpointLimits(
  bytes: number,
  limits: Required<CheckpointStorageLimits>
): void {
  if (bytes > limits.maxCheckpointBytes) {
    throw new CheckpointSizeLimitError("single", bytes, limits.maxCheckpointBytes);
  }
  if (bytes > limits.maxProjectBytes) {
    throw new CheckpointSizeLimitError("project", bytes, limits.maxProjectBytes);
  }
}

function expectedManifestMatchesCheckpoint(
  manifest: CheckpointArtifactManifest,
  relative: string,
  checkpoint: SharedSearchCheckpoint
): boolean {
  return manifest.entrypoint === relative
    && manifest.engine === checkpoint.engine
    && manifest.totalGranted === checkpoint.state.totalGranted
    && manifest.statesExplored === checkpoint.state.statesExplored;
}

async function reuseCheckpointArtifact(
  root: string,
  relative: string,
  id: string,
  checkpoint: SharedSearchCheckpoint,
  limits: Required<CheckpointStorageLimits>,
  expectedTransaction?: CheckpointTransaction
): Promise<CheckpointArtifactReference> {
  const directory = checkpointsDirectory(root);
  const existing = checkpointFile(root, id);
  let sizeBytes: number;
  const recovered = recoverPublishedCheckpoint(root, relative, id, checkpoint, limits, expectedTransaction);
  if (recovered) {
    sizeBytes = recovered.payloadSizeBytes + recovered.metadataSizeBytes;
  } else {
    try {
      const loaded = loadArtifactDetailed(root, id);
      const manifestFile = checkpointManifestFile(root, id);
      if (!fs.existsSync(manifestFile)) {
        const manifest = manifestForArtifact(
          loaded.artifact,
          loaded.storageEncoding,
          loaded.payloadSizeBytes,
          loaded.payloadSha256
        );
        const raw = serializedManifest(manifest);
        enforceDurableCheckpointLimits(loaded.payloadSizeBytes + Buffer.byteLength(raw), limits);
        publishCheckpointManifest(root, id, raw);
      }
      sizeBytes = summary(root, loaded).sizeBytes;
    } catch (error) {
      // Schema v1 may exceed the process string ceiling even though its stored
      // bytes are durable. Reuse is allowed only when the canonical manifest
      // matches this exact requested checkpoint and a fixed-memory full payload
      // digest verifies the otherwise-unparseable bytes.
      if (!(error instanceof CheckpointReadError) || error.kind !== "resource_limit") throw error;
      if (!fs.existsSync(checkpointManifestFile(root, id))) throw error;
      const { manifest, sizeBytes: metadataSizeBytes } = readCheckpointManifest(root, id);
      validateManifestStorage(root, id, existing, manifest);
      if (!expectedManifestMatchesCheckpoint(manifest, relative, checkpoint)) {
        throw corrupt("manifest", "checkpoint metadata manifest does not match the requested saved frontier");
      }
      sizeBytes = manifest.artifactSizeBytes + metadataSizeBytes;
      // Refuse an already-oversized durable pair from metadata alone before
      // spending I/O on its full fixed-memory checksum.
      enforceDurableCheckpointLimits(sizeBytes, limits);
      if (!error.payloadVerified) {
        verifyManifestPayload(
          existing,
          manifest,
          Math.min(limits.maxCheckpointBytes, limits.maxProjectBytes)
        );
      }
    }
    // A complete canonical pair makes any older recovery-only records for the
    // same stable ID redundant. They are invisible to list/prune throughout.
    cleanupRecoveryManifests(root, id, expectedTransaction);
  }
  enforceDurableCheckpointLimits(sizeBytes, limits);
  if (process.platform !== "win32") {
    fs.chmodSync(existing, 0o600);
    const manifestFile = checkpointManifestFile(root, id);
    if (fs.existsSync(manifestFile)) fs.chmodSync(manifestFile, 0o600);
  }
  const pruned = pruneCheckpoints(root, id, limits);
  if (pruned.length > 0) syncDirectory(directory);
  const encoding = checkpointFile(root, id).endsWith(".gz") ? "gzip" : "json";
  return { id, path: checkpointRelativePath(id, encoding), pruned };
}

async function saveCheckpointArtifactExclusive(
  root: string,
  relative: string,
  id: string,
  checkpoint: SharedSearchCheckpoint,
  limits: Required<CheckpointStorageLimits>
): Promise<CheckpointArtifactReference> {
  const directory = checkpointsDirectory(root);
  const destination = checkpointDestination(root, id);
  const existing = checkpointFile(root, id);
  if (fs.existsSync(existing)) return reuseCheckpointArtifact(root, relative, id, checkpoint, limits);
  // Validate the existing retention set before creating a new durable file.
  // Corrupt old state must not turn a successful write into a partial cleanup.
  try {
    checkpointRecords(root);
  } catch (error) {
    // A same-ID writer can publish between the initial existence check and
    // retention validation. Reopen its durable transaction instead of making
    // validation inflate a sidecar-free (and potentially huge) frontier.
    if (fs.existsSync(checkpointFile(root, id))) {
      return reuseCheckpointArtifact(root, relative, id, checkpoint, limits);
    }
    throw error;
  }
  if (fs.existsSync(checkpointFile(root, id))) {
    return reuseCheckpointArtifact(root, relative, id, checkpoint, limits);
  }
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
  const transaction = reserveCheckpointTransaction(root, id);
  const temporary = transaction.temporary;
  let publishedPayload = false;
  let completedPair = false;
  try {
    const written = await writeCompressedArtifact(temporary, artifact, limits, true);
    const manifest = manifestForArtifact(artifact, "gzip", written.sizeBytes, written.sha256);
    const rawManifest = serializedManifest(manifest);
    enforceDurableCheckpointLimits(written.sizeBytes + Buffer.byteLength(rawManifest), limits);
    // The recovery manifest is the durable transaction intent. It is fsynced,
    // then its directory is fsynced, before payload bytes can become visible.
    writeRecoveryManifest(root, id, transaction.slot, rawManifest);
    checkpointTestBarrier("after-recovery-manifest");
    checkpointTestCrash("after-recovery-manifest");
    try {
      fs.linkSync(temporary, destination);
      publishedPayload = true;
      syncDirectory(directory);
      checkpointTestCrash("after-payload-publication");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const reference = await reuseCheckpointArtifact(
      root,
      relative,
      id,
      checkpoint,
      limits,
      transaction
    );
    completedPair = true;
    return reference;
  } catch (error) {
    // Once another writer has completed the canonical pair, its verified
    // cleanup may unlink this loser's private slot while an fd is still open.
    // Treat an ensuing path-level ENOENT as loss of the no-clobber race and
    // reopen the winner; a corrupt/orphan final still fails closed there.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fs.existsSync(destination)) {
      const reference = await reuseCheckpointArtifact(
        root,
        relative,
        id,
        checkpoint,
        limits,
        transaction
      );
      completedPair = true;
      return reference;
    }
    throw error;
  } finally {
    // Publish a durable exact-nonce release before this operation returns.
    // Other processes may then reclaim a failed transaction even though this
    // Node process remains alive, while concurrent same-process transactions
    // with different nonces stay protected.
    releaseCheckpointTransaction(root, id, transaction);
    // A losing candidate can never describe the visible payload and a fully
    // verified pair no longer needs this writer's candidate. The winner's
    // matching candidate remains durable across every earlier failure path.
    if (!publishedPayload || completedPair) {
      cleanupRecoverySlot(root, id, transaction.slot, transaction);
    }
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
  const limits = storageLimits(inputLimits);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  return saveCheckpointArtifactExclusive(root, relative, id, checkpoint, limits);
}

export function listCheckpointArtifacts(
  projectRoot: string,
  readLimits: CheckpointReadLimits = {}
): CheckpointArtifactSummary[] {
  return checkpointRecords(projectRoot, readLimits)
    .map(({ file: _file, manifestFile: _manifestFile, ...record }) => record)
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

export async function openCheckpointArtifact(
  projectRoot: string,
  id: string,
  readLimits: CheckpointReadLimits = {}
): Promise<{
  artifact: CheckpointArtifactSummary & { freshness: CheckpointFreshness };
}> {
  const loaded = loadArtifactDetailed(projectRoot, id, readLimits);
  const current = await freshness(projectRoot, loaded.artifact);
  return { artifact: { ...summary(projectRoot, loaded), freshness: current.freshness } };
}

export async function loadCheckpointForResume(
  projectRoot: string,
  id: string,
  readLimits: CheckpointReadLimits = {}
): Promise<{
  artifact: CheckpointArtifactSummary & { freshness: "current" };
  checkpoint: SharedSearchCheckpoint;
  entrypoint: string;
}> {
  const loaded = loadArtifactDetailed(projectRoot, id, readLimits);
  const current = await freshness(projectRoot, loaded.artifact);
  if (current.freshness !== "current") {
    throw new Error(`checkpoint ${id} is ${current.freshness}; resume requires the exact source and knot map used to create it`);
  }
  return {
    artifact: { ...summary(projectRoot, loaded), freshness: "current" },
    checkpoint: loaded.artifact.checkpoint,
    entrypoint: current.entrypoint,
  };
}
