#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import {
  evaluateAgentReadinessFixture,
  evaluateAgentReadinessReleaseGate,
  loadAgentReadinessManifest,
  scoreAgentReadinessSubmission,
} from "./agent-readiness-benchmark";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = path.resolve(args[0] ?? "benchmarks/agent-readiness-v1");
  const submissionFlag = args.indexOf("--submission");
  const gateFlag = args.indexOf("--gate");
  const expected = await evaluateAgentReadinessFixture(root);
  if (gateFlag !== -1) {
    const files = args.slice(gateFlag + 1);
    if (files.length < 2) throw new Error("--gate requires at least two submission JSON files");
    const manifest = loadAgentReadinessManifest(root);
    const scored = files.map((file) => scoreAgentReadinessSubmission(
      manifest,
      expected,
      JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))
    ));
    const gate = evaluateAgentReadinessReleaseGate(scored);
    process.stdout.write(`${JSON.stringify({ gate, results: scored }, null, 2)}\n`);
    if (!gate.pass) process.exitCode = 1;
    return;
  }
  if (submissionFlag === -1) {
    process.stdout.write(`${JSON.stringify(expected, null, 2)}\n`);
    return;
  }
  const submissionFile = args[submissionFlag + 1];
  if (!submissionFile) throw new Error("--submission requires a JSON file");
  const submission = JSON.parse(fs.readFileSync(path.resolve(submissionFile), "utf8"));
  const scored = scoreAgentReadinessSubmission(loadAgentReadinessManifest(root), expected, submission);
  process.stdout.write(`${JSON.stringify(scored, null, 2)}\n`);
  if (!scored.pass || !scored.attributionComplete) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
