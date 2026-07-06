#!/usr/bin/env node
import { compile, stats, scanKnots, scanExternals } from "./inklecate";
import { explore, mergeMinRepro } from "./explore";

function usage(): never {
  console.log(`inkcheck — CI for ink stories

Usage: inkcheck <story.ink> [options]
       inkcheck mcp              Start the MCP server (stdio)

Options:
  --max-depth <n>    Max choices deep to explore (default 30)
  --max-states <n>   Max story states to visit (default 500)
  --no-min-repro     Skip the second pass that shortens repro paths
  --strict           Treat warnings and unvisited knots as failures
  --json             Emit the full report as JSON
`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "mcp") {
    require("./server");
    return;
  }
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) usage();
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const maxDepth = flag("--max-depth") ? parseInt(flag("--max-depth")!, 10) : undefined;
  const maxStates = flag("--max-states") ? parseInt(flag("--max-states")!, 10) : undefined;
  const strict = args.includes("--strict");
  const asJson = args.includes("--json");

  const compiled = await compile(file);

  if (!compiled.success) {
    if (asJson) {
      console.log(JSON.stringify({ compile: { ...compiled, storyJson: undefined } }, null, 2));
    } else {
      console.log(`✗ compile failed — ${compiled.errors} error(s), ${compiled.warnings} warning(s)\n`);
      for (const i of compiled.issues) console.log(`  ${i.raw}`);
    }
    process.exit(1);
  }

  const knots = scanKnots(file);
  const externals = scanExternals(file);
  const st = await stats(file);
  let report = explore(compiled.storyJson!, knots, externals, { maxDepth, maxStates });
  if (!args.includes("--no-min-repro")) {
    const bfs = explore(compiled.storyJson!, knots, externals, {
      maxDepth,
      maxStates,
      strategy: "bfs",
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
  }

  const hardFail = report.runtimeErrors.length > 0;
  const softFail =
    strict &&
    (compiled.warnings > 0 || report.unvisitedKnots.length > 0 || report.runtimeWarnings.length > 0);
  process.exit(hardFail || softFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
