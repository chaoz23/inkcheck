import { createHash } from "crypto";
import { constants as bufferConstants } from "buffer";
import { Readable, Writable } from "stream";
import { createGunzip, gzipSync } from "zlib";

export const CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION = 2 as const;
export const CHECKPOINT_ARTIFACT_V2_MAGIC = Buffer.from("INKCHECKCP2\r\n", "ascii");
const CHECKPOINT_ARTIFACT_VERSIONED_MAGIC_PROBE_PATTERN = /^INKCHECKCP([0-9]+)(?:\r\n|\r)?$/;

export const CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER = [
  "configuration",
  "scheduler",
  "frontier",
  "witnessAncestry",
  "dedupe",
  "semanticIndexes",
  "findings",
  "metadata",
] as const;

/** Backwards-compatible descriptive alias for callers that do not need rank order. */
export const CHECKPOINT_ARTIFACT_V2_COMPONENTS = CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER;

export type CheckpointArtifactV2Component = typeof CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER[number];

export interface CheckpointArtifactV2Limits {
  maxHeaderBytes: number;
  maxStoredFrameBytes: number;
  maxDecodedFrameBytes: number;
  maxRecordBytes: number;
  maxJsonDepth: number;
  maxRecordsPerFrame: number;
  maxFrames: number;
  maxTotalRecords: number;
  maxTotalStoredBytes: number;
  maxTotalDecodedBytes: number;
}

export const DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS: Readonly<CheckpointArtifactV2Limits> = Object.freeze({
  maxHeaderBytes: 64 * 1024,
  maxStoredFrameBytes: 16 * 1024 * 1024,
  maxDecodedFrameBytes: 32 * 1024 * 1024,
  maxRecordBytes: 8 * 1024 * 1024,
  maxJsonDepth: 512,
  maxRecordsPerFrame: 100_000,
  maxFrames: 65_536,
  maxTotalRecords: 10_000_000,
  maxTotalStoredBytes: 512 * 1024 * 1024,
  maxTotalDecodedBytes: 512 * 1024 * 1024,
});

export type CheckpointArtifactV2ErrorKind =
  | "corrupt"
  | "resource_limit"
  | "unsupported"
  | "cancelled";

export type CheckpointArtifactV2LimitMetric = "bytes" | "count" | "depth";

export type CheckpointArtifactV2ErrorStage =
  | "magic"
  | "prefix"
  | "header"
  | "payload"
  | "record"
  | "index"
  | "eof";

export class CheckpointArtifactV2Error extends Error {
  constructor(
    public readonly kind: CheckpointArtifactV2ErrorKind,
    public readonly stage: CheckpointArtifactV2ErrorStage,
    message: string,
    public readonly observed?: number,
    public readonly limit?: number,
    public readonly metric?: CheckpointArtifactV2LimitMetric
  ) {
    super(message);
    this.name = "CheckpointArtifactV2Error";
  }
}

export interface CheckpointArtifactV2RecordInput {
  component: CheckpointArtifactV2Component;
  field: string;
  /** Zero-based index of the first supplied record within this component field. */
  start: number;
  records: Iterable<unknown> | AsyncIterable<unknown>;
}

/** One ordered logical field input; the codec splits it into bounded wire frames. */
export type CheckpointArtifactV2FrameInput = CheckpointArtifactV2RecordInput;

export interface CheckpointArtifactV2Record {
  component: CheckpointArtifactV2Component;
  field: string;
  index: number;
  value: unknown;
}

export interface CheckpointArtifactV2FrameSummary {
  sequence: number;
  component: CheckpointArtifactV2Component;
  field: string;
  start: number;
  recordCount: number;
  headerBytes: number;
  decodedBytes: number;
  decodedSha256: string;
  storedBytes: number;
  storedSha256: string;
  maxRecordBytes: number;
}

export interface CheckpointArtifactV2ComponentSummary {
  component: CheckpointArtifactV2Component;
  frameCount: number;
  recordCount: number;
  decodedBytes: number;
  decodedSha256: string;
  storedBytes: number;
  storedSha256: string;
  maxRecordBytes: number;
}

export interface CheckpointArtifactV2IndexSummary {
  sequence: number;
  headerBytes: number;
  decodedBytes: number;
  decodedSha256: string;
  storedBytes: number;
  storedSha256: string;
  maxRecordBytes: number;
}

export interface CheckpointArtifactV2Result {
  schemaVersion: 2;
  artifactBytes: number;
  data: {
    frameCount: number;
    recordCount: number;
    decodedBytes: number;
    storedBytes: number;
    maxRecordBytes: number;
  };
  frames: CheckpointArtifactV2FrameSummary[];
  components: CheckpointArtifactV2ComponentSummary[];
  index: CheckpointArtifactV2IndexSummary;
}

export type CheckpointArtifactV2WriteResult = CheckpointArtifactV2Result;
export type CheckpointArtifactV2ReadResult = CheckpointArtifactV2Result;

export interface CheckpointArtifactV2WriteOptions {
  limits?: Partial<CheckpointArtifactV2Limits>;
  signal?: AbortSignal;
  gzipLevel?: number;
  /** The writer owns and ends its destination by default. */
  endDestination?: boolean;
}

export interface CheckpointArtifactV2ReadOptions {
  limits?: Partial<CheckpointArtifactV2Limits>;
  signal?: AbortSignal;
  /** Delivered records remain provisional until the read promise verifies the terminal index and exact EOF. */
  onRecord(record: CheckpointArtifactV2Record): void | Promise<void>;
}

interface DataFrameHeader {
  kind: "data";
  version: 2;
  sequence: number;
  component: CheckpointArtifactV2Component;
  field: string;
  start: number;
  recordCount: number;
  decodedBytes: number;
  decodedSha256: string;
  encoding: "gzip";
  storedBytes: number;
  storedSha256: string;
}

interface IndexFrameHeader {
  kind: "index";
  version: 2;
  sequence: number;
  recordCount: 1;
  decodedBytes: number;
  decodedSha256: string;
  encoding: "gzip";
  storedBytes: number;
  storedSha256: string;
}

interface ArtifactIndexRecord {
  version: 2;
  frameCount: number;
  recordCount: number;
  decodedBytes: number;
  storedBytes: number;
  maxRecordBytes: number;
  frames: CheckpointArtifactV2FrameSummary[];
  components: CheckpointArtifactV2ComponentSummary[];
}

interface EncodedRecord {
  prefix: Buffer;
  body: Buffer;
  decodedBytes: number;
  recordBytes: number;
}

const DATA_HEADER_KEYS: ReadonlyArray<keyof DataFrameHeader> = [
  "kind", "version", "sequence", "component", "field", "start", "recordCount",
  "decodedBytes", "decodedSha256", "encoding", "storedBytes", "storedSha256",
];
const INDEX_HEADER_KEYS: ReadonlyArray<keyof IndexFrameHeader> = [
  "kind", "version", "sequence", "recordCount", "decodedBytes", "decodedSha256",
  "encoding", "storedBytes", "storedSha256",
];
const INDEX_RECORD_KEYS: ReadonlyArray<keyof ArtifactIndexRecord> = [
  "version", "frameCount", "recordCount", "decodedBytes", "storedBytes",
  "maxRecordBytes", "frames", "components",
];
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMPONENT_RANK = new Map<CheckpointArtifactV2Component, number>(
  CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER.map((component, index) => [component, index])
);

function error(
  kind: CheckpointArtifactV2ErrorKind,
  stage: CheckpointArtifactV2ErrorStage,
  message: string,
  observed?: number,
  limit?: number,
  metric?: CheckpointArtifactV2LimitMetric
): CheckpointArtifactV2Error {
  return new CheckpointArtifactV2Error(kind, stage, message, observed, limit, metric);
}

function assertNotCancelled(signal: AbortSignal | undefined, stage: CheckpointArtifactV2ErrorStage): void {
  if (signal?.aborted) throw cancellationError(stage);
}

function cancellationError(stage: CheckpointArtifactV2ErrorStage): CheckpointArtifactV2Error {
  return error("cancelled", stage, "checkpoint artifact operation was cancelled");
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function checkedAdd(
  left: number,
  right: number,
  description: string,
  stage: CheckpointArtifactV2ErrorStage,
  metric: CheckpointArtifactV2LimitMetric
): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw error(
      "resource_limit",
      stage,
      `${description} exceeds JavaScript's safe integer range`,
      value,
      Number.MAX_SAFE_INTEGER,
      metric
    );
  }
  return value;
}

const CHECKPOINT_ARTIFACT_V2_LIMIT_METRICS: Readonly<
  Record<keyof CheckpointArtifactV2Limits, CheckpointArtifactV2LimitMetric>
> = Object.freeze({
  maxHeaderBytes: "bytes",
  maxStoredFrameBytes: "bytes",
  maxDecodedFrameBytes: "bytes",
  maxRecordBytes: "bytes",
  maxJsonDepth: "depth",
  maxRecordsPerFrame: "count",
  maxFrames: "count",
  maxTotalRecords: "count",
  maxTotalStoredBytes: "bytes",
  maxTotalDecodedBytes: "bytes",
});

export function resolveCheckpointArtifactV2Limits(
  input: Partial<CheckpointArtifactV2Limits> | undefined
): CheckpointArtifactV2Limits {
  const limits = { ...DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    const metric = CHECKPOINT_ARTIFACT_V2_LIMIT_METRICS[name as keyof CheckpointArtifactV2Limits];
    if (!metric) throw error("unsupported", "header", `unsupported checkpoint artifact limit ${name}`);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
      throw error(
        "resource_limit",
        "header",
        `${name} must be a positive 32-bit safe integer`,
        typeof value === "number" && Number.isFinite(value) ? value : undefined,
        0xffffffff,
        metric
      );
    }
  }
  const runtimeCeilings: Array<{
    name: keyof CheckpointArtifactV2Limits;
    limit: number;
    stage: CheckpointArtifactV2ErrorStage;
  }> = [
    {
      name: "maxHeaderBytes",
      limit: Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH),
      stage: "header",
    },
    { name: "maxStoredFrameBytes", limit: bufferConstants.MAX_LENGTH, stage: "payload" },
    { name: "maxDecodedFrameBytes", limit: bufferConstants.MAX_LENGTH, stage: "payload" },
    {
      name: "maxRecordBytes",
      limit: Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH),
      stage: "record",
    },
    {
      name: "maxJsonDepth",
      limit: DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxJsonDepth,
      stage: "record",
    },
  ];
  for (const ceiling of runtimeCeilings) {
    if (limits[ceiling.name] > ceiling.limit) {
      throw error(
        "resource_limit",
        ceiling.stage,
        `${ceiling.name} exceeds this runtime's safe codec ceiling`,
        limits[ceiling.name],
        ceiling.limit,
        CHECKPOINT_ARTIFACT_V2_LIMIT_METRICS[ceiling.name]
      );
    }
  }
  if (limits.maxRecordBytes + 4 > limits.maxDecodedFrameBytes) {
    throw error(
      "resource_limit",
      "record",
      "maxRecordBytes plus its length prefix must fit maxDecodedFrameBytes",
      limits.maxRecordBytes + 4,
      limits.maxDecodedFrameBytes,
      "bytes"
    );
  }
  return limits;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateField(field: unknown, stage: CheckpointArtifactV2ErrorStage): asserts field is string {
  if (typeof field !== "string" || !FIELD_PATTERN.test(field)) {
    throw error("unsupported", stage, "checkpoint frame field must match [A-Za-z][A-Za-z0-9]*");
  }
}

function componentRank(component: unknown, stage: CheckpointArtifactV2ErrorStage): number {
  const rank = COMPONENT_RANK.get(component as CheckpointArtifactV2Component);
  if (rank === undefined) throw error("unsupported", stage, `unsupported checkpoint component ${String(component)}`);
  return rank;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compactJson(value: unknown, stage: CheckpointArtifactV2ErrorStage): string {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(value);
  } catch (cause) {
    throw error("unsupported", stage, `checkpoint value is not JSON-serializable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (raw === undefined) throw error("unsupported", stage, "checkpoint value is not a JSON value");
  return raw;
}

function encodedRecord(value: unknown, limits: CheckpointArtifactV2Limits): EncodedRecord {
  const raw = compactJson(value, "record");
  enforceJsonDepth(raw, limits, "record");
  const recordBytes = Buffer.byteLength(raw, "utf8");
  if (recordBytes > limits.maxRecordBytes) {
    throw error("resource_limit", "record", "checkpoint record exceeds maxRecordBytes", recordBytes, limits.maxRecordBytes, "bytes");
  }
  const body = Buffer.from(raw, "utf8");
  const decodedBytes = checkedAdd(4, recordBytes, "checkpoint framed record bytes", "record", "bytes");
  if (decodedBytes > limits.maxDecodedFrameBytes) {
    throw error("resource_limit", "record", "checkpoint record cannot fit a decoded frame", decodedBytes, limits.maxDecodedFrameBytes, "bytes");
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(recordBytes, 0);
  return { prefix, body, decodedBytes, recordBytes };
}

function encodePayload(records: readonly EncodedRecord[]): Buffer {
  const bytes = records.reduce((total, record) => total + record.decodedBytes, 0);
  const payload = Buffer.allocUnsafe(bytes);
  let offset = 0;
  for (const record of records) {
    record.prefix.copy(payload, offset);
    offset += record.prefix.length;
    record.body.copy(payload, offset);
    offset += record.body.length;
  }
  return payload;
}

async function writeChunk(destination: Writable, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause);
    destination.once("error", onError);
    destination.write(chunk, (cause?: Error | null) => {
      if (cause) {
        // Node emits `error` after invoking a failed write callback. Leave the
        // one-shot listener installed so that event cannot become unhandled.
        reject(cause);
        return;
      }
      destination.off("error", onError);
      resolve();
    });
  });
}

async function endWritable(destination: Writable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => reject(cause);
    destination.once("error", onError);
    destination.end(() => {
      destination.off("error", onError);
      resolve();
    });
  });
}

async function writeWireFrame(destination: Writable, rawHeader: Buffer, stored: Buffer): Promise<number> {
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeUInt32BE(rawHeader.length, 0);
  prefix.writeUInt32BE(stored.length, 4);
  await writeChunk(destination, prefix);
  await writeChunk(destination, rawHeader);
  await writeChunk(destination, stored);
  return prefix.length + rawHeader.length + stored.length;
}

function emptyComponents(): CheckpointArtifactV2ComponentSummary[] {
  return CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER.map((component) => ({
    component,
    frameCount: 0,
    recordCount: 0,
    decodedBytes: 0,
    decodedSha256: sha256(Buffer.alloc(0)),
    storedBytes: 0,
    storedSha256: sha256(Buffer.alloc(0)),
    maxRecordBytes: 0,
  }));
}

function componentChecksum(
  component: CheckpointArtifactV2Component,
  frames: readonly CheckpointArtifactV2FrameSummary[],
  representation: "decoded" | "stored"
): string {
  const hash = createHash("sha256");
  for (const frame of frames) {
    if (frame.component !== component) continue;
    const descriptor = representation === "decoded" ? {
      sequence: frame.sequence,
      field: frame.field,
      start: frame.start,
      recordCount: frame.recordCount,
      bytes: frame.decodedBytes,
      sha256: frame.decodedSha256,
    } : {
      sequence: frame.sequence,
      field: frame.field,
      start: frame.start,
      recordCount: frame.recordCount,
      bytes: frame.storedBytes,
      sha256: frame.storedSha256,
    };
    const raw = Buffer.from(JSON.stringify(descriptor), "utf8");
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(raw.length, 0);
    hash.update(prefix).update(raw);
  }
  return hash.digest("hex");
}

function finalizeComponentChecksums(
  components: CheckpointArtifactV2ComponentSummary[],
  frames: readonly CheckpointArtifactV2FrameSummary[]
): void {
  for (const component of components) {
    component.decodedSha256 = componentChecksum(component.component, frames, "decoded");
    component.storedSha256 = componentChecksum(component.component, frames, "stored");
  }
}

function dataTotals(frames: readonly CheckpointArtifactV2FrameSummary[]): CheckpointArtifactV2Result["data"] {
  return frames.reduce<CheckpointArtifactV2Result["data"]>((totals, frame) => ({
    frameCount: totals.frameCount + 1,
    recordCount: totals.recordCount + frame.recordCount,
    decodedBytes: totals.decodedBytes + frame.decodedBytes,
    storedBytes: totals.storedBytes + frame.storedBytes,
    maxRecordBytes: Math.max(totals.maxRecordBytes, frame.maxRecordBytes),
  }), { frameCount: 0, recordCount: 0, decodedBytes: 0, storedBytes: 0, maxRecordBytes: 0 });
}

function indexRecord(
  frames: CheckpointArtifactV2FrameSummary[],
  components: CheckpointArtifactV2ComponentSummary[]
): ArtifactIndexRecord {
  const data = dataTotals(frames);
  return {
    version: CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION,
    frameCount: data.frameCount,
    recordCount: data.recordCount,
    decodedBytes: data.decodedBytes,
    storedBytes: data.storedBytes,
    maxRecordBytes: data.maxRecordBytes,
    frames,
    components,
  };
}

function compareTuple(
  left: { rank: number; field: string },
  right: { rank: number; field: string }
): number {
  return left.rank - right.rank || (left.field < right.field ? -1 : left.field > right.field ? 1 : 0);
}

async function cancellableIteratorNext<T>(
  iterator: Iterator<T> | AsyncIterator<T>,
  signal: AbortSignal | undefined,
  stage: CheckpointArtifactV2ErrorStage
): Promise<IteratorResult<T>> {
  assertNotCancelled(signal, stage);
  const pending = Promise.resolve(iterator.next());
  if (!signal) return await pending;

  let didAbort = false;
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (didAbort) return;
      didAbort = true;
      reject(cancellationError(stage));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function returnIteratorWithoutBlocking<T>(iterator: Iterator<T> | AsyncIterator<T>): void {
  try {
    const returned = iterator.return?.();
    if (returned) void Promise.resolve(returned).catch(() => undefined);
  } catch {
    // The write/cancellation failure remains authoritative. An uncooperative
    // producer must not keep the owned destination or caller promise open.
  }
}

async function* asAsync<T>(
  values: Iterable<T> | AsyncIterable<T>,
  signal: AbortSignal | undefined,
  stage: CheckpointArtifactV2ErrorStage
): AsyncIterable<T> {
  const asyncFactory = (values as AsyncIterable<T>)[Symbol.asyncIterator];
  const iterator: Iterator<T> | AsyncIterator<T> = typeof asyncFactory === "function"
    ? asyncFactory.call(values)
    : (values as Iterable<T>)[Symbol.iterator]();
  let completed = false;
  try {
    while (true) {
      const next = await cancellableIteratorNext(iterator, signal, stage);
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) returnIteratorWithoutBlocking(iterator);
  }
}

export async function writeCheckpointArtifactV2(
  destination: Writable,
  inputs: Iterable<CheckpointArtifactV2RecordInput> | AsyncIterable<CheckpointArtifactV2RecordInput>,
  options: CheckpointArtifactV2WriteOptions = {}
): Promise<CheckpointArtifactV2WriteResult> {
  const endDestination = options.endDestination ?? true;
  let limits: CheckpointArtifactV2Limits;
  let gzipLevel: number;
  try {
    limits = resolveCheckpointArtifactV2Limits(options.limits);
    gzipLevel = options.gzipLevel ?? 1;
    if (!Number.isInteger(gzipLevel) || gzipLevel < 0 || gzipLevel > 9) {
      throw error("unsupported", "payload", "gzipLevel must be an integer from 0 through 9");
    }
  } catch (cause) {
    if (endDestination && !destination.destroyed) destination.destroy();
    throw cause;
  }
  const frames: CheckpointArtifactV2FrameSummary[] = [];
  const components = emptyComponents();
  const expectedStarts = new Map<string, number>();
  let lastTuple: { rank: number; field: string } | undefined;
  let artifactBytes = 0;
  let totalRecords = 0;
  let totalDecodedBytes = 0;
  let totalStoredBytes = 0;

  const flush = async (
    component: CheckpointArtifactV2Component,
    field: string,
    start: number,
    records: EncodedRecord[]
  ): Promise<void> => {
    if (records.length === 0) return;
    assertNotCancelled(options.signal, "prefix");
    if (frames.length >= limits.maxFrames) {
      throw error("resource_limit", "header", "checkpoint artifact exceeds maxFrames", frames.length + 1, limits.maxFrames, "count");
    }
    const decoded = encodePayload(records);
    const stored = gzipSync(decoded, { level: gzipLevel });
    if (stored.length > limits.maxStoredFrameBytes) {
      if (records.length === 1) {
        throw error("resource_limit", "payload", "checkpoint record cannot fit maxStoredFrameBytes", stored.length, limits.maxStoredFrameBytes, "bytes");
      }
      const splitAt = Math.ceil(records.length / 2);
      await flush(component, field, start, records.slice(0, splitAt));
      await flush(
        component,
        field,
        checkedAdd(start, splitAt, "checkpoint frame start", "header", "count"),
        records.slice(splitAt)
      );
      return;
    }
    const nextStoredTotal = checkedAdd(totalStoredBytes, stored.length, "checkpoint stored bytes", "payload", "bytes");
    if (nextStoredTotal > limits.maxTotalStoredBytes) {
      throw error("resource_limit", "payload", "checkpoint artifact exceeds maxTotalStoredBytes", nextStoredTotal, limits.maxTotalStoredBytes, "bytes");
    }
    const header: DataFrameHeader = {
      kind: "data",
      version: CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION,
      sequence: frames.length,
      component,
      field,
      start,
      recordCount: records.length,
      decodedBytes: decoded.length,
      decodedSha256: sha256(decoded),
      encoding: "gzip",
      storedBytes: stored.length,
      storedSha256: sha256(stored),
    };
    const headerJson = compactJson(header, "header");
    const headerBytes = Buffer.byteLength(headerJson, "utf8");
    if (headerBytes > limits.maxHeaderBytes) {
      throw error("resource_limit", "header", "checkpoint frame header exceeds maxHeaderBytes", headerBytes, limits.maxHeaderBytes, "bytes");
    }
    const rawHeader = Buffer.from(headerJson, "utf8");
    artifactBytes = checkedAdd(artifactBytes, await writeWireFrame(destination, rawHeader, stored), "checkpoint artifact bytes", "payload", "bytes");
    const summary: CheckpointArtifactV2FrameSummary = {
      sequence: header.sequence,
      component,
      field,
      start,
      recordCount: records.length,
      headerBytes: rawHeader.length,
      decodedBytes: decoded.length,
      decodedSha256: header.decodedSha256,
      storedBytes: stored.length,
      storedSha256: header.storedSha256,
      maxRecordBytes: records.reduce((maximum, record) => Math.max(maximum, record.recordBytes), 0),
    };
    frames.push(summary);
    const componentSummary = components[componentRank(component, "header")];
    componentSummary.frameCount += 1;
    componentSummary.recordCount += summary.recordCount;
    componentSummary.decodedBytes += summary.decodedBytes;
    componentSummary.storedBytes += summary.storedBytes;
    componentSummary.maxRecordBytes = Math.max(componentSummary.maxRecordBytes, summary.maxRecordBytes);
    totalStoredBytes = nextStoredTotal;
  };

  try {
    assertNotCancelled(options.signal, "magic");
    await writeChunk(destination, CHECKPOINT_ARTIFACT_V2_MAGIC);
    artifactBytes = CHECKPOINT_ARTIFACT_V2_MAGIC.length;

    for await (const input of asAsync(inputs, options.signal, "prefix")) {
      const rank = componentRank(input.component, "header");
      validateField(input.field, "header");
      if (!isSafeNonnegativeInteger(input.start)) {
        throw error("unsupported", "header", "checkpoint record input start must be a safe nonnegative integer");
      }
      const tuple = { rank, field: input.field };
      if (lastTuple && compareTuple(tuple, lastTuple) < 0) {
        throw error("corrupt", "header", "checkpoint record inputs are not in component/field order");
      }
      const key = `${input.component}\0${input.field}`;
      const expectedStart = expectedStarts.get(key) ?? 0;
      if (input.start !== expectedStart) {
        throw error("corrupt", "header", `checkpoint record input for ${input.component}.${input.field} starts at ${input.start}, expected ${expectedStart}`);
      }
      lastTuple = tuple;
      let frameStart = input.start;
      let pending: EncodedRecord[] = [];
      let pendingBytes = 0;
      let inputCount = 0;
      for await (const value of asAsync(input.records, options.signal, "record")) {
        const record = encodedRecord(value, limits);
        if (pending.length > 0 && (pending.length >= limits.maxRecordsPerFrame
          || pendingBytes + record.decodedBytes > limits.maxDecodedFrameBytes)) {
          await flush(input.component, input.field, frameStart, pending);
          frameStart = checkedAdd(frameStart, pending.length, "checkpoint frame start", "header", "count");
          pending = [];
          pendingBytes = 0;
        }
        const nextRecordCount = checkedAdd(totalRecords, 1, "checkpoint record count", "record", "count");
        if (nextRecordCount > limits.maxTotalRecords) {
          throw error("resource_limit", "record", "checkpoint artifact exceeds maxTotalRecords", nextRecordCount, limits.maxTotalRecords, "count");
        }
        const nextDecodedTotal = checkedAdd(totalDecodedBytes, record.decodedBytes, "checkpoint decoded bytes", "record", "bytes");
        if (nextDecodedTotal > limits.maxTotalDecodedBytes) {
          throw error("resource_limit", "record", "checkpoint artifact exceeds maxTotalDecodedBytes", nextDecodedTotal, limits.maxTotalDecodedBytes, "bytes");
        }
        pending.push(record);
        pendingBytes += record.decodedBytes;
        inputCount += 1;
        totalRecords = nextRecordCount;
        totalDecodedBytes = nextDecodedTotal;
      }
      await flush(input.component, input.field, frameStart, pending);
      expectedStarts.set(key, checkedAdd(input.start, inputCount, "checkpoint field record count", "header", "count"));
    }

    assertNotCancelled(options.signal, "index");
    finalizeComponentChecksums(components, frames);
    const recordValue = indexRecord(frames, components);
    const encodedIndexRecord = encodedRecord(recordValue, limits);
    const decodedIndex = encodePayload([encodedIndexRecord]);
    const storedIndex = gzipSync(decodedIndex, { level: gzipLevel });
    if (storedIndex.length > limits.maxStoredFrameBytes) {
      throw error("resource_limit", "index", "checkpoint index exceeds maxStoredFrameBytes", storedIndex.length, limits.maxStoredFrameBytes, "bytes");
    }
    const totalWithIndexDecoded = checkedAdd(totalDecodedBytes, decodedIndex.length, "checkpoint decoded bytes including index", "index", "bytes");
    if (totalWithIndexDecoded > limits.maxTotalDecodedBytes) {
      throw error("resource_limit", "index", "checkpoint index exceeds maxTotalDecodedBytes", totalWithIndexDecoded, limits.maxTotalDecodedBytes, "bytes");
    }
    const totalWithIndexStored = checkedAdd(totalStoredBytes, storedIndex.length, "checkpoint stored bytes including index", "index", "bytes");
    if (totalWithIndexStored > limits.maxTotalStoredBytes) {
      throw error("resource_limit", "index", "checkpoint index exceeds maxTotalStoredBytes", totalWithIndexStored, limits.maxTotalStoredBytes, "bytes");
    }
    const indexHeader: IndexFrameHeader = {
      kind: "index",
      version: CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION,
      sequence: frames.length,
      recordCount: 1,
      decodedBytes: decodedIndex.length,
      decodedSha256: sha256(decodedIndex),
      encoding: "gzip",
      storedBytes: storedIndex.length,
      storedSha256: sha256(storedIndex),
    };
    const indexHeaderJson = compactJson(indexHeader, "index");
    const indexHeaderBytes = Buffer.byteLength(indexHeaderJson, "utf8");
    if (indexHeaderBytes > limits.maxHeaderBytes) {
      throw error("resource_limit", "index", "checkpoint index header exceeds maxHeaderBytes", indexHeaderBytes, limits.maxHeaderBytes, "bytes");
    }
    const rawIndexHeader = Buffer.from(indexHeaderJson, "utf8");
    artifactBytes = checkedAdd(
      artifactBytes,
      await writeWireFrame(destination, rawIndexHeader, storedIndex),
      "checkpoint artifact bytes",
      "index",
      "bytes"
    );
    if (endDestination) await endWritable(destination);
    const index: CheckpointArtifactV2IndexSummary = {
      sequence: indexHeader.sequence,
      headerBytes: rawIndexHeader.length,
      decodedBytes: decodedIndex.length,
      decodedSha256: indexHeader.decodedSha256,
      storedBytes: storedIndex.length,
      storedSha256: indexHeader.storedSha256,
      maxRecordBytes: encodedIndexRecord.recordBytes,
    };
    return {
      schemaVersion: CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION,
      artifactBytes,
      data: dataTotals(frames),
      frames,
      components,
      index,
    };
  } catch (cause) {
    if (endDestination && !destination.destroyed) destination.destroy();
    throw cause;
  }
}

class BoundedReadable {
  private readonly iterator: AsyncIterator<unknown>;
  private readonly iteratorListeners: Array<{
    event: string | symbol;
    listener: (...args: any[]) => void;
  }> = [];
  private readonly queue: Buffer[] = [];
  private queueOffset = 0;
  private queuedBytes = 0;
  private ended = false;
  private closed = false;

  constructor(
    private readonly source: Readable,
    private readonly signal: AbortSignal | undefined
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async next(stage: CheckpointArtifactV2ErrorStage): Promise<IteratorResult<unknown>> {
    assertNotCancelled(this.signal, stage);
    const listenersBefore = new Map(
      this.source.eventNames().map((event) => [event, this.source.rawListeners(event)])
    );
    const pending = this.iterator.next();
    for (const event of this.source.eventNames()) {
      const existing = listenersBefore.get(event) ?? [];
      for (const listener of this.source.rawListeners(event)) {
        if (!existing.includes(listener) && !this.iteratorListeners.some((entry) => (
          entry.event === event && entry.listener === listener
        ))) {
          this.iteratorListeners.push({ event, listener });
        }
      }
    }
    if (!this.signal) return await pending;

    let didAbort = false;
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        if (didAbort) return;
        didAbort = true;
        // Interrupt an in-flight iterator.next() without emitting an unrelated
        // stream error. The raced promise still observes its eventual result.
        if (!this.source.destroyed) this.source.destroy();
        reject(cancellationError(stage));
      };
      this.signal!.addEventListener("abort", onAbort, { once: true });
      if (this.signal!.aborted) onAbort();
    });
    try {
      return await Promise.race([pending, interrupted]);
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  private async fill(bytes: number, stage: CheckpointArtifactV2ErrorStage): Promise<void> {
    while (this.queuedBytes < bytes && !this.ended) {
      const next = await this.next(stage);
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      if (chunk.length > 0) {
        this.queue.push(chunk);
        this.queuedBytes += chunk.length;
      }
    }
  }

  async readExactly(bytes: number, stage: CheckpointArtifactV2ErrorStage): Promise<Buffer> {
    await this.fill(bytes, stage);
    if (this.queuedBytes < bytes) {
      throw error("corrupt", stage, `checkpoint artifact ended with ${this.queuedBytes} of ${bytes} required bytes`);
    }
    const first = this.queue[0];
    const firstAvailable = first.length - this.queueOffset;
    if (firstAvailable >= bytes) {
      const result = first.subarray(this.queueOffset, this.queueOffset + bytes);
      this.queueOffset += bytes;
      this.queuedBytes -= bytes;
      if (this.queueOffset === first.length) {
        this.queue.shift();
        this.queueOffset = 0;
      }
      return result;
    }
    const result = Buffer.allocUnsafe(bytes);
    let written = 0;
    while (written < bytes) {
      const chunk = this.queue[0];
      const available = chunk.length - this.queueOffset;
      const take = Math.min(available, bytes - written);
      chunk.copy(result, written, this.queueOffset, this.queueOffset + take);
      written += take;
      this.queueOffset += take;
      this.queuedBytes -= take;
      if (this.queueOffset === chunk.length) {
        this.queue.shift();
        this.queueOffset = 0;
      }
    }
    return result;
  }

  async requireEof(): Promise<void> {
    await this.fill(1, "eof");
    if (this.queuedBytes !== 0) throw error("corrupt", "eof", "checkpoint artifact has trailing bytes after its terminal index");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.source.destroyed) this.source.destroy();
    try {
      await this.iterator.return?.();
    } catch {
      // The codec's parse/read error remains authoritative. Destroying the
      // owned source above releases its backing descriptor and listeners.
    }
    for (const { event, listener } of this.iteratorListeners) {
      this.source.removeListener(event, listener);
    }
    this.iteratorListeners.length = 0;
  }
}

function decodeUtf8(raw: Buffer, stage: CheckpointArtifactV2ErrorStage): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw error("corrupt", stage, "checkpoint artifact contains invalid UTF-8");
  }
}

function enforceJsonDepth(
  text: string,
  limits: CheckpointArtifactV2Limits,
  stage: CheckpointArtifactV2ErrorStage
): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > limits.maxJsonDepth) {
        throw error(
          "resource_limit",
          stage,
          "checkpoint JSON exceeds maxJsonDepth",
          depth,
          limits.maxJsonDepth,
          "depth"
        );
      }
    } else if ((character === "}" || character === "]") && depth > 0) {
      depth -= 1;
    }
  }
}

function exactCompactJson(
  value: unknown,
  text: string,
  stage: CheckpointArtifactV2ErrorStage
): boolean {
  try {
    return JSON.stringify(value) === text;
  } catch {
    throw error("corrupt", stage, "checkpoint JSON cannot be canonicalized within runtime bounds");
  }
}

function parseJsonObject(
  raw: Buffer,
  stage: CheckpointArtifactV2ErrorStage,
  limits: CheckpointArtifactV2Limits
): Record<string, unknown> {
  const text = decodeUtf8(raw, stage);
  enforceJsonDepth(text, limits, stage);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw error("corrupt", stage, "checkpoint artifact contains invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error("corrupt", stage, "checkpoint artifact header/index must be a JSON object");
  }
  if (!exactCompactJson(value, text, stage)) {
    throw error("corrupt", stage, "checkpoint artifact JSON is not in exact compact schema order");
  }
  return value as Record<string, unknown>;
}

function validateCommonHeader(
  value: Record<string, unknown>,
  prefixStoredBytes: number,
  stage: CheckpointArtifactV2ErrorStage
): void {
  if (typeof value.version === "number" && value.version !== CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION) {
    throw error("unsupported", stage, `unsupported checkpoint frame version ${value.version}`);
  }
  if (value.version !== CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION
    || !isSafeNonnegativeInteger(value.sequence)
    || !isSafeNonnegativeInteger(value.recordCount)
    || !isSafeNonnegativeInteger(value.decodedBytes)
    || !isSafeNonnegativeInteger(value.storedBytes)
    || typeof value.decodedSha256 !== "string" || !SHA256_PATTERN.test(value.decodedSha256)
    || typeof value.storedSha256 !== "string" || !SHA256_PATTERN.test(value.storedSha256)) {
    throw error("corrupt", stage, "checkpoint frame header has invalid required fields");
  }
  if (value.encoding !== "gzip") {
    throw error(typeof value.encoding === "string" ? "unsupported" : "corrupt", stage, "checkpoint frame encoding must be gzip");
  }
  if (value.storedBytes !== prefixStoredBytes) {
    throw error("corrupt", stage, "checkpoint stored length prefix does not match its header");
  }
}

function parseHeader(
  raw: Buffer,
  prefixStoredBytes: number,
  limits: CheckpointArtifactV2Limits
): DataFrameHeader | IndexFrameHeader {
  const value = parseJsonObject(raw, "header", limits);
  if (typeof value.version === "number" && value.version !== CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION) {
    throw error("unsupported", "header", `unsupported checkpoint frame version ${value.version}`);
  }
  if (value.kind === "data") {
    if (!exactKeys(value, DATA_HEADER_KEYS)) throw error("corrupt", "header", "checkpoint data header fields/order do not match schema v2");
    validateCommonHeader(value, prefixStoredBytes, "header");
    componentRank(value.component, "header");
    validateField(value.field, "header");
    if (!isSafeNonnegativeInteger(value.start) || value.recordCount === 0 || value.decodedBytes === 0 || value.storedBytes === 0) {
      throw error("corrupt", "header", "checkpoint data header counts must be positive and start must be nonnegative");
    }
    return value as unknown as DataFrameHeader;
  }
  if (value.kind === "index") {
    if (!exactKeys(value, INDEX_HEADER_KEYS)) throw error("corrupt", "header", "checkpoint index header fields/order do not match schema v2");
    validateCommonHeader(value, prefixStoredBytes, "index");
    if (value.recordCount !== 1 || value.decodedBytes === 0 || value.storedBytes === 0) {
      throw error("corrupt", "index", "checkpoint index must contain exactly one nonempty record");
    }
    return value as unknown as IndexFrameHeader;
  }
  throw error("unsupported", "header", `unsupported checkpoint frame kind ${String(value.kind)}`);
}

async function gunzipBounded(
  stored: Buffer,
  declaredBytes: number,
  limitBytes: number
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const decoder = createGunzip();
    const chunks: Buffer[] = [];
    let bytes = 0;
    decoder.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        decoder.destroy(error("resource_limit", "payload", "decoded checkpoint frame exceeds its configured bound", bytes, limitBytes, "bytes"));
        return;
      }
      if (bytes > declaredBytes) {
        decoder.destroy(error("corrupt", "payload", "decoded checkpoint frame exceeds its declared length", bytes, declaredBytes, "bytes"));
        return;
      }
      chunks.push(chunk);
    });
    decoder.once("error", (cause: Error) => {
      reject(cause instanceof CheckpointArtifactV2Error
        ? cause
        : error("corrupt", "payload", `checkpoint gzip frame cannot be decoded: ${cause.message}`));
    });
    decoder.once("end", () => {
      if (bytes !== declaredBytes) {
        reject(error("corrupt", "payload", "decoded checkpoint frame length does not match its header", bytes, declaredBytes, "bytes"));
        return;
      }
      resolve(Buffer.concat(chunks, bytes));
    });
    decoder.end(stored);
  });
}

async function decodeRecords(
  decoded: Buffer,
  expectedCount: number,
  limits: CheckpointArtifactV2Limits,
  callback?: (value: unknown, offset: number, recordBytes: number) => void | Promise<void>,
  collectValues = false
): Promise<{ values: unknown[]; maxRecordBytes: number }> {
  const values: unknown[] = [];
  let offset = 0;
  let count = 0;
  let maxRecordBytes = 0;
  while (offset < decoded.length) {
    if (decoded.length - offset < 4) throw error("corrupt", "record", "checkpoint frame ends inside a record-length prefix");
    const recordBytes = decoded.readUInt32BE(offset);
    offset += 4;
    if (recordBytes > limits.maxRecordBytes) {
      throw error("resource_limit", "record", "checkpoint record exceeds maxRecordBytes", recordBytes, limits.maxRecordBytes, "bytes");
    }
    if (recordBytes > decoded.length - offset) throw error("corrupt", "record", "checkpoint record length exceeds its decoded frame");
    count += 1;
    if (count > limits.maxRecordsPerFrame) {
      throw error("resource_limit", "record", "checkpoint frame exceeds maxRecordsPerFrame", count, limits.maxRecordsPerFrame, "count");
    }
    const raw = decoded.subarray(offset, offset + recordBytes);
    offset += recordBytes;
    const text = decodeUtf8(raw, "record");
    enforceJsonDepth(text, limits, "record");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw error("corrupt", "record", "checkpoint frame contains invalid record JSON");
    }
    if (!exactCompactJson(value, text, "record")) {
      throw error("corrupt", "record", "checkpoint record JSON is not compact canonical JSON");
    }
    maxRecordBytes = Math.max(maxRecordBytes, recordBytes);
    if (collectValues) values.push(value);
    if (callback) await callback(value, count - 1, recordBytes);
  }
  if (count !== expectedCount) throw error("corrupt", "record", "checkpoint frame record count does not match its header", count, expectedCount, "count");
  return { values, maxRecordBytes };
}

function expectedIndexValue(
  frames: CheckpointArtifactV2FrameSummary[],
  components: CheckpointArtifactV2ComponentSummary[]
): ArtifactIndexRecord {
  return indexRecord(frames, components);
}

export async function readCheckpointArtifactV2(
  source: Readable,
  options: CheckpointArtifactV2ReadOptions
): Promise<CheckpointArtifactV2ReadResult> {
  const reader = new BoundedReadable(source, options.signal);
  try {
    const limits = resolveCheckpointArtifactV2Limits(options.limits);
    const frames: CheckpointArtifactV2FrameSummary[] = [];
    const components = emptyComponents();
    const expectedStarts = new Map<string, number>();
    let lastTuple: { rank: number; field: string } | undefined;
    let artifactBytes = 0;
    let totalRecords = 0;
    let totalDecodedBytes = 0;
    let totalStoredBytes = 0;

  assertNotCancelled(options.signal, "magic");
  const magic = await reader.readExactly(CHECKPOINT_ARTIFACT_V2_MAGIC.length, "magic");
  artifactBytes = checkedAdd(artifactBytes, magic.length, "checkpoint artifact bytes", "magic", "bytes");
  if (!magic.equals(CHECKPOINT_ARTIFACT_V2_MAGIC)) {
    const versioned = CHECKPOINT_ARTIFACT_VERSIONED_MAGIC_PROBE_PATTERN.exec(magic.toString("ascii"));
    if (versioned) {
      throw error("unsupported", "magic", `unsupported checkpoint artifact framing version ${versioned[1]}`);
    }
    throw error("corrupt", "magic", "checkpoint artifact has invalid framed-v2 magic bytes");
  }

  while (true) {
    assertNotCancelled(options.signal, "prefix");
    const prefix = await reader.readExactly(8, "prefix");
    artifactBytes = checkedAdd(artifactBytes, prefix.length, "checkpoint artifact bytes", "prefix", "bytes");
    const headerBytes = prefix.readUInt32BE(0);
    const storedBytes = prefix.readUInt32BE(4);
    if (headerBytes === 0) {
      throw error("corrupt", "header", "checkpoint frame header length must be nonzero");
    }
    if (headerBytes > limits.maxHeaderBytes) {
      throw error("resource_limit", "header", "checkpoint frame header exceeds maxHeaderBytes", headerBytes, limits.maxHeaderBytes, "bytes");
    }
    if (storedBytes === 0) {
      throw error("corrupt", "payload", "checkpoint frame stored length must be nonzero");
    }
    if (storedBytes > limits.maxStoredFrameBytes) {
      throw error("resource_limit", "payload", "checkpoint frame exceeds maxStoredFrameBytes", storedBytes, limits.maxStoredFrameBytes, "bytes");
    }
    const rawHeader = await reader.readExactly(headerBytes, "header");
    artifactBytes = checkedAdd(artifactBytes, rawHeader.length, "checkpoint artifact bytes", "header", "bytes");
    const header = parseHeader(rawHeader, storedBytes, limits);
    if (header.sequence !== frames.length) {
      throw error("corrupt", "header", `checkpoint frame sequence ${header.sequence} does not match expected ${frames.length}`);
    }
    if (header.decodedBytes > limits.maxDecodedFrameBytes) {
      throw error("resource_limit", "header", "checkpoint frame exceeds maxDecodedFrameBytes", header.decodedBytes, limits.maxDecodedFrameBytes, "bytes");
    }
    const nextStoredTotal = checkedAdd(totalStoredBytes, header.storedBytes, "checkpoint stored bytes", "header", "bytes");
    if (nextStoredTotal > limits.maxTotalStoredBytes) {
      throw error("resource_limit", "header", "checkpoint artifact exceeds maxTotalStoredBytes", nextStoredTotal, limits.maxTotalStoredBytes, "bytes");
    }
    const nextDecodedTotal = checkedAdd(totalDecodedBytes, header.decodedBytes, "checkpoint decoded bytes", "header", "bytes");
    if (nextDecodedTotal > limits.maxTotalDecodedBytes) {
      throw error("resource_limit", "header", "checkpoint artifact exceeds maxTotalDecodedBytes", nextDecodedTotal, limits.maxTotalDecodedBytes, "bytes");
    }
    if (header.kind === "data") {
      if (frames.length >= limits.maxFrames) {
        throw error("resource_limit", "header", "checkpoint artifact exceeds maxFrames", frames.length + 1, limits.maxFrames, "count");
      }
      if (header.recordCount > limits.maxRecordsPerFrame) {
        throw error("resource_limit", "header", "checkpoint frame exceeds maxRecordsPerFrame", header.recordCount, limits.maxRecordsPerFrame, "count");
      }
      const nextRecords = checkedAdd(totalRecords, header.recordCount, "checkpoint record count", "header", "count");
      if (nextRecords > limits.maxTotalRecords) {
        throw error("resource_limit", "header", "checkpoint artifact exceeds maxTotalRecords", nextRecords, limits.maxTotalRecords, "count");
      }
      const rank = componentRank(header.component, "header");
      const tuple = { rank, field: header.field };
      if (lastTuple && compareTuple(tuple, lastTuple) < 0) {
        throw error("corrupt", "header", "checkpoint frames are not in component/field order");
      }
      const key = `${header.component}\0${header.field}`;
      const expectedStart = expectedStarts.get(key) ?? 0;
      if (header.start !== expectedStart) {
        throw error("corrupt", "header", `checkpoint frame for ${header.component}.${header.field} starts at ${header.start}, expected ${expectedStart}`);
      }
      const stored = await reader.readExactly(storedBytes, "payload");
      artifactBytes = checkedAdd(artifactBytes, stored.length, "checkpoint artifact bytes", "payload", "bytes");
      if (sha256(stored) !== header.storedSha256) throw error("corrupt", "payload", "checkpoint stored frame checksum does not match its header");
      const decoded = await gunzipBounded(stored, header.decodedBytes, limits.maxDecodedFrameBytes);
      if (sha256(decoded) !== header.decodedSha256) throw error("corrupt", "payload", "checkpoint decoded frame checksum does not match its header");
      const decodedRecords = await decodeRecords(decoded, header.recordCount, limits, async (value, offset) => {
        await options.onRecord({
          component: header.component,
          field: header.field,
          index: checkedAdd(header.start, offset, "checkpoint record index", "record", "count"),
          value,
        });
      });
      const summary: CheckpointArtifactV2FrameSummary = {
        sequence: header.sequence,
        component: header.component,
        field: header.field,
        start: header.start,
        recordCount: header.recordCount,
        headerBytes,
        decodedBytes: header.decodedBytes,
        decodedSha256: header.decodedSha256,
        storedBytes: header.storedBytes,
        storedSha256: header.storedSha256,
        maxRecordBytes: decodedRecords.maxRecordBytes,
      };
      frames.push(summary);
      const component = components[rank];
      component.frameCount += 1;
      component.recordCount += summary.recordCount;
      component.decodedBytes += summary.decodedBytes;
      component.storedBytes += summary.storedBytes;
      component.maxRecordBytes = Math.max(component.maxRecordBytes, summary.maxRecordBytes);
      expectedStarts.set(
        key,
        checkedAdd(header.start, header.recordCount, "checkpoint field record count", "header", "count")
      );
      lastTuple = tuple;
      totalRecords = nextRecords;
      totalDecodedBytes = nextDecodedTotal;
      totalStoredBytes = nextStoredTotal;
      continue;
    }

    const stored = await reader.readExactly(storedBytes, "index");
    artifactBytes = checkedAdd(artifactBytes, stored.length, "checkpoint artifact bytes", "index", "bytes");
    if (sha256(stored) !== header.storedSha256) throw error("corrupt", "index", "checkpoint stored index checksum does not match its header");
    const decoded = await gunzipBounded(stored, header.decodedBytes, limits.maxDecodedFrameBytes);
    if (sha256(decoded) !== header.decodedSha256) throw error("corrupt", "index", "checkpoint decoded index checksum does not match its header");
    const decodedIndex = await decodeRecords(decoded, 1, limits, undefined, true);
    const value = decodedIndex.values[0];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw error("corrupt", "index", "checkpoint index record must be an object");
    const record = value as Record<string, unknown>;
    if (typeof record.version === "number" && record.version !== CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION) {
      throw error("unsupported", "index", `unsupported checkpoint index version ${record.version}`);
    }
    if (!exactKeys(record, INDEX_RECORD_KEYS)) throw error("corrupt", "index", "checkpoint index record fields/order do not match schema v2");
    finalizeComponentChecksums(components, frames);
    const expected = expectedIndexValue(frames, components);
    if (!exactCompactJson(record, JSON.stringify(expected), "index")) {
      throw error("corrupt", "index", "checkpoint terminal index does not match observed frame/component totals");
    }
    await reader.requireEof();
    const index: CheckpointArtifactV2IndexSummary = {
      sequence: header.sequence,
      headerBytes,
      decodedBytes: header.decodedBytes,
      decodedSha256: header.decodedSha256,
      storedBytes: header.storedBytes,
      storedSha256: header.storedSha256,
      maxRecordBytes: decodedIndex.maxRecordBytes,
    };
    return {
      schemaVersion: CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION,
      artifactBytes,
      data: dataTotals(frames),
      frames,
      components,
      index,
    };
  }
  } finally {
    await reader.close();
  }
}
