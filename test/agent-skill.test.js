const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const {
  compile,
  scanExternals,
  scanInboundDiverts,
  scanKnots,
  scanStorySemantics,
} = require("../dist/inklecate");
const { classifyUnvisitedKnots, explorePortfolio } = require("../dist/explore");
const { capabilities } = require("../dist/discovery");

const ROOT = path.join(__dirname, "..", "skills", "inkcheck");
const EXERCISES = path.join(ROOT, "exercises");

function story(name) {
  return path.join(EXERCISES, name);
}

test("bundled agent skill is compact, versioned, progressively linked, and packaged", () => {
  const skill = fs.readFileSync(path.join(ROOT, "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: inkcheck\r?\n/);
  assert.match(skill, /inspect.*compile.*explore.*replay.*fix.*verify/is);
  assert.match(skill, /does not prove complete coverage/i);
  assert.match(skill, /ask before changing story prose/i);
  assert.match(skill, /Inkcheck 0\.6\.x, capabilities schema 1, report schema 1, search-session schema 5/);
  for (const linked of [
    "references/ink-qa-primer.md",
    "references/finding-workflows.md",
    "references/decision-table.md",
    "exercises/manifest.json",
  ]) {
    assert.match(skill, new RegExp(linked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.strictEqual(fs.existsSync(path.join(ROOT, linked)), true, linked);
  }
  const estimatedTokens = Math.ceil(Buffer.byteLength(skill, "utf8") / 4);
  assert.ok(estimatedTokens >= 1_400 && estimatedTokens <= 2_100, `${estimatedTokens} estimated tokens`);
  assert.strictEqual(capabilities().features.bundledAgentSkill, true);
  const metadata = YAML.parse(fs.readFileSync(path.join(ROOT, "agents", "openai.yaml"), "utf8"));
  assert.strictEqual(metadata.interface.display_name, "Inkcheck QA");
  assert.match(metadata.interface.default_prompt, /\$inkcheck/);

  const packageFiles = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).files;
  assert.ok(packageFiles.includes("skills/inkcheck"));
});

test("ten golden exercises cover the declared agent QA curriculum and reproduce their signals", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXERCISES, "manifest.json"), "utf8"));
  assert.strictEqual(manifest.schemaVersion, 1);
  assert.match(manifest.inkcheckContract, /^0\.6\.x\//);
  assert.strictEqual(manifest.exercises.length, 10);
  assert.deepStrictEqual(new Set(manifest.exercises.map((entry) => entry.category)), new Set([
    "compilation",
    "content_exhaustion",
    "negative_resource",
    "impossible_ending",
    "stale_flag",
    "turns",
    "randomness",
    "externals",
    "unreachable_content",
    "path_changes",
  ]));
  for (const exercise of manifest.exercises) {
    assert.ok(exercise.expectedSignal.length > 10, exercise.id);
    assert.ok(exercise.correctRepair.length > 20, exercise.id);
    assert.ok(exercise.temptingWrongRepair.length > 20, exercise.id);
    assert.ok(exercise.verification.length > 20, exercise.id);
    assert.strictEqual(fs.existsSync(story(exercise.story)), true, exercise.story);
    const compiled = await compile(story(exercise.story));
    assert.strictEqual(compiled.success, exercise.category !== "compilation", exercise.id);
  }

  const contentFile = story("content-exhaustion.ink");
  const content = await compile(contentFile);
  const contentReport = explorePortfolio(content.storyJson, scanKnots(contentFile), [], { maxStates: 100 });
  assert.strictEqual(contentReport.runtimeErrors.length, 1);
  assert.deepStrictEqual(contentReport.runtimeErrors[0].choiceIndices, [0]);

  const negativeFile = story("negative-resource.ink");
  const negative = await compile(negativeFile);
  const negativeReport = explorePortfolio(negative.storyJson, scanKnots(negativeFile), [], {
    maxStates: 100,
    assertions: [{
      id: "gold_nonnegative",
      when: "always",
      condition: { left: { variable: "gold" }, operator: ">=", right: { literal: 0 } },
    }],
  });
  assert.strictEqual(negativeReport.assertionResults[0].status, "violated");
  assert.deepStrictEqual(negativeReport.assertionResults[0].violations[0].choiceIndices, [0]);

  const staleFile = story("stale-flag.ink");
  const stale = await compile(staleFile);
  const staleReport = explorePortfolio(stale.storyJson, scanKnots(staleFile), [], {
    maxStates: 100,
    assertions: [{
      id: "parcel_returned",
      when: "terminal",
      condition: { left: { variable: "carrying" }, operator: "==", right: { literal: false } },
    }],
  });
  assert.strictEqual(staleReport.assertionResults[0].status, "violated");

  const impossibleFile = story("impossible-ending.ink");
  const impossible = await compile(impossibleFile);
  const impossibleReport = explorePortfolio(impossible.storyJson, scanKnots(impossibleFile), [], { maxStates: 100 });
  classifyUnvisitedKnots(impossibleReport, scanInboundDiverts(impossibleFile));
  assert.ok(impossibleReport.unvisitedKnots.some((knot) => knot.name === "secret_ending"));

  assert.strictEqual(scanStorySemantics(story("turns.ink")).usesTurns, true);
  assert.strictEqual(scanStorySemantics(story("randomness.ink")).usesRandomness, true);
  assert.deepStrictEqual(scanExternals(story("external.ink")), ["owns_key"]);

  const orphanFile = story("unreachable-content.ink");
  const orphan = await compile(orphanFile);
  const orphanReport = explorePortfolio(orphan.storyJson, scanKnots(orphanFile), [], { maxStates: 100 });
  classifyUnvisitedKnots(orphanReport, scanInboundDiverts(orphanFile));
  assert.ok(orphanReport.unvisitedKnots.some((knot) =>
    knot.name === "forgotten_room" && knot.staticOrphanCandidate === true
  ));

  const pathFile = story("path-change.ink");
  const pathCompiled = await compile(pathFile);
  const pathReport = explorePortfolio(pathCompiled.storyJson, scanKnots(pathFile), [], { maxStates: 100 });
  assert.ok(pathReport.runtimeErrors.some((error) =>
    JSON.stringify(error.choiceIndices) === JSON.stringify([0, 0])
  ));
});
