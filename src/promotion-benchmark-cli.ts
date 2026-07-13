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
  validatePromotionManifest,
  type PromotionBenchmarkReport,
  type PromotionManifest,
  type PromotionObservation,
} from "./promotion-benchmark";
import { runSearchBenchmark } from "./search-benchmark";
import type { AssertionDefinition } from "./assertions";

interface WorkerRequest {
  story: string;
  budget: number;
  depth: number;
  seed: number;
  candidate: boolean;
  assertions?: AssertionDefinition[];
}

async function worker(requestFile: string): Promise<void> {
  const request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as WorkerRequest;
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
    minimizeRepros: false,
    assertions: request.assertions,
  };
  const strategy = request.candidate ? "policy-v2-replay" : "fixed-portfolio";
  const measured = runSearchBenchmark(strategy, () =>
    request.candidate
      ? explorePortfolioShadowReplay(compiled.storyJson!, knots, externals, options)
      : explorePortfolio(compiled.storyJson!, knots, externals, options)
  );
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(JSON.stringify({ ...measured, peakRssBytes }));
}

function runWorker(request: WorkerRequest, scratch: string, sequence: number): PromotionObservation {
  const requestFile = path.join(scratch, `request-${sequence}.json`);
  fs.writeFileSync(requestFile, JSON.stringify(request));
  const child = spawnSync(process.execPath, [__filename, "--worker", requestFile], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(requestFile, { force: true });
  if (child.status !== 0) throw new Error(child.stderr.trim() || `benchmark worker exited ${child.status}`);
  const value = JSON.parse(child.stdout) as { elapsedMs: number; peakRssBytes: number; summary: PromotionObservation["summary"] };
  return value;
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
  if (markdown && deterministic) throw new Error("--markdown and --deterministic are mutually exclusive");
  const positional = args.filter((arg) => arg !== "--markdown" && arg !== "--ci" && arg !== "--deterministic");
  if (positional.length !== 1) throw new Error("usage: inkcheck-promotion manifest.json [--ci] [--markdown|--deterministic]");
  const manifestFile = path.resolve(positional[0]);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as PromotionManifest;
  validatePromotionManifest(manifest);
  const root = path.dirname(manifestFile);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-promotion-"));
  const pairs = [];
  let sequence = 0;
  try {
    const cases = ci ? manifest.cases.filter((entry) => entry.ci) : manifest.cases;
    if (cases.length === 0) throw new Error("--ci requires at least one case with ci: true");
    for (const entry of cases) {
      const story = path.resolve(root, entry.story);
      const budgets = selected(entry.budgets, ci);
      const depths = ci && entry.depths.length > 1
        ? [entry.depths[0], entry.depths.at(-1)!]
        : entry.depths;
      const seeds = selected(entry.seeds, ci);
      for (const budget of budgets) for (const depth of depths) for (const seed of seeds) {
        const request = { story, budget, depth, seed, assertions: entry.assertions };
        let baseline = runWorker({ ...request, candidate: false }, scratch, sequence++);
        let candidate = runWorker({ ...request, candidate: true }, scratch, sequence++);
        if (entry.determinismCheck) {
          const baselineRepeat = runWorker({ ...request, candidate: false }, scratch, sequence++);
          const candidateRepeat = runWorker({ ...request, candidate: true }, scratch, sequence++);
          baseline = {
            ...baseline,
            deterministicRepeatMatch: JSON.stringify(baseline.summary) === JSON.stringify(baselineRepeat.summary),
          };
          candidate = {
            ...candidate,
            deterministicRepeatMatch: JSON.stringify(candidate.summary) === JSON.stringify(candidateRepeat.summary),
          };
        }
        pairs.push(comparePromotionPair({
          caseId: entry.id,
          family: entry.family,
          source: entry.source,
          budget,
          depth,
          seed,
          baseline,
          candidate,
        }));
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
    caveat: "This report presents separate evidence and worst-family regressions; it does not declare a winner. Bounded runs are not coverage proof.",
    pairs,
    families: summarizePromotionFamilies(pairs),
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
