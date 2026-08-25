import { createHash } from "crypto";
import * as fs from "fs";
import { types as utilTypes } from "util";
import type { CompileResult, StoryShapeProfile } from "./inklecate";
import type { ExploreResult, EndingReport, RuntimeErrorReport } from "./explore";
import type { NextRunAdvice } from "./advice";
import { REPORT_SCHEMA_VERSION } from "./discovery";
import { VERSION } from "./version";
import type { AssertionResult, AssertionViolation } from "./assertions";
import type { AssertionDefinition } from "./assertions";
import type { GoalDefinition } from "./goals";
import type { GoalResult } from "./goals";
import { recommendShadowDecision } from "./decision-policy";
import { runtimeFindingIdentity } from "./runtime-identity";

export type FindingKind =
  | "compile.missing_divert"
  | "compile.invalid_expression"
  | "compile.error"
  | "compile.warning"
  | "compile.todo"
  | "runtime.content_exhaustion"
  | "runtime.choice_failure"
  | "runtime.state_restore_failure"
  | "runtime.error"
  | "assertion.violation"
  | "goal.reached"
  | "ending.reached";

/**
 * A deterministic logical-size proxy for one JSON graph. The byte count is
 * the exact UTF-8 size of its compact JSON representation; it is not a heap
 * measurement or an observed process-memory peak.
 */
export interface LogicalJsonGraphV1 {
  count: 1;
  logicalJsonUtf8Bytes: number;
}

export interface ReportEnrichmentAccountingV1 {
  schemaVersion: 1;
  sourceExploreGraph: LogicalJsonGraphV1;
  /** Stable finding-ID input strings materialized while enriching the report. */
  findingIdentityStrings: {
    count: number;
    logicalUtf8Bytes: number;
  };
  returnedReportGraph: LogicalJsonGraphV1;
  graphOwnership: {
    /** Source plus returned proxies, conservatively assuming no sharing or reclamation. */
    conservativePotentialLogicalJsonUtf8Bytes: number;
    /** The builder returns one report graph and retains no source graph itself. */
    currentReturnedLogicalJsonUtf8Bytes: number;
  };
}

function safeByteSum(description: string, values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - total) {
      throw new RangeError(`${description} exceeds the safe integer range`);
    }
    total += value;
  }
  return total;
}

const OMIT_JSON_VALUE = Symbol("omit-json-value");

function prepareJsonValue(value: unknown): unknown | typeof OMIT_JSON_VALUE {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    const reflectable = value as object;
    if (utilTypes.isProxy(reflectable)) throw new TypeError("logical JSON graph must not contain Proxy containers");
    let owner: object | null = reflectable;
    while (owner !== null) {
      if (utilTypes.isProxy(owner)) throw new TypeError("logical JSON graph must not contain Proxy containers");
      const toJsonDescriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
      if (toJsonDescriptor) {
        if (!("value" in toJsonDescriptor) || typeof toJsonDescriptor.value === "function") {
          throw new TypeError("logical JSON graph must not contain toJSON hooks");
        }
        break;
      }
      owner = Object.getPrototypeOf(owner);
    }
  }
  return value === undefined || typeof value === "function" || typeof value === "symbol"
    ? OMIT_JSON_VALUE
    : value;
}

function plainJsonObjectKeys(value: Record<string, unknown>): string[] {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("logical JSON graph containers must be plain objects or arrays");
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("logical JSON graph must not contain accessor properties");
    }
  }
  return keys;
}

function plainJsonArrayItem(value: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor) {
    if (String(index) in value) {
      throw new TypeError("logical JSON graph arrays must not inherit indexed values");
    }
    return undefined;
  }
  if (!("value" in descriptor)) throw new TypeError("logical JSON graph must not contain accessor properties");
  return descriptor.value;
}

function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2; // opening and closing quotes
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
        ? 2
        : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6; // well-formed JSON escapes a lone high surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6; // well-formed JSON escapes a lone low surrogate
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

type JsonByteCountFrame =
  | { kind: "value"; value: unknown }
  | { kind: "array"; value: unknown[]; index: number; length: number }
  | { kind: "object"; value: Record<string, unknown>; keys: string[]; index: number; emitted: boolean };

/**
 * Count compact-JSON UTF-8 bytes without materializing a whole-graph JSON
 * string. Traversal retains only the active container stack and its key
 * vectors; strings are counted code-unit by code-unit without an escaped copy.
 */
export function measureLogicalJsonGraphV1(value: unknown): LogicalJsonGraphV1 {
  const root = prepareJsonValue(value);
  if (root === OMIT_JSON_VALUE) throw new TypeError("logical JSON graph must have a serializable root value");
  let logicalJsonUtf8Bytes = 0;
  const ancestors = new Set<object>();
  const stack: JsonByteCountFrame[] = [{ kind: "value", value: root }];
  const add = (...values: number[]) => {
    logicalJsonUtf8Bytes = safeByteSum("logical JSON graph byte count", [logicalJsonUtf8Bytes, ...values]);
  };

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "array") {
      if (frame.index >= frame.length) {
        add(1); // ]
        ancestors.delete(frame.value);
        continue;
      }
      const index = frame.index;
      frame.index++;
      stack.push(frame);
      if (index > 0) add(1); // ,
      const item = prepareJsonValue(plainJsonArrayItem(frame.value, index));
      if (item === OMIT_JSON_VALUE) add(4); // null
      else stack.push({ kind: "value", value: item });
      continue;
    }
    if (frame.kind === "object") {
      let scheduled = false;
      while (frame.index < frame.keys.length) {
        const key = frame.keys[frame.index++];
        const descriptor = Object.getOwnPropertyDescriptor(frame.value, key)!;
        const item = prepareJsonValue(descriptor.value);
        if (item === OMIT_JSON_VALUE) continue;
        if (frame.emitted) add(1); // ,
        frame.emitted = true;
        add(jsonStringUtf8Bytes(key), 1); // key and :
        stack.push(frame, { kind: "value", value: item });
        scheduled = true;
        break;
      }
      if (!scheduled) {
        add(1); // }
        ancestors.delete(frame.value);
      }
      continue;
    }

    const item = frame.value;
    if (item === null) {
      add(4);
    } else if (typeof item === "string") {
      add(jsonStringUtf8Bytes(item));
    } else if (typeof item === "number") {
      add(Number.isFinite(item) ? (Object.is(item, -0) ? "0" : String(item)).length : 4);
    } else if (typeof item === "boolean") {
      add(item ? 4 : 5);
    } else if (typeof item === "bigint") {
      throw new TypeError("Do not know how to serialize a BigInt");
    } else if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) {
        throw new TypeError("logical JSON graph containers must be plain objects or arrays");
      }
      if (ancestors.has(item)) throw new TypeError("Converting circular structure to JSON");
      ancestors.add(item);
      add(1); // [
      stack.push({ kind: "array", value: item, index: 0, length: item.length });
    } else if (typeof item === "object") {
      const object = item as Record<string, unknown>;
      if (ancestors.has(object)) throw new TypeError("Converting circular structure to JSON");
      ancestors.add(object);
      add(1); // {
      stack.push({ kind: "object", value: object, keys: plainJsonObjectKeys(object), index: 0, emitted: false });
    } else {
      throw new TypeError("logical JSON graph contains an unsupported value");
    }
  }
  return { count: 1, logicalJsonUtf8Bytes };
}

interface FindingIdentityAccumulator {
  count: number;
  logicalUtf8Bytes: number;
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

function stableId(kind: FindingKind, identity: unknown, accounting?: FindingIdentityAccumulator): string {
  const materializedIdentity = `${kind}\0${canonical(identity)}`;
  if (accounting) {
    accounting.count = safeByteSum("finding identity string count", [accounting.count, 1]);
    accounting.logicalUtf8Bytes = safeByteSum("finding identity string byte count", [
      accounting.logicalUtf8Bytes,
      Buffer.byteLength(materializedIdentity, "utf8"),
    ]);
  }
  const hash = createHash("sha256").update(materializedIdentity).digest("hex").slice(0, 16);
  return `${kind}:${hash}`;
}

export function runtimeKind(error: RuntimeErrorReport): FindingKind {
  if (/ran out of content|DONE|END/i.test(error.message)) return "runtime.content_exhaustion";
  if (/State restore failed/i.test(error.message)) return "runtime.state_restore_failure";
  if (/choice|ChooseChoiceIndex/i.test(error.message)) return "runtime.choice_failure";
  return "runtime.error";
}

function enrichRuntimeErrorInternal(
  error: RuntimeErrorReport,
  storySeed?: number,
  identityAccounting?: FindingIdentityAccumulator
) {
  const kind = runtimeKind(error);
  return {
    ...error,
    id: stableId(kind, runtimeFindingIdentity(error), identityAccounting),
    kind,
    replay: { tool: "playtest_story" as const, choices: [...error.choiceIndices], storySeed },
    witness: {
      choiceText: [...error.path],
      choiceIndices: [...error.choiceIndices],
      ...(error.sourceLocation ? { triggeringSourceLocation: error.sourceLocation } : {}),
    },
    suggestedAction: "inspect_source" as const,
    documentation: `inkcheck://findings/${kind}`,
  };
}

export function enrichRuntimeError(error: RuntimeErrorReport, storySeed?: number) {
  return enrichRuntimeErrorInternal(error, storySeed);
}

function enrichEndingInternal(
  ending: EndingReport,
  storySeed?: number,
  identityAccounting?: FindingIdentityAccumulator
) {
  const kind = "ending.reached" as const;
  return {
    ...ending,
    id: stableId(kind, { finalText: ending.finalText, variables: ending.variables }, identityAccounting),
    kind,
    replay: { tool: "playtest_story" as const, choices: [...ending.choiceIndices], storySeed },
    witness: {
      choiceText: [...ending.path],
      choiceIndices: [...ending.choiceIndices],
    },
    suggestedAction: "replay_witness" as const,
    documentation: `inkcheck://findings/${kind}`,
  };
}

export function enrichEnding(ending: EndingReport, storySeed?: number) {
  return enrichEndingInternal(ending, storySeed);
}

function enrichAssertionViolationInternal(
  violation: AssertionViolation,
  storySeed?: number,
  identityAccounting?: FindingIdentityAccumulator
) {
  const kind = "assertion.violation" as const;
  return {
    ...violation,
    id: stableId(kind, { ruleId: violation.ruleId }, identityAccounting),
    kind,
    replay: { tool: "playtest_story" as const, choices: [...violation.choiceIndices], storySeed },
    witness: {
      choiceText: [...violation.path],
      choiceIndices: [...violation.choiceIndices],
      ...(violation.sourceLocation ? { triggeringSourceLocation: violation.sourceLocation } : {}),
    },
    suggestedAction: "replay_witness" as const,
    documentation: `inkcheck://findings/${kind}`,
  };
}

export function enrichAssertionViolation(violation: AssertionViolation, storySeed?: number) {
  return enrichAssertionViolationInternal(violation, storySeed);
}

function enrichAssertionResult(
  result: AssertionResult,
  storySeed?: number,
  identityAccounting?: FindingIdentityAccumulator
) {
  return {
    ...result,
    violations: result.violations.map((violation) =>
      enrichAssertionViolationInternal(violation, storySeed, identityAccounting)),
  };
}

function enrichGoalResult(result: GoalResult, storySeed?: number, identityAccounting?: FindingIdentityAccumulator) {
  const kind = "goal.reached" as const;
  const enrichWitness = (witness: NonNullable<GoalResult["witness"]>, identity: Record<string, unknown>) => ({
    ...witness,
    id: stableId(kind, { ...identity, choiceIndices: witness.choiceIndices }, identityAccounting),
    kind,
    replay: { operation: "playtest_story" as const, choices: witness.choiceIndices, storySeed },
    suggestedAction: "inspect_goal_witness" as const,
    documentation: "inkcheck://findings/goal.reached",
    ...identity,
  });
  return {
    ...result,
    ...(result.witness ? { witness: enrichWitness(result.witness, { goalId: result.id }) } : {}),
    ...(result.stages ? { stages: result.stages.map((stage) => ({
      ...stage,
      ...(stage.witness ? { witness: enrichWitness(stage.witness, { goalId: result.id, stageId: stage.id }) } : {}),
    })) } : {}),
  };
}

export function bindingLimit(explore: ExploreResult): string | null {
  if (!explore.truncated) return null;
  if (explore.truncatedBy.worker) return "worker";
  if (explore.truncatedBy.memory) return "memory";
  if (explore.truncatedBy.time) return "time";
  if (explore.truncatedBy.frontier) return "frontier";
  if (explore.truncatedBy.loop) return "loop";
  if (explore.truncatedBy.maxDepth) return "maxDepth";
  if (explore.truncatedBy.maxStates) return "maxStates";
  if (explore.truncatedBy.beamWidth) return "beamWidth";
  return "unknown";
}

export interface EffectiveReportConfiguration {
  search: "portfolio" | "shared" | "shared-variable";
  /** Resolved portfolio worker ceiling; one preserves sequential execution. */
  concurrency?: number;
  /** Whether the ceiling was selected automatically or explicitly fixed. */
  concurrencyMode?: "auto" | "fixed";
  /** Why automatic concurrency was constrained before workload classification. */
  concurrencyFallbackReason?: "search_mode" | "additive_goals";
  /** Present only for a root-started child report, never an exact base run. */
  executionScope?: "goal-probe" | "assertion-probe" | "long-tail-probe";
  minRepro: boolean;
  strict: boolean;
  maxMemoryMb: number | null;
  maxTimeSec: number | null;
  maxFrontierStates: number | null;
  maxFrontierMb: number | null;
  /** Explicit additional directed-goal budget; zero preserves baseline-only work. */
  goalMaxStates: number;
  /** Initial Ink runtime RNG seed, independent of the search sampling seed. */
  storySeed: number;
  assertions?: AssertionDefinition[];
  goals?: GoalDefinition[];
}

function compileKind(issue: CompileResult["issues"][number]): FindingKind {
  if (/divert target not found|target not found/i.test(issue.message)) return "compile.missing_divert";
  if (/expression|operator|expected/i.test(issue.message)) return "compile.invalid_expression";
  if (issue.severity === "WARNING") return "compile.warning";
  if (issue.severity === "TODO") return "compile.todo";
  return "compile.error";
}

function enrichCompileInternal(
  compile: Omit<CompileResult, "storyJson">,
  identityAccounting?: FindingIdentityAccumulator
) {
  return {
    ...compile,
    issues: compile.issues.map((issue) => {
      const kind = compileKind(issue);
      return {
        ...issue,
        id: stableId(kind, {
          file: issue.file,
          line: issue.line,
          message: issue.message,
        }, identityAccounting),
        kind,
        suggestedAction: "inspect_source" as const,
        documentation: `inkcheck://findings/${kind}`,
      };
    }),
  };
}

export function enrichCompile(compile: Omit<CompileResult, "storyJson">) {
  return enrichCompileInternal(compile);
}

export function buildCompileFailureEnvelope(
  compile: Omit<CompileResult, "storyJson">,
  file: string,
  configuration: EffectiveReportConfiguration
) {
  const source = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from(file);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    storyFingerprint: {
      algorithm: "sha256" as const,
      source: "entry-source" as const,
      value: createHash("sha256").update(source).digest("hex"),
    },
    effectiveConfiguration: configuration,
    bindingLimit: null,
    compile: enrichCompile(compile),
  };
}

interface ReportInput {
  compile: Omit<CompileResult, "storyJson">;
  stats?: Record<string, number>;
  profile?: StoryShapeProfile;
  explore: ExploreResult;
  nextRun: NextRunAdvice;
  runs?: unknown[];
  storyJson: string;
  configuration: EffectiveReportConfiguration;
}

function buildReportEnvelopeInternal(input: ReportInput, identityAccounting?: FindingIdentityAccumulator) {
  const storySeed = input.explore.limits.storySeed;
  const explore = {
    ...input.explore,
    endingsFound: input.explore.endingsFound.map((ending) =>
      enrichEndingInternal(ending, storySeed, identityAccounting)),
    runtimeErrors: input.explore.runtimeErrors.map((error) =>
      enrichRuntimeErrorInternal(error, storySeed, identityAccounting)),
    assertionResults: input.explore.assertionResults.map((result) => enrichAssertionResult(result, storySeed, identityAccounting)),
    ...(input.explore.goalResults
      ? { goalResults: input.explore.goalResults.map((result) => enrichGoalResult(result, storySeed, identityAccounting)) }
      : {}),
  };
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    storyFingerprint: {
      algorithm: "sha256" as const,
      source: "compiled-story" as const,
      value: createHash("sha256").update(input.storyJson).digest("hex"),
    },
    effectiveConfiguration: {
      ...input.configuration,
      limits: { ...input.explore.limits },
    },
    bindingLimit: bindingLimit(input.explore),
    compile: enrichCompileInternal(input.compile, identityAccounting),
    ...(input.stats ? { stats: input.stats } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    explore,
    nextRun: input.nextRun,
    shadowDecision: recommendShadowDecision(input.explore),
    ...(input.runs ? { runs: input.runs } : {}),
  };
}

export function buildReportEnvelope(input: ReportInput) {
  return buildReportEnvelopeInternal(input);
}

export function buildReportEnvelopeAccounted(input: ReportInput): {
  report: ReturnType<typeof buildReportEnvelope>;
  accounting: ReportEnrichmentAccountingV1;
} {
  const sourceExploreGraph = measureLogicalJsonGraphV1(input.explore);
  const findingIdentityStrings: FindingIdentityAccumulator = { count: 0, logicalUtf8Bytes: 0 };
  const report = buildReportEnvelopeInternal(input, findingIdentityStrings);
  const returnedReportGraph = measureLogicalJsonGraphV1(report);
  return {
    report,
    accounting: {
      schemaVersion: 1,
      sourceExploreGraph,
      findingIdentityStrings: { ...findingIdentityStrings },
      returnedReportGraph,
      graphOwnership: {
        conservativePotentialLogicalJsonUtf8Bytes: safeByteSum(
          "report enrichment graph byte count",
          [sourceExploreGraph.logicalJsonUtf8Bytes, returnedReportGraph.logicalJsonUtf8Bytes]
        ),
        currentReturnedLogicalJsonUtf8Bytes: returnedReportGraph.logicalJsonUtf8Bytes,
      },
    },
  };
}
