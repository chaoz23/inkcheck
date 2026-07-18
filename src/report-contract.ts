import { createHash } from "crypto";
import * as fs from "fs";
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

function stableId(kind: FindingKind, identity: unknown): string {
  const hash = createHash("sha256").update(`${kind}\0${canonical(identity)}`).digest("hex").slice(0, 16);
  return `${kind}:${hash}`;
}

export function runtimeKind(error: RuntimeErrorReport): FindingKind {
  if (/ran out of content|DONE|END/i.test(error.message)) return "runtime.content_exhaustion";
  if (/State restore failed/i.test(error.message)) return "runtime.state_restore_failure";
  if (/choice|ChooseChoiceIndex/i.test(error.message)) return "runtime.choice_failure";
  return "runtime.error";
}

export function enrichRuntimeError(error: RuntimeErrorReport, storySeed?: number) {
  const kind = runtimeKind(error);
  return {
    ...error,
    id: stableId(kind, runtimeFindingIdentity(error)),
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

export function enrichEnding(ending: EndingReport, storySeed?: number) {
  const kind = "ending.reached" as const;
  return {
    ...ending,
    id: stableId(kind, { finalText: ending.finalText, variables: ending.variables }),
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

export function enrichAssertionViolation(violation: AssertionViolation, storySeed?: number) {
  const kind = "assertion.violation" as const;
  return {
    ...violation,
    id: stableId(kind, { ruleId: violation.ruleId }),
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

function enrichAssertionResult(result: AssertionResult, storySeed?: number) {
  return { ...result, violations: result.violations.map((violation) => enrichAssertionViolation(violation, storySeed)) };
}

function enrichGoalResult(result: GoalResult, storySeed?: number) {
  const kind = "goal.reached" as const;
  const enrichWitness = (witness: NonNullable<GoalResult["witness"]>, identity: Record<string, unknown>) => ({
    ...witness,
    id: stableId(kind, { ...identity, choiceIndices: witness.choiceIndices }),
    kind,
    replay: { operation: "playtest_story" as const, choices: witness.choiceIndices, storySeed },
    suggestedAction: "inspect_goal_witness" as const,
    documentation: "inkcheck://findings/goal.reached",
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

export function enrichCompile(compile: Omit<CompileResult, "storyJson">) {
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
        }),
        kind,
        suggestedAction: "inspect_source" as const,
        documentation: `inkcheck://findings/${kind}`,
      };
    }),
  };
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

export function buildReportEnvelope(input: ReportInput) {
  const storySeed = input.explore.limits.storySeed;
  const explore = {
    ...input.explore,
    endingsFound: input.explore.endingsFound.map((ending) => enrichEnding(ending, storySeed)),
    runtimeErrors: input.explore.runtimeErrors.map((error) => enrichRuntimeError(error, storySeed)),
    assertionResults: input.explore.assertionResults.map((result) => enrichAssertionResult(result, storySeed)),
    ...(input.explore.goalResults ? { goalResults: input.explore.goalResults.map((result) => enrichGoalResult(result, storySeed)) } : {}),
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
    compile: enrichCompile(input.compile),
    ...(input.stats ? { stats: input.stats } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    explore,
    nextRun: input.nextRun,
    shadowDecision: recommendShadowDecision(input.explore),
    ...(input.runs ? { runs: input.runs } : {}),
  };
}
