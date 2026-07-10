#!/usr/bin/env node
import {
  CompileResult,
  StoryShapeProfile,
  compile,
  stats,
  scanKnots,
  scanExternals,
  scanInboundDiverts,
  scanShapeProfile,
  scanStorySemantics,
} from "./inklecate";
import {
  ExploreResult,
  UnvisitedKnotReport,
  classifyUnvisitedKnots,
  explore,
  explorePortfolio,
  mergeMinRepro,
} from "./explore";
import {
  buildHumanFindings,
  renderHumanFindings,
  truncationAdvice,
  unvisitedKnotHint,
} from "./human-report";
import { HumanProgressRenderer } from "./terminal-progress";

function usage(message?: string): never {
  if (message) console.error(`inkcheck: ${message}\n`);
  console.error(`inkcheck — CI for ink stories

Usage: inkcheck <story.ink> [options]
       inkcheck mcp              Start the MCP server (stdio)

Options:
  --max-depth <n>    Max choices deep to explore, 1–1000 (default 30)
  --max-states <n>   Max story states to visit, 1–1000000 (default 100000)
  --seed <n>         Seed for the random-sampling slice, 1–4294967295 (default 1)
  --profile          Print the story's shape profile and suggested settings, without exploring
  --auto             Apply the shape profile: suggested depth (unless --max-depth given) and pass weights
  --no-min-repro     Skip the small breadth-first repro-shortening slice
  --strict           Also fail on warnings, unvisited knots, truncation, or external stubs
  --human            Emit a prioritized human-readable fix list
  --json             Emit the full report as JSON
  --markdown         Emit a GitHub-friendly Markdown report
  --progress=<mode>  Write progress to stderr: auto, human, ndjson, or off (default auto in a terminal)
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
  let seed: number | undefined;
  let strict = false;
  let asJson = false;
  let asMarkdown = false;
  let asHuman = false;
  let minRepro = true;
  let profileOnly = false;
  let auto = false;
  let progressMode: "auto" | "human" | "ndjson" | "off" = process.stderr.isTTY ? "auto" : "off";
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
    else if (arg === "--max-states") maxStates = boundedInt(arg, args[++i], 1_000_000);
    else if (arg === "--seed") seed = boundedInt(arg, args[++i], 4_294_967_295);
    else if (arg === "--profile") profileOnly = true;
    else if (arg === "--auto") auto = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--human") asHuman = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "--markdown") asMarkdown = true;
    else if (arg === "--no-min-repro") minRepro = false;
    else if (arg.startsWith("--progress=")) {
      const mode = arg.slice("--progress=".length);
      if (!["auto", "human", "ndjson", "off"].includes(mode)) {
        usage("--progress must be auto, human, ndjson, or off");
      }
      if (mode === "auto" && !process.stderr.isTTY) progressMode = "off";
      else progressMode = mode as typeof progressMode;
    }
    else if (arg.startsWith("--")) usage(`unknown option: ${arg}`);
    else if (file) usage(`unexpected extra argument: ${arg}`);
    else file = arg;
  }
  if (!file) usage("missing story file");
  if ([asJson, asMarkdown, asHuman].filter(Boolean).length > 1) {
    usage("--json, --markdown, and --human cannot be used together");
  }

  if (profileOnly) {
    const profile = scanShapeProfile(file);
    if (asJson) {
      console.log(JSON.stringify({ profile }, null, 2));
    } else {
      console.log(renderProfile(file, profile, maxDepth));
    }
    return;
  }

  const profile = auto ? scanShapeProfile(file) : undefined;
  // Explicit flags always win over the profile; --auto never lowers a limit.
  const autoDepth =
    profile && maxDepth === undefined && profile.suggested.maxDepth > 30
      ? profile.suggested.maxDepth
      : undefined;
  if (autoDepth !== undefined) maxDepth = autoDepth;

  const totalMaxStates = maxStates ?? 100_000;
  const startedAt = Date.now();
  let sequence = 0;
  let statesExplored = 0;
  const selectedProgressMode = progressMode as "auto" | "human" | "ndjson" | "off";
  const humanProgress = selectedProgressMode === "auto" || selectedProgressMode === "human"
    ? new HumanProgressRenderer(process.stderr, selectedProgressMode)
    : undefined;
  const emitProgress = (
    type: "run_start" | "phase_start" | "progress" | "phase_end" | "run_end",
    details: {
      phase?: "compile" | "source_scan" | "explore" | "min_repro" | "report";
      pass?: string;
      endingsFound?: number;
      runtimeErrorsFound?: number;
      unvisitedKnots?: number;
    } = {}
  ) => {
    const event = {
        schemaVersion: 1,
        sequence: ++sequence,
        type,
        elapsedMs: Date.now() - startedAt,
        statesExplored,
        stateBudget: totalMaxStates,
        budgetFraction: Math.min(1, statesExplored / totalMaxStates),
        ...details,
      };
    if (selectedProgressMode === "ndjson") process.stderr.write(JSON.stringify(event) + "\n");
    humanProgress?.handle(event);
  };

  emitProgress("run_start");
  emitProgress("phase_start", { phase: "compile" });
  const compiled = await compile(file);
  emitProgress("phase_end", { phase: "compile" });

  if (!compiled.success) {
    emitProgress("phase_start", { phase: "report" });
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
    emitProgress("phase_end", { phase: "report" });
    emitProgress("run_end");
    process.exitCode = 1;
    return;
  }

  emitProgress("phase_start", { phase: "source_scan" });
  const knots = scanKnots(file);
  const externals = scanExternals(file);
  const semantics = scanStorySemantics(file);
  const st = await stats(file);
  emitProgress("phase_end", { phase: "source_scan" });
  const reproStates = minRepro && totalMaxStates > 1 ? Math.max(1, Math.floor(totalMaxStates * 0.1)) : 0;
  const portfolioStates = totalMaxStates - reproStates;
  const exploreOptions = {
    maxDepth,
    maxStates: Math.max(1, portfolioStates),
    seed,
    weights: profile?.suggested.weights,
    preserveTurnState: semantics.usesTurns,
    preserveRandomState: semantics.usesRandomness,
    randomnessDetected: semantics.usesRandomness,
  };
  emitProgress("phase_start", { phase: "explore" });
  let report = explorePortfolio(compiled.storyJson!, knots, externals, {
    ...exploreOptions,
    onProgress: (progress) => {
      statesExplored = progress.statesExplored;
      emitProgress("progress", {
        pass: progress.pass,
        endingsFound: progress.endingsFound,
        runtimeErrorsFound: progress.runtimeErrorsFound,
        unvisitedKnots: progress.unvisitedKnots,
      });
    },
  });
  statesExplored = report.statesExplored;
  emitProgress("phase_end", { phase: "explore" });
  if (reproStates > 0) {
    emitProgress("phase_start", { phase: "min_repro" });
    const bfs = explore(compiled.storyJson!, knots, externals, {
      maxDepth,
      maxStates: reproStates,
      strategy: "bfs",
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      randomnessDetected: semantics.usesRandomness,
      onProgress: (progress) => {
        statesExplored = report.statesExplored + progress.statesExplored;
        emitProgress("progress", {
          pass: progress.pass,
          endingsFound: progress.endingsFound,
          runtimeErrorsFound: progress.runtimeErrorsFound,
          unvisitedKnots: progress.unvisitedKnots,
        });
      },
    });
    report = mergeMinRepro(report, bfs);
    statesExplored = report.statesExplored;
    emitProgress("phase_end", { phase: "min_repro" });
  }
  classifyUnvisitedKnots(report, scanInboundDiverts(file));

  const outputReport = {
    compile: { ...compiled, storyJson: undefined },
    stats: st,
    ...(profile ? { profile } : {}),
    explore: report,
  };
  emitProgress("phase_start", { phase: "report" });
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
    if (profile) {
      const w = profile.suggested.weights;
      console.log(
        `⚙ auto: shape profile applied — depth ${maxDepth ?? 30}${autoDepth !== undefined ? " (raised from 30)" : ""}, weights dfs ${Math.round((w.last + w.first + w.insideOut) * 100)}% / beam ${Math.round(w.beam * 100)}% / random ${Math.round(w.random * 100)}%`
      );
      for (const reason of profile.suggested.rationale) console.log(`    ${reason}`);
    }
    const limitParts = [
      `depth ${report.limits.maxDepth}`,
      `${report.limits.maxStates} states`,
    ];
    if (report.limits.seed !== undefined) limitParts.push(`seed ${report.limits.seed}`);
    const coverageFlag = report.exhaustive
      ? " — exhaustive (every reachable state visited)"
      : report.truncated
        ? " — truncated"
        : "";
    console.log(
      `✓ explored ${report.statesExplored} states within limits (${limitParts.join(", ")})${coverageFlag} — ${report.endingsFound.length} distinct terminal state(s)`
    );
    for (const e of report.endingsFound.slice(0, 10)) {
      console.log(`    terminal via [${e.path.join(" → ") || "linear"}]: "${e.finalText.split("\n").pop()}"`);
    }
    if (report.runtimeErrors.length) {
      console.log(`✗ ${report.runtimeErrors.length} runtime error(s):`);
      for (const e of report.runtimeErrors)
        console.log(
          `    ${e.message}\n      repro: [${e.path.join(" → ")}]${e.foundBy ? ` (found by ${e.foundBy})` : ""}`
        );
    }
    if (report.unvisitedKnots.length) {
      console.log(
        `⚠ ${report.unvisitedKnots.length} knot(s) never visited on any explored path — unreached is not necessarily unreachable:`
      );
      for (const k of report.unvisitedKnots)
        console.log(`    ${k.name} (${humanLocation(k.file, k.line)}) — ${unvisitedKnotHint(k)}`);
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
      console.log(`⚠ coverage is partial, not a proof — ${truncationAdvice(report)}`);
    }
  }
  emitProgress("phase_end", { phase: "report" });
  emitProgress("run_end", {
    endingsFound: report.endingsFound.length,
    runtimeErrorsFound: report.runtimeErrors.length,
    unvisitedKnots: report.unvisitedKnots.length,
  });

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

function renderProfile(file: string, profile: StoryShapeProfile, userMaxDepth?: number): string {
  const w = profile.suggested.weights;
  const lines = [
    `Story shape profile for ${file} (static scan; no exploration run)`,
    "",
    `  knots: ${profile.knots} (+${profile.functions} function(s))`,
    `  variables: ${profile.variables}, assignments: ${profile.varAssignments} (${Math.round(profile.earlyAssignmentShare * 100)}% in the first third)`,
    `  choice lines: ${profile.choiceLines}`,
    `  longest divert path: ${profile.longestKnotPath} knot(s), ~${profile.choiceDepthEstimate} choice point(s)${profile.hasCycles ? " — loops present, so this is a lower bound" : ""}`,
    "",
    "Suggested settings (apply with --auto):",
    `  --max-depth ${userMaxDepth ?? profile.suggested.maxDepth}${userMaxDepth !== undefined ? " (your flag wins over the profile)" : ""}`,
    `  pass weights: dfs:last ${Math.round(w.last * 100)}% / dfs:first ${Math.round(w.first * 100)}% / dfs:inside-out ${Math.round(w.insideOut * 100)}% / beam ${Math.round(w.beam * 100)}% / random ${Math.round(w.random * 100)}%`,
    "",
    "Why:",
    ...profile.suggested.rationale.map((reason) => `  - ${reason}`),
  ];
  return lines.join("\n");
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
    `| Depth limit | ${report.limits.maxDepth} |`,
    `| State budget | ${report.limits.maxStates} |`,
    ...(report.limits.seed !== undefined ? [`| Random seed | ${report.limits.seed} |`] : []),
    `| Truncated | ${report.truncated ? "yes" : "no"} |`,
    `| Exhaustive | ${report.exhaustive ? "yes" : "no"} |`,
    `| Distinct terminal states | ${report.endingsFound.length} |`,
    `| Runtime errors | ${report.runtimeErrors.length} |`,
    `| Unvisited knots | ${report.unvisitedKnots.length} |`,
  ];
  if (report.runtimeErrors.length) {
    lines.push("", "## Runtime errors", "");
    for (const error of report.runtimeErrors) {
      lines.push(
        `- ${escapeCell(error.message)} — path: ${error.path.join(" → ") || "linear"}${error.foundBy ? ` — found by \`${error.foundBy}\`` : ""}`
      );
    }
  }
  if (report.unvisitedKnots.length) {
    lines.push("", "## Unvisited knots", "");
    lines.push("Unreached within this run is not necessarily unreachable.", "");
    for (const knot of report.unvisitedKnots)
      lines.push(`- \`${knot.name}\` (${humanLocation(knot.file, knot.line)}) — ${unvisitedKnotHint(knot)}`);
  }
  const limitations: string[] = [];
  if (report.truncated) {
    limitations.push(
      `Coverage is partial, not a proof: ${truncationAdvice(report)}.`
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
