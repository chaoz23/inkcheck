#!/usr/bin/env node
import * as v8 from "v8";
import {
  CompileResult,
  DEFAULT_MAX_DEPTH,
  KnotInfo,
  StoryShapeProfile,
  StorySemantics,
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
  PortfolioWeights,
  UnvisitedKnotReport,
  classifyUnvisitedKnots,
  explore,
  exploreWithGoals,
  mergeMinRepro,
  validateAssertionsForStory,
  validateGoalsForStory,
} from "./explore";
import { NextRunAdvice, recommendNextRun } from "./advice";
import {
  buildHumanFindings,
  renderHumanFindings,
  truncationAdvice,
  unvisitedKnotHint,
} from "./human-report";
import { HumanProgressRenderer } from "./terminal-progress";
import {
  buildCompileFailureEnvelope,
  buildReportEnvelope,
  EffectiveReportConfiguration,
} from "./report-contract";
import {
  capabilities,
  inspectProject,
  renderCapabilitiesHuman,
  renderInspectionHuman,
} from "./discovery";
import { findDefaultProjectConfig, loadProjectConfig } from "./config";
import { createAgentKit, initProject, renderScaffoldResult } from "./scaffold";

function usage(message?: string): never {
  if (message) console.error(`inkcheck: ${message}\n`);
  console.error(`inkcheck — CI for ink stories

Usage: inkcheck <story.ink> [options]
       inkcheck capabilities [--json]
       inkcheck inspect <story.ink> [--json]
       inkcheck validate-config [inkcheck.yml] [--json]
       inkcheck init [directory] [--entrypoint story.ink] [--json]
       inkcheck agent-kit --format codex [directory] [--entrypoint story.ink] [--json]
       inkcheck mcp              Start the MCP server (stdio)

Options:
  --max-depth <n>    Max choices deep to explore, 1–1000 (default 100)
  --max-states <n>   Max story states to visit, 1–100000000 (default 10000000)
  --goal-states <n>  Additional directed-goal states, 1–100000000 (default 0)
  --seed <n>         Seed for the random-sampling slice, 1–4294967295 (default 1)
  --search <mode>    Search: portfolio (default), shared, or shared-variable
  --max-memory <mb>  Stop cleanly before heap use exceeds <mb> (default: 85% of the V8 heap limit)
  --max-time <s>     Stop cleanly after <s> seconds and return a partial report (default: no time limit)
  --profile          Print the story's shape profile and suggested settings, without exploring
  --auto             Apply the shape profile: suggested depth (unless --max-depth given) and pass weights
  --next             After the check, apply the recommended escalation automatically (up to 3 reruns)
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
  if (args[0] === "capabilities") {
    if (args.some((arg, index) => index > 0 && arg !== "--json")) {
      usage("capabilities accepts only --json");
    }
    const value = capabilities();
    console.log(args.includes("--json") ? JSON.stringify(value, null, 2) : renderCapabilitiesHuman(value));
    return;
  }
  if (args[0] === "validate-config") {
    const values = args.slice(1).filter((arg) => arg !== "--json");
    if (values.length > 1 || args.slice(1).some((arg) => arg.startsWith("--") && arg !== "--json")) {
      usage("validate-config accepts an optional config path and --json only");
    }
    try {
      const loaded = loadProjectConfig(values[0]);
      const result = {
        valid: true,
        schemaVersion: loaded.config.schemaVersion,
        configFile: loaded.path,
        entrypoint: loaded.entrypoint,
        config: loaded.config,
      };
      console.log(
        args.includes("--json")
          ? JSON.stringify(result, null, 2)
          : `Valid Inkcheck config v${result.schemaVersion}: ${result.configFile}\nEntrypoint: ${result.entrypoint}`
      );
      return;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }
  if (args[0] === "init" || args[0] === "agent-kit") {
    const command = args.shift() as "init" | "agent-kit";
    let directory = ".";
    let directorySpecified = false;
    let entrypoint: string | undefined;
    let format: string | undefined;
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--json") json = true;
      else if (arg === "--entrypoint") entrypoint = args[++index];
      else if (arg === "--format") format = args[++index];
      else if (arg.startsWith("--")) usage(`${command}: unknown option: ${arg}`);
      else if (directorySpecified) usage(`${command}: unexpected extra argument: ${arg}`);
      else {
        directory = arg;
        directorySpecified = true;
      }
    }
    if (entrypoint === undefined && args.includes("--entrypoint")) usage(`${command}: --entrypoint requires a path`);
    if (command === "agent-kit" && format !== "codex") usage("agent-kit requires --format codex");
    if (command === "init" && format !== undefined) usage("init does not accept --format");
    try {
      const result = command === "init"
        ? initProject(directory, entrypoint)
        : createAgentKit(directory, format, entrypoint);
      console.log(json ? JSON.stringify(result, null, 2) : renderScaffoldResult(result));
      return;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }
  const inspectMode = args[0] === "inspect";
  if (inspectMode) args.shift();
  let file: string | undefined;
  let maxDepth: number | undefined;
  let maxStates: number | undefined;
  let goalMaxStates: number | undefined;
  let seed: number | undefined;
  let search: "portfolio" | "shared" | "shared-variable" = "portfolio";
  let strict = false;
  let asJson = false;
  let asMarkdown = false;
  let asHuman = false;
  let minRepro = true;
  let minReproSpecified = false;
  let profileOnly = false;
  let auto = false;
  let followNext = false;
  let progressMode: "auto" | "human" | "ndjson" | "off" = process.stderr.isTTY ? "auto" : "off";
  let progressSpecified = false;
  let searchSpecified = false;
  let maxMemoryMb: number | undefined;
  let maxTimeSec: number | undefined;
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
    else if (arg === "--max-states") maxStates = boundedInt(arg, args[++i], 100_000_000);
    else if (arg === "--goal-states") goalMaxStates = boundedInt(arg, args[++i], 100_000_000);
    else if (arg === "--seed") seed = boundedInt(arg, args[++i], 4_294_967_295);
    else if (arg === "--search" || arg.startsWith("--search=")) {
      searchSpecified = true;
      const mode = arg === "--search" ? args[++i] : arg.slice("--search=".length);
      if (mode !== "portfolio" && mode !== "shared" && mode !== "shared-variable") {
        usage("--search must be portfolio, shared, or shared-variable");
      }
      search = mode;
    }
    else if (arg === "--max-memory") maxMemoryMb = boundedInt(arg, args[++i], 1_000_000);
    else if (arg === "--max-time") maxTimeSec = boundedInt(arg, args[++i], 86_400);
    else if (arg === "--profile") profileOnly = true;
    else if (arg === "--auto") auto = true;
    else if (arg === "--next") followNext = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--human") asHuman = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "--markdown") asMarkdown = true;
    else if (arg === "--no-min-repro") {
      minRepro = false;
      minReproSpecified = true;
    }
    else if (arg.startsWith("--progress=")) {
      progressSpecified = true;
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
  let projectConfig;
  try {
    projectConfig = findDefaultProjectConfig();
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  if (!file) file = projectConfig?.entrypoint;
  if (!file) usage("missing story file (or inkcheck.yml entrypoint)");
  if ([asJson, asMarkdown, asHuman].filter(Boolean).length > 1) {
    usage("--json, --markdown, and --human cannot be used together");
  }

  if (inspectMode) {
    if (asMarkdown || asHuman || profileOnly || auto || followNext || strict || !minRepro ||
        maxDepth !== undefined || maxStates !== undefined || goalMaxStates !== undefined || seed !== undefined ||
        maxMemoryMb !== undefined || maxTimeSec !== undefined || search !== "portfolio" ||
        progressSpecified) {
      usage("inspect accepts a story path and optional --json only");
    }
    try {
      const value = inspectProject(file);
      console.log(asJson ? JSON.stringify(value, null, 2) : renderInspectionHuman(value));
      return;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }

  const configDefaults = projectConfig?.config.ci;
  maxDepth ??= configDefaults?.maxDepth;
  maxStates ??= configDefaults?.maxStates;
  goalMaxStates ??= configDefaults?.goalMaxStates;
  seed ??= configDefaults?.seed;
  maxMemoryMb ??= configDefaults?.maxMemoryMb;
  maxTimeSec ??= configDefaults?.maxTimeSec;
  if (!searchSpecified && configDefaults?.search) search = configDefaults.search;
  if (!strict && configDefaults?.strict) strict = true;
  if (!minReproSpecified && configDefaults?.minRepro !== undefined) minRepro = configDefaults.minRepro;

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
    profile && maxDepth === undefined && profile.suggested.maxDepth > DEFAULT_MAX_DEPTH
      ? profile.suggested.maxDepth
      : undefined;
  if (autoDepth !== undefined) maxDepth = autoDepth;

  const baselineMaxStates = maxStates ?? 10_000_000;
  const additionalGoalStates = goalMaxStates ?? 0;
  if (baselineMaxStates + additionalGoalStates > 100_000_000) {
    usage("--max-states + --goal-states must not exceed 100000000");
  }
  const totalMaxStates = baselineMaxStates + additionalGoalStates;
  const reportConfiguration: EffectiveReportConfiguration = {
    search,
    minRepro,
    strict,
    maxMemoryMb: maxMemoryMb ?? null,
    maxTimeSec: maxTimeSec ?? null,
    goalMaxStates: additionalGoalStates,
    ...(projectConfig?.config.assertions?.length ? { assertions: projectConfig.config.assertions } : {}),
    ...(projectConfig?.config.goals?.length ? { goals: projectConfig.config.goals } : {}),
  };
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
      visibleOutcomes?: number;
      assertionViolations?: number;
      goalsReached?: number;
      stagesReached?: number;
    } = {}
  ) => {
    const event = {
        schemaVersion: 1,
        sequence: ++sequence,
        type,
        elapsedMs: Date.now() - startedAt,
        statesExplored,
        stateBudget: totalMaxStates,
        baselineStateBudget: baselineMaxStates,
        goalStateBudget: additionalGoalStates,
        budgetFraction: Math.min(1, statesExplored / totalMaxStates),
        ...details,
      };
    if (selectedProgressMode === "ndjson") process.stderr.write(JSON.stringify(event) + "\n");
    humanProgress?.handle(event);
  };

  emitProgress("run_start");
  emitProgress("phase_start", { phase: "compile" });
  const compiled = await compile(file);
  const { storyJson: _compiledStoryJson, ...compileReport } = compiled;
  emitProgress("phase_end", { phase: "compile" });

  if (!compiled.success) {
    emitProgress("phase_start", { phase: "report" });
    if (asJson) {
      console.log(
        JSON.stringify(
          buildCompileFailureEnvelope(
            compileReport,
            file,
            reportConfiguration
          ),
          null,
          2
        )
      );
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
  const inboundDiverts = scanInboundDiverts(file);
  const configuredAssertions = projectConfig?.config.assertions ?? [];
  const configuredGoals = projectConfig?.config.goals ?? [];
  if (additionalGoalStates > 0 && configuredGoals.length === 0) {
    usage("--goal-states requires at least one configured goal");
  }
  try {
    validateAssertionsForStory(compiled.storyJson!, knots, externals, configuredAssertions);
    validateGoalsForStory(compiled.storyJson!, knots, externals, configuredGoals);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  // The recommender uses the shape profile for a better deepen target even
  // when --auto was not requested; the scan is cheap and deterministic.
  const adviceProfile = profile ?? scanShapeProfile(file);
  emitProgress("phase_end", { phase: "source_scan" });

  // Memory guard: a V8 heap OOM cannot be caught after the fact, so stop
  // cleanly before it. The cap is an explicit --max-memory, or 85% of the
  // V8 old-space limit (which honors any --max-old-space-size the user set).
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const memoryCapBytes = maxMemoryMb !== undefined
    ? maxMemoryMb * 1024 * 1024
    : Math.floor(heapLimit * 0.85);
  const memoryGuard = () => process.memoryUsage().heapUsed < memoryCapBytes;

  // Time guard: stop cleanly at a wall-clock deadline and hand back a partial
  // report, rather than being killed mid-run. No deadline unless --max-time.
  const deadline = maxTimeSec !== undefined ? Date.now() + maxTimeSec * 1000 : undefined;
  const timeGuard = deadline !== undefined ? () => Date.now() < deadline : undefined;

  const runCheck = (bounds: { maxDepth?: number; maxStates?: number; seed?: number }): ExploreResult => {
    const runStates = bounds.maxStates ?? 10_000_000;
    if (runStates + additionalGoalStates > 100_000_000) {
      usage("baseline maxStates + goalMaxStates must not exceed 100000000");
    }
    const reproStates = minRepro && runStates > 1 ? Math.max(1, Math.floor(runStates * 0.1)) : 0;
    const portfolioStates = runStates - reproStates;
    // Progress accumulates across --next escalations, so offset by the
    // states already spent in earlier runs.
    const statesBase = statesExplored;
    emitProgress("phase_start", { phase: "explore" });
    let checked = exploreWithGoals(compiled.storyJson!, knots, externals, {
      maxDepth: bounds.maxDepth,
      maxStates: Math.max(1, portfolioStates),
      seed: bounds.seed,
      weights: profile?.suggested.weights,
      memoryGuard,
      timeGuard,
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      randomnessDetected: semantics.usesRandomness,
      assertions: configuredAssertions,
      goals: configuredGoals,
      goalMaxStates: additionalGoalStates,
      onProgress: (progress) => {
        statesExplored = statesBase + progress.statesExplored;
        emitProgress("progress", {
          pass: progress.pass,
          endingsFound: progress.endingsFound,
          runtimeErrorsFound: progress.runtimeErrorsFound,
          unvisitedKnots: progress.unvisitedKnots,
          visibleOutcomes: progress.visibleOutcomes,
          assertionViolations: progress.assertionViolations,
          goalsReached: progress.goalsReached,
          stagesReached: progress.stagesReached,
        });
      },
    }, search);
    statesExplored = statesBase + checked.statesExplored;
    emitProgress("phase_end", { phase: "explore" });
    if (reproStates > 0) {
      emitProgress("phase_start", { phase: "min_repro" });
      const bfs = explore(compiled.storyJson!, knots, externals, {
        maxDepth: bounds.maxDepth,
        maxStates: reproStates,
        strategy: "bfs",
        memoryGuard,
      timeGuard,
        preserveTurnState: semantics.usesTurns,
        preserveRandomState: semantics.usesRandomness,
        randomnessDetected: semantics.usesRandomness,
        assertions: configuredAssertions,
      });
      checked = mergeMinRepro(checked, bfs);
      statesExplored = statesBase + checked.statesExplored;
      emitProgress("phase_end", { phase: "min_repro" });
    }
    return classifyUnvisitedKnots(checked, inboundDiverts);
  };

  let report = runCheck({ maxDepth, maxStates, seed });
  let advice = recommendNextRun(report, adviceProfile);
  const runs: {
    run: number;
    flags: NextRunAdvice["flags"];
    statesExplored: number;
    endings: number;
    runtimeErrors: number;
    visitedKnots: number;
    recommendation: string;
  }[] = [];
  const summarize = (run: number, flags: NextRunAdvice["flags"], checked: ExploreResult) => ({
    run,
    flags,
    statesExplored: checked.statesExplored,
    endings: checked.endingsFound.length,
    runtimeErrors: checked.runtimeErrors.length,
    visitedKnots: checked.visitedKnots.length,
    recommendation: advice.recommendation,
  });
  runs.push(summarize(1, { ...report.limits }, report));
  if (followNext) {
    // Escalation loop: apply the recommendation, rerun, stop on a stop/
    // investigate verdict, a fixpoint, or after three escalations.
    while (!advice.stop && runs.length <= 3) {
      const previous = report;
      const flags = {
        ...advice.flags,
        maxStates: Math.min(advice.flags.maxStates, 100_000_000 - additionalGoalStates),
      };
      console.error(
        `↻ ${advice.recommendation}: rerunning with --max-depth ${flags.maxDepth} --max-states ${flags.maxStates}${flags.seed !== undefined ? ` --seed ${flags.seed}` : ""}`
      );
      report = runCheck(flags);
      advice = recommendNextRun(report, adviceProfile);
      const unchanged =
        report.endingsFound.length === previous.endingsFound.length &&
        report.runtimeErrors.length === previous.runtimeErrors.length &&
        report.visitedKnots.length === previous.visitedKnots.length;
      if (unchanged && !report.exhaustive) {
        advice = {
          ...advice,
          recommendation: "stop",
          stop: true,
          rationale: `fixpoint: the escalated run found no new endings, runtime errors, or knots compared with the previous run. Previously: ${advice.rationale}`,
          expectedGain: "none — consecutive runs at increased limits changed nothing",
        };
      }
      runs.push(summarize(runs.length + 1, flags, report));
    }
  }

  const outputReport = buildReportEnvelope({
    compile: compileReport,
    stats: st,
    ...(profile ? { profile } : {}),
    explore: report,
    nextRun: advice,
    ...(followNext ? { runs } : {}),
    storyJson: compiled.storyJson!,
    configuration: reportConfiguration,
  });
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
    console.log(renderMarkdown(compiled, st, report, advice));
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
        `⚙ auto: shape profile applied — depth ${maxDepth ?? DEFAULT_MAX_DEPTH}${autoDepth !== undefined ? ` (raised from ${DEFAULT_MAX_DEPTH})` : ""}, weights dfs ${Math.round((w.last + w.first + w.insideOut) * 100)}% / beam ${Math.round(w.beam * 100)}% / random ${Math.round(w.random * 100)}%`
      );
      for (const reason of profile.suggested.rationale) console.log(`    ${reason}`);
    }
    const limitParts = [
      `depth ${report.limits.maxDepth}`,
      `${report.limits.maxStates} baseline states`,
    ];
    if (report.limits.goalMaxStates) limitParts.push(`${report.limits.goalMaxStates} additional goal states`);
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
    const violatedAssertions = report.assertionResults.filter((result) => result.status === "violated");
    if (violatedAssertions.length) {
      console.log(`✗ ${violatedAssertions.length} story assertion(s) violated:`);
      for (const result of violatedAssertions) {
        const violation = result.violations[0];
        console.log(
          `    ${result.id}${result.description ? ` — ${result.description}` : ""}\n      observed: ${JSON.stringify(violation.observedValues)}\n      repro: [${violation.path.join(" → ") || "linear"}]`
        );
      }
    }
    if (report.goalResults?.length) {
      console.log(`◎ ${report.goalResults.filter((goal) => goal.status === "reached").length}/${report.goalResults.length} search goal(s) reached:`);
      for (const goal of report.goalResults) {
        console.log(
          `    ${goal.id}: ${goal.status}${goal.witness ? `\n      repro: [${goal.witness.path.join(" → ") || "linear"}]` : goal.closestObserved ? `\n      closest observed: ${JSON.stringify(goal.closestObserved.observedValues)}` : ""}`
        );
        for (const stage of goal.stages ?? []) {
          console.log(`      ${stage.id}: ${stage.status}${stage.blockedBy ? ` (blocked by ${stage.blockedBy})` : stage.witness ? ` — [${stage.witness.path.join(" → ") || "linear"}]` : ""}`);
        }
      }
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
    if (report.truncatedBy.memory) {
      console.log(
        `⚠ stopped early at ${report.statesExplored} states to stay under the memory guard (${Math.round(memoryCapBytes / 1048576)} MB) — the results above are partial but complete as far as they go`
      );
    } else if (report.truncatedBy.time) {
      console.log(
        `⚠ stopped early at ${report.statesExplored} states after the ${maxTimeSec}s time budget — the results above are partial but complete as far as they go`
      );
    } else if (report.truncated) {
      console.log(`⚠ coverage is partial, not a proof — ${truncationAdvice(report)}`);
    }
    if (advice.recommendation === "deepen" || advice.recommendation === "broaden" || advice.recommendation === "reseed") {
      console.log(
        `→ next run (${advice.recommendation}): --max-depth ${advice.flags.maxDepth} --max-states ${advice.flags.maxStates}${advice.flags.seed !== undefined ? ` --seed ${advice.flags.seed}` : ""} — ${advice.expectedGain}`
      );
    } else if (advice.recommendation === "investigate") {
      console.log(`→ next: investigate — ${advice.rationale}`);
    }
  }
  emitProgress("phase_end", { phase: "report" });
  emitProgress("run_end", {
    endingsFound: report.endingsFound.length,
    runtimeErrorsFound: report.runtimeErrors.length,
    unvisitedKnots: report.unvisitedKnots.length,
  });

  const assertionFail = report.assertionResults.some((result) => result.status === "violated");
  const hardFail = report.runtimeErrors.length > 0 || assertionFail;
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
  report: ExploreResult,
  advice?: NextRunAdvice
): string {
  const complete =
    !report.truncated && report.externalFunctionsStubbed.length === 0 && !report.randomnessDetected;
  const assertionViolations = report.assertionResults.filter((result) => result.status === "violated");
  const status = report.runtimeErrors.length && assertionViolations.length
    ? "❌ **Runtime and story-rule failures found.**"
    : report.runtimeErrors.length
      ? "❌ **Runtime failures found.**"
      : assertionViolations.length
        ? "❌ **Story assertion failures found.**"
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
    `| Baseline state budget | ${report.limits.maxStates} |`,
    ...(report.limits.goalMaxStates ? [
      `| Additional goal state budget | ${report.limits.goalMaxStates} |`,
      `| Total state budget | ${report.limits.totalMaxStates ?? report.limits.maxStates + report.limits.goalMaxStates} |`,
    ] : []),
    ...(report.limits.seed !== undefined ? [`| Random seed | ${report.limits.seed} |`] : []),
    `| Truncated | ${report.truncated ? "yes" : "no"} |`,
    `| Exhaustive | ${report.exhaustive ? "yes" : "no"} |`,
    `| Distinct terminal states | ${report.endingsFound.length} |`,
    `| Runtime errors | ${report.runtimeErrors.length} |`,
    `| Assertion violations | ${assertionViolations.length} |`,
    ...(report.goalResults?.length ? [`| Search goals reached | ${report.goalResults.filter((goal) => goal.status === "reached").length}/${report.goalResults.length} |`] : []),
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
  if (assertionViolations.length) {
    lines.push("", "## Story assertion violations", "");
    for (const result of assertionViolations) {
      const violation = result.violations[0];
      lines.push(
        `- \`${result.id}\`${result.description ? ` — ${escapeCell(result.description)}` : ""}; observed \`${escapeCell(JSON.stringify(violation.observedValues))}\`; path: ${violation.path.join(" → ") || "linear"}`
      );
    }
  }
  if (report.goalResults?.length) {
    lines.push("", "## Search goals", "");
    for (const goal of report.goalResults) {
      lines.push(`- \`${goal.id}\`: **${goal.status}**${goal.witness ? ` — path: ${goal.witness.path.join(" → ") || "linear"}` : goal.closestObserved ? ` — closest observed: \`${escapeCell(JSON.stringify(goal.closestObserved.observedValues))}\`` : ""}`);
      for (const stage of goal.stages ?? []) {
        lines.push(`  - \`${stage.id}\`: **${stage.status}**${stage.blockedBy ? ` — blocked by \`${stage.blockedBy}\`` : stage.witness ? ` — path: ${stage.witness.path.join(" → ") || "linear"}` : ""}`);
      }
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
  if (advice && advice.recommendation !== "stop") {
    limitations.push(
      advice.recommendation === "investigate"
        ? `Suggested next step: investigate — ${advice.rationale}`
        : `Suggested next run (${advice.recommendation}): \`--max-depth ${advice.flags.maxDepth} --max-states ${advice.flags.maxStates}${advice.flags.seed !== undefined ? ` --seed ${advice.flags.seed}` : ""}\` — ${advice.expectedGain}.`
    );
  }
  if (limitations.length) lines.push("", "## Coverage limitations", "", ...limitations.map((x) => `- ${x}`));
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
