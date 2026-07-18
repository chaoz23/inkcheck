"use strict";

const assert = require("node:assert");
const test = require("node:test");
const { evaluate, markdown } = require("../scripts/loop-specialist-evaluation");
const { isUnpublishedVersionError } = require("../scripts/release-preflight");

function report(version, explore) {
  return { inkcheckVersion: version, storyFingerprint: { value: "same-story" }, explore };
}

test("loop specialist evaluation reports bounded evidence deltas without coverage claims", () => {
  const result = evaluate(
    report("0.7.0", { statesExplored: 5_000_000, endingsFound: [{}], runtimeErrors: [], unvisitedKnots: [{}, {}], truncatedBy: { maxStates: true } }),
    report("0.7.1", { statesExplored: 5_000_000, endingsFound: [{}], runtimeErrors: [], loopRisks: [{}], unvisitedKnots: [{}], truncatedBy: { maxStates: true } })
  );
  assert.strictEqual(result.deltas.loopWarnings, 1);
  assert.strictEqual(result.deltas.unvisitedKnots, -1);
  assert.strictEqual(result.interpretation.runtimeEvidenceParity, true);
  assert.match(markdown(result), /does not prove coverage/);
});

test("loop specialist evaluation rejects reports from different stories", () => {
  assert.throws(
    () => evaluate(
      { storyFingerprint: { value: "one" }, explore: {} },
      { storyFingerprint: { value: "two" }, explore: {} }
    ),
    /different compiled stories/
  );
});

test("release preflight recognizes only npm's unavailable-version response", () => {
  assert.strictEqual(isUnpublishedVersionError({ stderr: "npm error code E404\n404 Not Found" }), true);
  assert.strictEqual(isUnpublishedVersionError({ stderr: "spawn npm ENOENT" }), false);
});
