#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function count(value) {
  return Array.isArray(value) ? value.length : 0;
}

function reportSummary(report) {
  const explore = report?.explore ?? report;
  if (!explore || typeof explore !== "object") throw new Error("expected an Inkcheck JSON report");
  return {
    version: report?.inkcheckVersion ?? "unknown",
    fingerprint: report?.storyFingerprint?.value ?? null,
    statesExplored: Number(explore.statesExplored ?? 0),
    endingsFound: count(explore.endingsFound),
    runtimeErrors: count(explore.runtimeErrors),
    loopWarnings: count(explore.loopRisks),
    unvisitedKnots: count(explore.unvisitedKnots),
    bindingLimit: report?.bindingLimit ?? null,
    truncatedBy: explore.truncatedBy ?? {},
  };
}

function evaluate(baselineReport, candidateReport) {
  const baseline = reportSummary(baselineReport);
  const candidate = reportSummary(candidateReport);
  if (baseline.fingerprint && candidate.fingerprint && baseline.fingerprint !== candidate.fingerprint) {
    throw new Error("reports describe different compiled stories");
  }
  return {
    schemaVersion: 1,
    kind: "loop_specialist_evaluation",
    baseline,
    candidate,
    deltas: {
      statesExplored: candidate.statesExplored - baseline.statesExplored,
      endingsFound: candidate.endingsFound - baseline.endingsFound,
      runtimeErrors: candidate.runtimeErrors - baseline.runtimeErrors,
      loopWarnings: candidate.loopWarnings - baseline.loopWarnings,
      unvisitedKnots: candidate.unvisitedKnots - baseline.unvisitedKnots,
    },
    interpretation: {
      runtimeEvidenceParity: candidate.runtimeErrors === baseline.runtimeErrors,
      loopWarningsRequireReview: candidate.loopWarnings > 0,
      note: "This comparison reports observed bounded-run differences. It does not prove coverage, loop correctness, or a general performance advantage.",
    },
  };
}

function markdown(result) {
  const rows = [
    ["Inkcheck version", result.baseline.version, result.candidate.version],
    ["States explored", result.baseline.statesExplored, result.candidate.statesExplored],
    ["Endings found", result.baseline.endingsFound, result.candidate.endingsFound],
    ["Runtime errors", result.baseline.runtimeErrors, result.candidate.runtimeErrors],
    ["Loop warnings", result.baseline.loopWarnings, result.candidate.loopWarnings],
    ["Unvisited knots", result.baseline.unvisitedKnots, result.candidate.unvisitedKnots],
    ["Binding limit", result.baseline.bindingLimit ?? "none", result.candidate.bindingLimit ?? "none"],
  ];
  return [
    "# Loop Specialist Evaluation",
    "",
    "| Signal | Baseline | Candidate |",
    "| --- | ---: | ---: |",
    ...rows.map(([name, baseline, candidate]) => `| ${name} | ${baseline} | ${candidate} |`),
    "",
    `Runtime evidence parity: **${result.interpretation.runtimeEvidenceParity ? "yes" : "no"}**.`,
    `New loop warnings require review: **${result.interpretation.loopWarningsRequireReview ? "yes" : "no"}**.`,
    "",
    result.interpretation.note,
    "",
  ].join("\n");
}

function main(args) {
  const baselineIndex = args.indexOf("--baseline");
  const candidateIndex = args.indexOf("--candidate");
  if (baselineIndex < 0 || candidateIndex < 0 || !args[baselineIndex + 1] || !args[candidateIndex + 1]) {
    throw new Error("usage: evaluate-loop-specialist --baseline <report.json> --candidate <report.json> [--markdown]");
  }
  const baselinePath = path.resolve(args[baselineIndex + 1]);
  const candidatePath = path.resolve(args[candidateIndex + 1]);
  const result = evaluate(JSON.parse(fs.readFileSync(baselinePath, "utf8")), JSON.parse(fs.readFileSync(candidatePath, "utf8")));
  process.stdout.write(args.includes("--markdown") ? markdown(result) : `${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`loop specialist evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { evaluate, markdown, reportSummary };
