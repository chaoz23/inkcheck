const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
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
  saveCheckpointArtifact,
  saveCheckpointArtifactFromSource,
} = require("../dist/checkpoints");
const {
  CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER,
  readCheckpointArtifactV2,
  writeCheckpointArtifactV2,
} = require("../dist/checkpoint-artifact-v2");

const FIXTURE = path.join(__dirname, "fixtures", "search", "low-dedup-wide.ink");
const DEEP_FIXTURE = path.join(__dirname, "fixtures", "search", "deep-branching.ink");

async function fixtureRoots(fixturePath = FIXTURE) {
  const graphRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-source-graph-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-source-live-"));
  const graphStory = path.join(graphRoot, "story.ink");
  const sourceStory = path.join(sourceRoot, "story.ink");
  fs.copyFileSync(fixturePath, graphStory);
  fs.copyFileSync(fixturePath, sourceStory);
  const compiled = await compile(graphStory);
  assert.strictEqual(compiled.success, true);
  return {
    graphRoot,
    sourceRoot,
    graphStory,
    sourceStory,
    compiled,
    knots: scanKnots(graphStory),
  };
}

async function withFixedDate(iso, callback) {
  const NativeDate = Date;
  const fixed = NativeDate.parse(iso);
  global.Date = class extends NativeDate {
    constructor(...values) {
      super(...(values.length > 0 ? values : [fixed]));
    }
    static now() { return fixed; }
  };
  try {
    return await callback();
  } finally {
    global.Date = NativeDate;
  }
}

async function rewriteFramedArtifact(root, reference, mutateRecord) {
  const payload = path.join(root, ...reference.path.split("/"));
  const manifestFile = path.join(path.dirname(payload), `${reference.id}.meta.json`);
  const inputs = [];
  let current;
  await readCheckpointArtifactV2(fs.createReadStream(payload), {
    onRecord(record) {
      const key = `${record.component}\0${record.field}`;
      if (!current || current.key !== key) {
        current = {
          key,
          component: record.component,
          field: record.field,
          start: record.index,
          records: [],
        };
        inputs.push(current);
      }
      current.records.push(mutateRecord(record));
    },
  });
  const replacement = `${payload}.replacement`;
  const codec = await writeCheckpointArtifactV2(
    fs.createWriteStream(replacement, { flags: "wx", mode: 0o600 }),
    inputs.map(({ key: _key, ...input }) => input)
  );
  fs.renameSync(replacement, payload);

  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const bytes = fs.readFileSync(payload);
  manifest.artifactSizeBytes = bytes.length;
  manifest.artifactSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  manifest.framedV2 = {
    schemaVersion: 2,
    componentOrder: CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER,
    artifactBytes: codec.artifactBytes,
    artifactOverheadBytes: codec.artifactBytes - codec.data.storedBytes - codec.index.storedBytes,
    data: codec.data,
    components: codec.components,
    index: codec.index,
  };
  const body = {
    manifestSchemaVersion: manifest.manifestSchemaVersion,
    artifactSchemaVersion: manifest.artifactSchemaVersion,
    artifactType: manifest.artifactType,
    id: manifest.id,
    createdAt: manifest.createdAt,
    inkcheckVersion: manifest.inkcheckVersion,
    checkpointSchemaVersion: manifest.checkpointSchemaVersion,
    entrypoint: manifest.entrypoint,
    engine: manifest.engine,
    totalGranted: manifest.totalGranted,
    statesExplored: manifest.statesExplored,
    storageEncoding: manifest.storageEncoding,
    artifactSizeBytes: manifest.artifactSizeBytes,
    artifactSha256: manifest.artifactSha256,
    framedV2: manifest.framedV2,
  };
  manifest.manifestSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(body)).digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}

test("engine-native source preserves logical ID, framed bytes, and exact resume without a checkpoint graph", async () => {
  const fixture = await fixtureRoots();
  const options = {
    maxDepth: 150,
    maxStates: 1_001,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
    sharedObservabilityIntervalStates: 25,
  };
  try {
    const materialized = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      options
    );
    assert.ok(materialized.checkpoint);

    let capturedSource;
    let danglingNodeIterator;
    const [graphReference, streamed] = await withFixedDate(
      "2026-09-06T12:34:56.000Z",
      async () => {
        const graphReference = await saveCheckpointArtifact(
          fixture.graphRoot,
          fixture.graphStory,
          materialized.checkpoint,
          { format: "framed-v2" }
        );
        const streamed = await exploreSharedResumableWithCheckpointSource(
          fixture.compiled.storyJson,
          fixture.knots,
          [],
          options,
          async (source) => {
            capturedSource = source;
            danglingNodeIterator = source.stateRecords("nodes")[Symbol.iterator]();
            let detachedNode = danglingNodeIterator.next();
            while (!detachedNode.done && detachedNode.value === null) {
              detachedNode = danglingNodeIterator.next();
            }
            assert.strictEqual(detachedNode.done, false);
            detachedNode.value.parent = 987_654_321;
            await new Promise((resolve) => setImmediate(resolve));
            return saveCheckpointArtifactFromSource(
              fixture.sourceRoot,
              fixture.sourceStory,
              source
            );
          }
        );
        return [graphReference, streamed];
      }
    );
    assert.ok(streamed.checkpoint);
    assert.deepStrictEqual(streamed.result, materialized.result);
    assert.strictEqual(streamed.checkpoint.id, graphReference.id);
    assert.deepStrictEqual(streamed.checkpoint.accounting.checkpointGraph, {
      count: 0,
      logicalUtf8Bytes: 0,
      peakSourceChunkUtf8Bytes: 0,
    });
    assert.deepStrictEqual(streamed.checkpoint.accounting.engineSource, {
      schemaVersion: 1,
      status: "applied",
      materializedCheckpointGraphs: 0,
      identityPasses: 1,
      framePasses: 1,
      reuseVerificationPasses: 0,
      logicalCheckpointUtf8BytesVisited:
        graphReference.accounting.checkpointGraph.logicalUtf8Bytes,
      peakSourceChunkUtf8Bytes:
        graphReference.accounting.checkpointGraph.peakSourceChunkUtf8Bytes,
    });
    assert.deepStrictEqual(streamed.checkpoint.accounting.serialization, {
      status: "not_applied",
      logicalArtifactUtf8BytesEmitted: 0,
      peakSourceChunkUtf8Bytes: 0,
    });
    assert.deepStrictEqual(streamed.checkpoint.accounting.compression, {
      status: "not_applied",
      storedBytesEmitted: 0,
      peakOutputChunkBytes: 0,
    });
    assert.strictEqual(streamed.checkpoint.accounting.framedV2.status, "applied");

    const graphPayload = fs.readFileSync(path.join(fixture.graphRoot, graphReference.path));
    const sourcePayload = fs.readFileSync(path.join(fixture.sourceRoot, streamed.checkpoint.path));
    assert.strictEqual(sourcePayload.equals(graphPayload), true,
      "fixed-time graph and engine-native producers emit identical framed bytes");
    assert.strictEqual(
      crypto.createHash("sha256").update(sourcePayload).digest("hex"),
      crypto.createHash("sha256").update(graphPayload).digest("hex")
    );

    const loaded = await loadCheckpointForResume(fixture.sourceRoot, streamed.checkpoint.id);
    assert.deepStrictEqual(loaded.checkpoint, materialized.checkpoint);
    assert.throws(
      () => capturedSource.stateRecords("nodes"),
      /no longer active outside its callback/
    );
    assert.deepStrictEqual(danglingNodeIterator.return(), { done: true, value: undefined },
      "release severs a paused iterator before user code asks it to unwind");
    assert.throws(
      () => danglingNodeIterator.next(),
      /no longer active outside its callback/
    );
    await assert.rejects(
      () => saveCheckpointArtifactFromSource(
        fixture.sourceRoot,
        fixture.sourceStory,
        capturedSource
      ),
      /no longer active outside its callback/
    );

    const endpointOptions = { ...options, maxStates: 1_200 };
    const nativeStringify = JSON.stringify;
    let serializedWholeCheckpointState = 0;
    JSON.stringify = (value, ...args) => {
      if (value === loaded.checkpoint.state) {
        serializedWholeCheckpointState++;
        throw new Error("whole checkpoint-state serialization is forbidden during restore");
      }
      return nativeStringify(value, ...args);
    };
    let resumed;
    try {
      resumed = exploreSharedResumable(
        fixture.compiled.storyJson,
        fixture.knots,
        [],
        endpointOptions,
        loaded.checkpoint
      );
    } finally {
      JSON.stringify = nativeStringify;
    }
    assert.strictEqual(serializedWholeCheckpointState, 0);
    const uninterrupted = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      endpointOptions
    );
    assert.deepStrictEqual(resumed, uninterrupted);
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("engine-native save rejects fabricated sources before filesystem work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-source-fabricated-"));
  try {
    const fabricated = {
      sourceSchemaVersion: 1,
      checkpointSchemaVersion: 1,
      engine: "shared:deep-novelty-v1",
      configuration: {},
      statesExplored: 1,
      totalGranted: 1,
      nodeSlots: 0,
      stateRecords: () => [],
      nodePayloadRecords: () => [],
      nodeAncestryRecords: () => [],
    };
    await assert.rejects(
      () => saveCheckpointArtifactFromSource(root, path.join(root, "story.ink"), fabricated),
      /must be minted by a live shared-search engine/
    );
    assert.deepStrictEqual(fs.readdirSync(root), [],
      "runtime branding fails before creating the checkpoint directory");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manifested framed same-ID source reuse compares records without parsing a complete checkpoint", async () => {
  const fixture = await fixtureRoots();
  const options = {
    maxDepth: 150,
    maxStates: 73,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  try {
    const materialized = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      options
    );
    assert.ok(materialized.checkpoint);
    const existing = await saveCheckpointArtifact(
      fixture.graphRoot,
      fixture.graphStory,
      materialized.checkpoint,
      { format: "framed-v2" }
    );
    const nativeParse = JSON.parse;
    let parsedCompleteCheckpoint = 0;
    const streamed = await exploreSharedResumableWithCheckpointSource(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      options,
      async (source) => {
        JSON.parse = (text, ...args) => {
          if (typeof text === "string" && text.includes('"checkpoint":')) {
            parsedCompleteCheckpoint++;
            throw new Error("complete checkpoint parsing is forbidden during source-native reuse");
          }
          return nativeParse(text, ...args);
        };
        try {
          return await saveCheckpointArtifactFromSource(
            fixture.graphRoot,
            fixture.graphStory,
            source
          );
        } finally {
          JSON.parse = nativeParse;
        }
      }
    );
    assert.ok(streamed.checkpoint);
    assert.strictEqual(streamed.checkpoint.id, existing.id);
    assert.strictEqual(streamed.checkpoint.path, existing.path);
    assert.strictEqual(streamed.checkpoint.accounting.outcome, "reused");
    assert.strictEqual(streamed.checkpoint.accounting.checkpointGraph.count, 0);
    assert.strictEqual(streamed.checkpoint.accounting.engineSource.materializedCheckpointGraphs, 0);
    assert.strictEqual(streamed.checkpoint.accounting.engineSource.framePasses, 0);
    assert.strictEqual(streamed.checkpoint.accounting.engineSource.reuseVerificationPasses, 1);
    assert.strictEqual(parsedCompleteCheckpoint, 0);
    assert.deepStrictEqual(streamed.result, materialized.result);
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("sequential engine-native saves create once and verify the same framed ID on reuse", async () => {
  const fixture = await fixtureRoots();
  const options = {
    maxDepth: 150,
    maxStates: 73,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  const save = () => exploreSharedResumableWithCheckpointSource(
    fixture.compiled.storyJson,
    fixture.knots,
    [],
    options,
    (source) => saveCheckpointArtifactFromSource(
      fixture.graphRoot,
      fixture.graphStory,
      source
    )
  );
  try {
    const first = await save();
    const second = await save();
    assert.ok(first.checkpoint);
    assert.ok(second.checkpoint);
    assert.strictEqual(first.checkpoint.accounting.outcome, "created");
    assert.strictEqual(second.checkpoint.accounting.outcome, "reused");
    assert.strictEqual(second.checkpoint.id, first.checkpoint.id);
    assert.strictEqual(second.checkpoint.path, first.checkpoint.path);
    assert.strictEqual(second.checkpoint.accounting.engineSource.materializedCheckpointGraphs, 0);
    assert.strictEqual(second.checkpoint.accounting.engineSource.reuseVerificationPasses, 1);
    assert.deepStrictEqual(second.result, first.result);
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("concurrent engine-native same-ID writers keep live source context through no-clobber reuse", async () => {
  const fixture = await fixtureRoots();
  const options = {
    maxDepth: 150,
    maxStates: 1_001,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  let ready = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const save = () => exploreSharedResumableWithCheckpointSource(
    fixture.compiled.storyJson,
    fixture.knots,
    [],
    options,
    async (source) => {
      ready += 1;
      if (ready === 2) release();
      await gate;
      return saveCheckpointArtifactFromSource(
        fixture.graphRoot,
        fixture.graphStory,
        source
      );
    }
  );
  try {
    const saves = await Promise.all([save(), save()]);
    assert.ok(saves[0].checkpoint);
    assert.ok(saves[1].checkpoint);
    assert.strictEqual(saves[0].checkpoint.id, saves[1].checkpoint.id);
    assert.strictEqual(saves[0].checkpoint.path, saves[1].checkpoint.path);
    assert.deepStrictEqual(
      saves.map((run) => run.checkpoint.accounting.outcome).sort(),
      ["created", "reused"]
    );
    for (const run of saves) {
      assert.strictEqual(run.checkpoint.accounting.engineSource.materializedCheckpointGraphs, 0);
      assert.strictEqual(
        run.checkpoint.accounting.engineSource.reuseVerificationPasses,
        run.checkpoint.accounting.outcome === "reused" ? 1 : 0
      );
    }
    const loaded = await loadCheckpointForResume(fixture.graphRoot, saves[0].checkpoint.id);
    assert.strictEqual(loaded.checkpoint.state.statesExplored, 1_001);
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("source reuse rejects a self-consistent framed payload whose logical frontier changed", async () => {
  const fixture = await fixtureRoots();
  const options = {
    maxDepth: 150,
    maxStates: 73,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  try {
    const materialized = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      options
    );
    assert.ok(materialized.checkpoint);
    const existing = await saveCheckpointArtifact(
      fixture.graphRoot,
      fixture.graphStory,
      materialized.checkpoint,
      { format: "framed-v2" }
    );
    let changed = 0;
    await rewriteFramedArtifact(fixture.graphRoot, existing, (record) => {
      if (record.component === "dedupe" && record.field === "dedupeHits") {
        changed += 1;
        return record.value + 1;
      }
      return record.value;
    });
    assert.strictEqual(changed, 1);
    const payload = path.join(fixture.graphRoot, ...existing.path.split("/"));
    const before = fs.readFileSync(payload);

    await assert.rejects(
      () => exploreSharedResumableWithCheckpointSource(
        fixture.compiled.storyJson,
        fixture.knots,
        [],
        options,
        (source) => saveCheckpointArtifactFromSource(
          fixture.graphRoot,
          fixture.graphStory,
          source
        )
      ),
      (error) => error?.kind === "corrupt" && error?.stage === "envelope"
        && /live source or stable ID/.test(error.message)
    );
    const nextCheckpoint = structuredClone(materialized.checkpoint);
    nextCheckpoint.state.dedupeHits += 2;
    const immediateWrite = await saveCheckpointArtifact(
      fixture.graphRoot,
      fixture.graphStory,
      nextCheckpoint,
      { format: "framed-v2" }
    );
    assert.notStrictEqual(immediateWrite.id, existing.id,
      "failed source-verification teardown settles before the next writer reuses its descriptor");
    assert.strictEqual(fs.readFileSync(payload).equals(before), true,
      "failed logical verification never replaces the suspect canonical pair");
    await assert.rejects(
      () => loadCheckpointForResume(fixture.graphRoot, existing.id),
      /content does not match its stable ID/
    );
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("manifested legacy reuse is explicit unsupported on the graph-free source path", async () => {
  const fixture = await fixtureRoots();
  const options = {
    maxDepth: 150,
    maxStates: 73,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  try {
    const materialized = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      options
    );
    assert.ok(materialized.checkpoint);
    const existing = await saveCheckpointArtifact(
      fixture.graphRoot,
      fixture.graphStory,
      materialized.checkpoint,
      { format: "legacy-v1" }
    );
    const payload = path.join(fixture.graphRoot, ...existing.path.split("/"));
    const before = fs.readFileSync(payload);
    const nativeParse = JSON.parse;
    let parsedCompleteCheckpoint = 0;
    JSON.parse = (text, ...args) => {
      if (typeof text === "string" && text.includes('"checkpoint":')) {
        parsedCompleteCheckpoint++;
        throw new Error("complete checkpoint parsing is forbidden during source-native reuse");
      }
      return nativeParse(text, ...args);
    };
    try {
      await assert.rejects(
        () => exploreSharedResumableWithCheckpointSource(
          fixture.compiled.storyJson,
          fixture.knots,
          [],
          options,
          (source) => saveCheckpointArtifactFromSource(
            fixture.graphRoot,
            fixture.graphStory,
            source
          )
        ),
        (error) => error?.kind === "unsupported" && error?.stage === "storage"
      );
    } finally {
      JSON.parse = nativeParse;
    }
    assert.strictEqual(parsedCompleteCheckpoint, 0);
    assert.strictEqual(fs.readFileSync(payload).equals(before), true);
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("sidecar-free legacy reuse is explicit unsupported on the graph-free source path", async () => {
  const fixture = await fixtureRoots();
  const options = {
    maxDepth: 150,
    maxStates: 73,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  try {
    const materialized = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      options
    );
    assert.ok(materialized.checkpoint);
    const existing = await saveCheckpointArtifact(
      fixture.graphRoot,
      fixture.graphStory,
      materialized.checkpoint,
      { format: "legacy-v1" }
    );
    const payload = path.join(fixture.graphRoot, existing.path);
    const before = fs.readFileSync(payload);
    fs.rmSync(path.join(path.dirname(payload), `${existing.id}.meta.json`));
    await assert.rejects(
      () => exploreSharedResumableWithCheckpointSource(
        fixture.compiled.storyJson,
        fixture.knots,
        [],
        options,
        (source) => saveCheckpointArtifactFromSource(
          fixture.graphRoot,
          fixture.graphStory,
          source
        )
      ),
      (error) => error?.kind === "unsupported" && error?.stage === "manifest"
    );
    assert.strictEqual(fs.readFileSync(payload).equals(before), true,
      "unsupported source-native reuse preserves the sidecar-free legacy bytes");
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("source retention fails closed on an unrelated sidecar-free legacy artifact without parsing it", async () => {
  const fixture = await fixtureRoots();
  const legacyOptions = {
    maxDepth: 150,
    maxStates: 71,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  const sourceOptions = { ...legacyOptions, maxStates: 73 };
  try {
    const legacy = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      legacyOptions
    );
    assert.ok(legacy.checkpoint);
    const existing = await saveCheckpointArtifact(
      fixture.graphRoot,
      fixture.graphStory,
      legacy.checkpoint,
      { format: "legacy-v1" }
    );
    const directory = path.dirname(path.join(fixture.graphRoot, ...existing.path.split("/")));
    fs.rmSync(path.join(directory, `${existing.id}.meta.json`));
    const beforeNames = fs.readdirSync(directory).sort();
    const nativeParse = JSON.parse;
    let parsedCompleteCheckpoint = 0;
    JSON.parse = (text, ...args) => {
      if (typeof text === "string" && text.includes('"checkpoint":')) {
        parsedCompleteCheckpoint++;
        throw new Error("retention must not parse a sidecar-free checkpoint");
      }
      return nativeParse(text, ...args);
    };
    try {
      await assert.rejects(
        () => exploreSharedResumableWithCheckpointSource(
          fixture.compiled.storyJson,
          fixture.knots,
          [],
          sourceOptions,
          (source) => saveCheckpointArtifactFromSource(
            fixture.graphRoot,
            fixture.graphStory,
            source,
            { maxGenerationsPerEntrypoint: 10 }
          )
        ),
        (error) => error?.kind === "unsupported" && error?.stage === "manifest"
      );
    } finally {
      JSON.parse = nativeParse;
    }
    assert.strictEqual(parsedCompleteCheckpoint, 0);
    assert.deepStrictEqual(fs.readdirSync(directory).sort(), beforeNames,
      "manifest-required preflight rejects before reserving or publishing a source candidate");
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("engine-native source preserves deep-frontier parity while migrating a pre-ledger checkpoint", async () => {
  const fixture = await fixtureRoots(DEEP_FIXTURE);
  const initialOptions = {
    maxDepth: 500,
    maxStates: 73,
    seed: 7,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  const resumedOptions = { ...initialOptions, maxStates: 401 };
  try {
    const initial = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      initialOptions
    );
    assert.ok(initial.checkpoint);
    const preLedger = JSON.parse(JSON.stringify(initial.checkpoint));
    delete preLedger.state.sharedObservability;
    delete preLedger.state.ownerAccounting;

    const materialized = exploreSharedResumable(
      fixture.compiled.storyJson,
      fixture.knots,
      [],
      resumedOptions,
      preLedger
    );
    assert.ok(materialized.checkpoint);
    const [graphReference, streamed] = await withFixedDate(
      "2026-09-06T12:35:56.000Z",
      async () => {
        const graphReference = await saveCheckpointArtifact(
          fixture.graphRoot,
          fixture.graphStory,
          materialized.checkpoint,
          { format: "framed-v2" }
        );
        const streamed = await exploreSharedResumableWithCheckpointSource(
          fixture.compiled.storyJson,
          fixture.knots,
          [],
          resumedOptions,
          (source) => saveCheckpointArtifactFromSource(
            fixture.sourceRoot,
            fixture.sourceStory,
            source
          ),
          preLedger
        );
        return [graphReference, streamed];
      }
    );
    assert.ok(streamed.checkpoint);
    assert.deepStrictEqual(streamed.result, materialized.result);
    assert.strictEqual(streamed.checkpoint.id, graphReference.id);
    const graphPayload = fs.readFileSync(path.join(fixture.graphRoot, graphReference.path));
    const sourcePayload = fs.readFileSync(path.join(fixture.sourceRoot, streamed.checkpoint.path));
    assert.strictEqual(sourcePayload.equals(graphPayload), true);
    const loaded = await loadCheckpointForResume(fixture.sourceRoot, streamed.checkpoint.id);
    assert.deepStrictEqual(loaded.checkpoint, materialized.checkpoint);
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("callback rejection invalidates and unwinds every live engine-source iterator", async () => {
  const fixture = await fixtureRoots();
  const expected = new Error("consumer rejected checkpoint source");
  let capturedSource;
  let capturedIterator;
  try {
    await assert.rejects(
      () => exploreSharedResumableWithCheckpointSource(
        fixture.compiled.storyJson,
        fixture.knots,
        [],
        {
          maxDepth: 150,
          maxStates: 73,
          seed: 7,
          preserveTurnState: false,
          preserveRandomState: false,
        },
        async (source) => {
          capturedSource = source;
          capturedIterator = source.stateRecords("nodes")[Symbol.iterator]();
          assert.strictEqual(capturedIterator.next().done, false);
          await new Promise((resolve) => setImmediate(resolve));
          throw expected;
        }
      ),
      (error) => error === expected
    );
    assert.throws(
      () => capturedSource.nodePayloadRecords(),
      /no longer active outside its callback/
    );
    assert.deepStrictEqual(capturedIterator.return(), { done: true, value: undefined });
    assert.throws(
      () => capturedIterator.next(),
      /no longer active outside its callback/
    );
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});

test("engine-native identity traversal is cancellable and always invalidates the source", async () => {
  const fixture = await fixtureRoots();
  let capturedSource;
  const controller = new AbortController();
  try {
    await assert.rejects(
      () => exploreSharedResumableWithCheckpointSource(
        fixture.compiled.storyJson,
        fixture.knots,
        [],
        {
          maxDepth: 150,
          maxStates: 2_000,
          seed: 7,
          preserveTurnState: false,
          preserveRandomState: false,
        },
        async (source) => {
          capturedSource = source;
          setImmediate(() => controller.abort());
          return saveCheckpointArtifactFromSource(
            fixture.sourceRoot,
            fixture.sourceStory,
            source,
            { signal: controller.signal }
          );
        }
      ),
      (error) => error?.name === "AbortError"
    );
    assert.throws(
      () => capturedSource.stateRecords("seenStates"),
      /no longer active outside its callback/
    );
    const directory = path.join(fixture.sourceRoot, ".inkcheck", "checkpoints");
    assert.deepStrictEqual(fs.existsSync(directory) ? fs.readdirSync(directory) : [], [],
      "cancellation before publication leaves no artifact or private transaction files");
  } finally {
    fs.rmSync(fixture.graphRoot, { recursive: true, force: true });
    fs.rmSync(fixture.sourceRoot, { recursive: true, force: true });
  }
});
