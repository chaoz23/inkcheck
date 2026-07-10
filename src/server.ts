#!/usr/bin/env node
import * as v8 from "v8";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compile, stats, scanKnots, scanExternals, scanInboundDiverts, scanShapeProfile, scanStorySemantics } from "./inklecate";
import { classifyUnvisitedKnots, playtest, explore, explorePortfolio, mergeMinRepro } from "./explore";
import { recommendNextRun } from "./advice";
import { VERSION } from "./version";

const server = new McpServer({ name: "inkcheck", version: VERSION });

function json(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

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
    return json(rest);
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
    },
  },
  async ({ file, choices }) => {
    const compiled = await compile(file);
    if (!compiled.success || !compiled.storyJson) {
      return err(
        "Compilation failed — fix these before playtesting:\n" +
          compiled.issues.map((i) => i.raw).join("\n")
      );
    }
    return json(playtest(compiled.storyJson, choices, scanExternals(file)));
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
        .describe("Max choices deep to explore (default 30)"),
      maxStates: z.number().int().min(1).max(100000000).optional()
        .describe("Max story states to visit (default 10000000)"),
      seed: z.number().int().min(0).max(4294967295).optional()
        .describe("Seed for the reproducible random-sampling slice (default 1)"),
      minRepro: z.boolean().optional()
        .describe("Reserve a small breadth-first slice to shorten repro paths (default true)"),
    },
  },
  async ({ file, maxDepth, maxStates, seed, minRepro }) => {
    const compiled = await compile(file);
    if (!compiled.success || !compiled.storyJson) {
      return err(
        "Compilation failed — fix these before exploring:\n" +
          compiled.issues.map((i) => i.raw).join("\n")
      );
    }
    const knots = scanKnots(file);
    const externals = scanExternals(file);
    const semantics = scanStorySemantics(file);
    const totalMaxStates = maxStates ?? 10_000_000;
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
      memoryGuard,
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      randomnessDetected: semantics.usesRandomness,
    };
    let result = explorePortfolio(compiled.storyJson, knots, externals, options);
    if (reproStates > 0) {
      const bfs = explore(compiled.storyJson, knots, externals, {
        maxDepth,
        maxStates: reproStates,
        strategy: "bfs",
        memoryGuard,
        preserveTurnState: semantics.usesTurns,
        preserveRandomState: semantics.usesRandomness,
        randomnessDetected: semantics.usesRandomness,
      });
      result = mergeMinRepro(result, bfs);
    }
    classifyUnvisitedKnots(result, scanInboundDiverts(file));
    const nextRun = recommendNextRun(result, scanShapeProfile(file));
    return json({ compileIssues: compiled.issues, ...result, nextRun });
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
