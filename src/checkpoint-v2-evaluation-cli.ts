#!/usr/bin/env node
import { spawn, spawnSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as v8 from "v8";
import {
  CheckpointReadError,
  listCheckpointArtifacts,
  loadCheckpointForResume,
  saveCheckpointArtifact,
  saveCheckpointArtifactFromSource,
  type CheckpointArtifactReference,
} from "./checkpoints";
import { inspectProject } from "./discovery";
import {
  exploreShared,
  exploreSharedResumable,
  exploreSharedResumableWithCheckpointSource,
  type ExploreOptions,
  type ExploreResult,
  type SharedSearchCheckpoint,
} from "./explore";
import {
  compile,
  resolveInklecate,
  scanExternals,
  scanKnots,
  scanStorySemantics,
} from "./inklecate";
import { createResourceGuards } from "./resource-guards";
import { VERSION } from "./version";

const EVALUATION_KIND = "checkpoint_v2_promotion_evaluation";
const EVALUATION_ID = "checkpoint-v2-promotion-v1";
const INKLECATE_VERSION = "1.2.1";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_WORKER_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_WORKER_DIAGNOSTIC_BYTES = 64 * 1024;
const WORKER_KILL_GRACE_MS = 2_000;

const EXPECTED_CELL_CONTRACT = [
  ["heresy2-legacy-split", "heresy2", "legacy-split", 100_000, 150_000, "resume_exact"],
  ["heresy2-framed-split", "heresy2", "framed-split", 100_000, 150_000, "resume_exact"],
  ["heresy2-uninterrupted", "heresy2", "uninterrupted", 100_000, 150_000, "endpoint"],
  ["intercept-uninterrupted", "intercept", "uninterrupted", 600_000, 650_000, "endpoint"],
  ["intercept-framed-split", "intercept", "framed-split", 600_000, 650_000, "resume_exact"],
  ["intercept-legacy-split", "intercept", "legacy-split", 600_000, 650_000, "legacy_readback_resource_limit"],
] as const;

type CellMode = "legacy-split" | "framed-split" | "uninterrupted";
type CellExpectation = "resume_exact" | "endpoint" | "legacy_readback_resource_limit";

export interface CheckpointV2EvaluationSource {
  id: string;
  story: string;
  entrypointSha256: string;
  compiledStorySha256: string;
  closure: {
    includeCount: number;
    fileCount: number;
    bundleSha256: string;
  };
  provenance: {
    license: string;
    licenseFile: string;
    licenseSha256: string;
    upstream: string;
    commit: string;
  };
}

export interface CheckpointV2EvaluationCell {
  id: string;
  sourceId: string;
  mode: CellMode;
  baseStates: number;
  targetStates: number;
  expected: CellExpectation;
}

export interface CheckpointV2EvaluationControls {
  cellOrder: string[];
  maxDepth: number;
  searchSeed: number;
  storySeed: number;
  concurrency: number;
  minimizeRepros: boolean;
  stateSensitivity: "source_semantics";
  loopRiskDetection: "only_without_turns_randomness_visit_counts_or_externals";
  maxMemoryMb: number;
  maxTimeMs: number;
  workerTimeoutMs: number;
  coordinatorMaxOldSpaceMb: number;
  storage: {
    maxCheckpointBytes: number;
    maxProjectBytes: number;
    framedV2: { maxTotalDecodedBytes: number };
  };
}

export interface CheckpointV2EvaluationManifest {
  schemaVersion: 1;
  kind: typeof EVALUATION_KIND;
  id: typeof EVALUATION_ID;
  compiler: { name: "inklecate"; version: "1.2.1" };
  controls: CheckpointV2EvaluationControls;
  sources: CheckpointV2EvaluationSource[];
  cells: CheckpointV2EvaluationCell[];
}

interface Digest {
  sha256: string;
  utf8Bytes: number;
}

interface CompilerFingerprint {
  name: "inklecate";
  version: "1.2.1";
  executableSha256: string;
  resolutionClass: "environment_override" | "managed_cache" | "path";
}

interface ResultObservation {
  digest: Digest;
  statesExplored: number;
  exhaustive: boolean;
  truncated: boolean;
  truncatedBy: {
    maxDepth: boolean;
    maxStates: boolean;
    beamWidth: boolean;
    frontier: boolean;
    memory: boolean;
    time: boolean;
    loop: boolean;
    worker: boolean;
  };
  counts: {
    endings: number;
    visibleOutcomes: number;
    runtimeErrors: number;
    runtimeWarnings: number;
    visitedKnots: number;
    unvisitedKnots: number;
  };
}

interface CheckpointObservation {
  requestedFormat: "legacy-v1" | "framed-v2";
  storageEncoding: "gzip" | "framed-v2";
  id: string;
  logicalCheckpointUtf8Bytes: number;
  payloadSizeBytes: number;
  durableSizeBytes: number;
  write: {
    outcome: "created" | "reused";
    materializedCheckpointGraphs: number;
    engineSourceMaterializedGraphs: number | null;
    engineSourceIdentityPasses: number | null;
    engineSourceFramePasses: number | null;
    legacySerializationApplied: boolean;
    legacyCompressionApplied: boolean;
    framedV2Applied: boolean;
  };
  logicalCheckpoint?: Digest;
  readback: {
    status: "completed" | "resource_limit";
    storageEncoding?: "gzip" | "framed-v2";
    kind?: "resource_limit";
    stage?: "decompression";
    unit?: "bytes";
    observed?: number;
    limit?: number;
    payloadVerified?: boolean;
  };
  preservation: {
    payloadBytesUnchanged: boolean;
    listingUnchanged: boolean;
    listedBefore: number;
    listedAfter: number;
  };
}

export interface CompletedCheckpointV2EvaluationCase {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  mode: CellMode;
  expected: CellExpectation;
  status: "completed" | "inconclusive";
  reason?: "legacy_readback_succeeded";
  configuration: {
    baseStates: number;
    targetStates: number;
    maxDepth: number;
    searchSeed: number;
    storySeed: number;
    concurrency: 1;
    preserveTurnState: boolean;
    preserveRandomState: boolean;
    detectLoopRisks: boolean;
  };
  compiler: CompilerFingerprint;
  source: {
    fileCount: number;
    bundleSha256: string;
    compiledStorySha256: string;
  };
  elapsedMs: number;
  peakRssBytes: number;
  base?: ResultObservation;
  checkpoint?: CheckpointObservation;
  resumed?: ResultObservation;
  uninterrupted?: ResultObservation;
}

interface FailedEvaluationCase {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  mode: CellMode;
  expected: CellExpectation;
  status: "failed" | "unavailable";
  reason: string;
  timeoutMs?: number;
  cleanupScope?: ProcessCleanupScope;
}

type EvaluationCaseResult = CompletedCheckpointV2EvaluationCase | FailedEvaluationCase;

interface ValidatedSource {
  entrypoint: string;
  root: string;
  relativeFiles: string[];
  entrypointRelative: string;
  bundleSha256: string;
}

interface WorkerRequest {
  schemaVersion: 1;
  manifestRoot: string;
  cellRoot: string;
  source: CheckpointV2EvaluationSource;
  cell: CheckpointV2EvaluationCell;
  controls: CheckpointV2EvaluationControls;
}

interface WorkerError {
  schemaVersion: 1;
  kind: "checkpoint_v2_evaluation_worker_error";
  code: string;
}

type ProcessCleanupScope = "process_group" | "process_tree" | "exact_process";

export interface BoundedProcessResult {
  status: "completed" | "timeout" | "output_limit" | "spawn_error";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  cleanupScope?: ProcessCleanupScope;
}

export interface EvaluationProgressSnapshot {
  status: "in_progress" | "completed";
  selectedCellCount: number;
  recordedCellCount: number;
  recordedCellIds: string[];
  activeCellId?: string;
}

class EvaluationProtocolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvaluationProtocolError";
  }
}

function protocol(code: string): never {
  throw new EvaluationProtocolError(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) protocol(code);
}

function integer(value: unknown, min: number, max: number, code: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) protocol(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Match the checked InkBench corpus packaging: compiler JSON plus one final LF. */
function compiledStorySha256(value: string): string {
  const withoutFinalNewline = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n") ? value.slice(0, -1) : value;
  return sha256(`${withoutFinalNewline}\n`);
}

function regularFile(file: string, code: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    protocol(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) protocol(code);
}

function safeFile(root: string, relative: string, code: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0")) protocol(code);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, resolved);
  if (relation === "" || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    protocol(code);
  }
  regularFile(resolved, code);
  let realRoot: string;
  let realResolved: string;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
    realResolved = fs.realpathSync(resolved);
  } catch {
    protocol(code);
  }
  const realRelation = path.relative(realRoot, realResolved);
  if (realRelation === "" || realRelation === ".." || realRelation.startsWith(`..${path.sep}`)
    || path.isAbsolute(realRelation)) {
    protocol(code);
  }
  return resolved;
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
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
  if (typeof value !== "object") protocol("non_json_value");
  if (ancestors.has(value)) protocol("circular_json_value");
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

export function digestJson(value: unknown): Digest {
  const hash = createHash("sha256");
  let utf8Bytes = 0;
  for (const chunk of jsonChunks(value)) {
    hash.update(chunk);
    utf8Bytes += Buffer.byteLength(chunk);
    if (!Number.isSafeInteger(utf8Bytes)) protocol("json_digest_size_overflow");
  }
  return { sha256: hash.digest("hex"), utf8Bytes };
}

async function digestFile(file: string): Promise<{ sha256: string; bytes: number }> {
  regularFile(file, "digest_file_invalid");
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (!Number.isSafeInteger(bytes)) {
        input.destroy(new RangeError("file size exceeds safe integer range"));
        return;
      }
      hash.update(buffer);
    });
    input.on("error", reject);
    input.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), bytes };
}

function sourceClosure(entrypoint: string): ValidatedSource {
  let inspection: ReturnType<typeof inspectProject>;
  try {
    inspection = inspectProject(entrypoint);
  } catch {
    protocol("source_inspection_failed");
  }
  if (inspection.truncation.includes) protocol("source_include_closure_truncated");
  const root = path.dirname(path.resolve(entrypoint));
  const entrypointRelative = normalizeRelative(path.relative(root, path.resolve(entrypoint)));
  const relativeFiles = [...new Set([entrypointRelative, ...inspection.includes.map(normalizeRelative)])].sort();
  const hash = createHash("sha256");
  for (const relative of relativeFiles) {
    const file = safeFile(root, relative, "source_closure_file_invalid");
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return {
    entrypoint: path.resolve(entrypoint),
    root,
    relativeFiles,
    entrypointRelative,
    bundleSha256: hash.digest("hex"),
  };
}

export async function validateEvaluationSource(
  manifestRoot: string,
  source: CheckpointV2EvaluationSource
): Promise<ValidatedSource> {
  const entrypoint = safeFile(manifestRoot, source.story, "source_entrypoint_invalid");
  const entrypointDigest = await digestFile(entrypoint);
  if (entrypointDigest.sha256 !== source.entrypointSha256) protocol("source_entrypoint_sha256_drift");
  const license = safeFile(manifestRoot, source.provenance.licenseFile, "source_license_invalid");
  if ((await digestFile(license)).sha256 !== source.provenance.licenseSha256) {
    protocol("source_license_sha256_drift");
  }
  const closure = sourceClosure(entrypoint);
  if (closure.relativeFiles.length !== source.closure.fileCount) protocol("source_closure_file_count_drift");
  if (closure.relativeFiles.length - 1 !== source.closure.includeCount) protocol("source_include_count_drift");
  if (closure.bundleSha256 !== source.closure.bundleSha256) protocol("source_bundle_sha256_drift");
  return closure;
}

export function validateCheckpointV2EvaluationManifest(
  value: unknown
): asserts value is CheckpointV2EvaluationManifest {
  if (!isObject(value)) protocol("manifest_not_object");
  exactKeys(value, ["schemaVersion", "kind", "id", "compiler", "controls", "sources", "cells"], "manifest_keys");
  if (value.schemaVersion !== 1 || value.kind !== EVALUATION_KIND || value.id !== EVALUATION_ID) {
    protocol("manifest_identity");
  }
  if (!isObject(value.compiler)) protocol("manifest_compiler");
  exactKeys(value.compiler, ["name", "version"], "manifest_compiler_keys");
  if (value.compiler.name !== "inklecate" || value.compiler.version !== INKLECATE_VERSION) {
    protocol("manifest_compiler_pin");
  }
  if (!isObject(value.controls)) protocol("manifest_controls");
  const controls = value.controls;
  exactKeys(controls, [
    "cellOrder", "maxDepth", "searchSeed", "storySeed", "concurrency", "minimizeRepros",
    "stateSensitivity", "loopRiskDetection", "maxMemoryMb", "maxTimeMs", "workerTimeoutMs",
    "coordinatorMaxOldSpaceMb", "storage",
  ], "manifest_control_keys");
  const expectedOrder = EXPECTED_CELL_CONTRACT.map(([id]) => id);
  if (!Array.isArray(controls.cellOrder) || JSON.stringify(controls.cellOrder) !== JSON.stringify(expectedOrder)) {
    protocol("manifest_cell_order");
  }
  const exactControls: Array<[string, unknown]> = [
    ["maxDepth", 100], ["searchSeed", 7], ["storySeed", 1], ["concurrency", 1],
    ["minimizeRepros", false], ["stateSensitivity", "source_semantics"],
    ["loopRiskDetection", "only_without_turns_randomness_visit_counts_or_externals"],
    ["maxMemoryMb", 4096], ["maxTimeMs", 840_000], ["workerTimeoutMs", 900_000],
    ["coordinatorMaxOldSpaceMb", 6144],
  ];
  for (const [key, expected] of exactControls) if (controls[key] !== expected) protocol(`manifest_control_${key}`);
  if (!isObject(controls.storage)) protocol("manifest_storage");
  exactKeys(controls.storage, ["maxCheckpointBytes", "maxProjectBytes", "framedV2"], "manifest_storage_keys");
  if (controls.storage.maxCheckpointBytes !== 536_870_912 || controls.storage.maxProjectBytes !== 2_147_483_648) {
    protocol("manifest_storage_limits");
  }
  if (!isObject(controls.storage.framedV2)) protocol("manifest_framed_limits");
  exactKeys(controls.storage.framedV2, ["maxTotalDecodedBytes"], "manifest_framed_limit_keys");
  if (controls.storage.framedV2.maxTotalDecodedBytes !== 2_147_483_648) protocol("manifest_framed_limit");

  if (!Array.isArray(value.sources) || value.sources.length !== 2) protocol("manifest_sources");
  const sourceIds = new Set<string>();
  for (const raw of value.sources) {
    if (!isObject(raw)) protocol("manifest_source_object");
    exactKeys(raw, ["id", "story", "entrypointSha256", "compiledStorySha256", "closure", "provenance"], "manifest_source_keys");
    if (typeof raw.id !== "string" || !["heresy2", "intercept"].includes(raw.id) || sourceIds.has(raw.id)) {
      protocol("manifest_source_id");
    }
    sourceIds.add(raw.id);
    if (typeof raw.story !== "string" || !raw.story.endsWith(".ink")) protocol("manifest_source_story");
    for (const key of ["entrypointSha256", "compiledStorySha256"] as const) {
      if (typeof raw[key] !== "string" || !/^[0-9a-f]{64}$/.test(raw[key] as string)) protocol("manifest_source_sha256");
    }
    if (!isObject(raw.closure)) protocol("manifest_source_closure");
    exactKeys(raw.closure, ["includeCount", "fileCount", "bundleSha256"], "manifest_source_closure_keys");
    integer(raw.closure.includeCount, 0, 10_000, "manifest_source_include_count");
    integer(raw.closure.fileCount, 1, 10_001, "manifest_source_file_count");
    if (raw.closure.fileCount !== raw.closure.includeCount + 1
      || typeof raw.closure.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.closure.bundleSha256)) {
      protocol("manifest_source_closure_values");
    }
    if (!isObject(raw.provenance)) protocol("manifest_source_provenance");
    exactKeys(raw.provenance, ["license", "licenseFile", "licenseSha256", "upstream", "commit"], "manifest_source_provenance_keys");
    if (typeof raw.provenance.license !== "string" || typeof raw.provenance.licenseFile !== "string"
      || typeof raw.provenance.upstream !== "string" || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(raw.provenance.upstream)
      || typeof raw.provenance.commit !== "string" || !/^[0-9a-f]{40}$/.test(raw.provenance.commit)
      || typeof raw.provenance.licenseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.provenance.licenseSha256)) {
      protocol("manifest_source_provenance_values");
    }
  }
  if (JSON.stringify(value.sources.map((source) => source.id)) !== JSON.stringify(["heresy2", "intercept"])) {
    protocol("manifest_source_order");
  }

  if (!Array.isArray(value.cells) || value.cells.length !== EXPECTED_CELL_CONTRACT.length) protocol("manifest_cells");
  value.cells.forEach((raw, index) => {
    if (!isObject(raw)) protocol("manifest_cell_object");
    exactKeys(raw, ["id", "sourceId", "mode", "baseStates", "targetStates", "expected"], "manifest_cell_keys");
    const expected = EXPECTED_CELL_CONTRACT[index];
    const actual = [raw.id, raw.sourceId, raw.mode, raw.baseStates, raw.targetStates, raw.expected];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) protocol(`manifest_cell_contract_${index}`);
  });
}

function copySource(closure: ValidatedSource, destination: string): string {
  for (const relative of closure.relativeFiles) {
    const source = safeFile(closure.root, relative, "source_copy_input_invalid");
    const target = path.resolve(destination, relative);
    const relation = path.relative(path.resolve(destination), target);
    if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      protocol("source_copy_escape");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target);
  }
  return path.resolve(destination, closure.entrypointRelative);
}

function safeTemporaryRoot(root: string): string {
  const resolved = path.resolve(root);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    protocol("cell_root_not_isolated_temp");
  }
  return resolved;
}

function compilerResolutionClass(executable: string): CompilerFingerprint["resolutionClass"] {
  const env = process.env.INKLECATE_PATH;
  if (env && path.resolve(env) === path.resolve(executable)) return "environment_override";
  const managed = path.resolve(os.homedir(), ".cache", "inkcheck", `inklecate-${INKLECATE_VERSION}`);
  const relative = path.relative(managed, path.resolve(executable));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return "managed_cache";
  }
  return "path";
}

async function compilerFingerprint(): Promise<CompilerFingerprint> {
  const executable = await resolveInklecate();
  return {
    name: "inklecate",
    version: INKLECATE_VERSION,
    executableSha256: (await digestFile(executable)).sha256,
    resolutionClass: compilerResolutionClass(executable),
  };
}

function resultObservation(result: ExploreResult, expectedStates: number, controls: CheckpointV2EvaluationControls): ResultObservation {
  const causes = result.truncatedBy;
  const loopStopped = causes.loop === true;
  const workerStopped = causes.worker === true;
  if (result.statesExplored !== expectedStates || result.limits.maxStates !== expectedStates
    || result.limits.maxDepth !== controls.maxDepth || result.limits.seed !== controls.searchSeed
    || result.limits.storySeed !== controls.storySeed || result.truncated !== true
    || causes.maxStates !== true || causes.beamWidth !== false || causes.frontier !== false
    || causes.memory !== false || causes.time !== false || loopStopped || workerStopped) {
    protocol("unexpected_search_horizon");
  }
  const visibleOutcomes = new Set(result.endingsFound.map((ending) => ending.finalText.trim().replace(/\s+/g, " "))).size;
  return {
    digest: digestJson(result),
    statesExplored: result.statesExplored,
    exhaustive: result.exhaustive,
    truncated: result.truncated,
    truncatedBy: {
      maxDepth: causes.maxDepth,
      maxStates: causes.maxStates,
      beamWidth: causes.beamWidth,
      frontier: causes.frontier,
      memory: causes.memory,
      time: causes.time,
      loop: loopStopped,
      worker: workerStopped,
    },
    counts: {
      endings: result.endingsFound.length,
      visibleOutcomes,
      runtimeErrors: result.runtimeErrors.length,
      runtimeWarnings: result.runtimeWarnings.length,
      visitedKnots: result.visitedKnots.length,
      unvisitedKnots: result.unvisitedKnots.length,
    },
  };
}

function checkpointDigest(checkpoint: SharedSearchCheckpoint): Digest {
  return digestJson(checkpoint);
}

function checkpointSummary(
  projectRoot: string,
  reference: CheckpointArtifactReference,
  expectedEncoding: "gzip" | "framed-v2"
) {
  const records = listCheckpointArtifacts(projectRoot);
  const record = records.find((candidate) => candidate.id === reference.id);
  if (!record || record.storageEncoding !== expectedEncoding || records.length !== 1) {
    protocol("checkpoint_listing_mismatch");
  }
  return { records, record };
}

function searchOptions(
  states: number,
  controls: CheckpointV2EvaluationControls,
  semantics: ReturnType<typeof scanStorySemantics>,
  externals: string[],
  guards: ReturnType<typeof createResourceGuards>
): ExploreOptions {
  return {
    maxStates: states,
    maxDepth: controls.maxDepth,
    seed: controls.searchSeed,
    storySeed: controls.storySeed,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    randomnessDetected: semantics.usesRandomness,
    detectLoopRisks: !semantics.usesTurns && !semantics.usesRandomness
      && !semantics.usesVisitCounts && externals.length === 0,
    memoryGuard: guards.memoryGuard,
    timeGuard: guards.timeGuard,
  };
}

async function resumeFrom(
  storyJson: string,
  knots: ReturnType<typeof scanKnots>,
  externals: string[],
  options: ExploreOptions,
  checkpoint: SharedSearchCheckpoint
): Promise<ExploreResult> {
  const resumed = await exploreSharedResumableWithCheckpointSource(
    storyJson,
    knots,
    externals,
    options,
    () => undefined,
    checkpoint
  );
  return resumed.result;
}

function commonCase(
  source: CheckpointV2EvaluationSource,
  cell: CheckpointV2EvaluationCell,
  controls: CheckpointV2EvaluationControls,
  semantics: ReturnType<typeof scanStorySemantics>,
  externals: string[],
  compiler: CompilerFingerprint,
  closure: ValidatedSource,
  startedAt: number
) {
  return {
    schemaVersion: 1 as const,
    id: cell.id,
    sourceId: source.id,
    mode: cell.mode,
    expected: cell.expected,
    configuration: {
      baseStates: cell.baseStates,
      targetStates: cell.targetStates,
      maxDepth: controls.maxDepth,
      searchSeed: controls.searchSeed,
      storySeed: controls.storySeed,
      concurrency: 1 as const,
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      detectLoopRisks: !semantics.usesTurns && !semantics.usesRandomness
        && !semantics.usesVisitCounts && externals.length === 0,
    },
    compiler,
    source: {
      fileCount: closure.relativeFiles.length,
      bundleSha256: closure.bundleSha256,
      compiledStorySha256: source.compiledStorySha256,
    },
    elapsedMs: Date.now() - startedAt,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}

async function runLegacySplit(
  projectRoot: string,
  entrypoint: string,
  storyJson: string,
  knots: ReturnType<typeof scanKnots>,
  externals: string[],
  baseOptions: ExploreOptions,
  targetOptions: ExploreOptions,
  controls: CheckpointV2EvaluationControls,
  cell: CheckpointV2EvaluationCell
): Promise<{
  status: "completed" | "inconclusive";
  reason?: "legacy_readback_succeeded";
  base: ResultObservation;
  checkpoint: CheckpointObservation;
  resumed?: ResultObservation;
}> {
  const baseRun = exploreSharedResumable(storyJson, knots, externals, baseOptions);
  if (!baseRun.checkpoint) protocol("base_checkpoint_missing");
  const base = resultObservation(baseRun.result, cell.baseStates, controls);
  const originalCheckpoint = checkpointDigest(baseRun.checkpoint);
  const reference = await saveCheckpointArtifact(projectRoot, entrypoint, baseRun.checkpoint, {
    maxCheckpointBytes: controls.storage.maxCheckpointBytes,
    maxProjectBytes: controls.storage.maxProjectBytes,
  });
  if (reference.accounting.checkpointGraph.count !== 1 || reference.accounting.outcome !== "created"
    || reference.accounting.serialization.status !== "applied" || reference.accounting.compression.status !== "applied") {
    protocol("legacy_write_receipt_mismatch");
  }
  const before = checkpointSummary(projectRoot, reference, "gzip");
  const payloadFile = path.resolve(projectRoot, reference.path);
  const payloadBefore = await digestFile(payloadFile);
  const listingBefore = digestJson(before.records);
  const checkpoint: CheckpointObservation = {
    requestedFormat: "legacy-v1",
    storageEncoding: "gzip",
    id: reference.id,
    logicalCheckpointUtf8Bytes: reference.accounting.checkpointGraph.logicalUtf8Bytes,
    payloadSizeBytes: before.record.payloadSizeBytes,
    durableSizeBytes: before.record.sizeBytes,
    write: {
      outcome: reference.accounting.outcome,
      materializedCheckpointGraphs: reference.accounting.checkpointGraph.count,
      engineSourceMaterializedGraphs: null,
      engineSourceIdentityPasses: null,
      engineSourceFramePasses: null,
      legacySerializationApplied: true,
      legacyCompressionApplied: true,
      framedV2Applied: false,
    },
    logicalCheckpoint: originalCheckpoint,
    readback: { status: "completed" },
    preservation: {
      payloadBytesUnchanged: true,
      listingUnchanged: true,
      listedBefore: before.records.length,
      listedAfter: before.records.length,
    },
  };
  let loaded: Awaited<ReturnType<typeof loadCheckpointForResume>>;
  try {
    loaded = await loadCheckpointForResume(projectRoot, reference.id, {
      maxStoredBytes: controls.storage.maxCheckpointBytes,
      maxDecompressedBytes: controls.storage.maxCheckpointBytes,
    });
  } catch (error) {
    if (cell.expected !== "legacy_readback_resource_limit") protocol("legacy_readback_unexpected_failure");
    if (!(error instanceof CheckpointReadError) || error.kind !== "resource_limit"
      || error.stage !== "decompression" || error.unit !== "bytes") {
      protocol("legacy_readback_wrong_failure_type");
    }
    const afterRecords = listCheckpointArtifacts(projectRoot);
    const payloadAfter = await digestFile(payloadFile);
    const payloadBytesUnchanged = payloadBefore.bytes === payloadAfter.bytes && payloadBefore.sha256 === payloadAfter.sha256;
    const listingUnchanged = listingBefore.sha256 === digestJson(afterRecords).sha256;
    if (!payloadBytesUnchanged || !listingUnchanged || afterRecords.length !== before.records.length) {
      protocol("legacy_readback_mutated_artifact");
    }
    checkpoint.readback = {
      status: "resource_limit",
      kind: "resource_limit",
      stage: "decompression",
      unit: "bytes",
      ...(error.observed === undefined ? {} : { observed: error.observed }),
      ...(error.limit === undefined ? {} : { limit: error.limit }),
      payloadVerified: error.payloadVerified,
    };
    checkpoint.preservation = {
      payloadBytesUnchanged,
      listingUnchanged,
      listedBefore: before.records.length,
      listedAfter: afterRecords.length,
    };
    return { status: "completed", base, checkpoint };
  }
  const loadedDigest = checkpointDigest(loaded.checkpoint);
  if (loadedDigest.sha256 !== originalCheckpoint.sha256 || loadedDigest.utf8Bytes !== originalCheckpoint.utf8Bytes) {
    protocol("legacy_loaded_checkpoint_mismatch");
  }
  checkpoint.logicalCheckpoint = loadedDigest;
  checkpoint.readback = { status: "completed", storageEncoding: loaded.artifact.storageEncoding as "gzip" };
  const resumed = resultObservation(
    await resumeFrom(storyJson, knots, externals, targetOptions, loaded.checkpoint),
    cell.targetStates,
    controls
  );
  return cell.expected === "legacy_readback_resource_limit"
    ? { status: "inconclusive", reason: "legacy_readback_succeeded", base, checkpoint, resumed }
    : { status: "completed", base, checkpoint, resumed };
}

async function runFramedSplit(
  projectRoot: string,
  entrypoint: string,
  storyJson: string,
  knots: ReturnType<typeof scanKnots>,
  externals: string[],
  baseOptions: ExploreOptions,
  targetOptions: ExploreOptions,
  controls: CheckpointV2EvaluationControls,
  cell: CheckpointV2EvaluationCell
): Promise<{
  base: ResultObservation;
  checkpoint: CheckpointObservation;
  resumed: ResultObservation;
}> {
  const baseRun = await exploreSharedResumableWithCheckpointSource(
    storyJson,
    knots,
    externals,
    baseOptions,
    (source) => saveCheckpointArtifactFromSource(projectRoot, entrypoint, source, {
      format: "framed-v2",
      maxCheckpointBytes: controls.storage.maxCheckpointBytes,
      maxProjectBytes: controls.storage.maxProjectBytes,
      framedV2Limits: {
        maxTotalDecodedBytes: controls.storage.framedV2.maxTotalDecodedBytes,
      },
    })
  );
  if (!baseRun.checkpoint) protocol("framed_base_checkpoint_missing");
  const reference = baseRun.checkpoint;
  const engine = reference.accounting.engineSource;
  if (reference.accounting.outcome !== "created" || reference.accounting.checkpointGraph.count !== 0
    || !engine || engine.materializedCheckpointGraphs !== 0 || engine.identityPasses !== 1 || engine.framePasses !== 1
    || reference.accounting.serialization.status !== "not_applied"
    || reference.accounting.compression.status !== "not_applied"
    || reference.accounting.framedV2?.status !== "applied") {
    protocol("framed_write_receipt_mismatch");
  }
  const base = resultObservation(baseRun.result, cell.baseStates, controls);
  const before = checkpointSummary(projectRoot, reference, "framed-v2");
  const payloadFile = path.resolve(projectRoot, reference.path);
  const payloadBefore = await digestFile(payloadFile);
  const listingBefore = digestJson(before.records);
  const loaded = await loadCheckpointForResume(projectRoot, reference.id, {
    maxStoredBytes: controls.storage.maxCheckpointBytes,
    maxDecompressedBytes: controls.storage.maxCheckpointBytes,
    framedV2Limits: {
      maxTotalDecodedBytes: controls.storage.framedV2.maxTotalDecodedBytes,
    },
  });
  if (loaded.artifact.storageEncoding !== "framed-v2"
    || loaded.accounting.storedPayload.status !== "not_applied"
    || loaded.accounting.decompressedPayload.status !== "not_applied"
    || loaded.accounting.rawArtifactString.status !== "not_applied"
    || loaded.accounting.parsedArtifactGraph.status !== "not_applied"
    || loaded.accounting.framedV2?.status !== "applied") {
    protocol("framed_read_receipt_mismatch");
  }
  const afterRecords = listCheckpointArtifacts(projectRoot);
  const payloadAfter = await digestFile(payloadFile);
  const preservation = {
    payloadBytesUnchanged: payloadBefore.bytes === payloadAfter.bytes && payloadBefore.sha256 === payloadAfter.sha256,
    listingUnchanged: listingBefore.sha256 === digestJson(afterRecords).sha256,
    listedBefore: before.records.length,
    listedAfter: afterRecords.length,
  };
  if (!preservation.payloadBytesUnchanged || !preservation.listingUnchanged) protocol("framed_readback_mutated_artifact");
  const checkpoint: CheckpointObservation = {
    requestedFormat: "framed-v2",
    storageEncoding: "framed-v2",
    id: reference.id,
    logicalCheckpointUtf8Bytes: engine.logicalCheckpointUtf8BytesVisited,
    payloadSizeBytes: before.record.payloadSizeBytes,
    durableSizeBytes: before.record.sizeBytes,
    write: {
      outcome: reference.accounting.outcome,
      materializedCheckpointGraphs: 0,
      engineSourceMaterializedGraphs: engine.materializedCheckpointGraphs,
      engineSourceIdentityPasses: engine.identityPasses,
      engineSourceFramePasses: engine.framePasses,
      legacySerializationApplied: false,
      legacyCompressionApplied: false,
      framedV2Applied: true,
    },
    logicalCheckpoint: checkpointDigest(loaded.checkpoint),
    readback: { status: "completed", storageEncoding: "framed-v2" },
    preservation,
  };
  const resumed = resultObservation(
    await resumeFrom(storyJson, knots, externals, targetOptions, loaded.checkpoint),
    cell.targetStates,
    controls
  );
  return { base, checkpoint, resumed };
}

export async function runCheckpointV2EvaluationCell(
  request: WorkerRequest
): Promise<CompletedCheckpointV2EvaluationCase> {
  const cellRoot = safeTemporaryRoot(request.cellRoot);
  if (fs.existsSync(cellRoot) && fs.readdirSync(cellRoot).length > 0) protocol("cell_root_not_empty");
  fs.mkdirSync(cellRoot, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  try {
    const closure = await validateEvaluationSource(request.manifestRoot, request.source);
    const entrypoint = copySource(closure, cellRoot);
    const copiedClosure = sourceClosure(entrypoint);
    if (copiedClosure.bundleSha256 !== request.source.closure.bundleSha256
      || JSON.stringify(copiedClosure.relativeFiles) !== JSON.stringify(closure.relativeFiles)) {
      protocol("isolated_source_copy_drift");
    }
    const inspection = inspectProject(entrypoint);
    if (inspection.truncation.includes) protocol("isolated_source_include_closure_truncated");
    const semantics = scanStorySemantics(entrypoint);
    const knots = scanKnots(entrypoint);
    const externals = scanExternals(entrypoint);
    const compiler = await compilerFingerprint();
    const guards = createResourceGuards({
      maxMemoryMb: request.controls.maxMemoryMb,
      maxTimeMs: request.controls.maxTimeMs,
      startedAtMs: startedAt,
    });
    const compiled = await compile(entrypoint);
    if (!compiled.success || !compiled.storyJson) protocol("compile_failed");
    if (compiledStorySha256(compiled.storyJson) !== request.source.compiledStorySha256) {
      protocol("compiled_story_sha256_drift");
    }
    const baseOptions = searchOptions(request.cell.baseStates, request.controls, semantics, externals, guards);
    const targetOptions = searchOptions(request.cell.targetStates, request.controls, semantics, externals, guards);
    const common = () => commonCase(
      request.source,
      request.cell,
      request.controls,
      semantics,
      externals,
      compiler,
      copiedClosure,
      startedAt
    );
    if (request.cell.mode === "uninterrupted") {
      const uninterrupted = resultObservation(
        exploreShared(compiled.storyJson, knots, externals, targetOptions),
        request.cell.targetStates,
        request.controls
      );
      return { ...common(), status: "completed", uninterrupted };
    }
    if (request.cell.mode === "framed-split") {
      const split = await runFramedSplit(
        cellRoot, entrypoint, compiled.storyJson, knots, externals,
        baseOptions, targetOptions, request.controls, request.cell
      );
      return { ...common(), status: "completed", ...split };
    }
    const split = await runLegacySplit(
      cellRoot, entrypoint, compiled.storyJson, knots, externals,
      baseOptions, targetOptions, request.controls, request.cell
    );
    return { ...common(), ...split };
  } finally {
    fs.rmSync(cellRoot, { recursive: true, force: true });
  }
}

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): ProcessCleanupScope {
  if (!child.pid) return "exact_process";
  if (process.platform === "win32") {
    // Windows has no detached POSIX process group that can receive SIGTERM.
    // Kill the captured tree while its leader still exists, then repeat at the
    // forced-cleanup boundary below. Waiting to use taskkill until after the
    // leader closes can orphan descendants that outlive that leader.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return "process_tree";
  }
  try {
    process.kill(-child.pid, signal);
    return "process_group";
  } catch {
    child.kill(signal);
    return "exact_process";
  }
}

export function runBoundedProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    stdoutLimitBytes?: number;
    stderrLimitBytes?: number;
    /** Testable grace boundary; production workers use WORKER_KILL_GRACE_MS. */
    killGraceMs?: number;
  }
): Promise<BoundedProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let termination: "timeout" | "output_limit" | undefined;
    let cleanupScope: ProcessCleanupScope | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let resolved = false;
    let forceAttempted = false;
    let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({
        status: termination ?? "completed",
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(cleanupScope ? { cleanupScope } : {}),
      });
    };
    const terminate = (reason: "timeout" | "output_limit") => {
      if (termination) return;
      termination = reason;
      cleanupScope = killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        const forcedScope = killProcessTree(child, "SIGKILL");
        if (cleanupScope === undefined || cleanupScope === "exact_process") cleanupScope = forcedScope;
        forceAttempted = true;
        if (closed) finish(closed.code, closed.signal);
      }, process.platform === "win32" ? 0 : (options.killGraceMs ?? WORKER_KILL_GRACE_MS));
      // This timer deliberately remains referenced. Once a leader exits after
      // SIGTERM, the coordinator must stay alive long enough to SIGKILL its
      // captured process group/tree rather than resolving and orphaning it.
    };
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= (options.stdoutLimitBytes ?? MAX_WORKER_OUTPUT_BYTES)) stdout.push(chunk);
      else terminate("output_limit");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= (options.stderrLimitBytes ?? MAX_WORKER_DIAGNOSTIC_BYTES)) stderr.push(chunk);
      else terminate("output_limit");
    });
    child.on("error", () => {
      if (resolved) return;
      if (termination && child.pid) {
        // A failed graceful signal must not cancel the scheduled force pass.
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status: "spawn_error",
        exitCode: null,
        signal: null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.on("close", (code, signal) => {
      if (resolved) return;
      clearTimeout(timeout);
      closed = { code, signal };
      if (!termination || forceAttempted) {
        if (killTimer) clearTimeout(killTimer);
        finish(code, signal);
      }
    });
  });
}

function workerRuntimeArgs(): string[] {
  const result: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index];
    if (/^--max[-_]old[-_]space[-_]size=\d+$/.test(argument)) result.push(argument);
    else if (/^--max[-_]old[-_]space[-_]size$/.test(argument) && /^\d+$/.test(process.execArgv[index + 1] ?? "")) {
      result.push(argument, process.execArgv[++index]);
    }
  }
  return result;
}

function maxOldSpaceSizeMb(): number | null {
  const args = workerRuntimeArgs();
  for (let index = 0; index < args.length; index++) {
    const inline = args[index].match(/=(\d+)$/);
    if (inline) return Number(inline[1]);
    if (/^--max[-_]old[-_]space[-_]size$/.test(args[index])) return Number(args[index + 1]);
  }
  return null;
}

function safeWorkerError(error: unknown): string {
  if (error instanceof EvaluationProtocolError) return error.code;
  if (error instanceof CheckpointReadError) return `checkpoint_${error.kind}_${error.stage}`;
  if (error instanceof RangeError) return "range_error";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  return "worker_error";
}

export function writeEvaluationOutputAtomic(file: string, value: string): void {
  const destination = path.resolve(file);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, value, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(destination), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function gitOutput(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) protocol("candidate_git_unavailable");
  return result.stdout.trim();
}

function regularFiles(root: string, relative = ""): string[] {
  const directory = path.resolve(root, relative);
  if (!fs.existsSync(directory)) protocol("candidate_dist_missing");
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) protocol("candidate_dist_symlink");
    if (entry.isDirectory()) result.push(...regularFiles(root, child));
    else if (entry.isFile()) result.push(normalizeRelative(child));
  }
  return result.sort();
}

function bundleDigest(root: string, files: string[]): string {
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.resolve(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function candidateFingerprint(manifestFile: string, manifestSha256: string) {
  const repositoryRoot = gitOutput(path.dirname(manifestFile), ["rev-parse", "--show-toplevel"]);
  const dirty = gitOutput(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/).filter(Boolean);
  const packageFile = safeFile(repositoryRoot, "package.json", "candidate_package_missing");
  const packageValue = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { version?: unknown };
  if (packageValue.version !== VERSION) protocol("candidate_version_mismatch");
  const lock = safeFile(repositoryRoot, "package-lock.json", "candidate_lock_missing");
  const distRoot = path.resolve(repositoryRoot, "dist");
  const distFiles = regularFiles(distRoot);
  return {
    manifestSha256,
    git: {
      head: gitOutput(repositoryRoot, ["rev-parse", "HEAD"]),
      tree: gitOutput(repositoryRoot, ["rev-parse", "HEAD^{tree}"]),
      clean: dirty.length === 0,
      dirtyEntryCount: dirty.length,
    },
    packageVersion: VERSION,
    dependencyLockSha256: sha256(fs.readFileSync(lock)),
    dist: {
      fileCount: distFiles.length,
      bundleSha256: bundleDigest(distRoot, distFiles),
    },
  };
}

function runtimeFingerprint() {
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    logicalCpuCount: cpus.length,
    cpuModel: cpus[0]?.model ?? "unknown",
    totalMemoryBytes: os.totalmem(),
    v8HeapLimitBytes: v8.getHeapStatistics().heap_size_limit,
    maxOldSpaceSizeMb: maxOldSpaceSizeMb(),
  };
}

function sameDigest(left: Digest | undefined, right: Digest | undefined): boolean {
  return Boolean(left && right && left.sha256 === right.sha256 && left.utf8Bytes === right.utf8Bytes);
}

export function evaluationProgressSnapshot(
  selectedCellIds: string[],
  recordedCellIds: string[],
  activeCellId: string | undefined,
  status: EvaluationProgressSnapshot["status"]
): EvaluationProgressSnapshot {
  if (recordedCellIds.length > selectedCellIds.length
    || recordedCellIds.some((id, index) => id !== selectedCellIds[index])) {
    protocol("evaluation_progress_order");
  }
  if (activeCellId !== undefined && activeCellId !== selectedCellIds[recordedCellIds.length]) {
    protocol("evaluation_progress_active_cell");
  }
  if (status === "completed"
    && (activeCellId !== undefined || recordedCellIds.length !== selectedCellIds.length)) {
    protocol("evaluation_progress_incomplete");
  }
  return {
    status,
    selectedCellCount: selectedCellIds.length,
    recordedCellCount: recordedCellIds.length,
    recordedCellIds: [...recordedCellIds],
    ...(activeCellId === undefined ? {} : { activeCellId }),
  };
}

interface VerdictGate {
  id: string;
  status: "passed" | "failed" | "not_evaluated";
  checks: Record<string, boolean>;
}

export function evaluateCheckpointV2Verdict(
  manifest: CheckpointV2EvaluationManifest,
  cases: EvaluationCaseResult[],
  selectedCellIds: string[],
  candidateClean: boolean,
  coordinatorHeapQualified: boolean
) {
  const completeMatrix = JSON.stringify(selectedCellIds) === JSON.stringify(manifest.controls.cellOrder)
    && cases.length === manifest.cells.length;
  const violations: string[] = [];
  const uncertainties: string[] = [];
  for (const cell of cases) {
    if (cell.status === "failed") violations.push(`${cell.id}:${cell.reason}`);
    else if (cell.status === "unavailable") uncertainties.push(`${cell.id}:${cell.reason}`);
    else if (cell.status === "inconclusive") uncertainties.push(`${cell.id}:${cell.reason ?? "inconclusive"}`);
  }
  if (!completeMatrix) uncertainties.push("filtered_or_incomplete_matrix");
  if (!candidateClean) uncertainties.push("candidate_worktree_dirty");
  if (!coordinatorHeapQualified) uncertainties.push("coordinator_heap_ceiling_unverified");
  const completed = new Map(cases
    .filter((cell): cell is CompletedCheckpointV2EvaluationCase => cell.status === "completed")
    .map((cell) => [cell.id, cell]));
  const gates: VerdictGate[] = [];
  const compare = (id: string, checks: Record<string, boolean> | undefined) => {
    if (!checks) {
      gates.push({ id, status: "not_evaluated", checks: {} });
      return;
    }
    const passed = Object.values(checks).every(Boolean);
    gates.push({ id, status: passed ? "passed" : "failed", checks });
    if (!passed) violations.push(id);
  };
  const heresyLegacy = completed.get("heresy2-legacy-split");
  const heresyFramed = completed.get("heresy2-framed-split");
  const heresyWhole = completed.get("heresy2-uninterrupted");
  compare("heresy2_base_storage_parity", heresyLegacy && heresyFramed ? {
    baseResult: sameDigest(heresyLegacy.base?.digest, heresyFramed.base?.digest),
    checkpointId: heresyLegacy.checkpoint?.id === heresyFramed.checkpoint?.id,
    logicalCheckpointBytes: heresyLegacy.checkpoint?.logicalCheckpointUtf8Bytes === heresyFramed.checkpoint?.logicalCheckpointUtf8Bytes,
    loadedCheckpoint: sameDigest(heresyLegacy.checkpoint?.logicalCheckpoint, heresyFramed.checkpoint?.logicalCheckpoint),
  } : undefined);
  compare("heresy2_exact_resume", heresyLegacy && heresyFramed && heresyWhole ? {
    legacyVsUninterrupted: sameDigest(heresyLegacy.resumed?.digest, heresyWhole.uninterrupted?.digest),
    framedVsUninterrupted: sameDigest(heresyFramed.resumed?.digest, heresyWhole.uninterrupted?.digest),
    legacyVsFramed: sameDigest(heresyLegacy.resumed?.digest, heresyFramed.resumed?.digest),
  } : undefined);
  const interceptWhole = completed.get("intercept-uninterrupted");
  const interceptFramed = completed.get("intercept-framed-split");
  const interceptLegacy = completed.get("intercept-legacy-split");
  compare("intercept_base_storage_parity", interceptLegacy && interceptFramed ? {
    baseResult: sameDigest(interceptLegacy.base?.digest, interceptFramed.base?.digest),
    checkpointId: interceptLegacy.checkpoint?.id === interceptFramed.checkpoint?.id,
    logicalCheckpointBytes: interceptLegacy.checkpoint?.logicalCheckpointUtf8Bytes === interceptFramed.checkpoint?.logicalCheckpointUtf8Bytes,
  } : undefined);
  compare("intercept_framed_exact_resume", interceptFramed && interceptWhole ? {
    framedVsUninterrupted: sameDigest(interceptFramed.resumed?.digest, interceptWhole.uninterrupted?.digest),
    engineNativeNoGraph: interceptFramed.checkpoint?.write.materializedCheckpointGraphs === 0
      && interceptFramed.checkpoint.write.engineSourceMaterializedGraphs === 0,
    legacyStagesNotApplied: interceptFramed.checkpoint?.write.legacySerializationApplied === false
      && interceptFramed.checkpoint.write.legacyCompressionApplied === false,
  } : undefined);
  compare("intercept_legacy_readback_boundary", interceptLegacy ? {
    typedResourceLimit: interceptLegacy.checkpoint?.readback.status === "resource_limit"
      && interceptLegacy.checkpoint.readback.kind === "resource_limit"
      && interceptLegacy.checkpoint.readback.stage === "decompression"
      && interceptLegacy.checkpoint.readback.unit === "bytes",
    payloadPreserved: interceptLegacy.checkpoint?.preservation.payloadBytesUnchanged === true,
    listingPreserved: interceptLegacy.checkpoint?.preservation.listingUnchanged === true,
  } : undefined);
  const unevaluated = gates.filter((gate) => gate.status === "not_evaluated").length;
  if (completeMatrix && unevaluated > 0) uncertainties.push("required_gate_not_evaluated");
  const status = violations.length > 0 ? "failed" : uncertainties.length > 0 ? "inconclusive" : "passed";
  const promotionClaims = [
    "declared_cell_exact_resume",
    "engine_native_zero_materialized_checkpoint_graph",
    "typed_legacy_readback_boundary",
    "artifact_preservation_after_readback_limit",
  ];
  return {
    status,
    completeMatrix,
    gates,
    violations,
    uncertainties,
    allowedClaims: status === "passed" ? promotionClaims : [],
    forbiddenClaims: [
      "universal_performance_improvement",
      "portable_memory_improvement",
      "story_coverage",
      "defect_absence",
      "allocation_policy_promotion",
      "checkpoint_default_format_change",
      "inkbench_improvement",
    ],
  };
}

export function evaluationSnapshotVerdict(
  verdict: ReturnType<typeof evaluateCheckpointV2Verdict>,
  status: EvaluationProgressSnapshot["status"]
): ReturnType<typeof evaluateCheckpointV2Verdict> {
  if (status === "completed" || verdict.status === "failed") return verdict;
  return {
    ...verdict,
    status: "inconclusive",
    uncertainties: [...verdict.uncertainties, "evaluation_in_progress"],
    allowedClaims: [],
  };
}

function assertPrivacySafe(value: unknown): void {
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (path.isAbsolute(item) || /^[A-Za-z]:[\\/]/.test(item) || item.includes("\n")) protocol("report_privacy_violation");
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (isObject(item)) Object.values(item).forEach(visit);
  };
  visit(value);
}

function parseWorkerError(stdout: string): WorkerError | undefined {
  try {
    const value = JSON.parse(stdout) as WorkerError;
    return value?.schemaVersion === 1 && value.kind === "checkpoint_v2_evaluation_worker_error"
      && typeof value.code === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function runWorkerCell(
  manifestRoot: string,
  scratch: string,
  source: CheckpointV2EvaluationSource,
  cell: CheckpointV2EvaluationCell,
  controls: CheckpointV2EvaluationControls,
  sequence: number
): Promise<EvaluationCaseResult> {
  const requestFile = path.join(scratch, `request-${sequence}.json`);
  const cellRoot = path.join(scratch, `cell-${sequence}`);
  const request: WorkerRequest = { schemaVersion: 1, manifestRoot, cellRoot, source, cell, controls };
  fs.writeFileSync(requestFile, JSON.stringify(request), { mode: 0o600 });
  try {
    const child = await runBoundedProcess(
      process.execPath,
      [...workerRuntimeArgs(), __filename, "--worker", requestFile],
      { cwd: process.cwd(), timeoutMs: controls.workerTimeoutMs }
    );
    if (child.status === "timeout") {
      return { schemaVersion: 1, id: cell.id, sourceId: source.id, mode: cell.mode, expected: cell.expected,
        status: "unavailable", reason: "worker_timeout", timeoutMs: controls.workerTimeoutMs,
        cleanupScope: child.cleanupScope };
    }
    if (child.status !== "completed") {
      return { schemaVersion: 1, id: cell.id, sourceId: source.id, mode: cell.mode, expected: cell.expected,
        status: "unavailable", reason: child.status, ...(child.cleanupScope ? { cleanupScope: child.cleanupScope } : {}) };
    }
    if (child.exitCode !== 0) {
      const error = parseWorkerError(child.stdout);
      return { schemaVersion: 1, id: cell.id, sourceId: source.id, mode: cell.mode, expected: cell.expected,
        status: error?.code === "worker_error" ? "unavailable" : "failed",
        reason: error?.code ?? "worker_exit" };
    }
    let result: CompletedCheckpointV2EvaluationCase;
    try {
      result = JSON.parse(child.stdout) as CompletedCheckpointV2EvaluationCase;
    } catch {
      return { schemaVersion: 1, id: cell.id, sourceId: source.id, mode: cell.mode, expected: cell.expected,
        status: "failed", reason: "worker_output_invalid" };
    }
    if (result.schemaVersion !== 1 || result.id !== cell.id || result.sourceId !== source.id
      || result.mode !== cell.mode || !["completed", "inconclusive"].includes(result.status)) {
      return { schemaVersion: 1, id: cell.id, sourceId: source.id, mode: cell.mode, expected: cell.expected,
        status: "failed", reason: "worker_output_contract" };
    }
    assertPrivacySafe(result);
    return result;
  } finally {
    fs.rmSync(requestFile, { force: true });
    fs.rmSync(cellRoot, { recursive: true, force: true });
  }
}

async function workerMain(requestFile: string): Promise<void> {
  let request: WorkerRequest;
  try {
    const raw = fs.readFileSync(requestFile, "utf8");
    request = JSON.parse(raw) as WorkerRequest;
    if (request.schemaVersion !== 1 || !request.source || !request.cell || !request.controls) {
      protocol("worker_request_invalid");
    }
    const result = await runCheckpointV2EvaluationCell(request);
    assertPrivacySafe(result);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const result: WorkerError = {
      schemaVersion: 1,
      kind: "checkpoint_v2_evaluation_worker_error",
      code: safeWorkerError(error),
    };
    process.stdout.write(JSON.stringify(result));
    process.exitCode = 1;
  }
}

function cliArguments(args: string[]): { manifestFile: string; outputFile?: string; requestedCells: string[] } {
  const positional: string[] = [];
  const requestedCells: string[] = [];
  let outputFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--case" || argument === "--output") {
      const value = args[++index];
      if (!value || value.startsWith("--")) protocol("cli_option_value_missing");
      if (argument === "--case") requestedCells.push(value);
      else outputFile = value;
      continue;
    }
    if (argument.startsWith("--")) protocol("cli_option_unknown");
    positional.push(argument);
  }
  if (positional.length !== 1) protocol("cli_usage");
  return { manifestFile: path.resolve(positional[0]), ...(outputFile ? { outputFile: path.resolve(outputFile) } : {}), requestedCells };
}

async function coordinatorMain(args: string[]): Promise<void> {
  const parsed = cliArguments(args);
  regularFile(parsed.manifestFile, "manifest_file_invalid");
  const raw = fs.readFileSync(parsed.manifestFile);
  if (raw.length > MAX_MANIFEST_BYTES) protocol("manifest_too_large");
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    protocol("manifest_json_invalid");
  }
  validateCheckpointV2EvaluationManifest(value);
  const manifest = value;
  const manifestRoot = path.dirname(parsed.manifestFile);
  for (const source of manifest.sources) await validateEvaluationSource(manifestRoot, source);
  const manifestSha256 = sha256(raw);
  const candidate = candidateFingerprint(parsed.manifestFile, manifestSha256);
  const runtime = runtimeFingerprint();
  const compiler = await compilerFingerprint();
  const requested = new Set(parsed.requestedCells);
  for (const id of requested) if (!manifest.controls.cellOrder.includes(id)) protocol("unknown_selected_cell");
  const selectedCells = requested.size === 0
    ? manifest.cells
    : manifest.cells.filter((cell) => requested.has(cell.id));
  if (selectedCells.length === 0) protocol("no_selected_cells");
  const selectedCellIds = selectedCells.map((cell) => cell.id);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-checkpoint-v2-evaluation-"));
  const cases: EvaluationCaseResult[] = [];
  const sourceSummaries = manifest.sources.map((source) => ({
    id: source.id,
    upstream: source.provenance.upstream,
    commit: source.provenance.commit,
    license: source.provenance.license,
    entrypointSha256: source.entrypointSha256,
    licenseSha256: source.provenance.licenseSha256,
    bundleSha256: source.closure.bundleSha256,
    fileCount: source.closure.fileCount,
    compiledStorySha256: source.compiledStorySha256,
  }));
  const writeReportSnapshot = (
    status: EvaluationProgressSnapshot["status"],
    activeCellId?: string
  ) => {
    const evaluatedVerdict = evaluateCheckpointV2Verdict(
      manifest,
      cases,
      selectedCellIds,
      candidate.git.clean,
      runtime.maxOldSpaceSizeMb !== null && runtime.maxOldSpaceSizeMb >= manifest.controls.coordinatorMaxOldSpaceMb
    );
    const verdict = evaluationSnapshotVerdict(evaluatedVerdict, status);
    const progress = evaluationProgressSnapshot(
      selectedCellIds,
      cases.map((cell) => cell.id),
      activeCellId,
      status
    );
    const report = {
      schemaVersion: 1,
      kind: EVALUATION_KIND,
      evaluationId: manifest.id,
      generatedAt: new Date().toISOString(),
      candidate,
      runtime,
      compiler,
      selection: {
        serial: true,
        requestedCellIds: parsed.requestedCells,
        selectedCellIds,
        completeMatrix: verdict.completeMatrix,
      },
      progress,
      controls: manifest.controls,
      sources: sourceSummaries,
      cases,
      verdict,
    };
    assertPrivacySafe(report);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (parsed.outputFile) writeEvaluationOutputAtomic(parsed.outputFile, output);
    else if (status === "completed") process.stdout.write(output);
    return verdict;
  };
  if (parsed.outputFile) writeReportSnapshot("in_progress");
  try {
    for (let index = 0; index < selectedCells.length; index++) {
      const cell = selectedCells[index];
      const source = manifest.sources.find((candidateSource) => candidateSource.id === cell.sourceId);
      if (!source) protocol("selected_source_missing");
      // Persist the active cell before it can allocate or spawn. If the
      // coordinator is cancelled or crashes, all earlier cases plus the exact
      // unfinished boundary remain in the atomic report.
      if (parsed.outputFile) writeReportSnapshot("in_progress", cell.id);
      process.stderr.write(`${JSON.stringify({ schemaVersion: 1, kind: "checkpoint_v2_evaluation_progress", cell: cell.id, status: "started" })}\n`);
      let result = await runWorkerCell(manifestRoot, scratch, source, cell, manifest.controls, index);
      if ((result.status === "completed" || result.status === "inconclusive")
        && JSON.stringify(result.compiler) !== JSON.stringify(compiler)) {
        result = { schemaVersion: 1, id: cell.id, sourceId: source.id, mode: cell.mode, expected: cell.expected,
          status: "failed", reason: "compiler_fingerprint_drift" };
      }
      cases.push(result);
      // Record every terminal cell outcome before starting the next cell. This
      // snapshot remains non-promotional until the coordinator writes the
      // explicit completed snapshot below.
      if (parsed.outputFile) writeReportSnapshot("in_progress");
      process.stderr.write(`${JSON.stringify({ schemaVersion: 1, kind: "checkpoint_v2_evaluation_progress", cell: cell.id, status: result.status })}\n`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const verdict = writeReportSnapshot("completed");
  if (verdict.status === "failed") process.exitCode = 1;
  else if (verdict.status === "inconclusive") process.exitCode = 2;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--worker" && args.length === 2) {
    await workerMain(path.resolve(args[1]));
    return;
  }
  await coordinatorMain(args);
}

if (require.main === module) {
  main().catch((error) => {
    const result = {
      schemaVersion: 1,
      kind: "checkpoint_v2_evaluation_error",
      code: safeWorkerError(error),
    };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 2;
  });
}
