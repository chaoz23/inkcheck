const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { compile, scanKnots } = require("../dist/inklecate");
const {
  exploreSharedResumable,
  exploreSharedResumableWithCheckpointSource,
} = require("../dist/explore");
const {
  loadCheckpointForResume,
  saveCheckpointArtifactFromSource,
} = require("../dist/checkpoints");

const FIXTURE = path.join(__dirname, "fixtures", "search", "low-dedup-wide.ink");

async function isolatedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-source-isolation-"));
  const story = path.join(root, "story.ink");
  fs.copyFileSync(FIXTURE, story);
  const compiled = await compile(story);
  assert.strictEqual(compiled.success, true);
  return { root, story, storyJson: compiled.storyJson };
}

test("checkpoint-source callbacks cannot mutate retained evidence or final-result inputs", async () => {
  const fixture = await isolatedFixture();
  const baselineOptions = {
    maxDepth: 150,
    maxStates: 1_001,
    seed: 7,
    storySeed: 1,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  try {
    const baselineKnots = scanKnots(fixture.story);
    const baseline = exploreSharedResumable(
      fixture.storyJson,
      baselineKnots,
      [],
      baselineOptions
    );
    assert.ok(baseline.checkpoint);

    const mutableKnots = scanKnots(fixture.story);
    const mutableExternals = [];
    let capturedFinding;
    let originalProgressCalls = 0;
    let replacementProgressCalls = 0;
    const mutableOptions = {
      ...baselineOptions,
      onEvidence(evidence) {
        if (!capturedFinding && evidence.kind === "ending") capturedFinding = evidence.finding;
      },
      onProgress() {
        originalProgressCalls++;
      },
    };
    const marker = " [caller mutation after identity began]";
    const streamed = await exploreSharedResumableWithCheckpointSource(
      fixture.storyJson,
      mutableKnots,
      mutableExternals,
      mutableOptions,
      async (source) => {
        assert.ok(capturedFinding, "the fixture emits retained evidence before its checkpoint boundary");
        setImmediate(() => {
          capturedFinding.finalText += marker;
          capturedFinding.path.push("caller-owned mutation");
          mutableExternals.push("late_external_never_bound");
          mutableOptions.randomnessDetected = true;
          mutableOptions.storySeed = 99;
          mutableOptions.goals = [{ id: "late-goal", condition: { kind: "ending" } }];
          mutableOptions.onProgress = () => {
            replacementProgressCalls++;
            throw new Error("late progress callback must not replace the captured callback");
          };
          mutableKnots[0].name = "late_mutated_knot";
          mutableKnots[0].file = "late-private-path.ink";
        });
        return saveCheckpointArtifactFromSource(fixture.root, fixture.story, source);
      }
    );

    assert.ok(streamed.checkpoint);
    assert.match(capturedFinding.finalText, /caller mutation after identity began/,
      "the adversarial mutation actually ran while the source callback was pending");
    assert.deepStrictEqual(streamed.result, baseline.result);
    assert.strictEqual(Object.hasOwn(streamed.result, "goalResults"), false);
    assert.deepStrictEqual(streamed.result.externalFunctionsStubbed, []);
    assert.strictEqual(streamed.result.randomnessDetected, false);
    assert.strictEqual(streamed.result.limits.storySeed, 1);
    assert.strictEqual(originalProgressCalls, 1);
    assert.strictEqual(replacementProgressCalls, 0);

    const loaded = await loadCheckpointForResume(fixture.root, streamed.checkpoint.id);
    assert.deepStrictEqual(loaded.checkpoint, baseline.checkpoint,
      "identity and frame passes retain the same detached finding bytes");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("checkpoint-source lease ends synchronously for plain results and spans a pending promise", async () => {
  const fixture = await isolatedFixture();
  const options = {
    maxDepth: 150,
    maxStates: 73,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  try {
    const knots = scanKnots(fixture.story);
    let synchronousSource;
    const synchronousRun = exploreSharedResumableWithCheckpointSource(
      fixture.storyJson,
      knots,
      [],
      options,
      (source) => {
        synchronousSource = source;
        return "synchronous";
      }
    );
    assert.throws(
      () => synchronousSource.stateRecords("nodes"),
      /no longer active outside its callback/,
      "a plain callback result releases before the async wrapper's first suspension"
    );
    assert.strictEqual((await synchronousRun).checkpoint, "synchronous");

    let pendingSource;
    let settle;
    const pendingRun = exploreSharedResumableWithCheckpointSource(
      fixture.storyJson,
      knots,
      [],
      options,
      (source) => {
        pendingSource = source;
        return new Promise((resolve) => { settle = resolve; });
      }
    );
    const iterator = pendingSource.stateRecords("nodes")[Symbol.iterator]();
    assert.strictEqual(iterator.next().done, false,
      "a source remains live while its callback promise is unsettled");
    settle("asynchronous");
    assert.strictEqual((await pendingRun).checkpoint, "asynchronous");
    assert.throws(
      () => pendingSource.stateRecords("nodes"),
      /no longer active outside its callback/
    );
    assert.throws(() => iterator.next(), /no longer active outside its callback/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("checkpoint-source lease adopts hostile thenables with one getter read and always releases", async () => {
  const fixture = await isolatedFixture();
  const options = {
    maxDepth: 150,
    maxStates: 73,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  try {
    const knots = scanKnots(fixture.story);
    let source;
    let getterReads = 0;
    const adopted = {};
    Object.defineProperty(adopted, "then", {
      get() {
        getterReads++;
        if (getterReads > 1) throw new Error("then getter was read twice");
        return function (resolve) {
          assert.strictEqual(source.stateRecords("nodes")[Symbol.iterator]().next().done, false);
          resolve("adopted-once");
        };
      },
    });
    const adoptedRun = exploreSharedResumableWithCheckpointSource(
      fixture.storyJson, knots, [], options,
      (value) => { source = value; return adopted; }
    );
    assert.strictEqual(source.stateRecords("nodes")[Symbol.iterator]().next().done, false,
      "thenable invocation is a later job, so its callback lifetime remains active");
    assert.strictEqual((await adoptedRun).checkpoint, "adopted-once");
    assert.strictEqual(getterReads, 1);
    assert.throws(() => source.stateRecords("nodes"), /no longer active outside its callback/);

    const getterError = new Error("then getter failed");
    let getterSource;
    const throwingGetter = {};
    Object.defineProperty(throwingGetter, "then", { get() { throw getterError; } });
    const getterRun = exploreSharedResumableWithCheckpointSource(
      fixture.storyJson, knots, [], options,
      (value) => { getterSource = value; return throwingGetter; }
    );
    assert.throws(() => getterSource.stateRecords("nodes"), /no longer active outside its callback/);
    await assert.rejects(() => getterRun, (error) => error === getterError);

    const invocationError = new Error("then invocation failed");
    let invocationSource;
    const throwingThen = {
      then() { throw invocationError; },
    };
    const invocationRun = exploreSharedResumableWithCheckpointSource(
      fixture.storyJson, knots, [], options,
      (value) => { invocationSource = value; return throwingThen; }
    );
    assert.strictEqual(invocationSource.stateRecords("nodes")[Symbol.iterator]().next().done, false);
    await assert.rejects(() => invocationRun, (error) => error === invocationError);
    assert.throws(() => invocationSource.stateRecords("nodes"), /no longer active outside its callback/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
