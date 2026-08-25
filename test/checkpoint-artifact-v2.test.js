const { test } = require("node:test");
const assert = require("node:assert");
const { constants: bufferConstants } = require("node:buffer");
const crypto = require("node:crypto");
const { getEventListeners } = require("node:events");
const { Readable, PassThrough } = require("node:stream");
const { gzipSync, gunzipSync } = require("node:zlib");

const {
  CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER,
  CHECKPOINT_ARTIFACT_V2_MAGIC,
  CheckpointArtifactV2Error,
  readCheckpointArtifactV2,
  writeCheckpointArtifactV2,
} = require("../dist/checkpoint-artifact-v2");

async function artifactFrom(inputs, options = {}) {
  const destination = new PassThrough();
  const chunks = [];
  destination.on("data", (chunk) => chunks.push(chunk));
  const result = await writeCheckpointArtifactV2(destination, inputs, options);
  return { artifact: Buffer.concat(chunks), result };
}

function fragmented(buffer, width = 7) {
  return Readable.from((function* () {
    for (let offset = 0; offset < buffer.length; offset += width) {
      yield buffer.subarray(offset, Math.min(offset + width, buffer.length));
    }
  })());
}

async function readArtifact(artifact, options = {}) {
  const records = [];
  const result = await readCheckpointArtifactV2(fragmented(artifact), {
    ...options,
    onRecord: async (record) => {
      records.push(record);
      await options.onRecord?.(record);
    },
  });
  return { records, result };
}

function recordPayload(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

function pseudoRandomBase64(seed, bytes) {
  const output = Buffer.allocUnsafe(bytes);
  let state = seed >>> 0;
  for (let index = 0; index < bytes; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = state & 0xff;
  }
  return output.toString("base64");
}

function wireFrames(artifact) {
  const frames = [];
  let offset = CHECKPOINT_ARTIFACT_V2_MAGIC.length;
  while (offset < artifact.length) {
    const frameOffset = offset;
    const headerBytes = artifact.readUInt32BE(offset);
    const storedBytes = artifact.readUInt32BE(offset + 4);
    offset += 8;
    const headerOffset = offset;
    const header = JSON.parse(artifact.subarray(offset, offset + headerBytes).toString("utf8"));
    offset += headerBytes;
    const storedOffset = offset;
    offset += storedBytes;
    frames.push({ frameOffset, headerOffset, storedOffset, end: offset, headerBytes, storedBytes, header });
  }
  return frames;
}

function wireFrame(header, stored) {
  const rawHeader = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeUInt32BE(rawHeader.length, 0);
  prefix.writeUInt32BE(stored.length, 4);
  return Buffer.concat([prefix, rawHeader, stored]);
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stalledAsyncIterable() {
  let markStarted;
  const state = {
    returnCalls: 0,
    started: new Promise((resolve) => {
      markStarted = resolve;
    }),
  };
  state.values = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          markStarted();
          return new Promise(() => {});
        },
        return() {
          state.returnCalls += 1;
          return new Promise(() => {});
        },
      };
    },
  };
  return state;
}

test("framed v2 round-trips ordered records, auto-splits frames, and reports exact accounting", async () => {
  const inputs = [
    {
      component: "configuration",
      field: "identity",
      start: 0,
      records: [{ z: 1, a: 2 }, ["x", 3], null],
    },
    {
      component: "metadata",
      field: "summary",
      start: 0,
      records: [{ states: 4, finished: false }],
    },
  ];
  const written = await artifactFrom(inputs, { limits: { maxRecordsPerFrame: 2 } });
  assert.ok(written.artifact.subarray(0, CHECKPOINT_ARTIFACT_V2_MAGIC.length).equals(CHECKPOINT_ARTIFACT_V2_MAGIC));
  assert.strictEqual(written.result.data.frameCount, 3);
  assert.strictEqual(written.result.data.recordCount, 4);
  assert.strictEqual(written.result.artifactBytes, written.artifact.length);
  assert.deepStrictEqual(written.result.components.map((item) => item.component), CHECKPOINT_ARTIFACT_V2_COMPONENT_ORDER);
  assert.match(written.result.components[0].decodedSha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(
    written.result.components[1].decodedSha256,
    crypto.createHash("sha256").digest("hex"),
    "an absent component has the stable empty aggregate digest"
  );

  const opened = await readArtifact(written.artifact);
  assert.deepStrictEqual(opened.result, written.result);
  assert.deepStrictEqual(opened.records.map(({ component, field, index, value }) => ({ component, field, index, value })), [
    { component: "configuration", field: "identity", index: 0, value: { z: 1, a: 2 } },
    { component: "configuration", field: "identity", index: 1, value: ["x", 3] },
    { component: "configuration", field: "identity", index: 2, value: null },
    { component: "metadata", field: "summary", index: 0, value: { states: 4, finished: false } },
  ]);
  assert.strictEqual(JSON.stringify(opened.records[0].value), '{"z":1,"a":2}', "record property order is preserved");
});

test("stored-size overflow deterministically re-splits an incompressible multi-record frame", async () => {
  const values = [
    { blob: pseudoRandomBase64(0x12345678, 8 * 1024) },
    { blob: pseudoRandomBase64(0x9abcdef0, 8 * 1024) },
  ];
  const singles = values.map((value) => gzipSync(recordPayload(value), { level: 1 }).length);
  const combined = gzipSync(Buffer.concat(values.map(recordPayload)), { level: 1 }).length;
  const maxSingle = Math.max(...singles);
  assert.ok(combined > maxSingle + 1024, "fixture must distinguish one record from two");
  const storedLimit = Math.floor((maxSingle + combined) / 2);
  const decodedBytes = values.map(recordPayload).reduce((sum, value) => sum + value.length, 0);
  const written = await artifactFrom([{
    component: "findings",
    field: "payload",
    start: 0,
    records: values,
  }], {
    limits: {
      maxStoredFrameBytes: storedLimit,
      maxDecodedFrameBytes: decodedBytes + 32,
      maxRecordBytes: Math.max(...values.map((value) => Buffer.byteLength(JSON.stringify(value)))) + 32,
    },
  });
  assert.strictEqual(written.result.data.frameCount, 2);
  assert.deepStrictEqual(written.result.frames.map((frame) => frame.start), [0, 1]);
  assert.ok(written.result.frames.every((frame) => frame.storedBytes <= storedLimit));
  const opened = await readArtifact(written.artifact);
  assert.deepStrictEqual(opened.records.map((record) => record.value), values);
});

test("reader rejects checksum corruption and any bytes after the terminal index", async () => {
  const written = await artifactFrom([{
    component: "scheduler",
    field: "state",
    start: 0,
    records: [{ cursor: 1 }, { cursor: 2 }],
  }]);
  const first = wireFrames(written.artifact)[0];
  const corrupt = Buffer.from(written.artifact);
  corrupt[first.storedOffset + Math.floor(first.storedBytes / 2)] ^= 0x01;
  await assert.rejects(
    () => readArtifact(corrupt),
    (cause) => cause instanceof CheckpointArtifactV2Error && cause.kind === "corrupt" && cause.stage === "payload"
  );
  await assert.rejects(
    () => readArtifact(Buffer.concat([written.artifact, Buffer.from([0])])),
    (cause) => cause instanceof CheckpointArtifactV2Error && cause.kind === "corrupt" && cause.stage === "eof"
  );
});

test("corrupt numeric mismatches distinguish decoded bytes from record counts", async () => {
  const written = await artifactFrom([{
    component: "scheduler",
    field: "state",
    start: 0,
    records: [{ cursor: 1 }],
  }]);
  const first = wireFrames(written.artifact)[0];
  const stored = written.artifact.subarray(first.storedOffset, first.end);

  for (const declaredBytes of [first.header.decodedBytes - 1, first.header.decodedBytes + 1]) {
    const tampered = Buffer.concat([
      written.artifact.subarray(0, first.frameOffset),
      wireFrame({ ...first.header, decodedBytes: declaredBytes }, stored),
      written.artifact.subarray(first.end),
    ]);
    await assert.rejects(
      () => readArtifact(tampered),
      (cause) => cause instanceof CheckpointArtifactV2Error
        && cause.kind === "corrupt"
        && cause.stage === "payload"
        && cause.observed === first.header.decodedBytes
        && cause.limit === declaredBytes
        && cause.metric === "bytes"
    );
  }

  const countTampered = Buffer.concat([
    written.artifact.subarray(0, first.frameOffset),
    wireFrame({ ...first.header, recordCount: first.header.recordCount + 1 }, stored),
    written.artifact.subarray(first.end),
  ]);
  await assert.rejects(
    () => readArtifact(countTampered),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "corrupt"
      && cause.stage === "record"
      && cause.observed === first.header.recordCount
      && cause.limit === first.header.recordCount + 1
      && cause.metric === "count"
  );
});

test("magic distinguishes future framing from arbitrary corruption and truncation", async () => {
  await assert.rejects(
    () => readArtifact(Buffer.from("INKCHECKCP3\r\n", "ascii")),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "unsupported"
      && cause.stage === "magic"
  );
  await assert.rejects(
    () => readArtifact(Buffer.from("INKCHECKCP10\r\n", "ascii")),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "unsupported"
      && cause.stage === "magic"
  );
  await assert.rejects(
    () => readArtifact(Buffer.alloc(CHECKPOINT_ARTIFACT_V2_MAGIC.length, 0x58)),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "corrupt"
      && cause.stage === "magic"
  );
  await assert.rejects(
    () => readArtifact(CHECKPOINT_ARTIFACT_V2_MAGIC.subarray(0, -1)),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "corrupt"
      && cause.stage === "magic"
  );
});

test("zero-length frame header and stored prefixes are corruption, not limits", async () => {
  const zeroHeader = Buffer.alloc(8);
  zeroHeader.writeUInt32BE(1, 4);
  await assert.rejects(
    () => readArtifact(Buffer.concat([CHECKPOINT_ARTIFACT_V2_MAGIC, zeroHeader])),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "corrupt"
      && cause.stage === "header"
      && cause.metric === undefined
  );

  const zeroStored = Buffer.alloc(8);
  zeroStored.writeUInt32BE(1, 0);
  await assert.rejects(
    () => readArtifact(Buffer.concat([CHECKPOINT_ARTIFACT_V2_MAGIC, zeroStored])),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "corrupt"
      && cause.stage === "payload"
      && cause.metric === undefined
  );
});

test("terminal index binds component checksums and observed frame totals", async () => {
  const written = await artifactFrom([{
    component: "semanticIndexes",
    field: "entries",
    start: 0,
    records: [{ key: "alpha" }, { key: "beta" }],
  }]);
  const frames = wireFrames(written.artifact);
  const indexFrame = frames.at(-1);
  const decoded = gunzipSync(written.artifact.subarray(indexFrame.storedOffset, indexFrame.end));
  const recordBytes = decoded.readUInt32BE(0);
  const index = JSON.parse(decoded.subarray(4, 4 + recordBytes).toString("utf8"));
  index.components[5].decodedSha256 = "0".repeat(64);
  const replacementDecoded = recordPayload(index);
  const replacementStored = gzipSync(replacementDecoded, { level: 1 });
  const replacementHeader = {
    ...indexFrame.header,
    decodedBytes: replacementDecoded.length,
    decodedSha256: crypto.createHash("sha256").update(replacementDecoded).digest("hex"),
    storedBytes: replacementStored.length,
    storedSha256: crypto.createHash("sha256").update(replacementStored).digest("hex"),
  };
  const rawHeader = Buffer.from(JSON.stringify(replacementHeader), "utf8");
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeUInt32BE(rawHeader.length, 0);
  prefix.writeUInt32BE(replacementStored.length, 4);
  const tampered = Buffer.concat([
    written.artifact.subarray(0, indexFrame.frameOffset),
    prefix,
    rawHeader,
    replacementStored,
  ]);
  let provisionalCallbacks = 0;
  await assert.rejects(
    () => readArtifact(tampered, { onRecord: () => { provisionalCallbacks += 1; } }),
    (cause) => cause instanceof CheckpointArtifactV2Error && cause.kind === "corrupt" && cause.stage === "index"
  );
  assert.strictEqual(provisionalCallbacks, 2, "records delivered before terminal verification remain provisional");
});

test("declared bounds fail before payload decode and cancellation is honored between frames", async () => {
  const written = await artifactFrom([{
    component: "frontier",
    field: "nodes",
    start: 0,
    records: [{ value: "x".repeat(80) }, { value: "y".repeat(80) }],
  }], { limits: { maxRecordsPerFrame: 1 } });

  await assert.rejects(
    () => readArtifact(written.artifact, {
      limits: { maxDecodedFrameBytes: 64, maxRecordBytes: 60 },
    }),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "resource_limit"
      && cause.stage === "header"
      && cause.metric === "bytes"
  );

  const controller = new AbortController();
  let callbacks = 0;
  await assert.rejects(
    () => readArtifact(written.artifact, {
      signal: controller.signal,
      onRecord: () => {
        callbacks += 1;
        controller.abort();
      },
    }),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "cancelled"
      && cause.message === "checkpoint artifact operation was cancelled"
  );
  assert.strictEqual(callbacks, 1, "abort takes effect at the next frame boundary");
});

test("future frame and index versions remain unsupported when they add fields", async () => {
  const written = await artifactFrom([{
    component: "configuration",
    field: "identity",
    start: 0,
    records: [{ value: 1 }],
  }]);
  const frames = wireFrames(written.artifact);
  const first = frames[0];
  const futureHeader = { ...first.header, version: 3, futureFlag: true };
  const futureHeaderArtifact = Buffer.concat([
    written.artifact.subarray(0, first.frameOffset),
    wireFrame(futureHeader, written.artifact.subarray(first.storedOffset, first.end)),
    written.artifact.subarray(first.end),
  ]);
  await assert.rejects(
    () => readArtifact(futureHeaderArtifact),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "unsupported"
      && cause.stage === "header"
  );

  const indexFrame = frames.at(-1);
  const decoded = gunzipSync(written.artifact.subarray(indexFrame.storedOffset, indexFrame.end));
  const recordBytes = decoded.readUInt32BE(0);
  const futureIndex = JSON.parse(decoded.subarray(4, 4 + recordBytes).toString("utf8"));
  futureIndex.version = 3;
  futureIndex.futureFlag = true;
  const replacementDecoded = recordPayload(futureIndex);
  const replacementStored = gzipSync(replacementDecoded, { level: 1 });
  const replacementHeader = {
    ...indexFrame.header,
    decodedBytes: replacementDecoded.length,
    decodedSha256: digest(replacementDecoded),
    storedBytes: replacementStored.length,
    storedSha256: digest(replacementStored),
  };
  const futureIndexArtifact = Buffer.concat([
    written.artifact.subarray(0, indexFrame.frameOffset),
    wireFrame(replacementHeader, replacementStored),
  ]);
  await assert.rejects(
    () => readArtifact(futureIndexArtifact),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "unsupported"
      && cause.stage === "index"
  );
});

test("reader enforces JSON depth before canonical reserialization", async () => {
  let value = 0;
  for (let depth = 0; depth < 40; depth++) value = [value];
  const written = await artifactFrom([{
    component: "configuration",
    field: "identity",
    start: 0,
    records: [value],
  }]);
  await assert.rejects(
    () => readArtifact(written.artifact, { limits: { maxJsonDepth: 32 } }),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "resource_limit"
      && cause.stage === "record"
      && cause.observed === 33
      && cause.limit === 32
      && cause.metric === "depth"
  );

  let tooDeep = 0;
  for (let depth = 0; depth < 513; depth++) tooDeep = [tooDeep];
  const destination = new PassThrough();
  destination.resume();
  await assert.rejects(
    () => writeCheckpointArtifactV2(destination, [{
      component: "configuration",
      field: "identity",
      start: 0,
      records: [tooDeep],
    }]),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "resource_limit"
      && cause.stage === "record"
      && cause.observed === 513
      && cause.limit === 512
      && cause.metric === "depth"
  );
  assert.strictEqual(destination.destroyed, true);
});

test("resource-limit metrics distinguish frame and record counts from bytes and depth", async () => {
  await assert.rejects(
    () => artifactFrom([{
      component: "configuration",
      field: "identity",
      start: 0,
      records: [1, 2],
    }], { limits: { maxFrames: 1, maxRecordsPerFrame: 1 } }),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "resource_limit"
      && cause.stage === "header"
      && cause.observed === 2
      && cause.limit === 1
      && cause.metric === "count"
  );

  await assert.rejects(
    () => artifactFrom([{
      component: "configuration",
      field: "identity",
      start: 0,
      records: [1, 2],
    }], { limits: { maxTotalRecords: 1 } }),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "resource_limit"
      && cause.stage === "record"
      && cause.observed === 2
      && cause.limit === 1
      && cause.metric === "count"
  );
});

test("reader owns its source on errors and abort interrupts a stalled read", async () => {
  class OpenReadable extends Readable {
    constructor(chunk) {
      super();
      this.chunk = chunk;
    }

    _read() {
      if (!this.chunk) return;
      const chunk = this.chunk;
      this.chunk = undefined;
      this.push(chunk);
    }
  }

  const invalid = new OpenReadable(Buffer.alloc(CHECKPOINT_ARTIFACT_V2_MAGIC.length, 0x58));
  await assert.rejects(
    () => readCheckpointArtifactV2(invalid, { onRecord() {} }),
    (cause) => cause instanceof CheckpointArtifactV2Error && cause.stage === "magic"
  );
  assert.strictEqual(invalid.destroyed, true, "an early parse failure closes the owned source");
  for (const event of ["close", "error", "end", "readable", "finish"]) {
    assert.strictEqual(invalid.listenerCount(event), 0, `iterator ${event} listener is released`);
  }

  const stalled = new OpenReadable();
  const controller = new AbortController();
  const reading = readCheckpointArtifactV2(stalled, {
    signal: controller.signal,
    onRecord() {},
  });
  setImmediate(() => controller.abort());
  await assert.rejects(
    () => reading,
    (cause) => cause instanceof CheckpointArtifactV2Error && cause.kind === "cancelled"
  );
  assert.strictEqual(stalled.destroyed, true, "abort closes a source blocked in iterator.next()");
  assert.strictEqual(getEventListeners(controller.signal, "abort").length, 0, "abort listener is released");
  for (const event of ["close", "error", "end", "readable", "finish"]) {
    assert.strictEqual(stalled.listenerCount(event), 0, `aborted iterator ${event} listener is released`);
  }
});

test("writer aborts stalled outer and record iterators without awaiting return", async () => {
  const outer = stalledAsyncIterable();
  const outerDestination = new PassThrough();
  outerDestination.resume();
  const outerController = new AbortController();
  const outerWrite = writeCheckpointArtifactV2(outerDestination, outer.values, {
    signal: outerController.signal,
  });
  await outer.started;
  outerController.abort();
  await assert.rejects(
    () => outerWrite,
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "cancelled"
      && cause.stage === "prefix"
  );
  assert.strictEqual(outer.returnCalls, 1, "outer iterator receives best-effort return");
  assert.strictEqual(outerDestination.destroyed, true, "outer stall releases the owned destination");
  assert.strictEqual(getEventListeners(outerController.signal, "abort").length, 0);

  const records = stalledAsyncIterable();
  const recordDestination = new PassThrough();
  recordDestination.resume();
  const recordController = new AbortController();
  const recordWrite = writeCheckpointArtifactV2(recordDestination, [{
    component: "configuration",
    field: "identity",
    start: 0,
    records: records.values,
  }], { signal: recordController.signal });
  await records.started;
  recordController.abort();
  await assert.rejects(
    () => recordWrite,
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "cancelled"
      && cause.stage === "record"
  );
  assert.strictEqual(records.returnCalls, 1, "record iterator receives best-effort return");
  assert.strictEqual(recordDestination.destroyed, true, "record stall releases the owned destination");
  assert.strictEqual(getEventListeners(recordController.signal, "abort").length, 0);
});

test("configured limits cannot exceed runtime string or structural ceilings", async () => {
  const source = new Readable({ read() {} });
  await assert.rejects(
    () => readCheckpointArtifactV2(source, {
      limits: { maxHeaderBytes: bufferConstants.MAX_STRING_LENGTH + 1 },
      onRecord() {},
    }),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "resource_limit"
      && cause.stage === "header"
      && cause.limit === bufferConstants.MAX_STRING_LENGTH
      && cause.metric === "bytes"
  );
  assert.strictEqual(source.destroyed, true, "invalid read limits still close the owned source");

  const destination = new PassThrough();
  await assert.rejects(
    () => writeCheckpointArtifactV2(destination, [], { limits: { maxJsonDepth: 513 } }),
    (cause) => cause instanceof CheckpointArtifactV2Error
      && cause.kind === "resource_limit"
      && cause.stage === "record"
      && cause.limit === 512
      && cause.metric === "depth"
  );
  assert.strictEqual(destination.destroyed, true, "invalid write limits close the owned destination");
});
