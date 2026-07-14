const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const { openReportArtifact, saveReportArtifact } = require("../dist/artifacts");
const { compile } = require("../dist/inklecate");
const {
  cancelSearchSession,
  continueSearchSession,
  inspectSearchSession,
  replaySessionWitness,
  startSearchSession,
} = require("../dist/search-sessions");

const FIXTURE = path.join(__dirname, "fixtures", "search", "low-dedup-wide.ink");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-session-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(FIXTURE, file);
  return { root, file };
}

test("MCP result-window continuation equals one uninterrupted shared run", async () => {
  const split = project();
  const full = project();
  try {
    const first = await startSearchSession({
      file: split.file,
      maxStates: 73,
      maxDepth: 150,
      seed: 7,
    });
    assert.strictEqual(first.session.status, "paused");
    assert.strictEqual(first.session.recoverable, true);
    assert.match(first.sessionCapability, /^mcp-session-[A-Za-z0-9_-]{43}$/);
    const resumed = await continueSearchSession({
      file: split.file,
      sessionCapability: first.sessionCapability,
      revision: first.session.revision,
      maxStates: 500,
    });
    const uninterrupted = await startSearchSession({
      file: full.file,
      maxStates: 500,
      maxDepth: 150,
      seed: 7,
    });
    const splitReport = await openReportArtifact(split.root, resumed.session.latestReportId);
    const fullReport = await openReportArtifact(full.root, uninterrupted.session.latestReportId);
    assert.deepStrictEqual(splitReport.report, fullReport.report);
    assert.strictEqual(resumed.session.latestReportId, uninterrupted.session.latestReportId);
    assert.strictEqual(resumed.session.revision, 2);
    assert.strictEqual(resumed.session.events.at(-1).type, "continued");
  } finally {
    fs.rmSync(split.root, { recursive: true, force: true });
    fs.rmSync(full.root, { recursive: true, force: true });
  }
});

test("MCP session inspection is bounded, private, and usable without process memory", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 73, findingLimit: 1 });
    const inspected = await inspectSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      findingLimit: 1,
    });
    assert.strictEqual(inspected.sessionCapability, undefined);
    assert.strictEqual(inspected.session.latestReportId, started.session.latestReportId);
    assert.ok(inspected.savedFindings.page.returned <= 1);
    assert.strictEqual("report" in inspected, false);
    assert.strictEqual("checkpoint" in inspected, false);

    const directory = path.join(root, ".inkcheck", "sessions");
    const names = fs.readdirSync(directory);
    assert.strictEqual(names.length, 1);
    assert.match(names[0], /^session-[0-9a-f]{64}\.json$/);
    const raw = fs.readFileSync(path.join(directory, names[0]), "utf8");
    assert.strictEqual(raw.includes(started.sessionCapability), false);
    for (const sensitive of ["stateJson", "choicePath", "transcript", "variables", "frontier", "nodes"]) {
      assert.strictEqual(raw.includes(sensitive), false, `metadata leaked ${sensitive}`);
    }
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(path.join(directory, names[0])).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancel retains an exact frontier by default and discard forgets the capability", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 73 });
    const cancelled = await cancelSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      revision: started.session.revision,
    });
    assert.strictEqual(cancelled.session.status, "cancelled");
    assert.strictEqual(cancelled.session.recoverable, true);
    const resumed = await continueSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      revision: cancelled.session.revision,
      maxStates: 100,
    });
    assert.strictEqual(resumed.session.revision, 3);
    const discarded = await cancelSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      revision: resumed.session.revision,
      discard: true,
    });
    assert.strictEqual(discarded.discarded, true);
    await assert.rejects(
      () => inspectSearchSession({ file, sessionCapability: started.sessionCapability }),
      /not found/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP sessions fail closed for capabilities, entrypoints, revisions, grants, and stale source", async () => {
  const { root, file } = project();
  try {
    const other = path.join(root, "other.ink");
    fs.copyFileSync(FIXTURE, other);
    const started = await startSearchSession({ file, maxStates: 73 });
    await assert.rejects(
      () => inspectSearchSession({ file, sessionCapability: "not-a-capability" }),
      /invalid search session capability/
    );
    await assert.rejects(
      () => inspectSearchSession({ file: other, sessionCapability: started.sessionCapability }),
      /different story entrypoint/
    );
    await assert.rejects(
      () => continueSearchSession({ file, sessionCapability: started.sessionCapability, revision: 99, maxStates: 100 }),
      /revision is 1, not 99/
    );
    await assert.rejects(
      () => continueSearchSession({ file, sessionCapability: started.sessionCapability, revision: 1, maxStates: 73 }),
      /greater than the prior total grant/
    );
    await assert.rejects(
      () => continueSearchSession({ file, sessionCapability: started.sessionCapability, revision: 1, maxStates: 5_000_074 }),
      /may add at most 5000000/
    );
    fs.appendFileSync(file, "\nChanged after the checkpoint.\n");
    await assert.rejects(
      () => continueSearchSession({ file, sessionCapability: started.sessionCapability, revision: 1, maxStates: 100 }),
      /resume requires the exact source and knot map/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP session metadata rejects incompatible versions and one recoverable session per story", async () => {
  const { root, file } = project();
  try {
    const started = await startSearchSession({ file, maxStates: 73 });
    await assert.rejects(
      () => startSearchSession({ file, maxStates: 73 }),
      /already has a recoverable search session/
    );
    const directory = path.join(root, ".inkcheck", "sessions");
    const metadata = path.join(directory, fs.readdirSync(directory)[0]);
    let value = JSON.parse(fs.readFileSync(metadata, "utf8"));
    value.schemaVersion = 1;
    fs.writeFileSync(metadata, JSON.stringify(value));
    const upgraded = await cancelSearchSession({
      file,
      sessionCapability: started.sessionCapability,
      revision: 1,
    });
    assert.strictEqual(upgraded.session.revision, 2);
    value = JSON.parse(fs.readFileSync(metadata, "utf8"));
    assert.strictEqual(value.schemaVersion, 2);
    value.events.push({
      sequence: 3,
      type: "replayed",
      revision: 3,
      totalGranted: value.totalGranted,
      statesExplored: value.statesExplored,
      reportId: value.latestReportId,
      findingId: "runtime.error:test",
      replayStatus: "runtime_error",
      transcript: "must never persist",
    });
    fs.writeFileSync(metadata, JSON.stringify(value));
    await assert.rejects(
      () => inspectSearchSession({ file, sessionCapability: started.sessionCapability }),
      /missing required bounded fields/
    );
    value.events.pop();
    value.schemaVersion = 999;
    fs.writeFileSync(metadata, JSON.stringify(value));
    await assert.rejects(
      () => startSearchSession({ file, maxStates: 73 }),
      /unsupported search session schema 999/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP witness replay executes current evidence and records only a privacy-safe audit event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-replay-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), file);
  try {
    const started = await startSearchSession({ file, maxStates: 100 });
    const findingId = started.savedFindings.findings[0].id;
    const replayed = await replaySessionWitness({
      file,
      sessionCapability: started.sessionCapability,
      revision: started.session.revision,
      findingId,
    });
    assert.strictEqual(replayed.reportId, started.session.latestReportId);
    assert.strictEqual(replayed.finding.id, findingId);
    assert.strictEqual(replayed.replay.replayStatus, "runtime_error");
    assert.strictEqual(replayed.session.revision, 2);
    assert.deepStrictEqual(replayed.session.events.at(-1), {
      sequence: 2,
      type: "replayed",
      revision: 2,
      totalGranted: 100,
      statesExplored: started.session.statesExplored,
      reportId: started.session.latestReportId,
      findingId,
      replayStatus: "runtime_error",
    });
    assert.match(replayed.disclosure, /transcript, choice text, and final variables/);

    const inspected = await inspectSearchSession({ file, sessionCapability: started.sessionCapability });
    assert.strictEqual(inspected.session.revision, 2);
    assert.strictEqual(inspected.session.events.at(-1).findingId, findingId);
    const metadata = path.join(root, ".inkcheck", "sessions", fs.readdirSync(path.join(root, ".inkcheck", "sessions"))[0]);
    const raw = fs.readFileSync(metadata, "utf8");
    for (const sensitive of ["Do you need", "steps", "choiceIndices", "variables", "pendingChoices"]) {
      assert.strictEqual(raw.includes(sensitive), false, `replay metadata leaked ${sensitive}`);
    }
    await assert.rejects(
      () => replaySessionWitness({ file, sessionCapability: started.sessionCapability, revision: 1, findingId }),
      /revision is 2, not 1/
    );
    fs.appendFileSync(file, "\nChanged source after replay.\n");
    await assert.rejects(
      () => replaySessionWitness({ file, sessionCapability: started.sessionCapability, revision: 2, findingId }),
      /replay requires current source; report is stale/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP witness replay rejects foreign IDs and findings without indexed witnesses", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-mcp-replay-invalid-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(path.join(__dirname, "..", "examples", "content-exhaustion.ink"), file);
  try {
    const started = await startSearchSession({ file, maxStates: 100 });
    await assert.rejects(
      () => replaySessionWitness({
        file,
        sessionCapability: started.sessionCapability,
        revision: 1,
        findingId: "runtime.error:foreign",
      }),
      /finding not found/
    );

    const compiled = await compile(file);
    assert.strictEqual(compiled.success, true);
    const noWitnessId = "ending.reached:no-witness";
    const reference = saveReportArtifact(root, file, {
      schemaVersion: 1,
      storyFingerprint: {
        algorithm: "sha256",
        source: "compiled-story",
        value: createHash("sha256").update(compiled.storyJson).digest("hex"),
      },
      effectiveConfiguration: {},
      compile: { issues: [] },
      explore: {
        runtimeErrors: [],
        endingsFound: [{ id: noWitnessId, kind: "ending.reached" }],
        assertionResults: [],
        goalResults: [],
      },
    });
    const sessions = path.join(root, ".inkcheck", "sessions");
    const metadata = path.join(sessions, fs.readdirSync(sessions)[0]);
    const record = JSON.parse(fs.readFileSync(metadata, "utf8"));
    record.latestReportId = reference.id;
    fs.writeFileSync(metadata, JSON.stringify(record));
    await assert.rejects(
      () => replaySessionWitness({
        file,
        sessionCapability: started.sessionCapability,
        revision: 1,
        findingId: noWitnessId,
      }),
      /no supported indexed replay witness/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
