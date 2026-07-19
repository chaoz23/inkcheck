#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function visibleOutcomeCount(endings) {
  return new Set((endings ?? []).map((ending) => String(ending.finalText ?? "").trim().replace(/\s+/g, " "))).size;
}

function summary(report, goal, elapsedMs) {
  const result = report.explore;
  const goalResult = result.goalResults?.find((item) => item.id === goal.id);
  return {
    storyFingerprint: report.storyFingerprint?.value,
    statesExplored: result.statesExplored,
    elapsedMs,
    target: {
      id: goal.id,
      status: goalResult?.status ?? "not_observed",
      witness: Boolean(goalResult?.witness),
      closestDistance: goalResult?.closestObserved?.distance ?? null,
    },
    evidence: {
      runtimeErrors: count(result.runtimeErrors),
      assertionViolations: (result.assertionResults ?? []).reduce((total, item) => total + count(item.violations), 0),
      endings: count(result.endingsFound),
      visibleOutcomes: visibleOutcomeCount(result.endingsFound),
      visitedKnots: count(result.visitedKnots),
      unvisitedKnots: count(result.unvisitedKnots),
    },
    bindingLimit: result.truncated ? Object.entries(result.truncatedBy ?? {}).find(([, value]) => value)?.[0] ?? "unknown" : null,
    exhaustive: result.exhaustive === true,
  };
}

function childRuntimeArgs(execArgv = process.execArgv) {
  return execArgv.filter((argument) => argument.startsWith("--max-old-space-size"));
}

function evaluationProject(cell, plan) {
  const file = path.resolve(cell.file);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-gate-probe-"));
  fs.cpSync(path.dirname(file), root, { recursive: true });
  const entrypoint = path.basename(file);
  fs.writeFileSync(path.join(root, "inkcheck.yml"), JSON.stringify({
    schemaVersion: 1,
    entrypoint,
    goals: [plan.goal],
  }, null, 2));
  return { root, entrypoint };
}

function forwardProgress(arm, chunk, state) {
  state.buffer += chunk.toString("utf8");
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.schemaVersion === 1 && event.type) {
        process.stderr.write(`${JSON.stringify({ schemaVersion: 1, kind: "gate_probe_evaluation_progress", arm, event })}\n`);
      } else state.diagnostics += `${line}\n`;
    } catch {
      state.diagnostics += `${line}\n`;
    }
  }
}

function runCliArm(cell, arm, plan) {
  const project = evaluationProject(cell, plan);
  const cli = path.resolve(__dirname, "..", "dist", "cli.js");
  const args = [
    ...childRuntimeArgs(), cli, project.entrypoint,
    "--json", "--progress=ndjson", "--search", "shared", "--no-min-repro",
    "--max-depth", String(cell.maxDepth), "--max-states", String(cell.maxStates),
    "--seed", String(cell.seed), "--story-seed", String(cell.storySeed),
    ...(cell.maxMemoryMb === undefined ? [] : ["--max-memory", String(cell.maxMemoryMb)]),
    ...(arm === "gate-probe" ? ["--goal-only"] : []),
  ];
  const startedAt = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: project.root, stdio: ["ignore", "pipe", "pipe"] });
    const progress = { buffer: "", diagnostics: "" };
    const stdout = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => forwardProgress(arm, chunk, progress));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      fs.rmSync(project.root, { recursive: true, force: true });
      if (progress.buffer.trim()) {
        const finalLine = progress.buffer;
        progress.buffer = "";
        forwardProgress(arm, Buffer.from(`${finalLine}\n`), progress);
      }
      if (code !== 0) return reject(new Error(`${cell.id}/${arm} failed: ${progress.diagnostics}`));
      try {
        const report = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        resolve({
          arm,
          gate: { location: plan.gate.location, expression: plan.gate.expression, condition: plan.goal.condition, assignmentSites: plan.gate.assignmentSites },
          result: summary(report, plan.goal, Number(process.hrtime.bigint() - startedAt) / 1e6),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function compareArms(baseline, candidate) {
  if (baseline.result.storyFingerprint !== candidate.result.storyFingerprint) throw new Error("baseline and gate probe describe different compiled stories");
  return {
    targetReached: { baseline: baseline.result.target.status === "reached", gateProbe: candidate.result.target.status === "reached" },
    targetWitness: { baseline: baseline.result.target.witness, gateProbe: candidate.result.target.witness },
    deltas: Object.fromEntries(["statesExplored", "elapsedMs"].map((key) => [key, candidate.result[key] - baseline.result[key]]).concat([
      ["runtimeErrors", candidate.result.evidence.runtimeErrors - baseline.result.evidence.runtimeErrors],
      ["assertionViolations", candidate.result.evidence.assertionViolations - baseline.result.evidence.assertionViolations],
      ["endings", candidate.result.evidence.endings - baseline.result.evidence.endings],
      ["visibleOutcomes", candidate.result.evidence.visibleOutcomes - baseline.result.evidence.visibleOutcomes],
      ["visitedKnots", candidate.result.evidence.visitedKnots - baseline.result.evidence.visitedKnots],
    ])),
    interpretation: "Matched bounded observations only. Gate reach is an intent signal, not coverage proof; terminal count and resource measurements are not defect counts or portable performance promises.",
  };
}

function selectedCells(manifest, args) {
  const requested = args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined;
  const includeRequired = args.includes("--include-required");
  return manifest.cells.filter((cell) => (!requested || cell.id === requested) && (includeRequired || cell.tier !== "required"));
}

function markdown(result) {
  const rows = result.cells.map((cell) => [cell.id, cell.baseline.result.target.status, cell.gateProbe.result.target.status, cell.comparison.deltas.runtimeErrors, cell.comparison.deltas.visitedKnots]);
  return ["# Gate Probe Evaluation", "", "| Cell | Broad target | Gate probe target | Runtime delta | Knot delta |", "| --- | --- | --- | ---: | ---: |", ...rows.map((row) => `| ${row.join(" | ")} |`), "", "Gate reach is an intent signal, not coverage proof. Required authored cells must be run explicitly and interpreted with their resource observations.", ""].join("\n");
}

async function main(args) {
  const manifestPath = path.resolve(args.includes("--manifest") ? args[args.indexOf("--manifest") + 1] : "benchmarks/gate-probe-evaluation-v1.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const budget = args.includes("--budget") ? Number(args[args.indexOf("--budget") + 1]) : undefined;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1 || budget > 100000000)) throw new Error("--budget must be an integer from 1 to 100000000");
  const cells = selectedCells(manifest, args);
  if (!cells.length) throw new Error("no evaluation cells selected");
  const completed = [];
  for (const sourceCell of cells) {
    const cell = budget === undefined ? sourceCell : { ...sourceCell, maxStates: budget };
    const { selectGateProbe } = require("../dist/discovery");
    const plan = selectGateProbe(path.resolve(cell.file), cell.gate);
    const baseline = await runCliArm(cell, "baseline", plan);
    const gateProbe = await runCliArm(cell, "gate-probe", plan);
    completed.push({ id: cell.id, status: "completed", configuration: cell, baseline, gateProbe, comparison: compareArms(baseline, gateProbe) });
  }
  const result = { schemaVersion: 1, kind: "gate_probe_evaluation", manifest: path.relative(process.cwd(), manifestPath), cells: completed, omittedRequiredCells: manifest.cells.filter((cell) => cell.tier === "required" && !cells.some((selected) => selected.id === cell.id)).map((cell) => cell.id), disclosure: "Each arm invokes the public CLI in a fresh process with the same declared configuration. Progress events are production NDJSON events tagged by evaluation arm. Results are bounded observations, not coverage proof or a promotion decision." };
  const output = args.includes("--markdown") ? markdown(result) : `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = args.includes("--output") ? path.resolve(args[args.indexOf("--output") + 1]) : undefined;
  if (outputPath) fs.writeFileSync(outputPath, output); else process.stdout.write(output);
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { process.stderr.write(`gate probe evaluation failed: ${error.message}\n`); process.exitCode = 1; });

module.exports = { childRuntimeArgs, compareArms, markdown, selectedCells };
