#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compile, stats, scanKnots, scanExternals, scanInboundDiverts, scanShapeProfile, scanStorySemantics, DEFAULT_MAX_DEPTH } from "./inklecate";
import { DEFAULT_STORY_SEED, MAX_STORY_SEED, classifyUnvisitedKnots, playtest, explore, exploreWithGoals, mergeMinRepro, validateAssertionsForStory, validateGoalsForStory } from "./explore";
import { recommendNextRun } from "./advice";
import { VERSION } from "./version";
import {
  capabilities,
  DEFAULT_INSPECT_PAGE_SIZE,
  inspectProjectOverview,
  inspectProjectSection,
  MAX_INSPECT_PAGE_SIZE,
  REPORT_SCHEMA_VERSION,
} from "./discovery";
import {
  buildCompileFailureEnvelope,
  buildReportEnvelope,
  enrichCompile,
} from "./report-contract";
import { parseAssertionDefinitions } from "./assertions";
import { parseGoalDefinitions } from "./goals";
import { findDefaultProjectConfig } from "./config";
import { createResourceGuards } from "./resource-guards";
import {
  explorePortfolioConcurrent,
  explorePortfolioPilotHandoffConcurrent,
} from "./concurrent-portfolio";
import { resolvePortfolioConcurrency } from "./concurrency-policy";
import {
  DEFAULT_MACHINE_DETAIL,
  DEFAULT_MACHINE_FINDING_LIMIT,
  MAX_MACHINE_FINDING_LIMIT,
  MAX_STANDARD_MACHINE_RESPONSE_BYTES,
  projectMachineReport,
} from "./machine-output";
import {
  addCampaignAssertions,
  addSessionGoal,
  probeSessionGate,
  cancelSearchSession,
  checkSessionRegression,
  continueSearchSession,
  continueCampaign,
  DEFAULT_MCP_SESSION_WINDOW_STATES,
  inspectSearchSession,
  MAX_MCP_SESSION_TOTAL_STATES,
  MAX_MCP_SESSION_WINDOW_STATES,
  pinSessionRegression,
  openSessionFinding,
  openSessionReport,
  replaySessionWitness,
  startSearchSession,
  startCampaign,
} from "./search-sessions";

export const MCP_PROFILE = process.env.INKCHECK_MCP_PROFILE === "full" ? "full" : "compact";
const COMPACT_TOOLS = new Set(["inkcheck_capabilities", "inspect_story", "compile_story", "start_search"]);
const rawServer = new McpServer({ name: "inkcheck", version: VERSION });
const server = new Proxy(rawServer, {
  get(target, property, receiver) {
    if (property === "registerTool") {
      return (name: string, ...args: unknown[]) => {
        if (MCP_PROFILE === "full" || COMPACT_TOOLS.has(name)) {
          return (target.registerTool.bind(target) as (...values: unknown[]) => unknown)(name, ...args);
        }
        return undefined;
      };
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as McpServer;

const WORKFLOW_OPERATIONS = {
  review_contract: { required: ["file"], optional: ["assertions", "goals"] },
  inspect_search: { required: ["file", "sessionCapability"], optional: ["findingLimit", "findingCursor", "since"] },
  continue_search: { required: ["file", "sessionCapability", "revision", "maxStates"], optional: ["findingLimit", "findingCursor", "since"] },
  start_campaign: { required: ["file"], optional: ["mode", "resourcePreference", "valuePreference", "stopPolicy", "totalStates", "windowStates", "maxElapsedSeconds", "maxMemoryMb", "maxDiskMb", "deadlineAt", "longTailShare", "minLongTailProbes", "regressionReserveStates", "maxDepth", "seed", "storySeed", "maxFrontierStates", "maxFrontierMb", "findingLimit"] },
  continue_campaign: { required: ["file", "sessionCapability", "revision"], optional: ["findingLimit", "findingCursor", "since"] },
  get_finding: { required: ["file", "sessionCapability", "reportId", "findingId"], optional: [] },
  open_report: { required: ["file", "sessionCapability", "reportId"], optional: [] },
  replay_witness: { required: ["file", "sessionCapability", "revision", "findingId"], optional: [] },
  pin_regression: { required: ["file", "sessionCapability", "revision", "findingId"], optional: [] },
  check_regression: { required: ["file", "sessionCapability", "revision", "pinId"], optional: [] },
  add_goal: { required: ["file", "sessionCapability", "revision", "goal", "maxStates"], optional: [] },
  probe_gate: { required: ["file", "sessionCapability", "revision", "gate", "maxStates"], optional: [] },
  add_assertions: { required: ["file", "sessionCapability", "revision", "assertions", "maxStates"], optional: [] },
  cancel_search: { required: ["file", "sessionCapability", "revision"], optional: ["discard"] },
  playtest_story: { required: ["file", "choices"], optional: ["storySeed"] },
} as const;

async function reviewContract(request: { file: string; assertions?: unknown; goals?: unknown }) {
  const assertionIssues: string[] = [];
  const assertions = parseAssertionDefinitions(request.assertions, "assertions", assertionIssues) ?? [];
  const goalIssues: string[] = [];
  const goals = parseGoalDefinitions(request.goals, "goals", goalIssues) ?? [];
  if (assertionIssues.length || goalIssues.length) {
    throw new Error([...assertionIssues, ...goalIssues].map((issue) => `- ${issue}`).join("\n"));
  }
  if (!assertions.length && !goals.length) {
    throw new Error("review_contract requires at least one proposed assertion or goal");
  }
  const compiled = await compile(request.file);
  if (!compiled.success || !compiled.storyJson) {
    throw new Error(`Compilation failed:\n${compiled.issues.map((issue) => `- ${issue.raw}`).join("\n")}`);
  }
  const knots = scanKnots(request.file);
  const externals = scanExternals(request.file);
  validateAssertionsForStory(compiled.storyJson, knots, externals, assertions);
  validateGoalsForStory(compiled.storyJson, knots, externals, goals);
  const inspection = inspectProjectOverview(request.file);
  const existing = findDefaultProjectConfig(require("node:path").dirname(request.file))?.config;
  return {
    schemaVersion: 1,
    kind: "agent_directed_qa_contract_review",
    authorApprovalRequired: true,
    source: {
      entrypoint: inspection.entrypoint,
      variables: inspection.inventory.variables,
      gates: inspection.inventory.gates,
      knots: inspection.inventory.knots,
    },
    existingContract: {
      assertions: existing?.assertions?.length ?? 0,
      goals: existing?.goals?.length ?? 0,
    },
    proposedContract: { assertions, goals },
    recommendedRun: {
      search: "portfolio",
      goalMaxStates: 0,
      rationale: "Run broad shared QA first. A goal-only probe is optional, separately budgeted work for an explicitly approved witness; it does not replace general QA.",
    },
    nextSteps: [
      "Show the proposed contract to the author and obtain approval before writing inkcheck.yml.",
      "Run broad shared QA with the approved assertions during ordinary exploration.",
      ...(goals.length ? ["Use a separately budgeted goal probe only when the author or agent explicitly needs a witness."] : []),
      "Pin confirmed runtime findings before editing, then recheck regression pins after the fix.",
    ],
  };
}

function json(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

server.registerTool(
  "inkcheck_capabilities",
  {
    description:
      "Return Inkcheck's versioned schemas, limits, search modes, and explicit supported/unsupported feature flags. Call this before relying on optional functionality.",
    inputSchema: {},
  },
  async () => json({
    ...capabilities(),
    mcp: {
      profile: MCP_PROFILE,
      compactBootstrapTools: [...COMPACT_TOOLS, "inkcheck_workflow"],
      fullProfileEnvironment: { INKCHECK_MCP_PROFILE: "full" },
      workflowOperations: WORKFLOW_OPERATIONS,
      disclosure: MCP_PROFILE === "compact"
        ? "Compact is the default agent profile. Use inkcheck_workflow after typed discovery/compile/start_search entry calls."
        : "Full compatibility profile exposes every named tool plus inkcheck_workflow and costs more bootstrap context.",
    },
  })
);

server.registerTool(
  "pin_regression",
  {
    description:
      "Pin one confirmed runtime-error finding from the session's latest current report for deterministic post-edit rechecks. Saves a private bounded artifact with indexed choices, story seed, and hashed expected errors; endings and assertion findings are rejected in this first slice.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search"),
      revision: z.number().int().min(1).describe("Last observed session revision"),
      findingId: z.string().min(1).max(256).describe("Stable runtime finding ID returned by inspect_search.savedFindings"),
    },
  },
  async (input) => {
    try {
      return json(await pinSessionRegression(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "check_regression",
  {
    description:
      "After editing current source, replay one private runtime regression pin without spending search states. Returns fixed, still_failing, or path_changed and advances the session revision; compile failures remain explicit prerequisite errors.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to create the pin"),
      sessionCapability: z.string().describe("Opaque bearer capability for the pin's originating session"),
      revision: z.number().int().min(1).describe("Last observed session revision"),
      pinId: z.string().regex(/^regression-[0-9a-f]{24}$/).describe("Opaque regression pin ID returned by pin_regression"),
    },
  },
  async (input) => {
    try {
      return json(await checkSessionRegression(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "inspect_story",
  {
    description:
      "Inspect an Ink project from source without compiling or exploring it. Returns a bounded project map with includes, shape, semantics, externals, knots, variables, static condition gates, and the recommended next operation.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
      section: z.enum(["includes", "externals", "knots", "variables", "gates"]).optional()
        .describe("Optional inventory section for stable paged drill-down; omit for the bounded overview"),
      limit: z.number().int().min(1).max(MAX_INSPECT_PAGE_SIZE).optional()
        .describe(`Section page size (default ${DEFAULT_INSPECT_PAGE_SIZE}, max ${MAX_INSPECT_PAGE_SIZE})`),
      cursor: z.string().optional().describe("Source-bound cursor returned by an earlier page of the same section"),
    },
  },
  async ({ file, section, limit, cursor }) => {
    try {
      if (!section && (limit !== undefined || cursor !== undefined)) {
        return err("inspect_story limit/cursor requires an explicit section");
      }
      return json(section ? inspectProjectSection(file, section, { limit, cursor }) : inspectProjectOverview(file));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "compile_story",
  {
    description:
      "Compile an .ink file with inklecate and return structured issues (errors, warnings, TODOs) with file and line numbers. The authoritative syntax/structure check — run this after any edit to an .ink file.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
      detail: z.enum(["summary", "standard", "full"]).optional()
        .describe(`Response detail (default ${DEFAULT_MACHINE_DETAIL}); full returns every compile issue`),
      findingLimit: z.number().int().min(1).max(MAX_MACHINE_FINDING_LIMIT).optional()
        .describe(`Maximum compile issue summaries in standard detail (default ${DEFAULT_MACHINE_FINDING_LIMIT})`),
    },
  },
  async ({ file, detail = DEFAULT_MACHINE_DETAIL, findingLimit = DEFAULT_MACHINE_FINDING_LIMIT }) => {
    const result = await compile(file);
    const { storyJson, ...rest } = result;
    return json(projectMachineReport({
      schemaVersion: REPORT_SCHEMA_VERSION,
      inkcheckVersion: VERSION,
      bindingLimit: null,
      compile: enrichCompile(rest),
    }, detail, findingLimit));
  }
);

server.registerTool(
  "story_stats",
  {
    description:
      "Word count, knot/stitch/choice/divert counts, plus the full list of authored knots (with file and line) for an .ink story, following INCLUDEs.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
      detail: z.enum(["summary", "standard", "full"]).optional()
        .describe(`Response detail (default ${DEFAULT_MACHINE_DETAIL}); full returns the complete knot list`),
      knotLimit: z.number().int().min(1).max(MAX_MACHINE_FINDING_LIMIT).optional()
        .describe(`Maximum knots in standard detail (default ${DEFAULT_MACHINE_FINDING_LIMIT})`),
    },
  },
  async ({ file, detail = DEFAULT_MACHINE_DETAIL, knotLimit = DEFAULT_MACHINE_FINDING_LIMIT }) => {
    const [s, knots] = [await stats(file), scanKnots(file)];
    if (detail === "full") return json({ ...s, knot_list: knots, response: { detail, dataTruncated: false } });
    const returned = detail === "standard" ? knots.slice(0, knotLimit).map((knot) => ({
      ...knot,
      name: knot.name.length <= 128 ? knot.name : `${knot.name.slice(0, 125)}...`,
      file: knot.file.length <= 256 ? knot.file : `...${knot.file.slice(-253)}`,
      ...(knot.file.length > 256 ? { pathTruncated: true } : {}),
    })) : [];
    const response = {
      ...s,
      ...(detail === "standard" ? { knot_list: returned } : {}),
      response: {
        detail,
        dataTruncated: returned.length < knots.length,
        knots: { returned: returned.length, total: knots.length, omitted: knots.length - returned.length },
        drillDown: { tool: "inspect_story", section: "knots", note: "Use source-bound section pages for stable pagination." },
      },
    };
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_STANDARD_MACHINE_RESPONSE_BYTES) {
      return err(`bounded story-stats response exceeded ${MAX_STANDARD_MACHINE_RESPONSE_BYTES} bytes`);
    }
    return json(response);
  }
);

server.registerTool(
  "playtest_story",
  {
    description:
      "Compile and play one scripted path through an ink story headlessly. Provide choice indices (0-based) in order; returns the full transcript, tags, final variable state, and any runtime errors hit along the way.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
      choices: z
        .array(z.number().int().min(0))
        .describe("Choice indices to take, in order (0-based)"),
      storySeed: z.number().int().min(1).max(MAX_STORY_SEED).optional()
        .describe(`Initial Ink runtime RNG seed (default ${DEFAULT_STORY_SEED})`),
    },
  },
  async ({ file, choices, storySeed }) => {
    const compiled = await compile(file);
    if (!compiled.success || !compiled.storyJson) {
      return err(
        "Compilation failed — fix these before playtesting:\n" +
          compiled.issues.map((i) => i.raw).join("\n")
      );
    }
    return json(playtest(compiled.storyJson, choices, scanExternals(file), storySeed));
  }
);

server.registerTool(
  "explore_story",
  {
    description:
      "Systematically explore an ink story's choice tree within explicit bounds. Reports distinct terminal states with choice trails, runtime errors with reproduction paths, unvisited knots, external stubs, randomness, and truncation. This is mechanical narrative QA and never writes prose.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
      maxDepth: z.number().int().min(1).max(1000).optional()
        .describe(`Max choices deep to explore (default ${DEFAULT_MAX_DEPTH})`),
      maxStates: z.number().int().min(1).max(100000000).optional()
        .describe("Max story states to visit (default 10000000)"),
      goalMaxStates: z.number().int().min(0).max(100000000).optional()
        .describe("Additional directed-goal states; baseline maxStates is preserved (default 0)"),
      seed: z.number().int().min(0).max(4294967295).optional()
        .describe("Seed for the reproducible random-sampling slice (default 1)"),
      storySeed: z.number().int().min(1).max(MAX_STORY_SEED).optional()
        .describe(`Initial Ink runtime RNG seed, independent of the search seed (default ${DEFAULT_STORY_SEED})`),
      minRepro: z.boolean().optional()
        .describe("Reserve a small breadth-first slice to shorten repro paths (default true)"),
      search: z.enum(["portfolio", "shared", "shared-variable"]).optional()
        .describe("Search engine: portfolio (default), shared, or variable-aware shared"),
      concurrency: z.union([z.literal("auto"), z.number().int().min(1).max(16)]).optional()
        .describe("Portfolio concurrency: workload-aware auto activation (default), or a fixed worker ceiling from 1 to 16"),
      maxFrontierStates: z.number().int().min(1).max(100000000).optional()
        .describe("Shared search only: maximum pending checkpoints retained (default unlimited)"),
      maxFrontierMb: z.number().int().min(1).max(1000000).optional()
        .describe("Shared search only: maximum pending checkpoint payload in MiB (default unlimited)"),
      assertions: z.array(z.unknown()).optional()
        .describe("Safe typed assertion definitions using comparisons plus all, any, and not"),
      goals: z.array(z.unknown()).optional()
        .describe("Safe typed target conditions; goalMaxStates enables explicit additional steering work"),
      detail: z.enum(["summary", "standard", "full"]).optional()
        .describe(`Response detail (default ${DEFAULT_MACHINE_DETAIL}); full may contain story prose, choices, variables, and witnesses`),
      findingLimit: z.number().int().min(1).max(MAX_MACHINE_FINDING_LIMIT).optional()
        .describe(`Maximum privacy-minimal finding summaries in standard detail (default ${DEFAULT_MACHINE_FINDING_LIMIT})`),
    },
  },
  async ({ file, maxDepth, maxStates, goalMaxStates, seed, storySeed = DEFAULT_STORY_SEED, minRepro, search, concurrency, maxFrontierStates, maxFrontierMb, assertions: assertionInput, goals: goalInput, detail = DEFAULT_MACHINE_DETAIL, findingLimit = DEFAULT_MACHINE_FINDING_LIMIT }) => {
    const assertionIssues: string[] = [];
    const assertions = parseAssertionDefinitions(assertionInput, "assertions", assertionIssues) ?? [];
    if (assertionIssues.length) return err(`Invalid assertions:\n${assertionIssues.map((issue) => `- ${issue}`).join("\n")}`);
    const goalIssues: string[] = [];
    const goals = parseGoalDefinitions(goalInput, "goals", goalIssues) ?? [];
    if (goalIssues.length) return err(`Invalid goals:\n${goalIssues.map((issue) => `- ${issue}`).join("\n")}`);
    const baselineMaxStates = maxStates ?? 10_000_000;
    const additionalGoalStates = goalMaxStates ?? 0;
    let resolvedConcurrency: ReturnType<typeof resolvePortfolioConcurrency>;
    try {
      resolvedConcurrency = resolvePortfolioConcurrency(concurrency, search ?? "portfolio", additionalGoalStates);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
    if (additionalGoalStates > 0 && goals.length === 0) return err("goalMaxStates requires at least one goal");
    if (baselineMaxStates + additionalGoalStates > 100_000_000) {
      return err("maxStates + goalMaxStates must not exceed 100000000");
    }
    if ((maxFrontierStates !== undefined || maxFrontierMb !== undefined) && (search ?? "portfolio") === "portfolio") {
      return err("maxFrontierStates/maxFrontierMb require shared or shared-variable search");
    }
    const compiled = await compile(file);
    const { storyJson: _compiledStoryJson, ...compileReport } = compiled;
    const configuration = {
      search: search ?? "portfolio" as const,
      concurrency: resolvedConcurrency.ceiling,
      concurrencyMode: resolvedConcurrency.mode,
      ...(resolvedConcurrency.fallbackReason
        ? { concurrencyFallbackReason: resolvedConcurrency.fallbackReason }
        : {}),
      minRepro: minRepro !== false,
      strict: false,
      maxMemoryMb: null,
      maxTimeSec: null,
      maxFrontierStates: maxFrontierStates ?? null,
      maxFrontierMb: maxFrontierMb ?? null,
      goalMaxStates: additionalGoalStates,
      storySeed,
      ...(assertions.length ? { assertions } : {}),
      ...(goals.length ? { goals } : {}),
    };
    if (!compiled.success || !compiled.storyJson) {
      return {
        ...json(projectMachineReport(buildCompileFailureEnvelope(
          compileReport,
          file,
          configuration
        ), detail, findingLimit)),
        isError: true,
      };
    }
    const knots = scanKnots(file);
    const externals = scanExternals(file);
    const semantics = scanStorySemantics(file);
    try {
      validateAssertionsForStory(compiled.storyJson, knots, externals, assertions);
      validateGoalsForStory(compiled.storyJson, knots, externals, goals);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
    const totalMaxStates = baselineMaxStates;
    const reproStates = minRepro !== false && totalMaxStates > 1 ? Math.max(1, Math.floor(totalMaxStates * 0.1)) : 0;
    const portfolioStates = totalMaxStates - reproStates;
    // Stop cleanly before a V8 heap OOM (uncatchable after the fact); the
    // cap tracks any --max-old-space-size the host set.
    const { memoryCapBytes, memoryGuard } = createResourceGuards();
    const options = {
      maxDepth,
      maxStates: Math.max(1, portfolioStates),
      seed,
      storySeed,
      memoryGuard,
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      detectLoopRisks: !semantics.usesTurns && !semantics.usesRandomness && !semantics.usesVisitCounts && externals.length === 0,
      randomnessDetected: semantics.usesRandomness,
      sharedMaxPendingStates: maxFrontierStates,
      sharedMaxPendingBytes: maxFrontierMb === undefined ? undefined : maxFrontierMb * 1024 * 1024,
      assertions,
      goals,
      goalMaxStates: additionalGoalStates,
    };
    let result = resolvedConcurrency.executor === "auto-handoff"
      ? explorePortfolioPilotHandoffConcurrent(compiled.storyJson, knots, externals, {
          ...options,
          concurrency: resolvedConcurrency.ceiling,
          memoryCapBytes,
        })
      : resolvedConcurrency.executor === "fixed-concurrent"
        ? explorePortfolioConcurrent(compiled.storyJson, knots, externals, {
            ...options,
            concurrency: resolvedConcurrency.ceiling,
            memoryCapBytes,
          })
      : exploreWithGoals(compiled.storyJson, knots, externals, options, search ?? "portfolio");
    const forcedRootCycle = result.loopRisks?.some(
      (risk) => risk.firstObservedAtState === 0 && risk.repeatedAtState === 1
    );
    if (reproStates > 0 && !forcedRootCycle) {
      const bfs = explore(compiled.storyJson, knots, externals, {
        maxDepth,
        maxStates: reproStates,
        strategy: "bfs",
        storySeed,
        memoryGuard,
        preserveTurnState: semantics.usesTurns,
        preserveRandomState: semantics.usesRandomness,
        detectLoopRisks: !semantics.usesTurns && !semantics.usesRandomness && !semantics.usesVisitCounts && externals.length === 0,
        randomnessDetected: semantics.usesRandomness,
        assertions,
      });
      result = mergeMinRepro(result, bfs);
    }
    classifyUnvisitedKnots(result, scanInboundDiverts(file));
    const nextRun = recommendNextRun(result, scanShapeProfile(file));
    return json(projectMachineReport(buildReportEnvelope({
      compile: compileReport,
      explore: result,
      nextRun,
      storyJson: compiled.storyJson,
      configuration,
    }), detail, findingLimit));
  }
);

server.registerTool(
  "start_campaign",
  {
    description:
      "Start one durable source-bound campaign and execute its first exact shared-search result window. A named mode supplies bounded defaults; optional expert overrides are persisted and every decision includes an uncertainty-labelled explanation.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
      mode: z.enum(["quick", "balanced", "deep", "overnight", "campaign", "fixed"]).optional().describe("High-level latency/resource posture; defaults to balanced. Fixed requires explicit ceilings and windowStates"),
      resourcePreference: z.enum(["scarce", "balanced", "abundant"]).optional().describe("Optional resource posture override"),
      valuePreference: z.enum(["broad_qa", "runtime_assertions", "outcomes", "approved_goals"]).optional().describe("Evidence class used to interpret marginal yield. Assertions and approved goals run only through explicit additive child windows, leaving exact base resume unchanged"),
      stopPolicy: z.enum(["ceilings", "knee"]).optional().describe("Stop only at hard ceilings, or after three dry preferred-yield windows and protected long-tail obligations"),
      intent: z.enum(["scarce", "balanced", "abundant"]).optional().describe("Deprecated fixed-mode resource posture retained for compatibility"),
      totalStates: z.number().int().min(10).max(MAX_MCP_SESSION_TOTAL_STATES).optional().describe("Optional aggregate campaign state ceiling override"),
      windowStates: z.number().int().min(1).max(MAX_MCP_SESSION_WINDOW_STATES).optional().describe("Optional explicit per-window grant"),
      maxElapsedSeconds: z.number().int().min(1).max(604800).optional().describe("Optional aggregate elapsed-time ceiling override, up to seven days"),
      maxMemoryMb: z.number().int().min(1).max(1000000).optional().describe("Campaign heap ceiling; defaults to Inkcheck's safe V8 watermark"),
      maxDiskMb: z.number().int().min(1).max(1000000).optional().describe("Optional aggregate ceiling for campaign-referenced report and checkpoint artifacts"),
      deadlineAt: z.string().datetime().optional().describe("Optional absolute ISO-8601 deadline"),
      longTailShare: z.number().min(0).max(0.9).optional().describe("Protected state share for later-peak probes"),
      minLongTailProbes: z.number().int().min(0).max(1000000).optional(),
      regressionReserveStates: z.number().int().min(0).max(MAX_MCP_SESSION_TOTAL_STATES).optional(),
      maxDepth: z.number().int().min(1).max(1000).optional(),
      seed: z.number().int().min(1).max(4294967295).optional(),
      storySeed: z.number().int().min(1).max(MAX_STORY_SEED).optional(),
      maxFrontierStates: z.number().int().min(1).max(100000000).optional(),
      maxFrontierMb: z.number().int().min(1).max(1000000).optional(),
      findingLimit: z.number().int().min(1).max(100).optional(),
    },
  },
  async (input) => {
    try {
      return json(await startCampaign(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "continue_campaign",
  {
    description:
      "Execute the next policy-allocated exact campaign window. Returns compact allocation evidence, preferred-yield forecast, uncertainty, binding constraint, and report IDs for drill-down; stale revisions and changed source fail closed.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the campaign"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_campaign"),
      revision: z.number().int().min(1).describe("Last observed campaign session revision"),
      findingLimit: z.number().int().min(1).max(100).optional(),
      findingCursor: z.string().optional(),
      since: z.string().optional().describe("Optional event cursor; return only newer bounded campaign events"),
    },
  },
  async (input) => {
    try {
      return json(await continueCampaign(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "start_search",
  {
    description:
      "Start one durable exact shared-search result window. Returns an opaque bearer capability plus bounded findings and a source-bound checkpoint when work remains. This call runs synchronously until the window boundary; it does not create a background job.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
      maxStates: z.number().int().min(1).max(MAX_MCP_SESSION_WINDOW_STATES).optional()
        .describe(`Total state grant for the first window (default ${DEFAULT_MCP_SESSION_WINDOW_STATES}, max ${MAX_MCP_SESSION_WINDOW_STATES})`),
      maxDepth: z.number().int().min(1).max(1000).optional()
        .describe(`Max choices deep to explore (default ${DEFAULT_MAX_DEPTH})`),
      seed: z.number().int().min(0).max(4294967295).optional()
        .describe("Seed for the reproducible shared frontier (default 1)"),
      storySeed: z.number().int().min(1).max(MAX_STORY_SEED).optional()
        .describe(`Initial Ink runtime RNG seed (default ${DEFAULT_STORY_SEED})`),
      maxFrontierStates: z.number().int().min(1).max(100000000).optional()
        .describe("Maximum pending checkpoints retained (default unlimited)"),
      maxFrontierMb: z.number().int().min(1).max(1000000).optional()
        .describe("Maximum pending checkpoint payload in MiB (default unlimited)"),
      findingLimit: z.number().int().min(1).max(100).optional()
        .describe("Maximum privacy-minimal saved finding summaries to return (default 20)"),
    },
  },
  async (input) => {
    try {
      return json(await startSearchSession(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "inspect_search",
  {
    description:
      "Inspect a durable MCP result-window session or campaign between windows. Returns bounded session/campaign evidence and privacy-minimal saved finding summaries, never the full report or sensitive frontier payload.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search"),
      findingLimit: z.number().int().min(1).max(100).optional(),
      findingCursor: z.string().optional().describe("Cursor returned by the previous immutable saved-finding page"),
      since: z.string().optional().describe("Optional event cursor; return only newer bounded session events"),
    },
  },
  async (input) => {
    try {
      return json(await inspectSearchSession(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "open_report",
  {
    description:
      "Open one full source-bound report owned by this session or campaign. Use a report ID from campaign.decision or session provenance only when compact inspection is insufficient; report content may include authored text and witnesses.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search or start_campaign"),
      reportId: z.string().regex(/^report-[0-9a-f]{24}$/).describe("Session-owned immutable report ID"),
    },
  },
  async (input) => {
    try {
      return json(await openSessionReport(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "get_finding",
  {
    description:
      "Fetch one full finding by stable ID from a session-owned immutable report. This content-revealing drill-down avoids loading the full report when one finding is sufficient.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search or start_campaign"),
      reportId: z.string().regex(/^report-[0-9a-f]{24}$/).describe("Session-owned immutable report ID"),
      findingId: z.string().min(1).max(256).describe("Stable ID returned by savedFindings"),
    },
  },
  async (input) => {
    try {
      return json(await openSessionFinding(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "continue_search",
  {
    description:
      "Continue the exact saved frontier to a larger cumulative state grant. Each synchronous call may add at most 5M states and returns at the next durable result boundary; pass the last observed revision to reject stale concurrent mutations.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search"),
      revision: z.number().int().min(1).describe("Last revision returned by start_search, inspect_search, or continue_search"),
      maxStates: z.number().int().min(2).max(MAX_MCP_SESSION_TOTAL_STATES)
        .describe("New cumulative total grant; must increase by no more than 5000000 states"),
      findingLimit: z.number().int().min(1).max(100).optional(),
      findingCursor: z.string().optional(),
      since: z.string().optional().describe("Optional event cursor; return only newer bounded session events"),
    },
  },
  async (input) => {
    try {
      return json(await continueSearchSession(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "add_goal",
  {
    description:
      "Run one safe typed goal as an explicit additive directed probe on an existing session or approved_goals campaign. The probe starts at the story root and preserves the exact base checkpoint/report and protected base budget.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search"),
      revision: z.number().int().min(1).describe("Last observed session revision"),
      goal: z.unknown().describe("One safe typed goal definition using condition or ordered stages"),
      maxStates: z.number().int().min(1).max(MAX_MCP_SESSION_WINDOW_STATES)
        .describe("Explicit additional directed grant for this root-started probe (max 5000000)"),
    },
  },
  async (input) => {
    try {
      return json(await addSessionGoal(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "probe_gate",
  {
    description:
      "Turn one explicitly selected, statically supported source gate into an additive bounded goal probe. Select gate.file and gate.line from inspect_story section=gates. The probe starts at the root, preserves the exact base frontier, and reports source assignment sites as hints rather than reachability proof.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search"),
      revision: z.number().int().min(1).describe("Last observed session revision"),
      gate: z.object({
        file: z.string().min(1).describe("Project-relative source file reported by inspect_story section=gates"),
        line: z.number().int().min(1).describe("Source line reported by inspect_story section=gates"),
      }),
      maxStates: z.number().int().min(1).max(MAX_MCP_SESSION_WINDOW_STATES)
        .describe("Explicit additional directed grant for this root-started probe (max 5000000)"),
    },
  },
  async (input) => {
    try {
      return json(await probeSessionGate(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "add_assertions",
  {
    description:
      "Run validated safe typed assertions as one explicit additive child window on a runtime_assertions campaign. The child starts at the story root, deduplicates yield credit against earlier campaign reports, and never mutates the exact base frontier.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the campaign"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_campaign"),
      revision: z.number().int().min(1).describe("Last observed campaign revision"),
      assertions: z.array(z.unknown()).min(1).describe("Validated safe typed assertion definitions"),
      maxStates: z.number().int().min(1).max(MAX_MCP_SESSION_WINDOW_STATES)
        .describe("Explicit additional assertion-window grant (max 5000000)"),
    },
  },
  async (input) => {
    try {
      return json(await addCampaignAssertions(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "cancel_search",
  {
    description:
      "Cancel a durable MCP search or campaign between result windows. Ordinary sessions retain their exact checkpoint by default; campaigns become terminal but retain the latest report/checkpoint provenance. discard=true forgets metadata and the bearer capability.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search"),
      revision: z.number().int().min(1).describe("Last observed session revision"),
      discard: z.boolean().optional().describe("Forget session metadata/capability instead of retaining recoverability (default false)"),
    },
  },
  async (input) => {
    try {
      return json(await cancelSearchSession(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

server.registerTool(
  "replay_witness",
  {
    description:
      "Explicitly replay one stable finding from the session's latest report against current source. This execution boundary returns transcript, choice text, and variables; ordinary inspect_search responses remain privacy-minimal. Successful replay advances the session revision and records only a bounded opaque audit event.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search"),
      revision: z.number().int().min(1).describe("Last observed session revision"),
      findingId: z.string().min(1).max(256).describe("Stable finding ID returned by inspect_search.savedFindings"),
    },
  },
  async (input) => {
    try {
      return json(await replaySessionWitness(input));
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

rawServer.registerTool(
  "inkcheck_workflow",
  {
    description:
      "Run one post-discovery Inkcheck operation through the compact agent surface. Call inkcheck_capabilities first for required/optional fields, then pass the exact operation and request object.",
    inputSchema: {
      operation: z.enum([
        "review_contract",
        "inspect_search",
        "continue_search",
        "start_campaign",
        "continue_campaign",
        "get_finding",
        "open_report",
        "replay_witness",
        "pin_regression",
        "check_regression",
        "add_goal",
        "probe_gate",
        "add_assertions",
        "cancel_search",
        "playtest_story",
      ]),
      request: z.record(z.string(), z.unknown()).describe("Operation input fields listed by inkcheck_capabilities.mcp.workflowOperations"),
    },
  },
  async ({ operation, request }) => {
    try {
      const contract = WORKFLOW_OPERATIONS[operation];
      const missing = contract.required.filter((field) => request[field] === undefined);
      if (missing.length) return err(`${operation} requires: ${missing.join(", ")}`);
      switch (operation) {
        case "review_contract":
          return json(await reviewContract(request as { file: string; assertions?: unknown; goals?: unknown }));
        case "inspect_search":
          return json(await inspectSearchSession(request as unknown as Parameters<typeof inspectSearchSession>[0]));
        case "continue_search":
          return json(await continueSearchSession(request as unknown as Parameters<typeof continueSearchSession>[0]));
        case "start_campaign":
          return json(await startCampaign(request as unknown as Parameters<typeof startCampaign>[0]));
        case "continue_campaign":
          return json(await continueCampaign(request as unknown as Parameters<typeof continueCampaign>[0]));
        case "get_finding":
          return json(await openSessionFinding(request as unknown as Parameters<typeof openSessionFinding>[0]));
        case "open_report":
          return json(await openSessionReport(request as unknown as Parameters<typeof openSessionReport>[0]));
        case "replay_witness":
          return json(await replaySessionWitness(request as unknown as Parameters<typeof replaySessionWitness>[0]));
        case "pin_regression":
          return json(await pinSessionRegression(request as unknown as Parameters<typeof pinSessionRegression>[0]));
        case "check_regression":
          return json(await checkSessionRegression(request as unknown as Parameters<typeof checkSessionRegression>[0]));
        case "add_goal":
          return json(await addSessionGoal(request as unknown as Parameters<typeof addSessionGoal>[0]));
        case "probe_gate":
          return json(await probeSessionGate(request as unknown as Parameters<typeof probeSessionGate>[0]));
        case "add_assertions":
          return json(await addCampaignAssertions(request as unknown as Parameters<typeof addCampaignAssertions>[0]));
        case "cancel_search":
          return json(await cancelSearchSession(request as unknown as Parameters<typeof cancelSearchSession>[0]));
        case "playtest_story": {
          const input = request as { file: string; choices: number[]; storySeed?: number };
          const compiled = await compile(input.file);
          if (!compiled.success || !compiled.storyJson) {
            return err(
              "Compilation failed — fix these before playtesting:\n" +
              compiled.issues.map((issue) => issue.raw).join("\n")
            );
          }
          return json(playtest(compiled.storyJson, input.choices, scanExternals(input.file), input.storySeed));
        }
      }
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("inkcheck MCP server running on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
