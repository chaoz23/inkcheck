#!/usr/bin/env node
import { createHash } from "crypto";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openReportArtifact } from "./artifacts";
import { openCheckpointArtifact } from "./checkpoints";
import type { CampaignAllocation, CampaignLedger } from "./campaign-policy";
import type { ExploreResult } from "./explore";
import { runtimeFindingIdentity } from "./runtime-identity";
import { continueCampaign, startCampaign, type SearchSessionResponse } from "./search-sessions";
import { VERSION } from "./version";

interface EvaluationCase {
  id: string;
  story: string;
  source: { name: string; license: string; commit: string; licenseFile: string | null };
  baseStates: number;
  additionalStates: number;
  maxDepth: number;
  seed: number;
  storySeed: number;
  maxElapsedSeconds: number;
  maxMemoryMb: number;
  maxDiskMb: number;
}

interface EvaluationManifest {
  schemaVersion: 1 | 2;
  workerTimeoutMs?: number;
  cases: EvaluationCase[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, label: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
}

function validateManifest(value: unknown): asserts value is EvaluationManifest {
  if (!object(value) || ![1, 2].includes(Number(value.schemaVersion)) || !Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("long-tail manifest requires schemaVersion 1 or 2 and a non-empty cases list");
  }
  const manifestWorkerTimeoutMs = value.workerTimeoutMs;
  if (manifestWorkerTimeoutMs !== undefined) integer(manifestWorkerTimeoutMs, "workerTimeoutMs", 1, 604_800_000);
  if (value.schemaVersion === 2 && manifestWorkerTimeoutMs === undefined) {
    throw new Error("long-tail manifest schemaVersion 2 requires workerTimeoutMs");
  }
  const ids = new Set<string>();
  value.cases.forEach((raw, index) => {
    if (!object(raw)) throw new Error(`cases[${index}] must be an object`);
    const entry = raw as unknown as EvaluationCase;
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`cases[${index}].id must be unique lowercase kebab case`);
    }
    ids.add(entry.id);
    if (typeof entry.story !== "string" || !entry.story.endsWith(".ink")) throw new Error(`${entry.id}.story must be an .ink path`);
    if (!object(entry.source) || typeof entry.source.name !== "string" || typeof entry.source.license !== "string"
      || typeof entry.source.commit !== "string" || (entry.source.licenseFile !== null && typeof entry.source.licenseFile !== "string")) {
      throw new Error(`${entry.id}.source is incomplete`);
    }
    integer(entry.baseStates, `${entry.id}.baseStates`, 1, 100_000_000);
    integer(entry.additionalStates, `${entry.id}.additionalStates`, 1, 5_000_000);
    if (entry.baseStates + entry.additionalStates > 100_000_000) throw new Error(`${entry.id} exceeds the 100M campaign ceiling`);
    if (entry.additionalStates > entry.baseStates * 9) throw new Error(`${entry.id} long-tail share exceeds 0.9`);
    if (Math.ceil((entry.baseStates + entry.additionalStates) / entry.baseStates) > 1_024) {
      throw new Error(`${entry.id} may require more than 1024 durable windows`);
    }
    integer(entry.maxDepth, `${entry.id}.maxDepth`, 1, 1_000);
    integer(entry.seed, `${entry.id}.seed`, 1, 0xffffffff);
    integer(entry.storySeed, `${entry.id}.storySeed`, 1, 2_147_483_646);
    integer(entry.maxElapsedSeconds, `${entry.id}.maxElapsedSeconds`, 1, 604_800);
    if (manifestWorkerTimeoutMs !== undefined && entry.maxElapsedSeconds * 1_000 >= manifestWorkerTimeoutMs) {
      throw new Error(`${entry.id}.maxElapsedSeconds requires headroom below workerTimeoutMs`);
    }
    integer(entry.maxMemoryMb, `${entry.id}.maxMemoryMb`, 1, 1_000_000);
    integer(entry.maxDiskMb, `${entry.id}.maxDiskMb`, 1, 1_000_000);
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityDigest(values: string[]) {
  const ordered = [...new Set(values)].sort();
  return { count: ordered.length, sha256: sha256(JSON.stringify(ordered)), examples: ordered.slice(0, 20) };
}

function identities(result: ExploreResult) {
  return {
    runtimeErrors: result.runtimeErrors.map((item) => sha256(JSON.stringify(runtimeFindingIdentity(item)))),
    assertionViolations: result.assertionResults.flatMap((item) => item.violations.map((violation) => sha256(JSON.stringify({
      ruleId: violation.ruleId,
      choices: violation.choiceIndices,
      observed: violation.observedValues,
    })))),
    goals: (result.goalResults ?? []).filter((goal) => goal.status === "reached").map((goal) => goal.id),
    visitedKnots: result.visitedKnots,
    visibleOutcomes: result.endingsFound.map((ending) => ending.finalText.trim().replace(/\s+/g, " ")),
    terminalVariants: result.endingsFound.map((ending) => sha256(JSON.stringify({ text: ending.finalText, variables: ending.variables }))),
  };
}

function compactResult(result: ExploreResult) {
  const evidence = identities(result);
  return {
    statesExplored: result.statesExplored,
    exhaustive: result.exhaustive,
    truncated: result.truncated,
    truncatedBy: result.truncatedBy,
    limits: result.limits,
    execution: result.execution,
    findings: Object.fromEntries(Object.entries(evidence).map(([key, values]) => [key, identityDigest(values)])),
  };
}

function combinedEvidence(results: ExploreResult[]) {
  const combined = {
    runtimeErrors: [] as string[],
    assertionViolations: [] as string[],
    goals: [] as string[],
    visitedKnots: [] as string[],
    visibleOutcomes: [] as string[],
    terminalVariants: [] as string[],
  };
  for (const result of results) {
    const evidence = identities(result);
    for (const key of Object.keys(combined) as Array<keyof typeof combined>) combined[key].push(...evidence[key]);
  }
  return Object.fromEntries(Object.entries(combined).map(([key, values]) => [key, identityDigest(values)]));
}

function combinedDelta(base: ExploreResult, results: ExploreResult[]) {
  const prior = identities(base);
  const additions = results.map(identities);
  return Object.fromEntries((Object.keys(prior) as Array<keyof typeof prior>).map((key) => {
    const existing = new Set(prior[key]);
    return [key, identityDigest(additions.flatMap((value) => value[key]).filter((value) => !existing.has(value)))];
  }));
}

function delta(base: ExploreResult, current: ExploreResult) {
  const prior = identities(base);
  const next = identities(current);
  return Object.fromEntries(Object.keys(next).map((key) => {
    const name = key as keyof typeof next;
    const existing = new Set(prior[name]);
    return [key, identityDigest(next[name].filter((value) => !existing.has(value)))];
  }));
}

async function report(projectRoot: string, reportId: string): Promise<ExploreResult> {
  const opened = await openReportArtifact(projectRoot, reportId);
  return (opened.report as { explore: ExploreResult }).explore;
}

function sessionMetadata(projectRoot: string): { ledger: CampaignLedger; latest: CampaignAllocation } {
  const directory = path.join(projectRoot, ".inkcheck", "sessions");
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  if (names.length !== 1) throw new Error(`expected one campaign session in ${projectRoot}`);
  const raw = JSON.parse(fs.readFileSync(path.join(directory, names[0]), "utf8")) as { campaign?: { ledger?: CampaignLedger } };
  const ledger = raw.campaign?.ledger;
  const latest = ledger?.allocations.at(-1);
  if (!ledger || !latest?.provenance || !latest.yield) throw new Error("campaign ledger omitted completed provenance");
  return { ledger, latest };
}

function compactLedger(projectRoot: string) {
  const { ledger, latest } = sessionMetadata(projectRoot);
  return {
    status: ledger.status,
    stopReason: ledger.stopReason,
    spend: ledger.spend,
    latest: {
      purpose: latest.purpose,
      reason: latest.reason,
      partition: latest.partition,
      grantedStates: latest.grantedStates,
      consumedStates: latest.consumedStates,
      stopReason: latest.stopReason,
      yield: latest.yield,
      observability: latest.observability,
      provenance: latest.provenance,
    },
  };
}

async function checkpointHash(projectRoot: string, response: SearchSessionResponse): Promise<string | null> {
  if (!response.session.latestCheckpointId) return null;
  return checkpointIdHash(projectRoot, response.session.latestCheckpointId);
}

async function checkpointIdHash(projectRoot: string, checkpointId: string): Promise<string> {
  const opened = await openCheckpointArtifact(projectRoot, checkpointId);
  return sha256(fs.readFileSync(path.resolve(projectRoot, opened.artifact.path)));
}

function campaignInput(file: string, entry: EvaluationCase, independent: boolean) {
  const totalStates = entry.baseStates + entry.additionalStates;
  return {
    file,
    mode: "fixed" as const,
    totalStates,
    windowStates: entry.baseStates,
    maxElapsedSeconds: entry.maxElapsedSeconds,
    maxMemoryMb: entry.maxMemoryMb,
    maxDiskMb: entry.maxDiskMb,
    maxDepth: entry.maxDepth,
    seed: entry.seed,
    storySeed: entry.storySeed,
    longTailShare: independent ? entry.additionalStates / totalStates : 0,
    minLongTailProbes: independent ? 1 : 0,
    regressionReserveStates: 0,
  };
}

function copyStory(source: string, root: string): string {
  const target = path.join(root, "story.ink");
  fs.copyFileSync(source, target);
  return target;
}

async function runArm(
  source: string,
  entry: EvaluationCase,
  root: string,
  independent: boolean,
  onSnapshot: (value: unknown) => void = () => {}
) {
  const label = independent ? "independent" : "same-frontier";
  const file = copyStory(source, root);
  const baseStarted = Date.now();
  const base = await startCampaign(campaignInput(file, entry, independent));
  const baseElapsedMs = Date.now() - baseStarted;
  if (!base.sessionCapability || !base.session.latestCheckpointId) {
    throw new Error(`${entry.id} ${label} base did not retain a checkpoint: ${base.campaign?.stopReason ?? base.session.bindingLimit}`);
  }
  const baseResult = await report(root, base.session.latestReportId);
  const checkpointBefore = await checkpointHash(root, base);
  process.stderr.write(`${entry.id} ${label} base: ${baseResult.statesExplored} states in ${baseElapsedMs} ms\n`);
  const continuationStarted = Date.now();
  let response = base;
  const additionalWindows: Array<{
    reportId: string;
    purpose: string;
    partition: CampaignAllocation["partition"];
    consumedStates: number;
    elapsedMs: number;
    stopReason: string;
    marginalYield: NonNullable<CampaignAllocation["yield"]>;
    observability?: NonNullable<CampaignAllocation["observability"]>;
    result: ReturnType<typeof compactResult>;
    newEvidence: ReturnType<typeof delta>;
  }> = [];
  const additionalResults: ExploreResult[] = [];
  const armResult = async (final: boolean) => {
    const checkpointAfter = final ? await checkpointIdHash(root, base.session.latestCheckpointId!) : null;
    const evidenceResults = independent ? additionalResults : additionalResults.slice(-1);
    return {
      base: {
        elapsedMs: baseElapsedMs,
        reportId: base.session.latestReportId,
        checkpointId: base.session.latestCheckpointId,
        result: compactResult(baseResult),
      },
      additional: {
        elapsedMs: Date.now() - continuationStarted,
        windows: additionalWindows,
        combinedEvidence: combinedEvidence(evidenceResults),
        newEvidence: combinedDelta(baseResult, evidenceResults),
        ledger: compactLedger(root),
      },
      invariants: {
        baseReportPreserved: independent ? response.session.latestReportId === base.session.latestReportId : null,
        baseCheckpointPreserved: independent && final
          ? checkpointBefore === checkpointAfter
          : null,
        campaignStatesWithinCeiling: response.campaign!.spend.states <= response.campaign!.ceilings.totalStates,
        reportReopens: true,
      },
    };
  };
  onSnapshot(await armResult(false));
  while (response.campaign!.spend.states < response.campaign!.ceilings.totalStates && response.session.recoverable) {
    const previousSpend = response.campaign!.spend.states;
    const windowStarted = Date.now();
    response = await continueCampaign({
      file,
      sessionCapability: base.sessionCapability,
      revision: response.session.revision,
    });
    if (response.campaign!.spend.states <= previousSpend) {
      if (!response.session.recoverable || response.campaign!.status !== "active") break;
      throw new Error(`${entry.id} ${label} campaign made no accounting progress`);
    }
    const reportId = independent ? response.campaign!.latestWindow!.reportId : response.session.latestReportId;
    const windowResult = await report(root, reportId);
    additionalResults.push(windowResult);
    additionalWindows.push({
      reportId,
      purpose: response.campaign!.latestWindow!.purpose,
      partition: response.campaign!.latestWindow!.partition,
      consumedStates: response.campaign!.spend.states - previousSpend,
      elapsedMs: Date.now() - windowStarted,
      stopReason: response.campaign!.latestWindow!.stopReason,
      marginalYield: response.campaign!.latestWindow!.yield,
      ...(response.campaign!.latestWindow!.observability
        ? { observability: response.campaign!.latestWindow!.observability }
        : {}),
      result: compactResult(windowResult),
      newEvidence: delta(baseResult, windowResult),
    });
    process.stderr.write(`${entry.id} ${label} window ${additionalWindows.length}: campaign=${response.campaign!.spend.states} report=${windowResult.statesExplored} states\n`);
    onSnapshot(await armResult(false));
  }
  return armResult(true);
}

function writeResult(outputFile: string, value: unknown): void {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, outputFile);
}

export async function runIsolatedArm(
  manifestFile: string,
  caseId: string,
  arm: "same-frontier" | "independent",
  workerTimeoutMs?: number,
  workerEntrypoint = __filename
): Promise<unknown> {
  const output = path.join(os.tmpdir(), `inkcheck-long-tail-${caseId}-${arm}-${process.pid}-${Date.now()}.json`);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `inkcheck-long-tail-worker-${caseId}-${arm}-`));
  const hardTerminationScope = process.platform === "win32" ? "coordinator_process" : "process_group";
  try {
    const worker = await new Promise<{ timedOut: boolean; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        ...process.execArgv,
        workerEntrypoint,
        manifestFile,
        "--output", output,
        "--case", caseId,
        "--arm", arm,
      ], {
        stdio: ["ignore", "inherit", "inherit"],
        detached: process.platform !== "win32",
        env: { ...process.env, INKCHECK_LONG_TAIL_PROJECT_ROOT: projectRoot },
      });
      let timedOut = false;
      let hardKill: NodeJS.Timeout | undefined;
      const killTree = (force: boolean) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          child.kill(force ? "SIGKILL" : "SIGTERM");
          return;
        }
        try {
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      };
      const timeout = workerTimeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        killTree(false);
        hardKill = setTimeout(() => killTree(true), 5_000);
        hardKill.unref();
      }, workerTimeoutMs);
      timeout?.unref();
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (timeout) clearTimeout(timeout);
        if (hardKill) clearTimeout(hardKill);
        resolve({ timedOut, code, signal });
      });
    });
    if (!fs.existsSync(output)) {
      if (worker.timedOut) return {
        unavailable: true,
        reason: "worker_timeout_before_snapshot",
        timeoutMs: workerTimeoutMs,
        hardTerminationScope,
      };
      throw new Error(`${caseId} ${arm} worker exited with ${worker.signal ?? worker.code} before writing evidence`);
    }
    const recovered = JSON.parse(fs.readFileSync(output, "utf8")) as { armResult: Record<string, unknown>; complete?: boolean };
    if (!worker.timedOut && worker.code !== 0) {
      return {
        ...recovered.armResult,
        worker: { status: "error_snapshot", exit: worker.signal ?? worker.code },
      };
    }
    return {
      ...recovered.armResult,
      worker: worker.timedOut
        ? { status: "hard_timeout_snapshot", timeoutMs: workerTimeoutMs, hardTerminationScope }
        : { status: "completed" },
    };
  } finally {
    fs.rmSync(output, { force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const caseIndex = args.indexOf("--case");
  const armIndex = args.indexOf("--arm");
  const timeoutIndex = args.indexOf("--worker-timeout-ms");
  const expectedLength = 3 + (caseIndex === -1 ? 0 : 2) + (armIndex === -1 ? 0 : 2) + (timeoutIndex === -1 ? 0 : 2);
  if (args.length !== expectedLength || outputIndex !== 1 || (caseIndex !== -1 && !args[caseIndex + 1])
    || (armIndex !== -1 && !["same-frontier", "independent"].includes(args[armIndex + 1]))
    || (timeoutIndex !== -1 && !args[timeoutIndex + 1])) {
    throw new Error("usage: inkcheck-long-tail-eval manifest.json --output result.json [--case ID] [--arm same-frontier|independent] [--worker-timeout-ms MS]");
  }
  const manifestFile = path.resolve(args[0]);
  const outputFile = path.resolve(args[2]);
  const selectedCase = caseIndex === -1 ? undefined : args[caseIndex + 1];
  const arm = armIndex === -1 ? undefined : args[armIndex + 1] as "same-frontier" | "independent";
  const timeoutOverride = timeoutIndex === -1 ? undefined : Number(args[timeoutIndex + 1]);
  if (timeoutOverride !== undefined) integer(timeoutOverride, "--worker-timeout-ms", 1, 604_800_000);
  const manifestRaw = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as unknown;
  validateManifest(manifest);
  const workerTimeoutMs = timeoutOverride ?? manifest.workerTimeoutMs;
  const selected = selectedCase ? manifest.cases.filter((entry) => entry.id === selectedCase) : manifest.cases;
  if (selected.length === 0) throw new Error(`unknown long-tail evaluation case: ${selectedCase}`);
  if (arm) {
    if (selected.length !== 1) throw new Error("an isolated arm requires exactly one --case");
    const entry = selected[0];
    const source = path.resolve(path.dirname(manifestFile), entry.story);
    if (!fs.existsSync(source)) throw new Error(`${entry.id}: story not found: ${source}`);
    const configuredRoot = process.env.INKCHECK_LONG_TAIL_PROJECT_ROOT;
    if (configuredRoot) {
      const resolved = path.resolve(configuredRoot);
      const relative = path.relative(path.resolve(os.tmpdir()), resolved);
      if (!path.basename(resolved).startsWith("inkcheck-long-tail-worker-")
        || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("isolated long-tail project root must be a dedicated temporary directory");
      }
    }
    const root = configuredRoot
      ? path.resolve(configuredRoot)
      : fs.mkdtempSync(path.join(os.tmpdir(), `inkcheck-long-tail-${arm}-${entry.id}-`));
    if (configuredRoot) fs.mkdirSync(root, { recursive: true });
    try {
      const persistSnapshot = (armResult: unknown) => writeResult(outputFile, { complete: false, armResult });
      const armResult = await runArm(source, entry, root, arm === "independent", persistSnapshot);
      writeResult(outputFile, { complete: true, armResult });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    return;
  }
  const result = {
    schemaVersion: manifest.schemaVersion,
    inkcheckVersion: VERSION,
    manifestSha256: sha256(JSON.stringify(manifest)),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      workerTimeoutMs: workerTimeoutMs ?? null,
    },
    cases: [] as unknown[],
  };
  for (const entry of selected) {
    const source = path.resolve(path.dirname(manifestFile), entry.story);
    if (!fs.existsSync(source)) throw new Error(`${entry.id}: story not found: ${source}`);
    const caseResult: Record<string, unknown> = {
      id: entry.id,
      source: entry.source,
      sourceSha256: sha256(fs.readFileSync(source)),
      configuration: {
        baseStates: entry.baseStates,
        additionalStates: entry.additionalStates,
        maxDepth: entry.maxDepth,
        seed: entry.seed,
        storySeed: entry.storySeed,
        maxElapsedSeconds: entry.maxElapsedSeconds,
        maxMemoryMb: entry.maxMemoryMb,
        maxDiskMb: entry.maxDiskMb,
      },
    };
    result.cases.push(caseResult);
    writeResult(outputFile, result);
    caseResult.sameFrontier = await runIsolatedArm(manifestFile, entry.id, "same-frontier", workerTimeoutMs);
    writeResult(outputFile, result);
    caseResult.independent = await runIsolatedArm(manifestFile, entry.id, "independent", workerTimeoutMs);
    writeResult(outputFile, result);
  }
  process.stdout.write(`${outputFile}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
