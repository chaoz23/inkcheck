import { createHash, randomUUID } from "crypto";
import { constants as bufferConstants } from "buffer";
import * as fs from "fs";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createGzip, gunzipSync } from "zlib";
import {
  CheckpointArtifactV2Error,
  DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS,
  type CheckpointArtifactV2FrameInput,
  type CheckpointArtifactV2Limits,
  type CheckpointArtifactV2ReadResult,
  type CheckpointArtifactV2WriteResult,
  readCheckpointArtifactV2,
  writeCheckpointArtifactV2,
} from "./checkpoint-artifact-v2";
import { compile, scanKnots } from "./inklecate";
import {
  SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION,
  type SharedSearchCheckpoint,
} from "./explore";
import { VERSION } from "./version";

export const CHECKPOINT_ARTIFACT_SCHEMA_VERSION = 1;
export const CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION = 2;
export const DEFAULT_MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_PROJECT_CHECKPOINT_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_GENERATIONS = 3;
export const CHECKPOINT_MANIFEST_SCHEMA_VERSION = 1;
export const CHECKPOINT_MANIFEST_V2_SCHEMA_VERSION = 2;
export const DEFAULT_MAX_STORED_CHECKPOINT_READ_BYTES = DEFAULT_MAX_CHECKPOINT_BYTES;
export const DEFAULT_MAX_DECOMPRESSED_CHECKPOINT_READ_BYTES = Math.min(
  DEFAULT_MAX_CHECKPOINT_BYTES,
  bufferConstants.MAX_STRING_LENGTH
);

const MAX_CHECKPOINT_MANIFEST_BYTES = 64 * 1024;
const MAX_CHECKPOINT_RECOVERY_MANIFESTS = 32;
const CHECKPOINT_RECOVERY_SLOT_WIDTH = String(MAX_CHECKPOINT_RECOVERY_MANIFESTS - 1).length;

export type CheckpointFreshness = "current" | "stale" | "path_changed";
export type CheckpointArtifactFormat = "legacy-v1" | "framed-v2";
type CheckpointStorageEncoding = "json" | "gzip" | "framed-v2";

export interface CheckpointWriteAccountingV1 {
  schemaVersion: 1;
  outcome: "created" | "reused";
  checkpointGraph: {
    count: 1;
    logicalUtf8Bytes: number;
    peakSourceChunkUtf8Bytes: number;
  };
  serialization: {
    status: "applied";
    logicalArtifactUtf8BytesEmitted: number;
    peakSourceChunkUtf8Bytes: number;
  } | {
    status: "not_applied";
    logicalArtifactUtf8BytesEmitted: 0;
    peakSourceChunkUtf8Bytes: 0;
  };
  compression: {
    status: "applied";
    storedBytesEmitted: number;
    peakOutputChunkBytes: number;
    configuredCapacity: {
      basis: "configured_capacity_not_observed_heap";
      zlibWorkspaceBytes: number;
      streamHighWaterMarksBytes: {
        compressorWritable: number;
        compressorReadable: number;
        outputLimiterWritable: number;
        outputLimiterReadable: number;
        destinationWritable: number;
      };
      streamTotalBytes: number;
      totalBytes: number;
    };
  } | {
    status: "not_applied";
    storedBytesEmitted: 0;
    peakOutputChunkBytes: 0;
  };
  /** Present only for a framed-v2 write; legacy monolithic owners stay not_applied. */
  framedV2?: {
    status: "applied";
    codec: CheckpointArtifactV2AccountingSummary;
  };
  durable: {
    payloadBytes: number;
    manifestBytes: number;
    totalPairBytes: number;
  };
}

export interface CheckpointArtifactReference {
  id: string;
  path: string;
  pruned: string[];
  accounting: CheckpointWriteAccountingV1;
}

export interface CheckpointArtifactSummary {
  id: string;
  path: string;
  /** Persisted artifact-envelope schema; independent of list/show response schemas. */
  artifactSchemaVersion: 1 | 2;
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
  storageEncoding: CheckpointStorageEncoding;
  /** Privacy-safe fixed component totals projected from the bounded v2 sidecar. */
  framedV2?: CheckpointArtifactV2AccountingSummary;
}

export interface CheckpointStorageLimits {
  maxCheckpointBytes?: number;
  maxProjectBytes?: number;
  maxGenerationsPerEntrypoint?: number;
  /** Storage layout only. The default remains the byte-compatible gzip v1 artifact. */
  format?: CheckpointArtifactFormat;
  /** Cancellation is honored only while the payload is still private. */
  signal?: AbortSignal;
  framedV2Limits?: Partial<CheckpointArtifactV2Limits>;
}

export interface CheckpointReadLimits {
  maxStoredBytes?: number;
  maxDecompressedBytes?: number;
  signal?: AbortSignal;
  framedV2Limits?: Partial<CheckpointArtifactV2Limits>;
}

type CheckpointByteStorageLimits = Required<Pick<
  CheckpointStorageLimits,
  "maxCheckpointBytes" | "maxProjectBytes" | "maxGenerationsPerEntrypoint"
>>;
type CheckpointByteReadLimits = Required<Pick<
  CheckpointReadLimits,
  "maxStoredBytes" | "maxDecompressedBytes"
>>;

export interface CheckpointReadAccountingV1 {
  schemaVersion: 1;
  status: "completed" | "failed";
  storageEncoding: CheckpointStorageEncoding;
  /** Effective safety limits. These values describe bounds, not allocations. */
  configuredLimits: {
    basis: "configured_limits_not_allocated_capacity";
    maxManifestBytes: number;
    maxStoredBytes: number;
    maxDecompressedBytes: number;
  };
  manifest: {
    status: "applied" | "not_present" | "not_completed";
    storedBuffer: { count: 0 | 1; bytes: number };
    rawString: { count: 0 | 1; logicalUtf8Bytes: number };
    parsedGraph: { count: 0 | 1; sourceLogicalUtf8Bytes: number };
    validationString: { count: 0 | 1; logicalUtf8Bytes: number };
  };
  storedPayload: {
    status: "applied" | "not_applied" | "not_completed";
    count: 0 | 1;
    bytes: number;
  };
  decompressedPayload: {
    status: "applied" | "not_applied" | "not_completed";
    count: 0 | 1;
    bytes: number;
  };
  rawArtifactString: {
    status: "applied" | "not_applied" | "not_completed";
    count: 0 | 1;
    logicalUtf8Bytes: number;
  };
  parsedArtifactGraph: {
    status: "applied" | "not_applied" | "not_completed";
    count: 0 | 1;
    /** UTF-8 bytes in the JSON source from which this graph was parsed. */
    sourceLogicalUtf8Bytes: number;
  };
  validationTraversal: {
    status: "applied" | "not_completed";
    count: 0 | 1;
    logicalCheckpointUtf8BytesVisited: number;
    peakSourceChunkUtf8Bytes: number;
    configurationStrings: {
      count: 0 | 2;
      logicalUtf8Bytes: number;
      peakStringUtf8Bytes: number;
    };
  };
  /**
   * Sum of every reached logical owner reported by this receipt plus the
   * largest validation chunk. This is conservative potential, not an observed
   * simultaneous peak or a measurement of runtime/library internals.
   */
  conservativePotential: {
    basis: "sum_of_reached_logical_owners_not_observed_peak";
    totalBytes: number;
  };
  /** The checkpoint graph retained by the API caller after return. */
  currentReturnedGraph: {
    status: "applied" | "not_applied";
    count: 0 | 1;
    logicalUtf8Bytes: number;
  };
  /** Present only for a framed-v2 read; no whole stored/decompressed/raw owner is claimed. */
  framedV2?: {
    status: "applied";
    codec: CheckpointArtifactV2AccountingSummary;
  };
  failure?: {
    kind: CheckpointReadErrorKind;
    stage: CheckpointReadStage;
  };
}

export type CheckpointReadErrorKind = "corrupt" | "resource_limit" | "unsupported";
export type CheckpointReadStage = "manifest" | "storage" | "decompression" | "json" | "envelope";
export type CheckpointReadLimitUnit = "bytes" | "count" | "depth";

export class CheckpointReadError extends Error {
  payloadVerified = false;
  /** Partial read-accounting receipt when the error came from open/resume. */
  accounting?: CheckpointReadAccountingV1;
  /** Generic resource-limit metric. Present only when the failure reports a bound. */
  readonly observed?: number;
  readonly limit?: number;
  readonly unit?: CheckpointReadLimitUnit;
  /** Backwards-compatible byte aliases; absent for count and depth limits. */
  readonly observedBytes?: number;
  readonly limitBytes?: number;

  constructor(
    public readonly kind: CheckpointReadErrorKind,
    public readonly stage: CheckpointReadStage,
    message: string,
    observed?: number,
    limit?: number,
    unit?: CheckpointReadLimitUnit
  ) {
    super(message);
    this.name = "CheckpointReadError";
    this.observed = observed;
    this.limit = limit;
    this.unit = observed === undefined && limit === undefined ? undefined : (unit ?? "bytes");
    if (this.unit === "bytes") {
      this.observedBytes = observed;
      this.limitBytes = limit;
    }
  }
}

interface CheckpointArtifact {
  artifactSchemaVersion: 1 | 2;
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

const CHECKPOINT_V2_COMPONENT_ORDER = [
  "configuration", "scheduler", "frontier", "witnessAncestry", "dedupe",
  "semanticIndexes", "findings", "metadata",
] as const;

export interface CheckpointArtifactV2ManifestSummary {
  schemaVersion: 2;
  componentOrder: typeof CHECKPOINT_V2_COMPONENT_ORDER;
  artifactBytes: number;
  artifactOverheadBytes: number;
  data: CheckpointArtifactV2WriteResult["data"];
  components: CheckpointArtifactV2WriteResult["components"];
  index: CheckpointArtifactV2WriteResult["index"];
}

export interface CheckpointArtifactV2AccountingSummary {
  schemaVersion: 2;
  componentOrder: typeof CHECKPOINT_V2_COMPONENT_ORDER;
  artifactBytes: number;
  artifactOverheadBytes: number;
  data: CheckpointArtifactV2WriteResult["data"];
  components: Array<{
    component: CheckpointArtifactV2WriteResult["components"][number]["component"];
    frameCount: number;
    recordCount: number;
    decodedBytes: number;
    storedBytes: number;
    maxRecordBytes: number;
  }>;
  index: {
    sequence: number;
    headerBytes: number;
    decodedBytes: number;
    storedBytes: number;
    maxRecordBytes: number;
  };
}

function checkpointArtifactV2Summary(
  result: CheckpointArtifactV2WriteResult | CheckpointArtifactV2ReadResult
): CheckpointArtifactV2ManifestSummary {
  const artifactOverheadBytes = result.artifactBytes - result.data.storedBytes - result.index.storedBytes;
  if (!Number.isSafeInteger(artifactOverheadBytes) || artifactOverheadBytes < 0) {
    throw corrupt("storage", "framed checkpoint codec returned inconsistent artifact overhead");
  }
  return {
    schemaVersion: CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION,
    componentOrder: CHECKPOINT_V2_COMPONENT_ORDER,
    artifactBytes: result.artifactBytes,
    artifactOverheadBytes,
    data: result.data,
    components: result.components,
    index: result.index,
  };
}

function checkpointArtifactV2AccountingSummary(
  summary: CheckpointArtifactV2ManifestSummary
): CheckpointArtifactV2AccountingSummary {
  return {
    schemaVersion: CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION,
    componentOrder: CHECKPOINT_V2_COMPONENT_ORDER,
    artifactBytes: summary.artifactBytes,
    artifactOverheadBytes: summary.artifactOverheadBytes,
    data: summary.data,
    components: summary.components.map((component) => ({
      component: component.component,
      frameCount: component.frameCount,
      recordCount: component.recordCount,
      decodedBytes: component.decodedBytes,
      storedBytes: component.storedBytes,
      maxRecordBytes: component.maxRecordBytes,
    })),
    index: {
      sequence: summary.index.sequence,
      headerBytes: summary.index.headerBytes,
      decodedBytes: summary.index.decodedBytes,
      storedBytes: summary.index.storedBytes,
      maxRecordBytes: summary.index.maxRecordBytes,
    },
  };
}

const CHECKPOINT_V2_STATE_COMPONENT_FIELDS = [
  {
    component: "scheduler",
    fields: ["current", "deep", "insertionOrder", "novelty", "policyCursor", "random", "rngState"],
  },
  {
    component: "frontier",
    fields: [
      "activeStateBytes", "activeVariableBytes", "pendingBytes", "pendingStates",
      "pendingVariableBytes", "peakPendingBytes", "peakPendingStates", "retainedNodes",
    ],
  },
  {
    component: "witnessAncestry",
    fields: ["ancestryPayloadBytes"],
  },
  {
    component: "dedupe",
    fields: ["dedupeBytes", "dedupeHits", "seenChoiceSets", "seenStates"],
  },
  {
    component: "semanticIndexes",
    fields: [
      "meaningfulVariableTransitions", "semanticIndexBytes", "variableStateCounts",
      "variableTransitionCounts", "visitedKnots",
    ],
  },
  {
    component: "findings",
    fields: [
      "discoveryCurve", "endings", "findingBytes", "lastDiscoveryAtState", "runtimeErrors",
      "runtimeWarnings", "sharedObservability", "visibleOutcomes",
    ],
  },
  {
    component: "metadata",
    fields: [
      "deepestStateDiscovered", "finished", "frontierCompactions", "guardChecksSinceLast",
      "maxDepthReached", "ownerAccounting", "peakRetainedMemory", "releasedNodes",
      "statesExplored", "totalGranted", "truncated", "truncatedBy",
    ],
  },
] as const satisfies ReadonlyArray<{
  component: CheckpointArtifactV2FrameInput["component"];
  fields: readonly (keyof SharedSearchCheckpoint["state"])[];
}>;

const CHECKPOINT_V2_ARRAY_STATE_FIELDS = new Set<keyof SharedSearchCheckpoint["state"]>([
  "deep", "endings", "novelty", "random", "runtimeErrors", "runtimeWarnings", "seenChoiceSets",
  "seenStates", "variableStateCounts", "variableTransitionCounts", "visibleOutcomes", "visitedKnots",
]);

function *checkpointV2NodePayloadRecords(
  nodes: SharedSearchCheckpoint["state"]["nodes"]
): Generator<unknown> {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node === null) continue;
    yield {
      index,
      ...(node.stateJson === undefined ? {} : { stateJson: node.stateJson }),
      ...(node.variables === undefined ? {} : { variables: node.variables }),
    };
  }
}

function *checkpointV2NodeAncestryRecords(
  nodes: SharedSearchCheckpoint["state"]["nodes"]
): Generator<unknown> {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node === null) continue;
    yield {
      index,
      parent: node.parent,
      ...(node.choiceText === undefined ? {} : { choiceText: node.choiceText }),
      ...(node.choiceIndex === undefined ? {} : { choiceIndex: node.choiceIndex }),
      depth: node.depth,
      active: node.active,
      childRefs: node.childRefs,
      stateBytes: node.stateBytes,
      variableBytes: node.variableBytes,
      ancestryBytes: node.ancestryBytes,
    };
  }
}

function checkpointArtifactV2Frames(
  artifact: CheckpointArtifact
): CheckpointArtifactV2FrameInput[] {
  const state = artifact.checkpoint.state;
  const frames: CheckpointArtifactV2FrameInput[] = [{
    component: "configuration",
    field: "checkpoint",
    start: 0,
    records: [{
      schemaVersion: artifact.checkpoint.schemaVersion,
      engine: artifact.checkpoint.engine,
      configuration: artifact.checkpoint.configuration,
    }],
  }];
  for (const spec of CHECKPOINT_V2_STATE_COMPONENT_FIELDS) {
    for (const field of spec.fields) {
      const value = state[field];
      if (value === undefined) continue;
      frames.push({
        component: spec.component,
        field,
        start: 0,
        records: CHECKPOINT_V2_ARRAY_STATE_FIELDS.has(field)
          ? value as Iterable<unknown>
          : [value],
      });
    }
    if (spec.component === "frontier") {
      frames.push({
        component: "frontier",
        field: "nodePayload",
        start: 0,
        records: checkpointV2NodePayloadRecords(state.nodes),
      });
    }
    if (spec.component === "witnessAncestry") {
      frames.push({
        component: "witnessAncestry",
        field: "nodeSlots",
        start: 0,
        records: [state.nodes.length],
      }, {
        component: "witnessAncestry",
        field: "nodes",
        start: 0,
        records: checkpointV2NodeAncestryRecords(state.nodes),
      });
    }
    if (spec.component === "metadata") {
      frames.push({
        component: "metadata",
        field: "artifact",
        start: 0,
        records: [{
          artifactSchemaVersion: artifact.artifactSchemaVersion,
          artifactType: artifact.artifactType,
          id: artifact.id,
          createdAt: artifact.createdAt,
          inkcheckVersion: artifact.inkcheckVersion,
          checkpointSchemaVersion: artifact.checkpointSchemaVersion,
          source: artifact.source,
          storySha256: artifact.storySha256,
          knotsSha256: artifact.knotsSha256,
        }],
      });
    }
  }
  return frames.sort((left, right) => {
    return CHECKPOINT_V2_COMPONENT_ORDER.indexOf(left.component)
      - CHECKPOINT_V2_COMPONENT_ORDER.indexOf(right.component)
      || (left.field < right.field ? -1 : left.field > right.field ? 1 : 0);
  });
}

type CheckpointV2Record = {
  component: CheckpointArtifactV2FrameInput["component"];
  field: string;
  index: number;
  value: unknown;
};

const CHECKPOINT_V2_SPECIAL_FIELDS = new Set([
  "configuration\0checkpoint",
  "frontier\0nodePayload",
  "witnessAncestry\0nodeSlots",
  "witnessAncestry\0nodes",
  "metadata\0artifact",
]);
const CHECKPOINT_V2_STATE_FIELDS = new Map<string, keyof SharedSearchCheckpoint["state"]>();
for (const spec of CHECKPOINT_V2_STATE_COMPONENT_FIELDS) {
  for (const field of spec.fields) {
    CHECKPOINT_V2_STATE_FIELDS.set(`${spec.component}\0${field}`, field);
  }
}

function checkpointV2Object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  description: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt("envelope", `${description} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(record).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(record, key))) {
    throw corrupt("envelope", `${description} fields do not match the framed-v2 schema`);
  }
  return record;
}

class CheckpointArtifactV2Assembly {
  private readonly records = new Map<string, unknown[]>();

  constructor(private readonly maxNodeSlots: number) {}

  add(record: CheckpointV2Record): void {
    const key = `${record.component}\0${record.field}`;
    const stateField = CHECKPOINT_V2_STATE_FIELDS.get(key);
    if (!stateField && !CHECKPOINT_V2_SPECIAL_FIELDS.has(key)) {
      throw corrupt("envelope", `framed checkpoint contains unknown ${record.component}.${record.field} records`);
    }
    const values = this.records.get(key) ?? [];
    if (record.index !== values.length) {
      throw corrupt("envelope", `framed checkpoint ${record.component}.${record.field} record indexes are not contiguous`);
    }
    const scalar = key === "configuration\0checkpoint"
      || key === "witnessAncestry\0nodeSlots"
      || key === "metadata\0artifact"
      || (stateField !== undefined && !CHECKPOINT_V2_ARRAY_STATE_FIELDS.has(stateField));
    if (scalar && values.length > 0) {
      throw corrupt("envelope", `framed checkpoint ${record.component}.${record.field} has duplicate scalar records`);
    }
    values.push(record.value);
    this.records.set(key, values);
  }

  private values(component: string, field: string): unknown[] {
    return this.records.get(`${component}\0${field}`) ?? [];
  }

  private one(component: string, field: string, optional = false): unknown {
    const values = this.values(component, field);
    if (values.length === 0 && optional) return undefined;
    if (values.length !== 1) {
      throw corrupt("envelope", `framed checkpoint ${component}.${field} must contain exactly one record`);
    }
    return values[0];
  }

  artifact(expectedId: string, accounting: CheckpointReadAccountingV1): CheckpointArtifact {
    const header = checkpointV2Object(
      this.one("configuration", "checkpoint"),
      ["schemaVersion", "engine", "configuration"],
      [],
      "framed checkpoint configuration header"
    );
    if (header.schemaVersion !== SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION) {
      throw unsupported(
        "envelope",
        `unsupported shared checkpoint schema ${String(header.schemaVersion)}; use a compatible Inkcheck version or migrate the checkpoint`
      );
    }
    const stateValue = <K extends keyof SharedSearchCheckpoint["state"]>(
      component: string,
      field: K,
      optional = false
    ): SharedSearchCheckpoint["state"][K] => {
      if (CHECKPOINT_V2_ARRAY_STATE_FIELDS.has(field)) {
        return this.values(component, field) as SharedSearchCheckpoint["state"][K];
      }
      return this.one(component, field, optional) as SharedSearchCheckpoint["state"][K];
    };

    const nodeSlots = this.one("witnessAncestry", "nodeSlots");
    if (!Number.isSafeInteger(nodeSlots) || (nodeSlots as number) < 0) {
      throw corrupt("envelope", "framed checkpoint node-slot count must be a non-negative safe integer");
    }
    if ((nodeSlots as number) > this.maxNodeSlots) {
      throw resourceLimit(
        "envelope",
        `framed checkpoint node-slot count ${String(nodeSlots)} exceeds its ${this.maxNodeSlots}-slot bound`,
        nodeSlots as number,
        this.maxNodeSlots,
        "count"
      );
    }
    const nodes: SharedSearchCheckpoint["state"]["nodes"] = Array(nodeSlots as number).fill(null);
    const payloadByIndex = new Map<number, Record<string, unknown>>();
    for (const value of this.values("frontier", "nodePayload")) {
      const payload = checkpointV2Object(
        value,
        ["index"],
        ["stateJson", "variables"],
        "framed checkpoint node payload"
      );
      if (!Number.isSafeInteger(payload.index) || (payload.index as number) < 0
        || (payload.index as number) >= nodes.length || payloadByIndex.has(payload.index as number)) {
        throw corrupt("envelope", "framed checkpoint node payload index is invalid or duplicated");
      }
      payloadByIndex.set(payload.index as number, payload);
    }
    const ancestryIndexes = new Set<number>();
    for (const value of this.values("witnessAncestry", "nodes")) {
      const ancestry = checkpointV2Object(
        value,
        [
          "index", "parent", "depth", "active", "childRefs", "stateBytes", "variableBytes",
          "ancestryBytes",
        ],
        ["choiceText", "choiceIndex"],
        "framed checkpoint node ancestry"
      );
      const index = ancestry.index;
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= nodes.length
        || ancestryIndexes.has(index as number)) {
        throw corrupt("envelope", "framed checkpoint node ancestry index is invalid or duplicated");
      }
      const payload = payloadByIndex.get(index as number);
      if (!payload) {
        throw corrupt("envelope", "framed checkpoint node ancestry is missing its split payload record");
      }
      ancestryIndexes.add(index as number);
      nodes[index as number] = {
        ...(Object.hasOwn(payload, "stateJson") ? { stateJson: payload.stateJson as string } : {}),
        ...(Object.hasOwn(payload, "variables")
          ? { variables: payload.variables as Record<string, unknown> }
          : {}),
        parent: ancestry.parent as number | null,
        ...(Object.hasOwn(ancestry, "choiceText") ? { choiceText: ancestry.choiceText as string } : {}),
        ...(Object.hasOwn(ancestry, "choiceIndex") ? { choiceIndex: ancestry.choiceIndex as number } : {}),
        depth: ancestry.depth as number,
        active: ancestry.active as boolean,
        childRefs: ancestry.childRefs as number,
        stateBytes: ancestry.stateBytes as number,
        variableBytes: ancestry.variableBytes as number,
        ancestryBytes: ancestry.ancestryBytes as number,
      };
    }
    if (payloadByIndex.size !== ancestryIndexes.size) {
      throw corrupt("envelope", "framed checkpoint has a node payload without matching ancestry metadata");
    }

    const meaningfulVariableTransitions = stateValue(
      "semanticIndexes", "meaningfulVariableTransitions", true
    );
    const sharedObservability = stateValue("findings", "sharedObservability", true);
    const ownerAccounting = stateValue("metadata", "ownerAccounting", true);
    const checkpoint: SharedSearchCheckpoint = {
      schemaVersion: SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION,
      engine: header.engine as SharedSearchCheckpoint["engine"],
      configuration: header.configuration as SharedSearchCheckpoint["configuration"],
      state: {
        endings: stateValue("findings", "endings"),
        visibleOutcomes: stateValue("findings", "visibleOutcomes"),
        runtimeErrors: stateValue("findings", "runtimeErrors"),
        runtimeWarnings: stateValue("findings", "runtimeWarnings"),
        visitedKnots: stateValue("semanticIndexes", "visitedKnots"),
        seenStates: stateValue("dedupe", "seenStates"),
        seenChoiceSets: stateValue("dedupe", "seenChoiceSets"),
        variableStateCounts: stateValue("semanticIndexes", "variableStateCounts"),
        variableTransitionCounts: stateValue("semanticIndexes", "variableTransitionCounts"),
        ...(meaningfulVariableTransitions === undefined ? {} : { meaningfulVariableTransitions }),
        nodes,
        deep: stateValue("scheduler", "deep"),
        random: stateValue("scheduler", "random"),
        novelty: stateValue("scheduler", "novelty"),
        rngState: stateValue("scheduler", "rngState"),
        policyCursor: stateValue("scheduler", "policyCursor"),
        insertionOrder: stateValue("scheduler", "insertionOrder"),
        current: stateValue("scheduler", "current"),
        pendingStates: stateValue("frontier", "pendingStates"),
        pendingBytes: stateValue("frontier", "pendingBytes"),
        pendingVariableBytes: stateValue("frontier", "pendingVariableBytes"),
        activeStateBytes: stateValue("frontier", "activeStateBytes"),
        activeVariableBytes: stateValue("frontier", "activeVariableBytes"),
        peakPendingStates: stateValue("frontier", "peakPendingStates"),
        peakPendingBytes: stateValue("frontier", "peakPendingBytes"),
        retainedNodes: stateValue("frontier", "retainedNodes"),
        dedupeBytes: stateValue("dedupe", "dedupeBytes"),
        semanticIndexBytes: stateValue("semanticIndexes", "semanticIndexBytes"),
        releasedNodes: stateValue("metadata", "releasedNodes"),
        frontierCompactions: stateValue("metadata", "frontierCompactions"),
        guardChecksSinceLast: stateValue("metadata", "guardChecksSinceLast"),
        statesExplored: stateValue("metadata", "statesExplored"),
        totalGranted: stateValue("metadata", "totalGranted"),
        dedupeHits: stateValue("dedupe", "dedupeHits"),
        maxDepthReached: stateValue("metadata", "maxDepthReached"),
        deepestStateDiscovered: stateValue("metadata", "deepestStateDiscovered"),
        lastDiscoveryAtState: stateValue("findings", "lastDiscoveryAtState"),
        discoveryCurve: stateValue("findings", "discoveryCurve"),
        truncated: stateValue("metadata", "truncated"),
        truncatedBy: stateValue("metadata", "truncatedBy"),
        finished: stateValue("metadata", "finished"),
        findingBytes: stateValue("findings", "findingBytes"),
        ancestryPayloadBytes: stateValue("witnessAncestry", "ancestryPayloadBytes"),
        peakRetainedMemory: stateValue("metadata", "peakRetainedMemory"),
        ...(sharedObservability === undefined ? {} : { sharedObservability }),
        ...(ownerAccounting === undefined ? {} : { ownerAccounting }),
      },
    };
    const metadata = checkpointV2Object(
      this.one("metadata", "artifact"),
      [
        "artifactSchemaVersion", "artifactType", "id", "createdAt", "inkcheckVersion",
        "checkpointSchemaVersion", "source", "storySha256", "knotsSha256",
      ],
      [],
      "framed checkpoint artifact metadata"
    );
    if (metadata.artifactSchemaVersion !== CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION) {
      throw unsupported(
        "envelope",
        `unsupported checkpoint artifact schema ${String(metadata.artifactSchemaVersion)}; use a compatible Inkcheck version or migrate the artifact`
      );
    }
    const artifact: CheckpointArtifact = {
      artifactSchemaVersion: CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION,
      artifactType: metadata.artifactType as CheckpointArtifact["artifactType"],
      id: metadata.id as string,
      createdAt: metadata.createdAt as string,
      inkcheckVersion: metadata.inkcheckVersion as string,
      checkpointSchemaVersion: metadata.checkpointSchemaVersion as number,
      source: metadata.source as CheckpointArtifact["source"],
      storySha256: metadata.storySha256 as string,
      knotsSha256: metadata.knotsSha256 as string,
      configuration: checkpoint.configuration,
      checkpoint,
    };
    return validateParsedArtifact(artifact, expectedId, accounting);
  }
}

interface CheckpointArtifactManifest {
  manifestSchemaVersion: 1 | 2;
  artifactSchemaVersion: 1 | 2;
  artifactType: "shared-search-checkpoint";
  id: string;
  createdAt: string;
  inkcheckVersion: string;
  checkpointSchemaVersion: number;
  entrypoint: string;
  engine: string;
  totalGranted: number;
  statesExplored: number;
  storageEncoding: CheckpointStorageEncoding;
  artifactSizeBytes: number;
  artifactSha256: string;
  framedV2?: CheckpointArtifactV2ManifestSummary;
  manifestSha256: string;
}

interface CheckpointRecord extends CheckpointArtifactSummary {
  file: string;
  manifestFile?: string;
}

interface LoadedCheckpointArtifact {
  artifact: CheckpointArtifact;
  file: string;
  storageEncoding: CheckpointStorageEncoding;
  payloadSizeBytes: number;
  payloadSha256: string;
  framedV2?: CheckpointArtifactV2ManifestSummary;
  accounting: CheckpointReadAccountingV1;
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

function checkpointRelativePath(id: string, encoding: CheckpointStorageEncoding = "gzip"): string {
  const suffix = encoding === "framed-v2" ? "inkcp" : encoding === "gzip" ? "json.gz" : "json";
  return path.posix.join(".inkcheck", "checkpoints", `${id}.${suffix}`);
}

function validateId(id: string): void {
  if (!/^checkpoint-[0-9a-f]{24}$/.test(id)) {
    throw new Error("checkpoint ID must look like checkpoint- followed by 24 lowercase hex characters");
  }
}

function checkpointDestination(
  projectRoot: string,
  id: string,
  format: CheckpointArtifactFormat = "legacy-v1"
): string {
  validateId(id);
  return path.join(
    checkpointsDirectory(projectRoot),
    `${id}.${format === "framed-v2" ? "inkcp" : "json.gz"}`
  );
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

function checkpointPublicationPayloadFile(projectRoot: string, id: string): string {
  validateId(id);
  return path.join(checkpointsDirectory(projectRoot), `.${id}.payload.commit`);
}

function checkpointDestinationForEncoding(
  projectRoot: string,
  id: string,
  encoding: CheckpointStorageEncoding
): string {
  validateId(id);
  const directory = checkpointsDirectory(projectRoot);
  if (encoding === "framed-v2") return path.join(directory, `${id}.inkcp`);
  if (encoding === "gzip") return path.join(directory, `${id}.json.gz`);
  return path.join(directory, `${id}.json`);
}

function checkpointCandidateFiles(projectRoot: string, id: string): string[] {
  validateId(id);
  const directory = checkpointsDirectory(projectRoot);
  return [
    path.join(directory, `${id}.inkcp`),
    path.join(directory, `${id}.json.gz`),
    path.join(directory, `${id}.json`),
  ];
}

function checkpointFile(projectRoot: string, id: string): string {
  const candidates = checkpointCandidateFiles(projectRoot, id);
  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  if (existing.length > 1) {
    throw corrupt("storage", `checkpoint ${id} has duplicate artifact layouts; retain only one valid copy`);
  }
  return existing[0] ?? checkpointDestination(projectRoot, id);
}

function checkpointStorageEncoding(file: string): CheckpointStorageEncoding {
  if (file.endsWith(".inkcp")) return "framed-v2";
  if (file.endsWith(".gz")) return "gzip";
  return "json";
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

interface JsonChunkAccounting {
  logicalUtf8Bytes: number;
  peakSourceChunkUtf8Bytes: number;
}

interface CheckpointIdentity {
  id: string;
  checkpointGraph: CheckpointWriteAccountingV1["checkpointGraph"];
}

function exactByteAdd(description: string, total: number, value: number): number {
  if (!Number.isSafeInteger(total) || total < 0
    || !Number.isSafeInteger(value) || value < 0
    || value > Number.MAX_SAFE_INTEGER - total) {
    throw new RangeError(`${description} exceeds the safe integer range`);
  }
  return total + value;
}

function exactByteSum(description: string, values: readonly number[]): number {
  let total = 0;
  for (const value of values) total = exactByteAdd(description, total, value);
  return total;
}

function checkpointReadAccounting(
  storageEncoding: CheckpointStorageEncoding,
  limits: CheckpointByteReadLimits
): CheckpointReadAccountingV1 {
  return {
    schemaVersion: 1,
    status: "completed",
    storageEncoding,
    configuredLimits: {
      basis: "configured_limits_not_allocated_capacity",
      maxManifestBytes: MAX_CHECKPOINT_MANIFEST_BYTES,
      maxStoredBytes: limits.maxStoredBytes,
      maxDecompressedBytes: limits.maxDecompressedBytes,
    },
    manifest: {
      status: "not_present",
      storedBuffer: { count: 0, bytes: 0 },
      rawString: { count: 0, logicalUtf8Bytes: 0 },
      parsedGraph: { count: 0, sourceLogicalUtf8Bytes: 0 },
      validationString: { count: 0, logicalUtf8Bytes: 0 },
    },
    storedPayload: storageEncoding === "framed-v2"
      ? { status: "not_applied", count: 0, bytes: 0 }
      : { status: "not_completed", count: 0, bytes: 0 },
    decompressedPayload: storageEncoding === "gzip"
      ? { status: "not_completed", count: 0, bytes: 0 }
      : { status: "not_applied", count: 0, bytes: 0 },
    rawArtifactString: {
      status: storageEncoding === "framed-v2" ? "not_applied" : "not_completed",
      count: 0,
      logicalUtf8Bytes: 0,
    },
    parsedArtifactGraph: {
      status: storageEncoding === "framed-v2" ? "not_applied" : "not_completed",
      count: 0,
      sourceLogicalUtf8Bytes: 0,
    },
    validationTraversal: {
      status: "not_completed",
      count: 0,
      logicalCheckpointUtf8BytesVisited: 0,
      peakSourceChunkUtf8Bytes: 0,
      configurationStrings: {
        count: 0,
        logicalUtf8Bytes: 0,
        peakStringUtf8Bytes: 0,
      },
    },
    conservativePotential: {
      basis: "sum_of_reached_logical_owners_not_observed_peak",
      totalBytes: 0,
    },
    currentReturnedGraph: {
      status: "not_applied",
      count: 0,
      logicalUtf8Bytes: 0,
    },
  };
}

function finalizeCheckpointReadAccounting(
  accounting: CheckpointReadAccountingV1,
  error?: CheckpointReadError
): CheckpointReadAccountingV1 {
  accounting.status = error ? "failed" : "completed";
  if (error) accounting.failure = { kind: error.kind, stage: error.stage };
  else delete accounting.failure;
  accounting.conservativePotential.totalBytes = exactByteSum(
    "checkpoint read conservative-potential byte count",
    [
      accounting.manifest.storedBuffer.bytes,
      accounting.manifest.rawString.logicalUtf8Bytes,
      accounting.manifest.parsedGraph.sourceLogicalUtf8Bytes,
      accounting.manifest.validationString.logicalUtf8Bytes,
      accounting.storedPayload.bytes,
      accounting.decompressedPayload.bytes,
      accounting.rawArtifactString.logicalUtf8Bytes,
      accounting.parsedArtifactGraph.sourceLogicalUtf8Bytes,
      accounting.validationTraversal.peakSourceChunkUtf8Bytes,
      accounting.validationTraversal.configurationStrings.logicalUtf8Bytes,
    ]
  );
  return accounting;
}

function retainReturnedCheckpointGraph(accounting: CheckpointReadAccountingV1): void {
  accounting.currentReturnedGraph = {
    status: "applied",
    count: 1,
    logicalUtf8Bytes: accounting.validationTraversal.logicalCheckpointUtf8BytesVisited,
  };
  finalizeCheckpointReadAccounting(accounting);
}

function accountJsonChunk(accounting: JsonChunkAccounting, chunk: string): void {
  const bytes = Buffer.byteLength(chunk);
  accounting.logicalUtf8Bytes = exactByteAdd(
    "checkpoint logical UTF-8 byte count",
    accounting.logicalUtf8Bytes,
    bytes
  );
  accounting.peakSourceChunkUtf8Bytes = Math.max(accounting.peakSourceChunkUtf8Bytes, bytes);
}

function *accountedJsonChunks(
  value: unknown,
  accounting: JsonChunkAccounting
): Generator<string> {
  for (const chunk of jsonChunks(value)) {
    accountJsonChunk(accounting, chunk);
    yield chunk;
  }
}

function checkpointIdentity(entrypoint: string, checkpoint: SharedSearchCheckpoint): CheckpointIdentity {
  const hash = createHash("sha256").update(entrypoint).update("\0");
  const accounting: JsonChunkAccounting = {
    logicalUtf8Bytes: 0,
    peakSourceChunkUtf8Bytes: 0,
  };
  for (const chunk of accountedJsonChunks(checkpoint, accounting)) hash.update(chunk);
  return {
    id: `checkpoint-${hash.digest("hex").slice(0, 24)}`,
    checkpointGraph: {
      count: 1,
      logicalUtf8Bytes: accounting.logicalUtf8Bytes,
      peakSourceChunkUtf8Bytes: accounting.peakSourceChunkUtf8Bytes,
    },
  };
}

function checkpointId(entrypoint: string, checkpoint: SharedSearchCheckpoint): string {
  return checkpointIdentity(entrypoint, checkpoint).id;
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
  limitBytes: number,
  unit: CheckpointReadLimitUnit = "bytes"
): CheckpointReadError {
  return new CheckpointReadError("resource_limit", stage, message, observedBytes, limitBytes, unit);
}

function validateStoredEntrypoint(projectRoot: string, entrypoint: string, stage: "manifest" | "envelope"): void {
  try {
    sourcePath(projectRoot, entrypoint);
  } catch {
    throw corrupt(stage, "checkpoint metadata contains an invalid project-relative entrypoint");
  }
}

function checkpointReadLimits(input: CheckpointReadLimits): CheckpointByteReadLimits {
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
  description: string,
  onBufferAllocated?: (bytes: number) => void
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
    onBufferAllocated?.(size);
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
  limits: CheckpointByteReadLimits,
  onBufferAllocated?: (bytes: number) => void
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
    onBufferAllocated?.(size);
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

function decompressCheckpointJson(
  compressed: Buffer,
  limits: CheckpointByteReadLimits,
  accounting?: CheckpointReadAccountingV1
): string {
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
  if (accounting) {
    accounting.decompressedPayload = {
      status: "applied",
      count: 1,
      bytes: decompressed.length,
    };
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

function removeMatchingPublicationPayload(
  projectRoot: string,
  id: string,
  expected: CheckpointPayloadDigest,
  maxStoredBytes: number
): boolean {
  const neutral = checkpointPublicationPayloadFile(projectRoot, id);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(neutral);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  // Reject a clearly foreign inode/size before hashing it under this caller's
  // cap. A later writer may legitimately have produced a larger layout with
  // different limits; its neutral must be left to that writer, not surfaced as
  // a resource failure in the already-verified canonical operation.
  if ((expected.inode !== 0 && stat.ino !== 0
      && (stat.dev !== expected.device || stat.ino !== expected.inode))
    || stat.size !== expected.sizeBytes) return false;
  let current: CheckpointPayloadDigest;
  try {
    current = fileDigest(neutral, maxStoredBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!samePayloadDigest(current, expected)) return false;
  try {
    fs.rmSync(neutral);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  syncDirectory(checkpointsDirectory(projectRoot));
  return true;
}

function validateParsedArtifact(
  value: unknown,
  expectedId?: string,
  accounting?: CheckpointReadAccountingV1
): CheckpointArtifact {
  if (!value || typeof value !== "object") {
    throw corrupt("envelope", "checkpoint artifact must be a JSON object");
  }
  const artifact = value as Partial<CheckpointArtifact>;
  if (artifact.artifactSchemaVersion !== CHECKPOINT_ARTIFACT_SCHEMA_VERSION
    && artifact.artifactSchemaVersion !== CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION) {
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
  const actualIdentity = checkpointIdentity(artifact.source.entrypoint, artifact.checkpoint);
  if (accounting) {
    accounting.validationTraversal = {
      status: "applied",
      count: 1,
      logicalCheckpointUtf8BytesVisited: actualIdentity.checkpointGraph.logicalUtf8Bytes,
      peakSourceChunkUtf8Bytes: actualIdentity.checkpointGraph.peakSourceChunkUtf8Bytes,
      configurationStrings: {
        count: 0,
        logicalUtf8Bytes: 0,
        peakStringUtf8Bytes: 0,
      },
    };
  }
  if (artifact.id !== actualIdentity.id || (expectedId !== undefined && artifact.id !== expectedId)) {
    throw corrupt("envelope", "checkpoint artifact content does not match its stable ID; restore or regenerate the artifact");
  }
  const configuration = artifact.checkpoint.configuration;
  const artifactConfigurationJson = JSON.stringify(artifact.configuration);
  const checkpointConfigurationJson = JSON.stringify(configuration);
  if (accounting) {
    const artifactConfigurationBytes = Buffer.byteLength(artifactConfigurationJson, "utf8");
    const checkpointConfigurationBytes = Buffer.byteLength(checkpointConfigurationJson, "utf8");
    accounting.validationTraversal.configurationStrings = {
      count: 2,
      logicalUtf8Bytes: exactByteSum(
        "checkpoint configuration-validation string byte count",
        [artifactConfigurationBytes, checkpointConfigurationBytes]
      ),
      peakStringUtf8Bytes: Math.max(artifactConfigurationBytes, checkpointConfigurationBytes),
    };
  }
  if (artifact.storySha256 !== configuration.storySha256
    || artifact.knotsSha256 !== configuration.knotsSha256
    || artifactConfigurationJson !== checkpointConfigurationJson) {
    throw corrupt("envelope", "checkpoint artifact metadata does not match its saved frontier; restore or regenerate the artifact");
  }
  return artifact as CheckpointArtifact;
}

function parseArtifact(
  raw: string,
  expectedId?: string,
  accounting?: CheckpointReadAccountingV1
): CheckpointArtifact {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corrupt("json", "checkpoint artifact is corrupt JSON; remove it or restore a valid copy before reopening it");
  }
  if (accounting) {
    accounting.parsedArtifactGraph = {
      status: "applied",
      count: 1,
      sourceLogicalUtf8Bytes: Buffer.byteLength(raw, "utf8"),
    };
  }
  return validateParsedArtifact(value, expectedId, accounting);
}

function loadLegacyArtifactDetailed(
  projectRoot: string,
  id: string,
  inputLimits: CheckpointReadLimits = {}
): LoadedCheckpointArtifact {
  const file = checkpointFile(projectRoot, id);
  if (!fs.existsSync(file)) throw new Error(`checkpoint not found: ${id}`);
  const limits = checkpointReadLimits(inputLimits);
  const storageEncoding = checkpointStorageEncoding(file);
  if (storageEncoding === "framed-v2") {
    throw unsupported("storage", "framed-v2 checkpoints require the version-2 streaming reader");
  }
  const accounting = checkpointReadAccounting(storageEncoding, limits);
  try {
    let storedManifest: CheckpointArtifactManifest | undefined;
    const manifestFile = checkpointManifestFile(projectRoot, id);
    if (fs.existsSync(manifestFile)) {
      accounting.manifest.status = "not_completed";
      storedManifest = readCheckpointManifest(projectRoot, id, accounting).manifest;
      validateManifestStorage(projectRoot, id, file, storedManifest);
    }
    let raw: string;
    let payloadSizeBytes: number;
    let payloadSha256: string;
    if (storageEncoding === "gzip") {
      const stored = readBoundedBuffer(
        file,
        limits.maxStoredBytes,
        "storage",
        "stored checkpoint artifact",
        (bytes) => {
          accounting.storedPayload = { status: "not_completed", count: 1, bytes };
        }
      );
      accounting.storedPayload.status = "applied";
      payloadSizeBytes = stored.length;
      payloadSha256 = createHash("sha256").update(stored).digest("hex");
      if (storedManifest && storedManifest.artifactSha256 !== payloadSha256) {
        throw corrupt("storage", "checkpoint artifact bytes do not match its metadata checksum; restore or regenerate it");
      }
      try {
        raw = decompressCheckpointJson(stored, limits, accounting);
      } catch (error) {
        if (storedManifest && error instanceof CheckpointReadError && error.kind === "resource_limit") {
          error.payloadVerified = true;
        }
        throw error;
      }
    } else {
      const stored = readLegacyJsonBuffer(file, limits, (bytes) => {
        accounting.storedPayload = { status: "not_completed", count: 1, bytes };
      });
      accounting.storedPayload.status = "applied";
      raw = stored.toString("utf8");
      payloadSizeBytes = stored.length;
      payloadSha256 = createHash("sha256").update(stored).digest("hex");
      if (storedManifest && storedManifest.artifactSha256 !== payloadSha256) {
        throw corrupt("storage", "checkpoint artifact bytes do not match its metadata checksum; restore or regenerate it");
      }
    }
    accounting.rawArtifactString = {
      status: "applied",
      count: 1,
      logicalUtf8Bytes: Buffer.byteLength(raw, "utf8"),
    };
    const artifact = parseArtifact(raw, id, accounting);
    if (artifact.artifactSchemaVersion !== CHECKPOINT_ARTIFACT_SCHEMA_VERSION) {
      throw unsupported("envelope", "a legacy JSON checkpoint cannot contain a framed-v2 artifact envelope");
    }
    validateStoredEntrypoint(projectRoot, artifact.source.entrypoint, "envelope");
    const loaded: LoadedCheckpointArtifact = {
      artifact,
      file,
      storageEncoding,
      payloadSizeBytes,
      payloadSha256,
      accounting,
    };
    validateManifestForLoaded(projectRoot, loaded, storedManifest);
    finalizeCheckpointReadAccounting(accounting);
    return loaded;
  } catch (error) {
    if (error instanceof CheckpointReadError) {
      error.accounting = finalizeCheckpointReadAccounting(accounting, error);
    }
    throw error;
  }
}

function checkpointAbortError(message = "checkpoint artifact operation was cancelled"): Error {
  const aborted = new Error(message);
  aborted.name = "AbortError";
  return aborted;
}

function checkpointReadErrorFromV2(error: CheckpointArtifactV2Error): Error {
  if (error.kind === "cancelled") return checkpointAbortError(error.message);
  const stage: CheckpointReadStage = error.stage === "record"
    ? "json"
    : error.stage === "payload"
      ? "decompression"
      : "storage";
  const metric = error.metric;
  return new CheckpointReadError(
    error.kind,
    stage,
    error.message,
    metric === undefined ? undefined : error.observed,
    metric === undefined ? undefined : error.limit,
    metric
  );
}

async function loadFramedArtifactDetailed(
  projectRoot: string,
  id: string,
  inputLimits: CheckpointReadLimits = {}
): Promise<LoadedCheckpointArtifact> {
  const file = checkpointFile(projectRoot, id);
  if (!fs.existsSync(file)) throw new Error(`checkpoint not found: ${id}`);
  if (checkpointStorageEncoding(file) !== "framed-v2") {
    throw unsupported("storage", "legacy checkpoints require the schema-v1 reader");
  }
  const limits = checkpointReadLimits(inputLimits);
  const accounting = checkpointReadAccounting("framed-v2", limits);
  try {
    inputLimits.signal?.throwIfAborted();
    const manifestFile = checkpointManifestFile(projectRoot, id);
    if (!fs.existsSync(manifestFile)) {
      throw corrupt("manifest", "framed-v2 checkpoints require their versioned metadata manifest");
    }
    accounting.manifest.status = "not_completed";
    const storedManifest = readCheckpointManifest(projectRoot, id, accounting).manifest;
    validateManifestStorage(projectRoot, id, file, storedManifest);
    if (!storedManifest.framedV2) {
      throw corrupt("manifest", "framed-v2 checkpoint metadata is missing its component summary");
    }
    inputLimits.signal?.throwIfAborted();
    const maxNodeSlots = inputLimits.framedV2Limits?.maxTotalRecords
      ?? DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalRecords;
    const assembly = new CheckpointArtifactV2Assembly(maxNodeSlots);
    const requestedStored = inputLimits.framedV2Limits?.maxTotalStoredBytes
      ?? DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalStoredBytes;
    const requestedDecoded = inputLimits.framedV2Limits?.maxTotalDecodedBytes
      ?? DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalDecodedBytes;
    let codec: CheckpointArtifactV2ReadResult;
    let payloadSizeBytes = 0;
    let payloadSha256 = "";
    const fd = fs.openSync(file, "r");
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      fs.closeSync(fd);
      throw corrupt("storage", "stored checkpoint artifact must be a regular file");
    }
    if (opened.size > limits.maxStoredBytes) {
      fs.closeSync(fd);
      throw resourceLimit(
        "storage",
        `stored checkpoint artifact is ${opened.size} bytes, above the ${limits.maxStoredBytes}-byte readback limit`,
        opened.size,
        limits.maxStoredBytes
      );
    }
    const source = fs.createReadStream(file, { fd, autoClose: false, start: 0 });
    const digest = new CheckpointReadDigestTransform(limits.maxStoredBytes);
    try {
      [codec] = await Promise.all([
        readCheckpointArtifactV2(digest, {
          limits: {
            ...inputLimits.framedV2Limits,
            maxTotalStoredBytes: Math.min(requestedStored, limits.maxStoredBytes),
            maxTotalDecodedBytes: Math.min(requestedDecoded, limits.maxDecompressedBytes),
          },
          signal: inputLimits.signal,
          onRecord: (record) => assembly.add(record),
        }),
        pipeline(source, digest),
      ]);
      const after = fs.fstatSync(fd);
      let visible: fs.Stats;
      try {
        visible = fs.statSync(file);
      } catch {
        throw corrupt("storage", "checkpoint artifact path changed while its opened payload was being decoded");
      }
      const openedIdentityChanged = opened.dev !== 0 && after.dev !== 0
        && (opened.dev !== after.dev || opened.ino !== after.ino);
      const pathIdentityChanged = opened.dev !== 0 && visible.dev !== 0
        && (opened.dev !== visible.dev || opened.ino !== visible.ino);
      if (openedIdentityChanged || pathIdentityChanged || after.size !== opened.size
        || visible.size !== opened.size || digest.bytes !== opened.size) {
        throw corrupt("storage", "checkpoint artifact changed while its opened payload was being decoded");
      }
      payloadSizeBytes = digest.bytes;
      payloadSha256 = digest.digest();
    } catch (error) {
      if (!source.destroyed) source.destroy();
      if (inputLimits.signal?.aborted) throw checkpointAbortError();
      if (error instanceof CheckpointArtifactV2Error) throw checkpointReadErrorFromV2(error);
      throw error;
    } finally {
      try {
        fs.closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
      }
    }
    if (payloadSha256 !== storedManifest.artifactSha256) {
      throw corrupt("storage", "checkpoint artifact bytes do not match its metadata checksum; restore or regenerate it");
    }
    if (codec.artifactBytes !== payloadSizeBytes) {
      throw corrupt("storage", "framed checkpoint codec byte count does not match its metadata");
    }
    const framedV2 = checkpointArtifactV2Summary(codec);
    if (JSON.stringify(framedV2) !== JSON.stringify(storedManifest.framedV2)) {
      throw corrupt("manifest", "framed checkpoint component summary does not match its streamed payload");
    }
    accounting.framedV2 = {
      status: "applied",
      codec: checkpointArtifactV2AccountingSummary(framedV2),
    };
    const artifact = assembly.artifact(id, accounting);
    validateStoredEntrypoint(projectRoot, artifact.source.entrypoint, "envelope");
    const loaded: LoadedCheckpointArtifact = {
      artifact,
      file,
      storageEncoding: "framed-v2",
      payloadSizeBytes,
      payloadSha256,
      framedV2,
      accounting,
    };
    validateManifestForLoaded(projectRoot, loaded, storedManifest);
    finalizeCheckpointReadAccounting(accounting);
    return loaded;
  } catch (error) {
    if (error instanceof CheckpointReadError) {
      error.accounting = finalizeCheckpointReadAccounting(accounting, error);
    }
    throw error;
  }
}

async function loadArtifactDetailed(
  projectRoot: string,
  id: string,
  inputLimits: CheckpointReadLimits = {}
): Promise<LoadedCheckpointArtifact> {
  const file = checkpointFile(projectRoot, id);
  inputLimits.signal?.throwIfAborted();
  if (checkpointStorageEncoding(file) === "framed-v2") {
    return loadFramedArtifactDetailed(projectRoot, id, inputLimits);
  }
  const loaded = loadLegacyArtifactDetailed(projectRoot, id, inputLimits);
  inputLimits.signal?.throwIfAborted();
  return loaded;
}

function summary(projectRoot: string, loaded: LoadedCheckpointArtifact): CheckpointArtifactSummary {
  const { artifact } = loaded;
  const manifestFile = checkpointManifestFile(projectRoot, artifact.id);
  const metadataSizeBytes = fs.existsSync(manifestFile) ? fs.statSync(manifestFile).size : 0;
  return {
    id: artifact.id,
    path: checkpointRelativePath(artifact.id, loaded.storageEncoding),
    artifactSchemaVersion: artifact.artifactSchemaVersion,
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
    ...(loaded.framedV2
      ? { framedV2: checkpointArtifactV2AccountingSummary(loaded.framedV2) }
      : {}),
  };
}

function manifestForArtifact(
  artifact: CheckpointArtifact,
  storageEncoding: CheckpointStorageEncoding,
  artifactSizeBytes: number,
  artifactSha256: string,
  framedV2?: CheckpointArtifactV2ManifestSummary
): CheckpointArtifactManifest {
  const framed = storageEncoding === "framed-v2";
  if (framed !== (artifact.artifactSchemaVersion === CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION)) {
    throw new Error("checkpoint artifact schema does not match its requested storage encoding");
  }
  if (framed !== (framedV2 !== undefined)) {
    throw new Error("framed checkpoint metadata summary does not match its storage encoding");
  }
  const body: Omit<CheckpointArtifactManifest, "manifestSha256"> = {
    manifestSchemaVersion: framed
      ? CHECKPOINT_MANIFEST_V2_SCHEMA_VERSION
      : CHECKPOINT_MANIFEST_SCHEMA_VERSION,
    artifactSchemaVersion: artifact.artifactSchemaVersion,
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
    ...(framedV2 ? { framedV2 } : {}),
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
    ...(manifest.framedV2 ? { framedV2: manifest.framedV2 } : {}),
  };
}

function manifestDigest(
  manifest: Omit<CheckpointArtifactManifest, "manifestSha256">,
  accounting?: CheckpointReadAccountingV1
): string {
  const raw = JSON.stringify(manifest);
  if (accounting) {
    accounting.manifest.validationString = {
      count: 1,
      logicalUtf8Bytes: Buffer.byteLength(raw, "utf8"),
    };
  }
  return createHash("sha256").update(raw).digest("hex");
}

function serializedManifest(manifest: CheckpointArtifactManifest): string {
  return JSON.stringify(manifest);
}

function exactOrderedKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeManifestCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateCheckpointArtifactV2ManifestSummary(
  value: unknown,
  artifactSizeBytes: number
): CheckpointArtifactV2ManifestSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt("manifest", "framed checkpoint summary must be an object");
  }
  const summary = value as Record<string, unknown>;
  if (typeof summary.schemaVersion === "number"
    && summary.schemaVersion !== CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION) {
    throw unsupported(
      "manifest",
      `unsupported framed checkpoint summary schema ${String(summary.schemaVersion)}; use a compatible Inkcheck version`
    );
  }
  if (!exactOrderedKeys(summary, [
    "schemaVersion", "componentOrder", "artifactBytes", "artifactOverheadBytes",
    "data", "components", "index",
  ]) || summary.schemaVersion !== CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION) {
    throw corrupt("manifest", "framed checkpoint summary fields/order do not match schema v2");
  }
  if (!Array.isArray(summary.componentOrder)
    || JSON.stringify(summary.componentOrder) !== JSON.stringify(CHECKPOINT_V2_COMPONENT_ORDER)) {
    throw corrupt("manifest", "framed checkpoint component order does not match schema v2");
  }
  if (!safeManifestCount(summary.artifactBytes)
    || !safeManifestCount(summary.artifactOverheadBytes)
    || summary.artifactBytes !== artifactSizeBytes) {
    throw corrupt("manifest", "framed checkpoint artifact byte totals are invalid");
  }
  if (!summary.data || typeof summary.data !== "object" || Array.isArray(summary.data)
    || !exactOrderedKeys(summary.data as Record<string, unknown>, [
      "frameCount", "recordCount", "decodedBytes", "storedBytes", "maxRecordBytes",
    ])) {
    throw corrupt("manifest", "framed checkpoint data totals fields/order do not match schema v2");
  }
  const data = summary.data as Record<string, unknown>;
  if (![data.frameCount, data.recordCount, data.decodedBytes, data.storedBytes, data.maxRecordBytes]
    .every(safeManifestCount)) {
    throw corrupt("manifest", "framed checkpoint data totals must be non-negative safe integers");
  }
  if (!Array.isArray(summary.components)
    || summary.components.length !== CHECKPOINT_V2_COMPONENT_ORDER.length) {
    throw corrupt("manifest", "framed checkpoint summary must contain all fixed components");
  }
  const shaPattern = /^[0-9a-f]{64}$/;
  const components = summary.components.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !exactOrderedKeys(value as Record<string, unknown>, [
        "component", "frameCount", "recordCount", "decodedBytes", "decodedSha256",
        "storedBytes", "storedSha256", "maxRecordBytes",
      ])) {
      throw corrupt("manifest", "framed checkpoint component summary fields/order do not match schema v2");
    }
    const component = value as Record<string, unknown>;
    if (component.component !== CHECKPOINT_V2_COMPONENT_ORDER[index]
      || ![
        component.frameCount, component.recordCount, component.decodedBytes,
        component.storedBytes, component.maxRecordBytes,
      ].every(safeManifestCount)
      || typeof component.decodedSha256 !== "string" || !shaPattern.test(component.decodedSha256)
      || typeof component.storedSha256 !== "string" || !shaPattern.test(component.storedSha256)) {
      throw corrupt("manifest", "framed checkpoint component summary values are invalid");
    }
    return component;
  });
  if (!summary.index || typeof summary.index !== "object" || Array.isArray(summary.index)
    || !exactOrderedKeys(summary.index as Record<string, unknown>, [
      "sequence", "headerBytes", "decodedBytes", "decodedSha256", "storedBytes",
      "storedSha256", "maxRecordBytes",
    ])) {
    throw corrupt("manifest", "framed checkpoint index summary fields/order do not match schema v2");
  }
  const index = summary.index as Record<string, unknown>;
  if (![index.sequence, index.headerBytes, index.decodedBytes, index.storedBytes, index.maxRecordBytes]
    .every(safeManifestCount)
    || typeof index.decodedSha256 !== "string" || !shaPattern.test(index.decodedSha256)
    || typeof index.storedSha256 !== "string" || !shaPattern.test(index.storedSha256)) {
    throw corrupt("manifest", "framed checkpoint index summary values are invalid");
  }
  const componentTotals = components.reduce<{
    frameCount: number;
    recordCount: number;
    decodedBytes: number;
    storedBytes: number;
    maxRecordBytes: number;
  }>((totals, component) => ({
    frameCount: totals.frameCount + (component.frameCount as number),
    recordCount: totals.recordCount + (component.recordCount as number),
    decodedBytes: totals.decodedBytes + (component.decodedBytes as number),
    storedBytes: totals.storedBytes + (component.storedBytes as number),
    maxRecordBytes: Math.max(totals.maxRecordBytes, component.maxRecordBytes as number),
  }), { frameCount: 0, recordCount: 0, decodedBytes: 0, storedBytes: 0, maxRecordBytes: 0 });
  if (Object.keys(componentTotals).some((key) => {
    const typed = key as keyof typeof componentTotals;
    return componentTotals[typed] !== data[typed];
  }) || index.sequence !== data.frameCount
    || summary.artifactOverheadBytes !== (summary.artifactBytes as number)
      - (data.storedBytes as number) - (index.storedBytes as number)) {
    throw corrupt("manifest", "framed checkpoint summary totals are internally inconsistent");
  }
  return summary as unknown as CheckpointArtifactV2ManifestSummary;
}

function parseManifest(
  raw: string,
  expectedId: string,
  accounting?: CheckpointReadAccountingV1
): CheckpointArtifactManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corrupt("manifest", "checkpoint metadata manifest is corrupt JSON; restore or regenerate it");
  }
  if (accounting) {
    accounting.manifest.parsedGraph = {
      count: 1,
      sourceLogicalUtf8Bytes: Buffer.byteLength(raw, "utf8"),
    };
  }
  if (!value || typeof value !== "object") {
    throw corrupt("manifest", "checkpoint metadata manifest must be a JSON object");
  }
  const manifest = value as Partial<CheckpointArtifactManifest>;
  if (typeof manifest.manifestSchemaVersion === "number"
    && manifest.manifestSchemaVersion !== CHECKPOINT_MANIFEST_SCHEMA_VERSION
    && manifest.manifestSchemaVersion !== CHECKPOINT_MANIFEST_V2_SCHEMA_VERSION) {
    throw unsupported(
      "manifest",
      `unsupported checkpoint metadata manifest schema ${String(manifest.manifestSchemaVersion)}; use a compatible Inkcheck version`
    );
  }
  const expectedKeys: Array<keyof CheckpointArtifactManifest> = [
    "manifestSchemaVersion", "artifactSchemaVersion", "artifactType", "id", "createdAt",
    "inkcheckVersion", "checkpointSchemaVersion", "entrypoint", "engine", "totalGranted",
    "statesExplored", "storageEncoding", "artifactSizeBytes", "artifactSha256", "manifestSha256",
    ...(manifest.manifestSchemaVersion === CHECKPOINT_MANIFEST_V2_SCHEMA_VERSION
      ? ["framedV2" as const]
      : []),
  ];
  const actualKeys = Object.keys(manifest).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== [...expectedKeys].sort()[index])) {
    throw corrupt("manifest", "checkpoint metadata manifest fields do not match its schema");
  }
  if (manifest.manifestSchemaVersion !== CHECKPOINT_MANIFEST_SCHEMA_VERSION
    && manifest.manifestSchemaVersion !== CHECKPOINT_MANIFEST_V2_SCHEMA_VERSION) {
    throw corrupt("manifest", "checkpoint metadata manifest is missing its schema version");
  }
  const validLayout = manifest.manifestSchemaVersion === CHECKPOINT_MANIFEST_SCHEMA_VERSION
    ? manifest.artifactSchemaVersion === CHECKPOINT_ARTIFACT_SCHEMA_VERSION
      && (manifest.storageEncoding === "json" || manifest.storageEncoding === "gzip")
      && manifest.framedV2 === undefined
    : manifest.artifactSchemaVersion === CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION
      && manifest.storageEncoding === "framed-v2"
      && manifest.framedV2 !== undefined;
  if (!validLayout || manifest.checkpointSchemaVersion !== SHARED_SEARCH_CHECKPOINT_SCHEMA_VERSION) {
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
    || (manifest.storageEncoding !== "json" && manifest.storageEncoding !== "gzip"
      && manifest.storageEncoding !== "framed-v2")
    || !Number.isSafeInteger(manifest.artifactSizeBytes) || (manifest.artifactSizeBytes ?? 0) < 1
    || typeof manifest.artifactSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.artifactSha256)
    || (manifest.framedV2 !== undefined
      && (!manifest.framedV2 || typeof manifest.framedV2 !== "object"))
    || typeof manifest.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.manifestSha256)) {
    throw corrupt("manifest", "checkpoint metadata manifest is missing required fields; restore or regenerate it");
  }
  if (manifest.manifestSchemaVersion === CHECKPOINT_MANIFEST_V2_SCHEMA_VERSION) {
    manifest.framedV2 = validateCheckpointArtifactV2ManifestSummary(
      manifest.framedV2,
      manifest.artifactSizeBytes as number
    );
  }
  const complete = manifest as CheckpointArtifactManifest;
  if (manifestDigest(manifestBody(complete), accounting) !== complete.manifestSha256) {
    throw corrupt("manifest", "checkpoint metadata manifest content does not match its canonical checksum");
  }
  return complete;
}

function readCheckpointManifest(
  projectRoot: string,
  id: string,
  accounting?: CheckpointReadAccountingV1
): {
  manifest: CheckpointArtifactManifest;
  sizeBytes: number;
} {
  const manifestFile = checkpointManifestFile(projectRoot, id);
  const stored = readBoundedBuffer(
    manifestFile,
    MAX_CHECKPOINT_MANIFEST_BYTES,
    "manifest",
    "checkpoint metadata manifest",
    (bytes) => {
      if (accounting) accounting.manifest.storedBuffer = { count: 1, bytes };
    }
  );
  const raw = stored.toString("utf8");
  if (accounting) {
    accounting.manifest.rawString = {
      count: 1,
      logicalUtf8Bytes: Buffer.byteLength(raw, "utf8"),
    };
  }
  const manifest = parseManifest(raw, id, accounting);
  if (accounting) {
    accounting.manifest.status = "applied";
  }
  return { manifest, sizeBytes: stored.length };
}

function validateManifestStorage(
  projectRoot: string,
  id: string,
  file: string,
  manifest: CheckpointArtifactManifest
): void {
  validateStoredEntrypoint(projectRoot, manifest.entrypoint, "manifest");
  const storageEncoding = checkpointStorageEncoding(file);
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
  let manifest: CheckpointArtifactManifest;
  if (alreadyRead) {
    manifest = alreadyRead;
  } else {
    loaded.accounting.manifest.status = "not_completed";
    manifest = readCheckpointManifest(
      projectRoot,
      loaded.artifact.id,
      loaded.accounting
    ).manifest;
  }
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
  const storageEncoding = checkpointStorageEncoding(file);
  const payloadSizeBytes = manifest.artifactSizeBytes;
  return {
    id,
    path: checkpointRelativePath(id, storageEncoding),
    artifactSchemaVersion: manifest.artifactSchemaVersion,
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
    ...(manifest.framedV2
      ? { framedV2: checkpointArtifactV2AccountingSummary(manifest.framedV2) }
      : {}),
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
    .filter((name) => /^checkpoint-[0-9a-f]{24}\.(?:json(?:\.gz)?|inkcp)$/.test(name));
  const ids = new Set<string>();
  return names.map((name) => {
    const id = name.slice(0, name.indexOf("."));
    if (ids.has(id)) {
      throw corrupt("storage", `checkpoint ${id} has duplicate artifact layouts; retain only one valid copy`);
    }
    ids.add(id);
    const file = path.join(directory, name);
    const manifestFile = checkpointManifestFile(projectRoot, id);
    if (fs.existsSync(manifestFile)) return recordFromManifest(projectRoot, id, file);
    if (checkpointStorageEncoding(file) === "framed-v2") {
      throw corrupt("manifest", `framed checkpoint ${id} is missing its required versioned metadata manifest`);
    }
    return { ...summary(projectRoot, loadLegacyArtifactDetailed(projectRoot, id, inputLimits)), file };
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
  peakChunkBytes = 0;
  private readonly hash = createHash("sha256");

  constructor(private readonly kind: "single" | "project", private readonly limit: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.bytes += chunk.length;
    this.peakChunkBytes = Math.max(this.peakChunkBytes, chunk.length);
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

class CheckpointReadDigestTransform extends Transform {
  bytes = 0;
  private readonly hash = createHash("sha256");

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(resourceLimit(
        "storage",
        `stored checkpoint artifact exceeds the ${this.limit}-byte readback limit`,
        this.bytes,
        this.limit
      ));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }

  digest(): string {
    return this.hash.digest("hex");
  }
}

interface CheckpointArtifactWriteAccounting {
  serialization?: Extract<CheckpointWriteAccountingV1["serialization"], { status: "applied" }>;
  compression?: Extract<CheckpointWriteAccountingV1["compression"], { status: "applied" }>;
  framedV2?: NonNullable<CheckpointWriteAccountingV1["framedV2"]>;
}

interface WrittenCheckpointArtifact extends CheckpointArtifactWriteAccounting {
  sizeBytes: number;
  sha256: string;
  framedV2Manifest?: CheckpointArtifactV2ManifestSummary;
}

// Integration-owned validation failures are raised before writeFramedArtifact
// creates a destination stream. This private subtype is the only failed-write
// path that may truthfully join a concurrently committed same-ID winner.
class CheckpointFramedPreflightError extends CheckpointArtifactV2Error {}

const CHECKPOINT_GZIP_WINDOW_BITS = 15;
const CHECKPOINT_GZIP_MEMORY_LEVEL = 8;

function zlibWorkspaceCapacityBytes(): number {
  // zlib documents this as deflate's configured window/hash tables plus its
  // approximately 6-KiB overhead. It is a capacity estimate, not evidence
  // that Node or V8 retained this many bytes.
  return (1 << (CHECKPOINT_GZIP_WINDOW_BITS + 2))
    + (1 << (CHECKPOINT_GZIP_MEMORY_LEVEL + 9))
    + 6 * 1024;
}

async function writeCompressedArtifact(
  temporary: string,
  artifact: CheckpointArtifact,
  limits: CheckpointByteStorageLimits,
  precreated = false,
  signal?: AbortSignal
): Promise<WrittenCheckpointArtifact> {
  const kind = limits.maxCheckpointBytes <= limits.maxProjectBytes ? "single" : "project";
  const limit = Math.min(limits.maxCheckpointBytes, limits.maxProjectBytes);
  const serialization: JsonChunkAccounting = {
    logicalUtf8Bytes: 0,
    peakSourceChunkUtf8Bytes: 0,
  };
  const source = Readable.from(accountedJsonChunks(artifact, serialization));
  const compressor = createGzip({
    level: 1,
    windowBits: CHECKPOINT_GZIP_WINDOW_BITS,
    memLevel: CHECKPOINT_GZIP_MEMORY_LEVEL,
  });
  const limiter = new ByteLimitTransform(kind, limit);
  const destination = fs.createWriteStream(temporary, { flags: precreated ? "r+" : "wx", mode: 0o600 });
  const streamHighWaterMarksBytes = {
    compressorWritable: compressor.writableHighWaterMark,
    compressorReadable: compressor.readableHighWaterMark,
    outputLimiterWritable: limiter.writableHighWaterMark,
    outputLimiterReadable: limiter.readableHighWaterMark,
    destinationWritable: destination.writableHighWaterMark,
  };
  const streamTotalBytes = exactByteSum(
    "checkpoint configured stream capacity",
    Object.values(streamHighWaterMarksBytes)
  );
  const workspaceBytes = zlibWorkspaceCapacityBytes();
  await pipeline(
    source,
    // Checkpoints favor fast commits over archival density. Their repeated Ink
    // state still compresses heavily at level 1, while users and agents wait at
    // this durable result-window boundary.
    compressor,
    limiter,
    destination,
    { signal }
  );
  // Windows requires a writable handle for fsync even after the stream has
  // closed; reopening r+ preserves the same durability step on every platform.
  const fd = fs.openSync(temporary, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return {
    sizeBytes: limiter.bytes,
    sha256: limiter.digest(),
    serialization: {
      status: "applied",
      logicalArtifactUtf8BytesEmitted: serialization.logicalUtf8Bytes,
      peakSourceChunkUtf8Bytes: serialization.peakSourceChunkUtf8Bytes,
    },
    compression: {
      status: "applied",
      storedBytesEmitted: limiter.bytes,
      peakOutputChunkBytes: limiter.peakChunkBytes,
      configuredCapacity: {
        basis: "configured_capacity_not_observed_heap",
        zlibWorkspaceBytes: workspaceBytes,
        streamHighWaterMarksBytes,
        streamTotalBytes,
        totalBytes: exactByteSum(
          "checkpoint configured compression capacity",
          [workspaceBytes, streamTotalBytes]
        ),
      },
    },
  };
}

async function writeFramedArtifact(
  temporary: string,
  artifact: CheckpointArtifact,
  limits: CheckpointByteStorageLimits,
  framedV2Limits: Partial<CheckpointArtifactV2Limits> | undefined,
  signal: AbortSignal | undefined
): Promise<WrittenCheckpointArtifact> {
  signal?.throwIfAborted();
  checkpointTestBarrier("during-candidate-preflight");
  signal?.throwIfAborted();
  const kind = limits.maxCheckpointBytes <= limits.maxProjectBytes ? "single" : "project";
  const limit = Math.min(limits.maxCheckpointBytes, limits.maxProjectBytes);
  const requestedStoredLimit = framedV2Limits?.maxTotalStoredBytes
    ?? DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalStoredBytes;
  const effectiveFramedLimits = { ...DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS, ...framedV2Limits };
  for (const [name, value] of Object.entries(effectiveFramedLimits)) {
    const metric: CheckpointReadLimitUnit | undefined = name === "maxJsonDepth"
      ? "depth"
      : name.endsWith("Bytes")
        ? "bytes"
        : ["maxRecordsPerFrame", "maxFrames", "maxTotalRecords"].includes(name)
          ? "count"
          : undefined;
    if (!metric) {
      throw new CheckpointFramedPreflightError(
        "unsupported",
        "header",
        `unsupported checkpoint artifact limit ${name}`
      );
    }
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
      throw new CheckpointFramedPreflightError(
        "resource_limit",
        "header",
        `${name} must be a positive 32-bit safe integer`,
        value,
        0xffffffff,
        metric
      );
    }
  }
  if (effectiveFramedLimits.maxRecordBytes + 4 > effectiveFramedLimits.maxDecodedFrameBytes) {
    throw new CheckpointFramedPreflightError(
      "resource_limit",
      "record",
      "maxRecordBytes plus its length prefix must fit maxDecodedFrameBytes",
      effectiveFramedLimits.maxRecordBytes + 4,
      effectiveFramedLimits.maxDecodedFrameBytes,
      "bytes"
    );
  }
  const maxNodeSlots = framedV2Limits?.maxTotalRecords
    ?? DEFAULT_CHECKPOINT_ARTIFACT_V2_LIMITS.maxTotalRecords;
  if (Number.isSafeInteger(maxNodeSlots) && maxNodeSlots > 0
    && artifact.checkpoint.state.nodes.length > maxNodeSlots) {
    throw new CheckpointFramedPreflightError(
      "resource_limit",
      "record",
      `framed checkpoint node-slot count ${artifact.checkpoint.state.nodes.length} exceeds maxTotalRecords`,
      artifact.checkpoint.state.nodes.length,
      maxNodeSlots,
      "count"
    );
  }
  const limiter = new ByteLimitTransform(kind, limit);
  const destination = fs.createWriteStream(temporary, { flags: "r+", mode: 0o600 });
  const codecLimits = {
    ...framedV2Limits,
    maxTotalStoredBytes: Math.min(requestedStoredLimit, limit),
  };
  let codec: CheckpointArtifactV2WriteResult;
  try {
    [codec] = await Promise.all([
      writeCheckpointArtifactV2(limiter, checkpointArtifactV2Frames(artifact), {
        limits: codecLimits,
        signal,
      }),
      pipeline(limiter, destination),
    ]);
  } catch (error) {
    if (signal?.aborted) throw checkpointAbortError();
    if (error instanceof CheckpointArtifactV2Error && error.kind === "cancelled") {
      throw checkpointReadErrorFromV2(error);
    }
    throw error;
  }
  if (codec.artifactBytes !== limiter.bytes) {
    throw new Error("framed checkpoint codec byte count does not match the durable output stream");
  }
  const fd = fs.openSync(temporary, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const summary = checkpointArtifactV2Summary(codec);
  return {
    sizeBytes: limiter.bytes,
    sha256: limiter.digest(),
    framedV2: { status: "applied", codec: checkpointArtifactV2AccountingSummary(summary) },
    framedV2Manifest: summary,
  };
}

function oldestFirst<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function pruneCheckpoints(
  projectRoot: string,
  protectedId: string,
  limits: CheckpointByteStorageLimits
): string[] {
  let records = checkpointRecords(projectRoot);
  const removed: string[] = [];
  const remove = (record: CheckpointRecord) => {
    fs.rmSync(record.file, { force: true });
    if (record.manifestFile) fs.rmSync(record.manifestFile, { force: true });
    fs.rmSync(checkpointPublicationPayloadFile(projectRoot, record.id), { force: true });
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

function storageLimits(input: CheckpointStorageLimits): CheckpointByteStorageLimits {
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
    MAX_CHECKPOINT_RECOVERY_MANIFESTS,
    "count"
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
  const storageEncoding = checkpointStorageEncoding(file);
  return manifestMatchesCheckpointPayload(
    projectRoot,
    id,
    manifest,
    payload,
    relative,
    checkpoint
  ) && manifest.storageEncoding === storageEncoding;
}

function manifestMatchesCheckpointPayload(
  projectRoot: string,
  id: string,
  manifest: CheckpointArtifactManifest,
  payload: { sizeBytes: number; sha256: string },
  relative: string,
  checkpoint: SharedSearchCheckpoint
): boolean {
  try {
    validateStoredEntrypoint(projectRoot, manifest.entrypoint, "manifest");
  } catch {
    return false;
  }
  return manifest.id === id
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

function matchingRecoveryManifestForNeutralPayload(
  projectRoot: string,
  id: string,
  payload: { sizeBytes: number; sha256: string },
  relative: string,
  checkpoint: SharedSearchCheckpoint
): RecoveryManifest | undefined {
  let match: RecoveryManifest | undefined;
  for (const candidate of recoveryManifestSourceFiles(projectRoot, id)) {
    try {
      const recovery = readRecoveryManifest(candidate.file, id, candidate.slot);
      if (!manifestMatchesCheckpointPayload(
        projectRoot,
        id,
        recovery.manifest,
        payload,
        relative,
        checkpoint
      )) continue;
      if (match && match.raw !== recovery.raw) {
        throw corrupt("manifest", `checkpoint ${id} has ambiguous recovery metadata for its committed payload`);
      }
      match = recovery;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof CheckpointReadError && error.kind === "corrupt") continue;
      throw error;
    }
  }
  return match;
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
  limits: CheckpointByteStorageLimits,
  expectedTransaction?: CheckpointTransaction
): RecoveredCheckpointPair | undefined {
  // Healthy canonical pairs stay metadata-only here. Probe the fixed slot set
  // before opening or hashing a potentially very large payload.
  if (!hasRecoveryManifest(projectRoot, id)) return undefined;
  const digestLimit = Math.min(
    limits.maxCheckpointBytes,
    limits.maxProjectBytes
  );
  const directory = checkpointsDirectory(projectRoot);
  const neutral = checkpointPublicationPayloadFile(projectRoot, id);
  const visible = checkpointCandidateFiles(projectRoot, id)
    .filter((candidate) => fs.existsSync(candidate));
  if (visible.length > 1) {
    throw corrupt("storage", `checkpoint ${id} has duplicate artifact layouts during publication recovery`);
  }
  let file: string;
  let payload: CheckpointPayloadDigest;
  let recovery: RecoveryManifest | undefined;
  let expectedManifestRaw: string;
  if (visible.length === 1) {
    // A canonical public pathname is the publication authority. A later
    // writer may already have reused the neutral name while this owner or a
    // helper was paused, so that neutral inode must not redirect recovery.
    file = visible[0];
    payload = fileDigest(file, digestLimit);
    const canonical = readMatchingCanonicalManifest(
      projectRoot,
      id,
      file,
      payload,
      relative,
      checkpoint
    );
    if (canonical) {
      expectedManifestRaw = canonical.raw;
    } else {
      recovery = matchingRecoveryManifest(
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
      expectedManifestRaw = recovery.raw;
    }
  } else if (fs.existsSync(neutral)) {
    // Before any public pathname exists, the sole neutral hard link remains
    // the no-clobber authority and its recovery record selects the suffix.
    if (checkpointCandidateFiles(projectRoot, id)
      .some((candidate) => fs.existsSync(candidate))) {
      return recoverPublishedCheckpoint(
        projectRoot,
        relative,
        id,
        checkpoint,
        limits,
        expectedTransaction
      );
    }
    let committed: CheckpointPayloadDigest;
    try {
      committed = fileDigest(neutral, digestLimit);
      recovery = matchingRecoveryManifestForNeutralPayload(
        projectRoot,
        id,
        committed,
        relative,
        checkpoint
      );
    } catch (error) {
      // A public winner can appear while a later, larger neutral is being
      // inspected under this caller's lower cap. Public precedence makes the
      // foreign neutral irrelevant; restart there instead of leaking its
      // resource error into the verified canonical operation.
      if (checkpointCandidateFiles(projectRoot, id)
        .some((candidate) => fs.existsSync(candidate))) {
        return recoverPublishedCheckpoint(
          projectRoot,
          relative,
          id,
          checkpoint,
          limits,
          expectedTransaction
        );
      }
      throw error;
    }
    if (checkpointCandidateFiles(projectRoot, id)
      .some((candidate) => fs.existsSync(candidate))) {
      return recoverPublishedCheckpoint(
        projectRoot,
        relative,
        id,
        checkpoint,
        limits,
        expectedTransaction
      );
    }
    if (!recovery) {
      throw corrupt(
        "manifest",
        `checkpoint ${id} committed payload has no matching bounded recovery metadata`
      );
    }
    file = checkpointDestinationForEncoding(projectRoot, id, recovery.manifest.storageEncoding);
    try {
      fs.linkSync(neutral, file);
      syncDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    payload = fileDigest(file, digestLimit);
    if (!samePayloadDigest(committed, payload)) {
      throw corrupt(
        "storage",
        `checkpoint ${id} public payload does not match its neutral no-clobber commit`
      );
    }
    checkpointTestBarrier("after-recovery-publication-link");
    promoteRecoveryManifest(
      projectRoot,
      id,
      file,
      payload,
      relative,
      checkpoint,
      recovery
    );
    expectedManifestRaw = recovery.raw;
  } else {
    return undefined;
  }
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
    expectedManifestRaw
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
  // Only the neutral hard link for this verified public inode is ours to
  // remove. A distinct neutral can already belong to a later active writer.
  removeMatchingPublicationPayload(projectRoot, id, verifiedPayload, digestLimit);
  return {
    manifest: verifiedManifest.manifest,
    metadataSizeBytes: verifiedManifest.sizeBytes,
    payloadSizeBytes: verifiedPayload.sizeBytes,
    payloadSha256: verifiedPayload.sha256,
  };
}

type CheckpointTestStage =
  | "before-reserve-transaction"
  | "before-candidate-write"
  | "during-candidate-preflight"
  | "after-recovery-manifest"
  | "after-recovery-publication-link"
  | "after-neutral-publication"
  | "before-publication-link"
  | "after-payload-publication"
  | "after-legacy-manifest-temporary"
  | "before-manifest-displacement"
  | "after-manifest-displacement";

function checkpointTestBarrier(stage: CheckpointTestStage): void {
  if (process.env.NODE_ENV !== "test") return;
  const gate = [
    [process.env.INKCHECK_TEST_CHECKPOINT_GATE, process.env.INKCHECK_TEST_CHECKPOINT_GATE_STAGE],
    [process.env.INKCHECK_TEST_CHECKPOINT_GATE_2, process.env.INKCHECK_TEST_CHECKPOINT_GATE_STAGE_2],
  ].find((entry) => entry[0] !== undefined && entry[1] === stage)?.[0];
  if (!gate) return;
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
  limits: CheckpointByteStorageLimits
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

function checkpointWriteAccounting(
  identity: CheckpointIdentity,
  payloadBytes: number,
  manifestBytes: number,
  operation?: {
    outcome: CheckpointWriteAccountingV1["outcome"];
    written?: CheckpointArtifactWriteAccounting;
  }
): CheckpointWriteAccountingV1 {
  const written = operation?.written;
  const totalPairBytes = exactByteSum(
    "durable checkpoint pair byte count",
    [payloadBytes, manifestBytes]
  );
  return {
    schemaVersion: 1,
    outcome: operation?.outcome ?? "reused",
    checkpointGraph: identity.checkpointGraph,
    serialization: written?.serialization ?? {
      status: "not_applied",
      logicalArtifactUtf8BytesEmitted: 0,
      peakSourceChunkUtf8Bytes: 0,
    },
    compression: written?.compression ?? {
      status: "not_applied",
      storedBytesEmitted: 0,
      peakOutputChunkBytes: 0,
    },
    ...(written?.framedV2 ? { framedV2: written.framedV2 } : {}),
    durable: {
      payloadBytes,
      manifestBytes,
      totalPairBytes,
    },
  };
}

async function reuseCheckpointArtifact(
  root: string,
  relative: string,
  identity: CheckpointIdentity,
  checkpoint: SharedSearchCheckpoint,
  limits: CheckpointByteStorageLimits,
  expectedTransaction?: CheckpointTransaction,
  operation?: {
    outcome: CheckpointWriteAccountingV1["outcome"];
    written?: CheckpointArtifactWriteAccounting;
  }
): Promise<CheckpointArtifactReference> {
  const { id } = identity;
  const directory = checkpointsDirectory(root);
  let existing = checkpointFile(root, id);
  let payloadBytes: number;
  let manifestBytes: number;
  const recovered = recoverPublishedCheckpoint(root, relative, id, checkpoint, limits, expectedTransaction);
  if (recovered) {
    existing = checkpointFile(root, id);
    payloadBytes = recovered.payloadSizeBytes;
    manifestBytes = recovered.metadataSizeBytes;
  } else {
    try {
      const loaded = await loadArtifactDetailed(root, id);
      const manifestFile = checkpointManifestFile(root, id);
      if (!fs.existsSync(manifestFile)) {
        const manifest = manifestForArtifact(
          loaded.artifact,
          loaded.storageEncoding,
          loaded.payloadSizeBytes,
          loaded.payloadSha256
        );
        const raw = serializedManifest(manifest);
        enforceDurableCheckpointLimits(exactByteSum(
          "durable checkpoint pair byte count",
          [loaded.payloadSizeBytes, Buffer.byteLength(raw)]
        ), limits);
        publishCheckpointManifest(root, id, raw);
      }
      const loadedSummary = summary(root, loaded);
      payloadBytes = loadedSummary.payloadSizeBytes;
      manifestBytes = loadedSummary.metadataSizeBytes;
    } catch (error) {
      // Schema v1 may exceed the process string ceiling even though its stored
      // bytes are durable. Reuse is allowed only when the canonical manifest
      // matches this exact requested checkpoint and a fixed-memory full payload
      // digest verifies the otherwise-unparseable bytes.
      if (!(error instanceof CheckpointReadError) || error.kind !== "resource_limit") throw error;
      existing = checkpointFile(root, id);
      if (!fs.existsSync(checkpointManifestFile(root, id))) throw error;
      const { manifest, sizeBytes: metadataSizeBytes } = readCheckpointManifest(root, id);
      validateManifestStorage(root, id, existing, manifest);
      if (!expectedManifestMatchesCheckpoint(manifest, relative, checkpoint)) {
        throw corrupt("manifest", "checkpoint metadata manifest does not match the requested saved frontier");
      }
      payloadBytes = manifest.artifactSizeBytes;
      manifestBytes = metadataSizeBytes;
      // Refuse an already-oversized durable pair from metadata alone before
      // spending I/O on its full fixed-memory checksum.
      enforceDurableCheckpointLimits(exactByteSum(
        "durable checkpoint pair byte count",
        [payloadBytes, manifestBytes]
      ), limits);
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
  const sizeBytes = exactByteSum(
    "durable checkpoint pair byte count",
    [payloadBytes, manifestBytes]
  );
  enforceDurableCheckpointLimits(sizeBytes, limits);
  existing = checkpointFile(root, id);
  if (process.platform !== "win32") {
    fs.chmodSync(existing, 0o600);
    const manifestFile = checkpointManifestFile(root, id);
    if (fs.existsSync(manifestFile)) fs.chmodSync(manifestFile, 0o600);
  }
  const pruned = pruneCheckpoints(root, id, limits);
  if (pruned.length > 0) syncDirectory(directory);
  const encoding = checkpointStorageEncoding(checkpointFile(root, id));
  return {
    id,
    path: checkpointRelativePath(id, encoding),
    pruned,
    accounting: checkpointWriteAccounting(identity, payloadBytes, manifestBytes, operation),
  };
}

async function saveCheckpointArtifactExclusive(
  root: string,
  relative: string,
  identity: CheckpointIdentity,
  checkpoint: SharedSearchCheckpoint,
  limits: CheckpointByteStorageLimits,
  format: CheckpointArtifactFormat,
  signal?: AbortSignal,
  framedV2Limits?: Partial<CheckpointArtifactV2Limits>
): Promise<CheckpointArtifactReference> {
  const { id } = identity;
  const directory = checkpointsDirectory(root);
  const destination = checkpointDestination(root, id, format);
  const neutral = checkpointPublicationPayloadFile(root, id);
  const hasCommittedCandidate = () => fs.existsSync(neutral)
    || checkpointCandidateFiles(root, id).some((candidate) => fs.existsSync(candidate));
  if (hasCommittedCandidate()) {
    signal?.throwIfAborted();
    return reuseCheckpointArtifact(root, relative, identity, checkpoint, limits);
  }
  // Validate the existing retention set before creating a new durable file.
  // Corrupt old state must not turn a successful write into a partial cleanup.
  try {
    checkpointRecords(root);
  } catch (error) {
    // A same-ID writer can publish between the initial existence check and
    // retention validation. Reopen its durable transaction instead of making
    // validation inflate a sidecar-free (and potentially huge) frontier.
    if (hasCommittedCandidate()) {
      signal?.throwIfAborted();
      return reuseCheckpointArtifact(root, relative, identity, checkpoint, limits);
    }
    throw error;
  }
  if (hasCommittedCandidate()) {
    signal?.throwIfAborted();
    return reuseCheckpointArtifact(root, relative, identity, checkpoint, limits);
  }
  const artifact: CheckpointArtifact = {
    artifactSchemaVersion: format === "framed-v2"
      ? CHECKPOINT_ARTIFACT_V2_SCHEMA_VERSION
      : CHECKPOINT_ARTIFACT_SCHEMA_VERSION,
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
  checkpointTestBarrier("before-reserve-transaction");
  let transaction: CheckpointTransaction;
  try {
    signal?.throwIfAborted();
    transaction = reserveCheckpointTransaction(root, id);
  } catch (error) {
    // Cancellation always wins over a concurrently committed candidate. A
    // caller that withdrew this request must never receive a reused success.
    if (signal?.aborted) signal.throwIfAborted();
    if ((error as Error)?.name === "AbortError") throw error;
    // A same-ID writer can commit after the final pre-reservation check while
    // this loser is scanning the bounded recovery slots. Its verified durable
    // pair makes a slot/preflight failure irrelevant to this logical ID.
    if (hasCommittedCandidate()) {
      return reuseCheckpointArtifact(root, relative, identity, checkpoint, limits);
    }
    throw error;
  }
  const temporary = transaction.temporary;
  let publishedPayload = false;
  let completedPair = false;
  let written: WrittenCheckpointArtifact | undefined;
  try {
    signal?.throwIfAborted();
    checkpointTestBarrier("before-candidate-write");
    // The test barrier models arbitrary synchronous work between the early
    // recovery check and format-specific preflight. Recheck withdrawal first.
    signal?.throwIfAborted();
    if (hasCommittedCandidate()) {
      const reference = await reuseCheckpointArtifact(
        root,
        relative,
        identity,
        checkpoint,
        limits,
        transaction
      );
      completedPair = true;
      return reference;
    }
    try {
      written = format === "framed-v2"
        ? await writeFramedArtifact(temporary, artifact, limits, framedV2Limits, signal)
        : await writeCompressedArtifact(temporary, artifact, limits, true, signal);
    } catch (error) {
      // Cancellation wins even if another writer committed while this request
      // was validating its format-specific limits.
      if (signal?.aborted) signal.throwIfAborted();
      if ((error as Error)?.name === "AbortError") throw error;
      // Only integration preflight failures are proven to occur before a
      // destination stream exists. Codec/pipeline failures may still have a
      // sibling stream settling, so a momentary file-size probe is not proof
      // that no candidate bytes were or will be emitted.
      if (!(error instanceof CheckpointFramedPreflightError)
        || !hasCommittedCandidate()) throw error;
      const reference = await reuseCheckpointArtifact(
        root,
        relative,
        identity,
        checkpoint,
        limits,
        transaction
      );
      completedPair = true;
      return reference;
    }
    signal?.throwIfAborted();
    const manifest = manifestForArtifact(
      artifact,
      format === "framed-v2" ? "framed-v2" : "gzip",
      written.sizeBytes,
      written.sha256,
      written.framedV2Manifest
    );
    const rawManifest = serializedManifest(manifest);
    enforceDurableCheckpointLimits(exactByteSum(
      "durable checkpoint pair byte count",
      [written.sizeBytes, Buffer.byteLength(rawManifest)]
    ), limits);
    // The recovery manifest is the durable transaction intent. It is fsynced,
    // then its directory is fsynced, before payload bytes can become visible.
    writeRecoveryManifest(root, id, transaction.slot, rawManifest);
    checkpointTestBarrier("after-recovery-manifest");
    checkpointTestCrash("after-recovery-manifest");
    signal?.throwIfAborted();
    try {
      // Every layout competes for this one neutral hard-link pathname. The
      // winning inode, not the public suffix, is the cross-format no-clobber
      // serialization point. Its durable recovery manifest selects the one
      // public layout that a retry is allowed to complete.
      fs.linkSync(temporary, neutral);
      publishedPayload = true;
      syncDirectory(directory);
      checkpointTestBarrier("after-neutral-publication");
      checkpointTestCrash("after-neutral-publication");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (publishedPayload) {
      const visible = checkpointCandidateFiles(root, id).filter((candidate) => fs.existsSync(candidate));
      if (visible.length > 0) {
        // A helper can recover this writer's neutral payload, publish the
        // manifest-selected public name, and remove the neutral link while the
        // owner is paused. The sole payload still belongs to this transaction
        // only when it is the same inode as this transaction's neutral/private
        // candidate, not merely byte-identical to another deterministic writer.
        const digestLimit = Math.min(limits.maxCheckpointBytes, limits.maxProjectBytes);
        const publicDigest = visible.length === 1
          ? fileDigest(visible[0], digestLimit)
          : undefined;
        // The neutral pathname can be reused by a third writer after a helper
        // removes this transaction's link. The claimed temporary remains the
        // authoritative, protected inode for this writer until cleanup.
        const ownerDigest = fileDigest(temporary, digestLimit);
        const helperPublishedThisCandidate = publicDigest !== undefined
          && path.resolve(visible[0]) === path.resolve(destination)
          && publicDigest.sizeBytes === written.sizeBytes
          && publicDigest.sha256 === written.sha256
          && samePayloadDigest(ownerDigest, publicDigest);
        if (!helperPublishedThisCandidate) {
          // A later writer may already own the shared neutral pathname. Only
          // this transaction's protected candidate authorizes its removal.
          removeMatchingPublicationPayload(root, id, ownerDigest, digestLimit);
          publishedPayload = false;
        }
      } else {
        checkpointTestBarrier("before-publication-link");
        try {
          fs.linkSync(neutral, destination);
          syncDirectory(directory);
          checkpointTestCrash("after-payload-publication");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOENT") throw error;
          const current = checkpointCandidateFiles(root, id)
            .filter((candidate) => fs.existsSync(candidate));
          const digestLimit = Math.min(limits.maxCheckpointBytes, limits.maxProjectBytes);
          // As above, the shared neutral name may already belong to another
          // transaction; only this claimed temporary proves ownership.
          const ownerDigest = fileDigest(temporary, digestLimit);
          const helperPublishedThisCandidate = current.length === 1
            && path.resolve(current[0]) === path.resolve(destination)
            && (() => {
              const digest = fileDigest(current[0], digestLimit);
              return digest.sizeBytes === written.sizeBytes
                && digest.sha256 === written.sha256
                && samePayloadDigest(ownerDigest, digest);
            })();
          if (current.length > 0 && !helperPublishedThisCandidate) {
            removeMatchingPublicationPayload(root, id, ownerDigest, digestLimit);
            publishedPayload = false;
          }
        }
      }
    }
    const reference = await reuseCheckpointArtifact(
      root,
      relative,
      identity,
      checkpoint,
      limits,
      transaction,
      {
        outcome: publishedPayload ? "created" : "reused",
        written,
      }
    );
    completedPair = true;
    return reference;
  } catch (error) {
    // Before this transaction owns the neutral commit, cancellation must not
    // be converted into success merely because a concurrent winner is now
    // visible. After neutral publication, recovery is deliberately
    // non-cancellable so the durable pair can be completed.
    if (!publishedPayload && signal?.aborted) signal.throwIfAborted();
    if (!publishedPayload && (error as Error)?.name === "AbortError") throw error;
    // Once another writer has completed the canonical pair, its verified
    // cleanup may unlink this loser's private slot while an fd is still open.
    // Treat an ensuing path-level ENOENT as loss of the no-clobber race and
    // reopen the winner; a corrupt/orphan final still fails closed there.
    if ((error as NodeJS.ErrnoException).code === "ENOENT"
      && checkpointCandidateFiles(root, id).some((candidate) => fs.existsSync(candidate))) {
      const reference = await reuseCheckpointArtifact(
        root,
        relative,
        identity,
        checkpoint,
        limits,
        transaction,
        written ? {
          outcome: publishedPayload ? "created" : "reused",
          written,
        } : undefined
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
  const identity = checkpointIdentity(relative, checkpoint);
  const directory = checkpointsDirectory(root);
  const limits = storageLimits(inputLimits);
  const format = inputLimits.format ?? "legacy-v1";
  if (format !== "legacy-v1" && format !== "framed-v2") {
    throw new RangeError("checkpoint format must be legacy-v1 or framed-v2");
  }
  inputLimits.signal?.throwIfAborted();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  return saveCheckpointArtifactExclusive(
    root,
    relative,
    identity,
    checkpoint,
    limits,
    format,
    inputLimits.signal,
    inputLimits.framedV2Limits
  );
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
  accounting: CheckpointReadAccountingV1;
}> {
  const loaded = await loadArtifactDetailed(projectRoot, id, readLimits);
  const current = await freshness(projectRoot, loaded.artifact);
  return {
    artifact: { ...summary(projectRoot, loaded), freshness: current.freshness },
    accounting: loaded.accounting,
  };
}

export async function loadCheckpointForResume(
  projectRoot: string,
  id: string,
  readLimits: CheckpointReadLimits = {}
): Promise<{
  artifact: CheckpointArtifactSummary & { freshness: "current" };
  checkpoint: SharedSearchCheckpoint;
  entrypoint: string;
  accounting: CheckpointReadAccountingV1;
}> {
  const loaded = await loadArtifactDetailed(projectRoot, id, readLimits);
  const current = await freshness(projectRoot, loaded.artifact);
  if (current.freshness !== "current") {
    throw new Error(`checkpoint ${id} is ${current.freshness}; resume requires the exact source and knot map used to create it`);
  }
  retainReturnedCheckpointGraph(loaded.accounting);
  return {
    artifact: { ...summary(projectRoot, loaded), freshness: "current" },
    checkpoint: loaded.artifact.checkpoint,
    entrypoint: current.entrypoint,
    accounting: loaded.accounting,
  };
}
