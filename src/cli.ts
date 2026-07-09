#!/usr/bin/env node
import {
  CompileResult,
  compile,
  stats,
  scanKnots,
  scanExternals,
  scanStorySemantics,
} from "./inklecate";
import { ExploreResult, explore, explorePortfolio, mergeMinRepro } from "./explore";
import { buildHumanFindings, renderHumanFindings } from "./human-report";

function usage(message?: string): never {
  if (message) console.error(`inkcheck: ${message}\n`);
  console.error(`inkcheck — CI for ink stories

Usage: inkcheck <story.ink> [options]
       inkcheck mcp              Start the MCP server (stdio)

Options:
  --max-depth <n>    Max choices deep to explore, 1–1000 (default 30)
  --max-states <n>   Max story states to visit, 1–50000 (default 500)
  --no-min-repro     Skip the small breadth-first repro-shortening slice
  --strict           Also fail on warnings, unvisited knots, truncation, or external stubs
  --human            Emit a prioritized human-readable fix list
  --json             Emit the full report as JSON
  --markdown         Emit a GitHub-friendly Markdown report
`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "mcp") {
    require("./server");
    return;
  }
  let file: string | undefined;
  let maxDepth: number | undefined;
  let maxStates: number | undefined;
  let strict = false;
  let asJson = false;
  let asMarkdown = false;
  let asHuman = false;
  let minRepro = true;
  const boundedInt = (flag: string, raw: string | undefined, max: number): number => {
    const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      usage(`${flag} requires an integer from 1 to ${max}`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--max-depth") maxDepth = boundedInt(arg, args[++i], 1_000);
    else if (arg === "--max-states") maxStates = boundedInt(arg, args[++i], 50_000);
    else if (arg === "--strict") strict = true;
    else if (arg === "--human") asHuman = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "--markdown") asMarkdown = true;
    else if (arg === "--no-min-repro") minRepro = false;
    else if (arg.startsWith("--")) usage(`unknown option: ${arg}`);
    else if (file) usage(`unexpected extra argument: ${arg}`);
    else file = arg;
  }
  if (!file) usage("missing story file");
  if ([asJson, asMarkdown, asHuman].filter(Boolean).length > 1) {
    usage("--json, --markdown, and --human cannot be used together");
  }

  const compiled = await compile(file);

  if (!compiled.success) {
    if (asJson) {
      console.log(JSON.stringify({ compile: { ...compiled, storyJson: undefined } }, null, 2));
    } else if (asMarkdown) {
      console.log(renderCompileFailureMarkdown(compiled));
    } else if (asHuman) {
      console.log(renderHumanFindings(buildHumanFindings({ compile: compiled })));
    } else {
      console.log(`✗ compile failed — ${compiled.errors} error(s), ${compiled.warnings} warning(s)\n`);
      for (const i of compiled.issues) console.log(`  ${i.raw}`);
    }
    process.exitCode = 1;
    return;
  }

  const knots = scanKnots(file);
  const externals = scanExternals(file);
  const semantics = scanStorySemantics(file);
  const st = await stats(file);
  const totalMaxStates = maxStates ?? 500;
  const reproStates = minRepro && totalMaxStates > 1 ? Math.max(1, Math.floor(totalMaxStates * 0.1)) : 0;
  const portfolioStates = totalMaxStates - reproStates;
  const exploreOptions = {
    maxDepth,
    maxStates: Math.max(1, portfolioStates),
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    randomnessDetected: semantics.usesRandomness,
  };
  let report = explorePortfolio(compiled.storyJson!, knots, externals, exploreOptions);
  if (reproStates > 0) {
    const bfs = explore(compiled.storyJson!, knots, externals, {
      maxDepth,
      maxStates: reproStates,
      strategy: "bfs",
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      randomnessDetected: semantics.usesRandomness,
    });
    report = mergeMinRepro(report, bfs);
  }

  const outputReport = { compile: { ...compiled, storyJson: undefined }, stats: st, explore: report };
  if (asJson) {
    console.log(
      JSON.stringify(
        outputReport,
        null,
        2
      )
    );
  } else if (asMarkdown) {
    console.log(renderMarkdown(compiled, st, report));
  } else if (asHuman) {
    console.log(renderHumanFindings(buildHumanFindings(outputReport)));
  } else {
    console.log(
      `✓ compiled — ${st.words ?? "?"} words, ${st.knots ?? knots.length} knots, ${st.choices ?? "?"} choices`
    );
    for (const i of compiled.issues) console.log(`  ${i.raw}`);
    console.log(
      `✓ explored ${report.statesExplored} states${report.truncated ? " (truncated at limits)" : ""} — ${report.endingsFound.length} distinct terminal state(s)`
    );
    for (const e of report.endingsFound.slice(0, 10)) {
      console.log(`    terminal via [${e.path.join(" → ") || "linear"}]: "${e.finalText.split("\n").pop()}"`);
    }
    if (report.runtimeErrors.length) {
      console.log(`✗ ${report.runtimeErrors.length} runtime error(s):`);
      for (const e of report.runtimeErrors)
        console.log(`    ${e.message}\n      repro: [${e.path.join(" → ")}]`);
    }
    if (report.unvisitedKnots.length) {
      console.log(`⚠ ${report.unvisitedKnots.length} knot(s) never visited on any explored path:`);
      for (const k of report.unvisitedKnots)
        console.log(`    ${k.name} (${humanLocation(k.file, k.line)})`);
    }
    if (report.runtimeWarnings.length) {
      console.log(`⚠ ${report.runtimeWarnings.length} runtime warning(s):`);
      for (const w of report.runtimeWarnings) console.log(`    ${w}`);
    }
    if (report.externalFunctionsStubbed.length) {
      console.log(
        `⚠ ${report.externalFunctionsStubbed.length} EXTERNAL function(s) were stubbed to 0; coverage is conditional: ${report.externalFunctionsStubbed.join(", ")}`
      );
    }
    if (report.randomnessDetected) {
      console.log(
        `⚠ random behavior detected; exploration follows reachable RNG states but does not enumerate every possible seed`
      );
    }
    if (report.truncated) {
      console.log(
        `⚠ exploration stopped at a configured limit; increase --max-depth or --max-states for broader coverage`
      );
    }
  }

  const hardFail = report.runtimeErrors.length > 0;
  const softFail =
    strict &&
    (compiled.warnings > 0 ||
      report.unvisitedKnots.length > 0 ||
      report.runtimeWarnings.length > 0 ||
      report.truncated ||
      report.externalFunctionsStubbed.length > 0);
  process.exitCode = hardFail || softFail ? 1 : 0;
}

function escapeCell(value: unknown): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function humanLocation(file: string, line: number | null | undefined): string {
  return `${file}${line ? ` line ${line}` : ""}`;
}

function renderCompileFailureMarkdown(compiled: CompileResult): string {
  const lines = ["# inkcheck report", "", "❌ **Compilation failed.**", ""];
  for (const issue of compiled.issues) {
    const location = issue.file ? `${humanLocation(issue.file, issue.line)}: ` : "";
    lines.push(`- **${issue.severity}** ${location}${issue.message}`);
  }
  return lines.join("\n");
}

function renderMarkdown(
  compiled: CompileResult,
  storyStats: Record<string, number>,
  report: ExploreResult
): string {
  const complete =
    !report.truncated && report.externalFunctionsStubbed.length === 0 && !report.randomnessDetected;
  const status = report.runtimeErrors.length
    ? "❌ **Runtime failures found.**"
    : complete
      ? "✅ **Choice traversal completed within the configured limits.**"
      : "⚠️ **Results have coverage limitations; see below.**";
  const lines = [
    "# inkcheck report",
    "",
    status,
    "",
    "| Check | Result |",
    "| --- | ---: |",
    `| Compile errors | ${compiled.errors} |`,
    `| Compile warnings | ${compiled.warnings} |`,
    `| Words | ${storyStats.words ?? "unknown"} |`,
    `| States explored | ${report.statesExplored} |`,
    `| Distinct terminal states | ${report.endingsFound.length} |`,
    `| Runtime errors | ${report.runtimeErrors.length} |`,
    `| Unvisited knots | ${report.unvisitedKnots.length} |`,
  ];
  if (report.runtimeErrors.length) {
    lines.push("", "## Runtime errors", "");
    for (const error of report.runtimeErrors) {
      lines.push(`- ${escapeCell(error.message)} — path: ${error.path.join(" → ") || "linear"}`);
    }
  }
  if (report.unvisitedKnots.length) {
    lines.push("", "## Unvisited knots", "");
    for (const knot of report.unvisitedKnots) lines.push(`- \`${knot.name}\` (${humanLocation(knot.file, knot.line)})`);
  }
  const limitations: string[] = [];
  if (report.truncated) {
    limitations.push(
      `Traversal stopped at max depth ${report.limits.maxDepth} or max states ${report.limits.maxStates}.`
    );
  }
  if (report.externalFunctionsStubbed.length) {
    limitations.push(`EXTERNAL functions were stubbed to zero: ${report.externalFunctionsStubbed.join(", ")}.`);
  }
  if (report.randomnessDetected) {
    limitations.push("Random behavior was detected; every possible random seed was not enumerated.");
  }
  if (limitations.length) lines.push("", "## Coverage limitations", "", ...limitations.map((x) => `- ${x}`));
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
