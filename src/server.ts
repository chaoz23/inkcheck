#!/usr/bin/env node
import * as v8 from "v8";
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
      assertions: z.array(z.unknown()).optional()
        .describe("Safe typed assertion definitions using comparisons plus all, any, and not"),
      goals: z.array(z.unknown()).optional()
        .describe("Safe typed target conditions; goalMaxStates enables explicit additional steering work"),
    },
  },
  async ({ file, maxDepth, maxStates, goalMaxStates, seed, storySeed = DEFAULT_STORY_SEED, minRepro, search, assertions: assertionInput, goals: goalInput }) => {
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
    const compiled = await compile(file);
    const { storyJson: _compiledStoryJson, ...compileReport } = compiled;
    const configuration = {
      search: search ?? "portfolio" as const,
      minRepro: minRepro !== false,
      strict: false,
      maxMemoryMb: null,
      maxTimeSec: null,
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
    const memoryCapBytes = Math.floor(v8.getHeapStatistics().heap_size_limit * 0.85);
    const memoryGuard = () => process.memoryUsage().heapUsed < memoryCapBytes;
    const options = {
      maxDepth,
      maxStates: Math.max(1, portfolioStates),
      seed,
      storySeed,
      memoryGuard,
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      randomnessDetected: semantics.usesRandomness,
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

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("inkcheck MCP server running on stdio");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
