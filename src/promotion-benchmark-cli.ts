#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { compile, scanExternals, scanKnots } from "./inklecate";
import { explorePortfolio, explorePortfolioShadowReplay } from "./explore";
import {
  comparePromotionPair,
  deterministicPromotionView,
  renderPromotionMarkdown,
  summarizePromotionFamilies,
  summarizePromotionProjects,
  validatePromotionManifest,
  type PromotionBenchmarkReport,
  type PromotionManifest,
  type PromotionObservation,
  type PromotionUnavailableCell,
} from "./promotion-benchmark";
import { runSearchBenchmark, summarizeSearchResult } from "./search-benchmark";
import type { AssertionDefinition } from "./assertions";
import { createResourceGuards } from "./resource-guards";

interface WorkerRequest {
  story: string;
  budget: number;
  depth: number;
  seed: number;
  storySeed: number;
  candidate: boolean;
  assertions?: AssertionDefinition[];
  maxMemoryMb?: number;
  maxTimeMs?: number;
  /** Optional for compatibility with already-running pre-snapshot workers. */
  snapshotFile?: string;
}

interface WorkerLimits {
  hardTimeoutMs?: number;
  maxMemoryMb?: number;
}

export function gracefulWorkerTimeMs(hardTimeoutMs: number): number {
  const margin = Math.min(10_000, Math.max(1_000, Math.floor(hardTimeoutMs * 0.1)));
  return Math.max(1, hardTimeoutMs - margin);
}

async function worker(requestFile: string): Promise<void> {
  const startedAtMs = Date.now();
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as WorkerRequest;
  const guards = createResourceGuards({
    maxMemoryMb: request.maxMemoryMb,
    maxTimeMs: request.maxTimeMs,
    startedAtMs,
  });
  const compiled = await compile(request.story);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`${request.story}: compile failed: ${compiled.issues.map((issue) => issue.message).join("; ")}`);
  }
  const knots = scanKnots(request.story);
  const externals = scanExternals(request.story);
  const options = {
    maxStates: request.budget,
    maxDepth: request.depth,
    seed: request.seed,
    storySeed: request.storySeed,
    minimizeRepros: false,
    assertions: request.assertions,
    memoryGuard: guards.memoryGuard,
    timeGuard: guards.timeGuard,
  };
  const strategy = request.candidate ? "policy-v2-replay" : "fixed-portfolio";
  const observation = (summary: PromotionObservation["summary"]): PromotionObservation => ({
    elapsedMs: Date.now() - startedAtMs,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    resourceLimits: {
      memoryCapBytes: guards.memoryCapBytes,
      timeLimitMs: request.maxTimeMs ?? null,
    },
    workerExit: "completed",
    summary,
  });
  const persistSnapshot = (report: Parameters<typeof summarizeSearchResult>[1]) => {
    if (!request.snapshotFile) return;
    const destination = request.snapshotFile;
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(observation(summarizeSearchResult(strategy, report))));
    fs.renameSync(temporary, destination);
  };
  const measured = runSearchBenchmark(strategy, () =>
    request.candidate
      ? explorePortfolioShadowReplay(compiled.storyJson!, knots, externals, { ...options, onSnapshot: persistSnapshot })
      : explorePortfolio(compiled.storyJson!, knots, externals, { ...options, onSnapshot: persistSnapshot })
  );
  process.stdout.write(JSON.stringify(observation(measured.summary)));
}

class WorkerTimeoutError extends Error {}

function runWorker(
  request: Omit<WorkerRequest, "snapshotFile" | "maxMemoryMb" | "maxTimeMs">,
  scratch: string,
  sequence: number,
  limits: WorkerLimits = {}
): PromotionObservation {
  const requestFile = path.join(scratch, `request-${sequence}.json`);
  const snapshotFile = path.join(scratch, `snapshot-${sequence}.json`);
  fs.writeFileSync(requestFile, JSON.stringify({
    ...request,
    snapshotFile,
    maxMemoryMb: limits.maxMemoryMb,
    ...(limits.hardTimeoutMs === undefined ? {} : { maxTimeMs: gracefulWorkerTimeMs(limits.hardTimeoutMs) }),
  }));
  try {
    const child = spawnSync(process.execPath, [__filename, "--worker", requestFile], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...(limits.hardTimeoutMs ? { timeout: limits.hardTimeoutMs } : {}),
    });
    if (child.error && (child.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      if (!fs.existsSync(snapshotFile)) throw new WorkerTimeoutError("benchmark worker timed out before its first snapshot");
      const recovered = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as PromotionObservation;
      if (!recovered.summary.result.exhaustive) {
        recovered.summary.result.truncated = true;
        recovered.summary.result.truncatedBy = {
          ...recovered.summary.result.truncatedBy,
          maxStates: false,
          frontier: recovered.summary.result.truncatedBy.frontier ?? false,
          time: true,
        };
      }
      recovered.workerExit = "hard-timeout-snapshot";
      return recovered;
    }
    if (child.status !== 0) throw new Error(child.stderr.trim() || `benchmark worker exited ${child.status}`);
    return JSON.parse(child.stdout) as PromotionObservation;
  } finally {
    fs.rmSync(requestFile, { force: true });
    fs.rmSync(snapshotFile, { force: true });
    fs.rmSync(`${snapshotFile}.tmp`, { force: true });
  }
}

function selected(values: number[], ci: boolean): number[] {
  if (!ci || values.length === 1) return values;
  return [values[0]];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--worker" && args.length === 2) return worker(args[1]);
  const markdown = args.includes("--markdown");
  const ci = args.includes("--ci");
  const deterministic = args.includes("--deterministic");
  const optionValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
    return args[index + 1];
  };
  const selectedCase = optionValue("--case");
  const selectedBudgetText = optionValue("--budget");
  const selectedBudget = selectedBudgetText === undefined ? undefined : Number(selectedBudgetText);
  const workerTimeoutText = optionValue("--worker-timeout-ms");
  const workerTimeoutMs = workerTimeoutText === undefined ? undefined : Number(workerTimeoutText);
  const workerMemoryText = optionValue("--worker-max-memory-mb");
  const workerMaxMemoryMb = workerMemoryText === undefined ? undefined : Number(workerMemoryText);
  if (selectedBudget !== undefined && (!Number.isSafeInteger(selectedBudget) || selectedBudget < 1)) {
    throw new Error("--budget requires a positive integer");
  }
  if (workerTimeoutMs !== undefined && (!Number.isSafeInteger(workerTimeoutMs) || workerTimeoutMs < 1)) {
    throw new Error("--worker-timeout-ms requires a positive integer");
  }
  if (workerMaxMemoryMb !== undefined && (!Number.isSafeInteger(workerMaxMemoryMb) || workerMaxMemoryMb < 1 || workerMaxMemoryMb > 1_000_000)) {
    throw new Error("--worker-max-memory-mb requires an integer from 1 to 1000000");
  }
  if (markdown && deterministic) throw new Error("--markdown and --deterministic are mutually exclusive");
  const optionValues = new Set([selectedCase, selectedBudgetText, workerTimeoutText, workerMemoryText].filter((value): value is string => value !== undefined));
  const positional = args.filter((arg) => !["--markdown", "--ci", "--deterministic", "--case", "--budget", "--worker-timeout-ms", "--worker-max-memory-mb"].includes(arg) && !optionValues.has(arg));
  if (positional.length !== 1) throw new Error("usage: inkcheck-promotion manifest.json [--ci] [--case ID] [--budget STATES] [--worker-timeout-ms MS] [--worker-max-memory-mb MB] [--markdown|--deterministic]");
  const manifestFile = path.resolve(positional[0]);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as PromotionManifest;
  validatePromotionManifest(manifest);
  const root = path.dirname(manifestFile);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-promotion-"));
  const pairs = [];
  const unavailable: PromotionUnavailableCell[] = [];
  const workerLimits = { hardTimeoutMs: workerTimeoutMs, maxMemoryMb: workerMaxMemoryMb };
  let sequence = 0;
  try {
    let cases = ci ? manifest.cases.filter((entry) => entry.ci) : manifest.cases;
    if (selectedCase) cases = cases.filter((entry) => entry.id === selectedCase);
    if (cases.length === 0) throw new Error(selectedCase ? `unknown or unselected promotion case: ${selectedCase}` : "--ci requires at least one case with ci: true");
    for (const entry of cases) {
      const story = path.resolve(root, entry.story);
      const budgets = selected(entry.budgets, ci).filter((budget) => selectedBudget === undefined || budget === selectedBudget);
      if (budgets.length === 0) throw new Error(`${entry.id}: selected budget is not declared`);
      const depths = ci && entry.depths.length > 1
        ? [entry.depths[0], entry.depths.at(-1)!]
        : entry.depths;
      const seeds = selected(entry.seeds, ci);
      for (const budget of budgets) for (const depth of depths) for (const seed of seeds) {
        const storySeed = entry.storySeed ?? 1;
        const request = { story, budget, depth, seed, storySeed, assertions: entry.assertions };
        console.error(`starting ${entry.id} budget=${budget} depth=${depth} seed=${seed}`);
        let baseline: PromotionObservation;
        let candidate: PromotionObservation;
        try {
          baseline = runWorker({ ...request, candidate: false }, scratch, sequence++, workerLimits);
        } catch (error) {
          if (!(error instanceof WorkerTimeoutError) || !workerTimeoutMs) throw error;
          unavailable.push({ caseId: entry.id, family: entry.family, budget, depth, seed, storySeed, stage: "baseline", reason: "worker-timeout", timeoutMs: workerTimeoutMs });
          console.error(`unavailable ${entry.id} budget=${budget} stage=baseline timeout=${workerTimeoutMs}`);
          continue;
        }
        try {
          candidate = runWorker({ ...request, candidate: true }, scratch, sequence++, workerLimits);
        } catch (error) {
          if (!(error instanceof WorkerTimeoutError) || !workerTimeoutMs) throw error;
          unavailable.push({ caseId: entry.id, family: entry.family, budget, depth, seed, storySeed, stage: "candidate", reason: "worker-timeout", timeoutMs: workerTimeoutMs });
          console.error(`unavailable ${entry.id} budget=${budget} stage=candidate timeout=${workerTimeoutMs}`);
          continue;
        }
        if (entry.determinismCheck || entry.determinismBudgets?.includes(budget)) {
          let baselineRepeat: PromotionObservation | undefined;
          let candidateRepeat: PromotionObservation | undefined;
          try {
            baselineRepeat = runWorker({ ...request, candidate: false }, scratch, sequence++, workerLimits);
          } catch (error) {
            if (!(error instanceof WorkerTimeoutError) || !workerTimeoutMs) throw error;
            unavailable.push({ caseId: entry.id, family: entry.family, budget, depth, seed, storySeed, stage: "baseline-repeat", reason: "worker-timeout", timeoutMs: workerTimeoutMs });
            console.error(`unavailable ${entry.id} budget=${budget} stage=baseline-repeat timeout=${workerTimeoutMs}`);
          }
          try {
            candidateRepeat = runWorker({ ...request, candidate: true }, scratch, sequence++, workerLimits);
          } catch (error) {
            if (!(error instanceof WorkerTimeoutError) || !workerTimeoutMs) throw error;
            unavailable.push({ caseId: entry.id, family: entry.family, budget, depth, seed, storySeed, stage: "candidate-repeat", reason: "worker-timeout", timeoutMs: workerTimeoutMs });
            console.error(`unavailable ${entry.id} budget=${budget} stage=candidate-repeat timeout=${workerTimeoutMs}`);
          }
          baseline = {
            ...baseline,
            ...(baselineRepeat ? { deterministicRepeatMatch: JSON.stringify(baseline.summary) === JSON.stringify(baselineRepeat.summary) } : {}),
          };
          candidate = {
            ...candidate,
            ...(candidateRepeat ? { deterministicRepeatMatch: JSON.stringify(candidate.summary) === JSON.stringify(candidateRepeat.summary) } : {}),
          };
        }
        pairs.push(comparePromotionPair({
          caseId: entry.id,
          family: entry.family,
          source: entry.source,
          budget,
          depth,
          seed,
          storySeed,
          baseline,
          candidate,
        }));
        console.error(`finished ${entry.id} budget=${budget} depth=${depth} seed=${seed}`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const report: PromotionBenchmarkReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidate: "policy-v2-replay",
    baseline: "fixed-portfolio",
    caveat: "This report presents unavailable cells, separate evidence, and worst-project/family regressions; it does not declare a winner. Bounded runs are not coverage proof.",
    pairs,
    families: summarizePromotionFamilies(pairs),
    ...(manifest.tier === "authored-project" ? { projects: summarizePromotionProjects(pairs) } : {}),
    ...(unavailable.length ? { unavailable } : {}),
  };
  const output = markdown
    ? renderPromotionMarkdown(report)
    : JSON.stringify(deterministic ? deterministicPromotionView(report) : report, null, 2);
  process.stdout.write(markdown ? output : `${output}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Could not run promotion benchmark");
  process.exitCode = 1;
});
