#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compile, stats, scanKnots, scanExternals } from "./inklecate";
import { playtest, explore, mergeMinRepro } from "./explore";

const server = new McpServer({ name: "inkcheck", version: "0.1.0" });

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
      "Exhaustively explore an ink story's choice tree (breadth-first, bounded). Reports every distinct ending with the choice trail that reaches it, every runtime error with a reproduction path, unvisited knots (potential dead content), and loop truncation. This is automated narrative QA — use it to verify story structure after edits.",
    inputSchema: {
      file: z.string().describe("Path to the root .ink file"),
      maxDepth: z.number().int().min(1).max(200).optional()
        .describe("Max choices deep to explore (default 30)"),
      maxStates: z.number().int().min(1).max(20000).optional()
        .describe("Max story states to visit (default 500)"),
      minRepro: z.boolean().optional()
        .describe("Run a second BFS pass to shorten repro paths (default true)"),
    },
  },
  async ({ file, maxDepth, maxStates, minRepro }) => {
    const compiled = await compile(file);
    if (!compiled.success || !compiled.storyJson) {
      return err(
        "Compilation failed — fix these before exploring:\n" +
          compiled.issues.map((i) => i.raw).join("\n")
      );
    }
    const knots = scanKnots(file);
    const externals = scanExternals(file);
    let result = explore(compiled.storyJson, knots, externals, { maxDepth, maxStates });
    if (minRepro !== false) {
      const bfs = explore(compiled.storyJson, knots, externals, {
        maxDepth,
        maxStates,
        strategy: "bfs",
      });
      result = mergeMinRepro(result, bfs);
    }
    return json({ compileIssues: compiled.issues, ...result });
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
