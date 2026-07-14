#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compile, stats, scanKnots, scanExternals, scanInboundDiverts, scanShapeProfile, scanStorySemantics, DEFAULT_MAX_DEPTH } from "./inklecate";
import { DEFAULT_STORY_SEED, MAX_STORY_SEED, classifyUnvisitedKnots, playtest, explore, exploreWithGoals, mergeMinRepro, validateAssertionsForStory, validateGoalsForStory } from "./explore";
import { recommendNextRun } from "./advice";
import { VERSION } from "./version";
import { capabilities, inspectProject, REPORT_SCHEMA_VERSION } from "./discovery";
import {
  buildCompileFailureEnvelope,
  buildReportEnvelope,
  enrichCompile,
} from "./report-contract";
import { parseAssertionDefinitions } from "./assertions";
import { parseGoalDefinitions } from "./goals";
import { createResourceGuards } from "./resource-guards";
import {
  cancelSearchSession,
  checkSessionRegression,
  continueSearchSession,
  DEFAULT_MCP_SESSION_WINDOW_STATES,
  inspectSearchSession,
  MAX_MCP_SESSION_TOTAL_STATES,
  MAX_MCP_SESSION_WINDOW_STATES,
  pinSessionRegression,
  replaySessionWitness,
  startSearchSession,
} from "./search-sessions";

const server = new McpServer({ name: "inkcheck", version: VERSION });

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
  async () => json(capabilities())
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
      "Inspect an Ink project from source without compiling or exploring it. Returns a bounded project map with includes, shape, semantics, externals, knots, variables, and the recommended next operation.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
    },
  },
  async ({ file }) => {
    try {
      return json(inspectProject(file));
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
    },
  },
  async ({ file }) => {
    const result = await compile(file);
    const { storyJson, ...rest } = result;
    return json({
      schemaVersion: REPORT_SCHEMA_VERSION,
      inkcheckVersion: VERSION,
      compile: enrichCompile(rest),
    });
  }
);

server.registerTool(
  "story_stats",
  {
    description:
      "Word count, knot/stitch/choice/divert counts, plus the full list of authored knots (with file and line) for an .ink story, following INCLUDEs.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
    },
  },
  async ({ file }) => {
    const [s, knots] = [await stats(file), scanKnots(file)];
    return json({ ...s, knot_list: knots });
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
      maxFrontierStates: z.number().int().min(1).max(100000000).optional()
        .describe("Shared search only: maximum pending checkpoints retained (default unlimited)"),
      maxFrontierMb: z.number().int().min(1).max(1000000).optional()
        .describe("Shared search only: maximum pending checkpoint payload in MiB (default unlimited)"),
      assertions: z.array(z.unknown()).optional()
        .describe("Safe typed assertion definitions using comparisons plus all, any, and not"),
      goals: z.array(z.unknown()).optional()
        .describe("Safe typed target conditions; goalMaxStates enables explicit additional steering work"),
    },
  },
  async ({ file, maxDepth, maxStates, goalMaxStates, seed, storySeed = DEFAULT_STORY_SEED, minRepro, search, maxFrontierStates, maxFrontierMb, assertions: assertionInput, goals: goalInput }) => {
    const assertionIssues: string[] = [];
    const assertions = parseAssertionDefinitions(assertionInput, "assertions", assertionIssues) ?? [];
    if (assertionIssues.length) return err(`Invalid assertions:\n${assertionIssues.map((issue) => `- ${issue}`).join("\n")}`);
    const goalIssues: string[] = [];
    const goals = parseGoalDefinitions(goalInput, "goals", goalIssues) ?? [];
    if (goalIssues.length) return err(`Invalid goals:\n${goalIssues.map((issue) => `- ${issue}`).join("\n")}`);
    const baselineMaxStates = maxStates ?? 10_000_000;
    const additionalGoalStates = goalMaxStates ?? 0;
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
        ...json(buildCompileFailureEnvelope(
          compileReport,
          file,
          configuration
        )),
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
    const { memoryGuard } = createResourceGuards();
    const options = {
      maxDepth,
      maxStates: Math.max(1, portfolioStates),
      seed,
      storySeed,
      memoryGuard,
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      randomnessDetected: semantics.usesRandomness,
      sharedMaxPendingStates: maxFrontierStates,
      sharedMaxPendingBytes: maxFrontierMb === undefined ? undefined : maxFrontierMb * 1024 * 1024,
      assertions,
      goals,
      goalMaxStates: additionalGoalStates,
    };
    let result = exploreWithGoals(compiled.storyJson, knots, externals, options, search ?? "portfolio");
    if (reproStates > 0) {
      const bfs = explore(compiled.storyJson, knots, externals, {
        maxDepth,
        maxStates: reproStates,
        strategy: "bfs",
        storySeed,
        memoryGuard,
        preserveTurnState: semantics.usesTurns,
        preserveRandomState: semantics.usesRandomness,
        randomnessDetected: semantics.usesRandomness,
        assertions,
      });
      result = mergeMinRepro(result, bfs);
    }
    classifyUnvisitedKnots(result, scanInboundDiverts(file));
    const nextRun = recommendNextRun(result, scanShapeProfile(file));
    return json(buildReportEnvelope({
      compile: compileReport,
      explore: result,
      nextRun,
      storyJson: compiled.storyJson,
      configuration,
    }));
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
      "Inspect a durable MCP result-window session between windows. Returns bounded session evidence and privacy-minimal saved finding summaries, never the full report or sensitive frontier payload.",
    inputSchema: {
      file: z.string().describe("The same root .ink file used to start the session"),
      sessionCapability: z.string().describe("Opaque bearer capability returned by start_search"),
      findingLimit: z.number().int().min(1).max(100).optional(),
      findingCursor: z.string().optional().describe("Cursor returned by the previous immutable saved-finding page"),
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
  "cancel_search",
  {
    description:
      "Cancel a durable MCP search between result windows. By default the exact checkpoint is retained and can be continued later; discard=true forgets the session metadata and bearer capability. This cannot interrupt a start_search or continue_search call already running.",
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

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("inkcheck MCP server running on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
