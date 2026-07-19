#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function summary(result, goal, elapsedMs, rssBytes, fingerprint) {
  const goalResult = result.goalResults?.find((item) => item.id === goal.id);
  return {
    storyFingerprint: fingerprint,
    statesExplored: result.statesExplored,
    elapsedMs,
    rssBytes,
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
      visibleOutcomes: count(result.visibleOutcomes),
      visitedKnots: count(result.visitedKnots),
      unvisitedKnots: count(result.unvisitedKnots),
    },
    bindingLimit: result.truncated ? Object.entries(result.truncatedBy ?? {}).find(([, value]) => value)?.[0] ?? "unknown" : null,
    exhaustive: result.exhaustive === true,
  };
}

async function runArm(cell, arm) {
  const { compile, scanExternals, scanKnots, scanStorySemantics } = require("../dist/inklecate");
  const { selectGateProbe } = require("../dist/discovery");
  const { exploreGoalProbe, exploreShared } = require("../dist/explore");
  const file = path.resolve(cell.file);
  const plan = selectGateProbe(file, cell.gate);
  const compiled = await compile(file);
  if (!compiled.success || !compiled.storyJson) throw new Error(`compile failed for ${cell.id}`);
  const semantics = scanStorySemantics(file);
  const options = {
    maxDepth: cell.maxDepth,
    maxStates: cell.maxStates,
    seed: cell.seed,
    storySeed: cell.storySeed,
    goals: [plan.goal],
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    randomnessDetected: semantics.usesRandomness,
  };
  const startedAt = process.hrtime.bigint();
  const result = arm === "baseline"
    ? exploreShared(compiled.storyJson, scanKnots(file), scanExternals(file), options)
    : exploreGoalProbe(compiled.storyJson, scanKnots(file), scanExternals(file), { ...options, goalMaxStates: cell.maxStates });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return {
    arm,
    gate: {
      location: plan.gate.location,
      expression: plan.gate.expression,
      condition: plan.goal.condition,
      assignmentSites: plan.gate.assignmentSites,
    },
    result: summary(
      result,
      plan.goal,
      elapsedMs,
      process.memoryUsage().rss,
      createHash("sha256").update(compiled.storyJson).digest("hex")
    ),
  };
}

function compareArms(baseline, candidate) {
  if (baseline.result.storyFingerprint !== candidate.result.storyFingerprint) {
    throw new Error("baseline and gate probe describe different compiled stories");
  }
  return {
    targetReached: { baseline: baseline.result.target.status === "reached", gateProbe: candidate.result.target.status === "reached" },
    targetWitness: { baseline: baseline.result.target.witness, gateProbe: candidate.result.target.witness },
    deltas: {
      statesExplored: candidate.result.statesExplored - baseline.result.statesExplored,
      elapsedMs: candidate.result.elapsedMs - baseline.result.elapsedMs,
      rssBytes: candidate.result.rssBytes - baseline.result.rssBytes,
      runtimeErrors: candidate.result.evidence.runtimeErrors - baseline.result.evidence.runtimeErrors,
      assertionViolations: candidate.result.evidence.assertionViolations - baseline.result.evidence.assertionViolations,
      endings: candidate.result.evidence.endings - baseline.result.evidence.endings,
      visibleOutcomes: candidate.result.evidence.visibleOutcomes - baseline.result.evidence.visibleOutcomes,
      visitedKnots: candidate.result.evidence.visitedKnots - baseline.result.evidence.visitedKnots,
    },
    interpretation: "Matched bounded observations only. Gate reach is an intent signal, not coverage proof; terminal count and resource measurements are not defect counts or portable performance promises.",
  };
}

function runIsolated(cell, arm) {
  const child = spawnSync(process.execPath, [__filename, "--arm", arm, "--cell", Buffer.from(JSON.stringify(cell)).toString("base64url")], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`${cell.id}/${arm} failed: ${child.stderr || child.stdout}`);
  return JSON.parse(child.stdout);
}

function selectedCells(manifest, args) {
  const requested = args.includes("--case") ? args[args.indexOf("--case") + 1] : undefined;
  const includeRequired = args.includes("--include-required");
  return manifest.cells.filter((cell) => (!requested || cell.id === requested) && (includeRequired || cell.tier !== "required"));
}

function markdown(result) {
  const rows = result.cells.filter((cell) => cell.status === "completed").map((cell) => [
    cell.id,
    cell.baseline.result.target.status,
    cell.gateProbe.result.target.status,
    cell.comparison.deltas.runtimeErrors,
    cell.comparison.deltas.visitedKnots,
  ]);
  return [
    "# Gate Probe Evaluation",
    "",
    "| Cell | Broad target | Gate probe target | Runtime delta | Knot delta |",
    "| --- | --- | --- | ---: | ---: |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    "Gate reach is an intent signal, not coverage proof. Required authored cells must be run explicitly and interpreted with their resource observations.",
    "",
  ].join("\n");
}

async function main(args) {
  const armIndex = args.indexOf("--arm");
  if (armIndex >= 0) {
    const cell = JSON.parse(Buffer.from(args[args.indexOf("--cell") + 1], "base64url").toString("utf8"));
    process.stdout.write(`${JSON.stringify(await runArm(cell, args[armIndex + 1]))}\n`);
    return;
  }
  const manifestPath = path.resolve(args.includes("--manifest") ? args[args.indexOf("--manifest") + 1] : "benchmarks/gate-probe-evaluation-v1.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const budget = args.includes("--budget") ? Number(args[args.indexOf("--budget") + 1]) : undefined;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1 || budget > 100000000)) throw new Error("--budget must be an integer from 1 to 100000000");
  const cells = selectedCells(manifest, args);
  if (!cells.length) throw new Error("no evaluation cells selected");
  const result = {
    schemaVersion: 1,
    kind: "gate_probe_evaluation",
    manifest: path.relative(process.cwd(), manifestPath),
    cells: cells.map((sourceCell) => {
      const cell = budget === undefined ? sourceCell : { ...sourceCell, maxStates: budget };
      const baseline = runIsolated(cell, "baseline");
      const gateProbe = runIsolated(cell, "gate-probe");
      return { id: cell.id, status: "completed", configuration: cell, baseline, gateProbe, comparison: compareArms(baseline, gateProbe) };
    }),
    omittedRequiredCells: manifest.cells.filter((cell) => cell.tier === "required" && !cells.some((selected) => selected.id === cell.id)).map((cell) => cell.id),
    disclosure: "Each arm runs in a fresh process with the same declared configuration. Results are bounded observations, not coverage proof or a promotion decision.",
  };
  const output = args.includes("--markdown") ? markdown(result) : `${JSON.stringify(result, null, 2)}\n`;
  const outputPath = args.includes("--output") ? path.resolve(args[args.indexOf("--output") + 1]) : undefined;
  if (outputPath) fs.writeFileSync(outputPath, output);
  else process.stdout.write(output);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`gate probe evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { compareArms, markdown, selectedCells };
