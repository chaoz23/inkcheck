#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import type { ExploreResult } from "./explore";
import {
  evaluateShadowBudgetLadder,
  renderShadowEvaluationMarkdown,
  type ShadowEvaluationCase,
} from "./shadow-evaluation";

interface ManifestRun {
  budget: number;
  report: string;
  elapsedMs?: number;
}

interface ManifestCase extends Omit<ShadowEvaluationCase, "runs"> {
  runs: ManifestRun[];
}

interface Manifest {
  schemaVersion: 1;
  cases: ManifestCase[];
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function exploreReport(value: unknown, file: string): ExploreResult {
  if (!value || typeof value !== "object") throw new Error(`${file}: expected a JSON object`);
  const candidate = value as { explore?: ExploreResult; statesExplored?: number };
  const report = candidate.explore ?? value as ExploreResult;
  if (!Number.isFinite(report.statesExplored) || !report.limits || !Array.isArray(report.endingsFound)) {
    throw new Error(`${file}: expected an Inkcheck JSON report or explore object`);
  }
  return report;
}

function usage(): never {
  throw new Error("usage: node dist/shadow-evaluation-cli.js manifest.json [--markdown]");
}

try {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args[1] !== undefined && args[1] !== "--markdown")) usage();
  const manifestFile = path.resolve(args[0]);
  const manifest = readJson(manifestFile) as Manifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases)) throw new Error("manifest schemaVersion 1 and cases are required");
  const root = path.dirname(manifestFile);
  const results = manifest.cases.map((entry) => evaluateShadowBudgetLadder({
    ...entry,
    runs: entry.runs.map((run) => ({
      budget: run.budget,
      ...(run.elapsedMs === undefined ? {} : { elapsedMs: run.elapsedMs }),
      report: exploreReport(readJson(path.resolve(root, run.report)), run.report),
    })),
  }));
  console.log(args[1] === "--markdown" ? renderShadowEvaluationMarkdown(results) : JSON.stringify({ schemaVersion: 1, results }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not evaluate shadow policy");
  process.exitCode = 1;
}
