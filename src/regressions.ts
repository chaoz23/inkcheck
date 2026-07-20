import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { openReportArtifact, openReportFinding, replayReportFinding } from "./artifacts";
import { playtest } from "./explore";
import { evaluateCondition, parseAssertionDefinitions, type AssertionDefinition } from "./assertions";
import { parseGoalDefinitions, type GoalDefinition } from "./goals";
import { compile, scanExternals, scanKnots } from "./inklecate";
import {
  MAX_REGRESSION_PIN_BYTES,
  MAX_REGRESSION_PINS_PER_PROJECT,
  REGRESSION_ARTIFACT_SCHEMA_VERSION,
} from "./regression-contract";
import { VERSION } from "./version";

export {
  MAX_REGRESSION_PIN_BYTES,
  MAX_REGRESSION_PINS_PER_PROJECT,
  REGRESSION_ARTIFACT_SCHEMA_VERSION,
} from "./regression-contract";

interface RuntimeRegressionArtifact {
  schemaVersion: 1;
  artifactType: "runtime-regression-pin";
  id: string;
  createdAt: string;
  inkcheckVersion: string;
  sessionCapabilityHash: string;
  source: { entrypoint: string; baselineFingerprint: string };
  reportId: string;
  findingId: string;
  findingKind: string;
  choices: number[];
  storySeed: number;
  expectedRuntimeErrorHashes: string[];
}

interface AssertionRegressionArtifact {
  schemaVersion: 2;
  artifactType: "assertion-regression-pin";
  id: string;
  createdAt: string;
  inkcheckVersion: string;
  sessionCapabilityHash: string;
  source: { entrypoint: string; baselineFingerprint: string };
  reportId: string;
  findingId: string;
  findingKind: "assertion.violation";
  choices: number[];
  storySeed: number;
  rule: Pick<AssertionDefinition, "id" | "when" | "condition">;
}

interface GoalRegressionArtifact {
  schemaVersion: 2;
  artifactType: "goal-witness-pin";
  id: string;
  createdAt: string;
  inkcheckVersion: string;
  sessionCapabilityHash: string;
  source: { entrypoint: string; baselineFingerprint: string };
  reportId: string;
  findingId: string;
  findingKind: "goal.reached";
  choices: number[];
  storySeed: number;
  goal: Pick<GoalDefinition, "id" | "condition" | "stages">;
  stageId?: string;
}

type RegressionArtifact = RuntimeRegressionArtifact | AssertionRegressionArtifact | GoalRegressionArtifact;

export interface RegressionPinSummary {
  id: string;
  artifactType: RegressionArtifact["artifactType"];
  entrypoint: string;
  reportId: string;
  findingId: string;
  findingKind: string;
  storySeed: number;
  choiceCount: number;
  baselineFingerprint: string;
}

export interface RegressionCheckResult {
  pin: RegressionPinSummary;
  status: "fixed" | "still_failing" | "still_reached" | "lost" | "path_changed";
  reason: "completed_without_pinned_failure" | "pinned_failure_reproduced" | "indexed_path_changed" | "different_runtime_failure" | "assertion_violation_reproduced" | "assertion_holds_at_pinned_checkpoint" | "goal_witness_reproduced" | "goal_not_reached_at_pinned_checkpoint";
  replayStatus: "completed" | "runtime_error" | "path_changed";
  runtimeErrorCount: number;
}

function directory(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".inkcheck", "regressions");
}

function relativeEntrypoint(projectRoot: string, entrypoint: string): string {
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, path.resolve(entrypoint));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("regression entrypoint must stay inside its project root");
  }
  return relative.split(path.sep).join("/");
}

function sourcePath(projectRoot: string, entrypoint: string): string {
  if (!entrypoint || path.isAbsolute(entrypoint)) throw new Error("regression entrypoint must be project-relative");
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, entrypoint);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("regression entrypoint escapes the project root");
  }
  return resolved;
}

function validateSessionHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("invalid regression session capability hash");
}

function runtimeErrorHash(message: string): string {
  return createHash("sha256").update(message.trim().replace(/\s+/g, " ")).digest("hex");
}

function pinId(artifact: object): string {
  return `regression-${createHash("sha256").update(JSON.stringify(artifact)).digest("hex").slice(0, 24)}`;
}

function artifactFile(projectRoot: string, id: string): string {
  if (!/^regression-[0-9a-f]{24}$/.test(id)) {
    throw new Error("regression pin ID must look like regression- followed by 24 lowercase hex characters");
  }
  return path.join(directory(projectRoot), `${id}.json`);
}

function parseArtifact(raw: string, expectedId?: string): RegressionArtifact {
  if (Buffer.byteLength(raw, "utf8") > MAX_REGRESSION_PIN_BYTES) {
    throw new Error(`regression pin exceeds the ${MAX_REGRESSION_PIN_BYTES}-byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("regression pin is corrupt JSON; remove it or restore a valid copy");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("regression pin must be a JSON object");
  const artifact = value as Record<string, unknown>;
  const allowedKeys = [
    "artifactType", "choices", "createdAt", "expectedRuntimeErrorHashes", "findingId", "findingKind",
    "id", "inkcheckVersion", "reportId", "schemaVersion", "sessionCapabilityHash", "source", "storySeed", "rule", "goal", "stageId",
  ];
  if (Object.keys(artifact).some((key) => !allowedKeys.includes(key))) {
    throw new Error("regression pin contains unsupported or privacy-sensitive fields; recreate it from a current finding");
  }
  const source = artifact.source as Record<string, unknown> | undefined;
  if (source && Object.keys(source).some((key) => !["baselineFingerprint", "entrypoint"].includes(key))) {
    throw new Error("regression pin source metadata contains unsupported fields; recreate it from a current finding");
  }
  if (artifact.schemaVersion !== 1 && artifact.schemaVersion !== REGRESSION_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`unsupported regression pin schema ${String(artifact.schemaVersion)}; use a compatible Inkcheck version or recreate the pin`);
  }
  if (!["runtime-regression-pin", "assertion-regression-pin", "goal-witness-pin"].includes(String(artifact.artifactType)) || typeof artifact.id !== "string"
    || typeof artifact.createdAt !== "string" || !Number.isFinite(Date.parse(artifact.createdAt))
    || typeof artifact.inkcheckVersion !== "string"
    || typeof artifact.sessionCapabilityHash !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sessionCapabilityHash)
    || !source || typeof source.entrypoint !== "string"
    || typeof source.baselineFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(source.baselineFingerprint)
    || typeof artifact.reportId !== "string" || !/^report-[0-9a-f]{24}$/.test(artifact.reportId)
    || typeof artifact.findingId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(artifact.findingId)
    || typeof artifact.findingKind !== "string"
    || !Array.isArray(artifact.choices) || !artifact.choices.every((choice) => Number.isSafeInteger(choice) && choice >= 0)
    || !Number.isSafeInteger(artifact.storySeed) || (artifact.storySeed as number) < 1
  ) {
    throw new Error("regression pin is missing required bounded fields; recreate it from a current finding");
  }
  if ((artifact.schemaVersion === 1) !== (artifact.artifactType === "runtime-regression-pin")) {
    throw new Error("regression pin schema does not match its evidence type; recreate it from a current finding");
  }
  if (artifact.artifactType === "runtime-regression-pin" && (!String(artifact.findingKind).startsWith("runtime.")
    || !Array.isArray(artifact.expectedRuntimeErrorHashes) || artifact.expectedRuntimeErrorHashes.length < 1
    || !artifact.expectedRuntimeErrorHashes.every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)))) {
    throw new Error("runtime regression pin is missing expected error hashes; recreate it from a current finding");
  }
  if (artifact.artifactType === "assertion-regression-pin" && (artifact.findingKind !== "assertion.violation" || !artifact.rule || typeof artifact.rule !== "object")) {
    throw new Error("assertion regression pin is missing its typed rule; recreate it from a current finding");
  }
  if (artifact.artifactType === "goal-witness-pin" && (artifact.findingKind !== "goal.reached" || !artifact.goal || typeof artifact.goal !== "object")) {
    throw new Error("goal witness pin is missing its typed goal; recreate it from a current finding");
  }
  if (artifact.artifactType === "assertion-regression-pin") {
    const issues: string[] = [];
    if (parseAssertionDefinitions([artifact.rule], "rule", issues)?.length !== 1 || issues.length) {
      throw new Error("assertion regression pin has an invalid typed rule; recreate it from a current finding");
    }
  }
  if (artifact.artifactType === "goal-witness-pin") {
    const issues: string[] = [];
    if (parseGoalDefinitions([artifact.goal], "goal", issues)?.length !== 1 || issues.length) {
      throw new Error("goal witness pin has an invalid typed goal; recreate it from a current finding");
    }
  }
  const identity = {
    sessionCapabilityHash: artifact.sessionCapabilityHash,
    source,
    reportId: artifact.reportId,
    findingId: artifact.findingId,
    findingKind: artifact.findingKind,
    choices: artifact.choices,
    storySeed: artifact.storySeed as number,
    ...(artifact.artifactType === "runtime-regression-pin" ? { expectedRuntimeErrorHashes: artifact.expectedRuntimeErrorHashes } : {}),
    ...(artifact.artifactType === "assertion-regression-pin" ? { rule: artifact.rule } : {}),
    ...(artifact.artifactType === "goal-witness-pin" ? { goal: artifact.goal, ...(typeof artifact.stageId === "string" ? { stageId: artifact.stageId } : {}) } : {}),
  };
  const actualId = pinId(identity);
  if (artifact.id !== actualId || (expectedId !== undefined && artifact.id !== expectedId)) {
    throw new Error("regression pin content does not match its stable ID; restore or recreate it");
  }
  return artifact as unknown as RegressionArtifact;
}

function loadArtifact(projectRoot: string, id: string): RegressionArtifact {
  const file = artifactFile(projectRoot, id);
  if (!fs.existsSync(file)) throw new Error(`regression pin not found: ${id}`);
  return parseArtifact(fs.readFileSync(file, "utf8"), id);
}

function syncDirectory(target: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR"
      && code !== "EPERM" && code !== "EACCES" && code !== "EBADF") throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function summary(artifact: RegressionArtifact): RegressionPinSummary {
  return {
    id: artifact.id,
    artifactType: artifact.artifactType,
    entrypoint: artifact.source.entrypoint,
    reportId: artifact.reportId,
    findingId: artifact.findingId,
    findingKind: artifact.findingKind,
    storySeed: artifact.storySeed,
    choiceCount: artifact.choices.length,
    baselineFingerprint: artifact.source.baselineFingerprint,
  };
}

function pinFiles(projectRoot: string): string[] {
  const target = directory(projectRoot);
  if (!fs.existsSync(target)) return [];
  return fs.readdirSync(target).filter((name) => /^regression-[0-9a-f]{24}\.json$/.test(name));
}

function replayWitness(finding: Record<string, unknown>, findingId: string): { choices: number[]; storySeed: number } {
  const replay = finding.replay as Record<string, unknown> | undefined;
  const choices = replay?.choices;
  const storySeed = replay?.storySeed;
  if (!Array.isArray(choices) || !choices.every((choice) => Number.isSafeInteger(choice) && (choice as number) >= 0)
    || !Number.isSafeInteger(storySeed) || (storySeed as number) < 1) {
    throw new Error(`finding has no supported indexed replay witness: ${findingId}`);
  }
  return { choices: choices as number[], storySeed: storySeed as number };
}

function configuredContract(report: Record<string, unknown>, key: "assertions" | "goals"): unknown[] {
  const config = report.effectiveConfiguration as Record<string, unknown> | undefined;
  return Array.isArray(config?.[key]) ? config[key] as unknown[] : [];
}

function withoutDescription<T extends Record<string, unknown>>(value: T): T {
  const { description: _description, ...rest } = value;
  return rest as T;
}

export async function createRegressionPin(
  projectRoot: string,
  entrypoint: string,
  sessionCapabilityHash: string,
  reportId: string,
  findingId: string
): Promise<RegressionPinSummary> {
  validateSessionHash(sessionCapabilityHash);
  const relative = relativeEntrypoint(projectRoot, entrypoint);
  const opened = await openReportFinding(projectRoot, reportId, findingId);
  if (opened.artifact.freshness !== "current" || !opened.artifact.currentFingerprint) {
    throw new Error(`regression pin requires current source; report is ${opened.artifact.freshness}`);
  }
  const witness = replayWitness(opened.finding, findingId);
  const common = {
    sessionCapabilityHash,
    source: { entrypoint: relative, baselineFingerprint: opened.artifact.currentFingerprint.value },
    reportId,
    findingId,
    findingKind: opened.summary.kind,
    choices: witness.choices,
    storySeed: witness.storySeed,
  };
  let artifactType: RegressionArtifact["artifactType"];
  let identity: object;
  if (opened.summary.kind.startsWith("runtime.")) {
    const replayed = await replayReportFinding(projectRoot, reportId, findingId);
    if (replayed.replay.replayStatus !== "runtime_error" || replayed.replay.runtimeErrors.length === 0) {
      throw new Error("runtime finding no longer reproduces on current source; replay it before pinning");
    }
    artifactType = "runtime-regression-pin";
    identity = { ...common, expectedRuntimeErrorHashes: [...new Set(replayed.replay.runtimeErrors.map(runtimeErrorHash))].sort() };
  } else if (opened.summary.kind === "assertion.violation") {
    const report = await openReportArtifact(projectRoot, reportId);
    const ruleId = opened.finding.ruleId;
    const rule = configuredContract(report.report, "assertions").find((item) => (item as { id?: unknown }).id === ruleId);
    if (!rule || typeof rule !== "object") throw new Error("assertion finding has no typed rule in its saved report configuration");
    artifactType = "assertion-regression-pin";
    identity = { ...common, rule: withoutDescription(rule as Record<string, unknown>) };
  } else if (opened.summary.kind === "goal.reached") {
    const report = await openReportArtifact(projectRoot, reportId);
    const goalId = opened.finding.goalId;
    const goal = configuredContract(report.report, "goals").find((item) => (item as { id?: unknown }).id === goalId);
    if (!goal || typeof goal !== "object") throw new Error("goal witness has no typed goal in its saved report configuration");
    artifactType = "goal-witness-pin";
    identity = { ...common, goal: withoutDescription(goal as Record<string, unknown>), ...(typeof opened.finding.stageId === "string" ? { stageId: opened.finding.stageId } : {}) };
  } else {
    throw new Error(`regression pins support runtime errors, assertion violations, and goal witnesses only, not ${opened.summary.kind}`);
  }
  const id = pinId(identity);
  const targetDirectory = directory(projectRoot);
  const destination = artifactFile(projectRoot, id);
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(targetDirectory, 0o700);
  if (fs.existsSync(destination)) {
    const existing = loadArtifact(projectRoot, id);
    if (existing.sessionCapabilityHash !== sessionCapabilityHash) throw new Error("regression pin belongs to another session");
    if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
    return summary(existing);
  }
  if (pinFiles(projectRoot).length >= MAX_REGRESSION_PINS_PER_PROJECT) {
    throw new Error(`project already has ${MAX_REGRESSION_PINS_PER_PROJECT} regression pins; remove an obsolete private pin before adding another`);
  }
  const artifact: RegressionArtifact = {
    schemaVersion: artifactType === "runtime-regression-pin" ? 1 : REGRESSION_ARTIFACT_SCHEMA_VERSION,
    artifactType,
    id,
    createdAt: new Date().toISOString(),
    inkcheckVersion: VERSION,
    ...identity,
  } as RegressionArtifact;
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REGRESSION_PIN_BYTES) {
    throw new Error(`regression pin exceeds the ${MAX_REGRESSION_PIN_BYTES}-byte limit`);
  }
  const temporary = path.join(targetDirectory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, destination);
    if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
    syncDirectory(targetDirectory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  return summary(artifact);
}

export async function checkRegressionPin(
  projectRoot: string,
  entrypoint: string,
  sessionCapabilityHash: string,
  id: string
): Promise<RegressionCheckResult> {
  validateSessionHash(sessionCapabilityHash);
  const artifact = loadArtifact(projectRoot, id);
  if (artifact.sessionCapabilityHash !== sessionCapabilityHash) throw new Error("regression pin belongs to another search session");
  if (artifact.source.entrypoint !== relativeEntrypoint(projectRoot, entrypoint)) {
    throw new Error("regression pin belongs to a different story entrypoint");
  }
  const current = sourcePath(projectRoot, artifact.source.entrypoint);
  if (!fs.existsSync(current)) throw new Error("regression entrypoint no longer exists");
  const compiled = await compile(current);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`current story does not compile; fix ${compiled.issues.length} compile issue(s) before checking the regression`);
  }
  const replay = playtest(compiled.storyJson, artifact.choices, scanExternals(current), artifact.storySeed, scanKnots(current));
  if (replay.replayStatus === "path_changed") {
    return {
      pin: summary(artifact), status: "path_changed", reason: "indexed_path_changed",
      replayStatus: replay.replayStatus, runtimeErrorCount: replay.runtimeErrors.length,
    };
  }
  if (artifact.artifactType === "assertion-regression-pin") {
    const checkpoint = replay.checkpoints.find((item) => item.choiceIndices.length === artifact.choices.length);
    if (!checkpoint) {
      return { pin: summary(artifact), status: "path_changed", reason: "indexed_path_changed", replayStatus: replay.replayStatus, runtimeErrorCount: replay.runtimeErrors.length };
    }
    const applies = artifact.rule.when === "always"
      || (artifact.rule.when === "terminal" ? checkpoint.terminal : checkpoint.knots.includes(artifact.rule.when.knot));
    const violated = applies && !evaluateCondition(artifact.rule.condition, checkpoint.variables);
    return {
      pin: summary(artifact),
      status: violated ? "still_failing" : "fixed",
      reason: violated ? "assertion_violation_reproduced" : "assertion_holds_at_pinned_checkpoint",
      replayStatus: replay.replayStatus,
      runtimeErrorCount: replay.runtimeErrors.length,
    };
  }
  if (artifact.artifactType === "goal-witness-pin") {
    const checkpoint = replay.checkpoints.find((item) => item.choiceIndices.length === artifact.choices.length);
    if (!checkpoint) {
      return { pin: summary(artifact), status: "path_changed", reason: "indexed_path_changed", replayStatus: replay.replayStatus, runtimeErrorCount: replay.runtimeErrors.length };
    }
    const stages = artifact.goal.stages ?? [];
    const target = artifact.stageId
      ? stages.find((stage) => stage.id === artifact.stageId)?.condition
      : artifact.goal.condition;
    if (!target) throw new Error("goal witness pin has no replayable target condition; recreate it from a current finding");
    const reached = evaluateCondition(target, checkpoint.variables);
    return {
      pin: summary(artifact),
      status: reached ? "still_reached" : "lost",
      reason: reached ? "goal_witness_reproduced" : "goal_not_reached_at_pinned_checkpoint",
      replayStatus: replay.replayStatus,
      runtimeErrorCount: replay.runtimeErrors.length,
    };
  }
  const actualHashes = new Set(replay.runtimeErrors.map(runtimeErrorHash));
  const matched = artifact.expectedRuntimeErrorHashes.some((hash) => actualHashes.has(hash));
  let status: RegressionCheckResult["status"];
  let reason: RegressionCheckResult["reason"];
  if (matched) {
    status = "still_failing";
    reason = "pinned_failure_reproduced";
  } else if (replay.replayStatus === "runtime_error") {
    status = "path_changed";
    reason = "different_runtime_failure";
  } else {
    status = "fixed";
    reason = "completed_without_pinned_failure";
  }
  return {
    pin: summary(artifact),
    status,
    reason,
    replayStatus: replay.replayStatus,
    runtimeErrorCount: replay.runtimeErrors.length,
  };
}
