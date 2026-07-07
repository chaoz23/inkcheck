const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  parseIssue,
  compile,
  scanKnots,
  scanExternals,
  scanStorySemantics,
} = require("../dist/inklecate");
const { explore, playtest, mergeMinRepro, stateKey } = require("../dist/explore");

const MANOR = path.join(__dirname, "..", "examples", "manor.ink");
const BROKEN = path.join(__dirname, "..", "examples", "broken.ink");
const LINEAR_RUNTIME_ERROR = path.join(
  __dirname,
  "..",
  "examples",
  "linear-runtime-error.ink"
);
const CLEAN_BRANCH = path.join(__dirname, "..", "examples", "clean-branch.ink");
const EXTERNAL_STORY = path.join(__dirname, "..", "examples", "external-story.ink");
const CLI = path.join(__dirname, "..", "dist", "cli.js");

test("parseIssue extracts severity, file, line, message", () => {
  const i = parseIssue("ERROR: 'story.ink' line 42: Divert target not found: '-> nowhere'");
  assert.strictEqual(i.severity, "ERROR");
  assert.strictEqual(i.file, "story.ink");
  assert.strictEqual(i.line, 42);
  assert.match(i.message, /Divert target not found/);
});

test("parseIssue tolerates lines without file/line", () => {
  const i = parseIssue("WARNING: something general");
  assert.strictEqual(i.severity, "WARNING");
  assert.strictEqual(i.line, null);
});

test("scanKnots finds all knots with locations", () => {
  const knots = scanKnots(MANOR);
  const names = knots.map((k) => k.name);
  assert.ok(names.includes("entrance"));
  assert.ok(names.includes("treasure_vault"));
  assert.strictEqual(knots.length, 7);
  const vault = knots.find((k) => k.name === "treasure_vault");
  assert.strictEqual(vault.file, "manor.ink");
  assert.ok(vault.line > 30);
});

test("scanExternals returns empty for stories without EXTERNAL", () => {
  assert.deepStrictEqual(scanExternals(MANOR), []);
});

test("compile reports structured errors for a broken story", async () => {
  const result = await compile(BROKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.errors, 3);
  assert.strictEqual(result.warnings, 1);
  assert.ok(result.issues.every((i) => i.file === "broken.ink"));
});

test("compile succeeds and returns story JSON for a valid story", async () => {
  const result = await compile(MANOR);
  assert.strictEqual(result.success, true);
  assert.ok(result.storyJson.length > 100);
});

test("explore finds endings, runtime errors with repro, and unvisited knots", async () => {
  const compiled = await compile(MANOR);
  const report = explore(compiled.storyJson, scanKnots(MANOR));
  assert.strictEqual(report.endingsFound.length, 5);
  assert.strictEqual(report.runtimeErrors.length, 1);
  assert.deepStrictEqual(report.runtimeErrors[0].path, [
    "Enter in darkness",
    "Descend to the cellar",
  ]);
  assert.deepStrictEqual(
    report.unvisitedKnots.map((k) => k.name),
    ["treasure_vault"]
  );
  assert.strictEqual(report.truncated, false);
});

test("BFS strategy reaches the same endings", async () => {
  const compiled = await compile(MANOR);
  const dfs = explore(compiled.storyJson, scanKnots(MANOR));
  const bfs = explore(compiled.storyJson, scanKnots(MANOR), [], { strategy: "bfs" });
  assert.strictEqual(bfs.endingsFound.length, dfs.endingsFound.length);
  const merged = mergeMinRepro(dfs, bfs);
  for (const e of merged.endingsFound) assert.ok(e.path.length <= 3);
});

test("playtest follows a scripted path and reports variables", async () => {
  const compiled = await compile(MANOR);
  // Take the torch, search the study, leave with the loot.
  const result = playtest(compiled.storyJson, [0, 0, 0]);
  assert.strictEqual(result.ended, true);
  assert.strictEqual(result.runtimeErrors.length, 0);
  assert.strictEqual(result.variables.gold, 50);
  assert.strictEqual(result.variables.torches, 1);
});

test("playtest reports out-of-range choices as errors", async () => {
  const compiled = await compile(MANOR);
  const result = playtest(compiled.storyJson, [9]);
  assert.strictEqual(result.runtimeErrors.length, 1);
  assert.match(result.runtimeErrors[0], /out of range/);
});

test("explore does not report a crashing linear story as an ending", async () => {
  const compiled = await compile(LINEAR_RUNTIME_ERROR);
  assert.strictEqual(compiled.success, true);
  const report = explore(compiled.storyJson, scanKnots(LINEAR_RUNTIME_ERROR));
  assert.strictEqual(report.runtimeErrors.length, 1);
  assert.strictEqual(report.endingsFound.length, 0);
});

test("state identity preserves turn and random state", () => {
  const base = { flows: {}, variablesState: {}, turnIdx: 1, storySeed: 10, previousRandom: 4 };
  assert.notStrictEqual(stateKey(JSON.stringify(base)), stateKey(JSON.stringify({ ...base, turnIdx: 2 })));
  assert.notStrictEqual(
    stateKey(JSON.stringify(base)),
    stateKey(JSON.stringify({ ...base, storySeed: 11 }))
  );
  assert.notStrictEqual(
    stateKey(JSON.stringify(base)),
    stateKey(JSON.stringify({ ...base, previousRandom: 5 }))
  );
  assert.strictEqual(
    stateKey(JSON.stringify(base), { turns: false, randomness: false }),
    stateKey(JSON.stringify({ ...base, turnIdx: 2, storySeed: 11, previousRandom: 5 }), {
      turns: false,
      randomness: false,
    })
  );
});

test("scanStorySemantics follows includes and detects turn and random behavior", () => {
  const semantics = scanStorySemantics(
    path.join(__dirname, "..", "examples", "semantic-features.ink")
  );
  assert.deepStrictEqual(semantics, { usesTurns: true, usesRandomness: true });
});

test("CLI accepts limit flags before the story path", () => {
  const proc = spawnSync(process.execPath, [CLI, "--max-states", "20", MANOR, "--json"], {
    encoding: "utf8",
  });
  assert.strictEqual(proc.status, 1);
  assert.strictEqual(JSON.parse(proc.stdout).compile.success, true);
});

test("CLI rejects invalid numeric and unknown options as usage errors", () => {
  const invalid = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--max-states", "nope"], {
    encoding: "utf8",
  });
  assert.strictEqual(invalid.status, 2);
  assert.match(invalid.stderr, /requires a positive integer/);
  const unknown = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--surprise"], {
    encoding: "utf8",
  });
  assert.strictEqual(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/);
});

test("strict mode fails when traversal is truncated", () => {
  const proc = spawnSync(
    process.execPath,
    [CLI, CLEAN_BRANCH, "--max-states", "1", "--no-min-repro", "--strict", "--json"],
    { encoding: "utf8" }
  );
  assert.strictEqual(proc.status, 1);
  assert.strictEqual(JSON.parse(proc.stdout).explore.truncated, true);
});

test("external stubs are disclosed and make strict coverage fail", () => {
  const proc = spawnSync(process.execPath, [CLI, EXTERNAL_STORY, "--strict", "--json"], {
    encoding: "utf8",
  });
  const report = JSON.parse(proc.stdout).explore;
  assert.strictEqual(proc.status, 1);
  assert.deepStrictEqual(report.externalFunctionsStubbed, ["choose_route"]);
});

test("markdown output is suitable for a GitHub Actions step summary", () => {
  const proc = spawnSync(process.execPath, [CLI, CLEAN_BRANCH, "--markdown"], {
    encoding: "utf8",
  });
  assert.strictEqual(proc.status, 0);
  assert.match(proc.stdout, /# inkcheck report/);
  assert.match(proc.stdout, /Distinct terminal states \| 2/);
});
