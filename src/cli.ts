#!/usr/bin/env node
import { compile, stats, scanKnots, scanExternals, scanStorySemantics } from "./inklecate";
import { ExploreResult, explore, mergeMinRepro } from "./explore";
import { CompileResult } from "./inklecate";

function usage(message?: string): never {
  if (message) console.error(`inkcheck: ${message}\n`);
  console.error(`inkcheck — CI for ink stories

Usage: inkcheck <story.ink> [options]
       inkcheck mcp              Start the MCP server (stdio)

Options:
  --max-depth <n>    Max choices deep to explore (default 30)
  --max-states <n>   Max story states to visit (default 500)
  --no-min-repro     Skip the second pass that shortens repro paths
  --strict           Also fail on warnings, unvisited knots, truncation, or external stubs
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
  let minRepro = true;
  const positiveInt = (flag: string, raw: string | undefined): number => {
    if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) {
      usage(`${flag} requires a positive integer`);
    }
    return Number(raw);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--max-depth") maxDepth = positiveInt(arg, args[++i]);
    else if (arg === "--max-states") maxStates = positiveInt(arg, args[++i]);
    else if (arg === "--strict") strict = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "--markdown") asMarkdown = true;
    else if (arg === "--no-min-repro") minRepro = false;
    else if (arg.startsWith("--")) usage(`unknown option: ${arg}`);
    else if (file) usage(`unexpected extra argument: ${arg}`);
    else file = arg;
  }
  if (!file) usage("missing story file");
  if (asJson && asMarkdown) usage("--json and --markdown cannot be used together");

  const compiled = await compile(file);

  if (!compiled.success) {
    if (asJson) {
      console.log(JSON.stringify({ compile: { ...compiled, storyJson: undefined } }, null, 2));
    } else if (asMarkdown) {
      console.log(renderCompileFailureMarkdown(compiled));
    } else {
      console.log(`✗ compile failed — ${compiled.errors} error(s), ${compiled.warnings} warning(s)\n`);
      for (const i of compiled.issues) console.log(`  ${i.raw}`);
    }
    process.exit(1);
  }

  const knots = scanKnots(file);
  const externals = scanExternals(file);
  const semantics = scanStorySemantics(file);
  const st = await stats(file);
  const exploreOptions = {
    maxDepth,
    maxStates,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    randomnessDetected: semantics.usesRandomness,
  };
  let report = explore(compiled.storyJson!, knots, externals, exploreOptions);
  if (minRepro) {
    const bfs = explore(compiled.storyJson!, knots, externals, {
      maxDepth,
      maxStates,
      strategy: "bfs",
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      randomnessDetected: semantics.usesRandomness,
    });
    report = mergeMinRepro(report, bfs);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        { compile: { ...compiled, storyJson: undefined }, stats: st, explore: report },
        null,
        2
      )
    );
  } else if (asMarkdown) {
    console.log(renderMarkdown(compiled, st, report));
  } else {
    console.log(
      `✓ compiled — ${st.words ?? "?"} words, ${st.knots ?? knots.length} knots, ${st.choices ?? "?"} choices`
    );
    for (const i of compiled.issues) console.log(`  ${i.raw}`);
    console.log(
      `✓ explored ${report.statesExplored} states${report.truncated ? " (truncated at limits)" : ""} — ${report.endingsFound.length} distinct ending(s)`
    );
    for (const e of report.endingsFound.slice(0, 10)) {
      console.log(`    ending via [${e.path.join(" → ") || "linear"}]: "${e.finalText.split("\n").pop()}"`);
    }
    if (report.runtimeErrors.length) {
      console.log(`✗ ${report.runtimeErrors.length} runtime error(s):`);
      for (const e of report.runtimeErrors)
        console.log(`    ${e.message}\n      repro: [${e.path.join(" → ")}]`);
    }
    if (report.unvisitedKnots.length) {
      console.log(`⚠ ${report.unvisitedKnots.length} knot(s) never visited on any explored path:`);
      for (const k of report.unvisitedKnots)
        console.log(`    ${k.name} (${k.file}:${k.line})`);
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
  process.exit(hardFail || softFail ? 1 : 0);
}

function escapeCell(value: unknown): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderCompileFailureMarkdown(compiled: CompileResult): string {
  const lines = ["# inkcheck report", "", "❌ **Compilation failed.**", ""];
  for (const issue of compiled.issues) {
    const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}: ` : "";
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
  const lines = [
    "# inkcheck report",
    "",
    complete
      ? "✅ **Choice traversal completed within the configured limits.**"
      : "⚠️ **Results have coverage limitations; see below.**",
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
    for (const knot of report.unvisitedKnots) lines.push(`- \`${knot.name}\` (${knot.file}:${knot.line})`);
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
