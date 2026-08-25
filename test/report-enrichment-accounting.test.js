const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const artifacts = require("../dist/artifacts");
const reportContract = require("../dist/report-contract");
const {
  buildReportEnvelope,
  buildReportEnvelopeAccounted,
  measureLogicalJsonGraphV1,
} = reportContract;

function compactUtf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function reportInput(privateMarker = "PRIVATE-REPORT-MARKER") {
  const largeFinding = `${privateMarker}-${"é🧪\"\\\n".repeat(32_768)}`;
  const sharedVariables = { score: 7, label: "共享" };
  const explore = {
    statesExplored: 3,
    endingsFound: [{
      path: ["終わり"],
      choiceIndices: [0],
      firstDiscoveredAtState: 3,
      finalText: largeFinding,
      variables: sharedVariables,
    }],
    runtimeErrors: [{
      message: largeFinding,
      path: ["échec"],
      choiceIndices: [1],
      firstDiscoveredAtState: 2,
      sourceLocation: { file: "物語.ink", line: 7, approximate: true },
    }],
    assertionResults: [],
    runtimeWarnings: [],
    unvisitedKnots: [],
    visitedKnots: [],
    externalFunctionsStubbed: [],
    randomnessDetected: false,
    truncated: false,
    truncatedBy: {
      maxDepth: false,
      maxStates: false,
      beamWidth: false,
      frontier: false,
      memory: false,
      time: false,
    },
    exhaustive: true,
    limits: { maxDepth: 10, maxStates: 10, seed: 1, storySeed: 2 },
  };
  return {
    compile: {
      success: true,
      issues: [{
        severity: "WARNING",
        file: "物語.ink",
        line: 1,
        message: largeFinding,
        raw: largeFinding,
      }],
      errors: 0,
      warnings: 1,
      todos: 0,
    },
    explore,
    nextRun: {
      recommendation: "stop",
      stop: true,
      flags: { maxDepth: 10, maxStates: 10, seed: 1 },
      rationale: "exhaustive fixture",
      expectedGain: "none",
    },
    storyJson: "{\"inkVersion\":21,\"root\":[\"^こんにちは\",\"end\",null]}",
    configuration: {
      search: "shared",
      minRepro: false,
      strict: false,
      maxMemoryMb: null,
      maxTimeSec: null,
      maxFrontierStates: null,
      maxFrontierMb: null,
      goalMaxStates: 0,
      storySeed: 2,
    },
  };
}

test("accounted report enrichment is deep-equal, nonmutating, UTF-8 exact, and private", () => {
  const privateMarker = "PRIVATE-ENRICHMENT-UNICODE-MARKER";
  const input = reportInput(privateMarker);
  const before = structuredClone(input);
  const ordinary = buildReportEnvelope(input);
  const accounted = buildReportEnvelopeAccounted(input);

  assert.deepStrictEqual(accounted.report, ordinary);
  assert.deepStrictEqual(input, before, "the opt-in builder does not mutate its report input");
  assert.strictEqual(
    accounted.accounting.sourceExploreGraph.logicalJsonUtf8Bytes,
    compactUtf8Bytes(input.explore)
  );
  assert.strictEqual(
    accounted.accounting.returnedReportGraph.logicalJsonUtf8Bytes,
    compactUtf8Bytes(accounted.report)
  );
  assert.strictEqual(accounted.accounting.findingIdentityStrings.count, 3);
  assert.ok(accounted.accounting.findingIdentityStrings.logicalUtf8Bytes > 300_000);
  assert.strictEqual(
    accounted.accounting.graphOwnership.conservativePotentialLogicalJsonUtf8Bytes,
    accounted.accounting.sourceExploreGraph.logicalJsonUtf8Bytes
      + accounted.accounting.returnedReportGraph.logicalJsonUtf8Bytes
  );
  assert.strictEqual(
    accounted.accounting.graphOwnership.currentReturnedLogicalJsonUtf8Bytes,
    accounted.accounting.returnedReportGraph.logicalJsonUtf8Bytes
  );
  assert.ok(
    accounted.accounting.returnedReportGraph.logicalJsonUtf8Bytes > JSON.stringify(accounted.report).length,
    "non-ASCII findings distinguish UTF-8 bytes from JavaScript code units"
  );
  assert.strictEqual(JSON.stringify(accounted.accounting).includes(privateMarker), false,
    "numeric accounting does not copy authored prose or finding content");
});

test("the logical JSON graph counter is streaming over depth and fails closed on active hooks", () => {
  const shared = { text: "é🧪", optional: undefined };
  const dag = { left: shared, right: shared, array: [undefined, shared, NaN] };
  assert.strictEqual(measureLogicalJsonGraphV1(dag).logicalJsonUtf8Bytes, compactUtf8Bytes(dag));

  const escaped = {
    [`key-\ud800-\"`]: `\u0000\b\t\n\f\r\u001f\"\\\u2028\u2029\ud800\udc00🧪${"界".repeat(100_000)}`,
    numbers: [-0, 0, 1.25, 1e-7, 1e21, Number.MAX_VALUE, NaN, Infinity, -Infinity],
  };
  const escapedBytes = compactUtf8Bytes(escaped);
  const originalStringify = JSON.stringify;
  let graphSerializations = 0;
  JSON.stringify = function (value, ...args) {
    graphSerializations++;
    return originalStringify.call(JSON, value, ...args);
  };
  try {
    assert.strictEqual(measureLogicalJsonGraphV1(escaped).logicalJsonUtf8Bytes, escapedBytes);
  } finally {
    JSON.stringify = originalStringify;
  }
  assert.strictEqual(graphSerializations, 0,
    "graph measurement counts strings, keys, and numeric scalars without invoking JSON.stringify");

  let deep = null;
  const depth = 20_000;
  for (let index = 0; index < depth; index++) deep = { n: deep };
  assert.strictEqual(measureLogicalJsonGraphV1(deep).logicalJsonUtf8Bytes, depth * 6 + 4,
    "the explicit traversal stack does not depend on JSON.stringify's recursion depth");

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => measureLogicalJsonGraphV1(cyclic), /circular structure/i);
  assert.throws(() => measureLogicalJsonGraphV1({ value: 1n }), /BigInt/);
  assert.throws(() => measureLogicalJsonGraphV1(new String("boxed")), /plain objects or arrays/);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "private", {
    enumerable: true,
    get() {
      getterCalls++;
      return "should-not-run";
    },
  });
  assert.throws(() => measureLogicalJsonGraphV1(accessor), /accessor properties/);
  assert.strictEqual(getterCalls, 0);

  let toJsonCalls = 0;
  const activeHook = {
    toJSON() {
      toJsonCalls++;
      return { leaked: true };
    },
  };
  assert.throws(() => measureLogicalJsonGraphV1(activeHook), /toJSON hooks/);
  assert.strictEqual(toJsonCalls, 0);

  let callableHookCalls = 0;
  function callable() {}
  callable.toJSON = () => {
    callableHookCalls++;
    return { leaked: true };
  };
  assert.throws(() => measureLogicalJsonGraphV1({ callable }), /toJSON hooks/);
  assert.strictEqual(callableHookCalls, 0, "callable toJSON hooks are rejected before ordinary function omission");

  let inheritedHookCalls = 0;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    value() {
      inheritedHookCalls++;
      return { leaked: true };
    },
  });
  try {
    assert.throws(() => measureLogicalJsonGraphV1({ ordinary: true }), /toJSON hooks/);
    assert.strictEqual(inheritedHookCalls, 0);
  } finally {
    delete Object.prototype.toJSON;
  }

  let proxyTraps = 0;
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      proxyTraps++;
      return Object.prototype;
    },
    ownKeys() {
      proxyTraps++;
      return [];
    },
  });
  assert.throws(() => measureLogicalJsonGraphV1(proxy), /Proxy containers/);
  assert.strictEqual(proxyTraps, 0);
  assert.throws(() => measureLogicalJsonGraphV1(Object.create(proxy)), /Proxy containers/);
  assert.strictEqual(proxyTraps, 0, "proxy prototypes are rejected before descriptor reflection");
});

test("report create and reuse account distinct graphs without changing IDs, payloads, or I/O", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-report-enrichment-"));
  const file = path.join(root, "物語.ink");
  const privateMarker = "PRIVATE-FINALIZATION-MARKER";
  try {
    fs.writeFileSync(file, "こんにちは\n-> END\n");
    const built = buildReportEnvelopeAccounted(reportInput(privateMarker));
    const originalStringify = JSON.stringify;
    let prettySerializations = 0;
    JSON.stringify = function (value, replacer, space) {
      if (space !== undefined) prettySerializations++;
      return originalStringify.call(JSON, value, replacer, space);
    };
    let created;
    try {
      created = artifacts.saveReportArtifact(root, file, built.report, {}, built.accounting);
    } finally {
      JSON.stringify = originalStringify;
    }
    assert.strictEqual(prettySerializations, 1, "create performs the existing single artifact serialization");
    const destination = path.join(root, ...created.path.split("/"));
    const durableBefore = fs.readFileSync(destination);
    const savedArtifact = JSON.parse(durableBefore.toString("utf8"));
    assert.deepStrictEqual(savedArtifact.report, built.report);
    assert.strictEqual(Object.hasOwn(savedArtifact, "accounting"), false);
    assert.strictEqual(Object.hasOwn(savedArtifact.report, "accounting"), false);
    assert.deepStrictEqual(created.accounting.reportEnrichment, {
      status: "applied",
      accounting: built.accounting,
    });
    assert.strictEqual(created.accounting.graphMaterialization.createdEnvelope.status, "applied");
    assert.strictEqual(created.accounting.graphMaterialization.reuseParsedArtifact.status, "not_applied");
    assert.strictEqual(
      created.accounting.graphMaterialization.createdEnvelope.graph.logicalJsonUtf8Bytes,
      compactUtf8Bytes(savedArtifact)
    );
    assert.deepStrictEqual(created.accounting.graphMaterialization.conservativePotential, {
      status: "applied",
      logicalJsonUtf8Bytes: created.accounting.graphMaterialization.createdEnvelope.graph.logicalJsonUtf8Bytes,
    });
    assert.strictEqual(created.accounting.graphMaterialization.currentLogicalJsonUtf8Bytes, 0);
    assert.strictEqual(
      created.accounting.serialization.conservativePotentialStringUtf8Bytes,
      created.accounting.reportIdentity.logicalUtf8Bytes
        + created.accounting.serialization.logicalArtifactUtf8Bytes,
      "graph proxies are not folded into the separate string total"
    );
    assert.strictEqual(JSON.stringify(created.accounting).includes(privateMarker), false);

    const originalReadFileSync = fs.readFileSync;
    const originalParse = JSON.parse;
    let artifactReads = 0;
    let parses = 0;
    prettySerializations = 0;
    fs.readFileSync = (candidate, ...args) => {
      if (path.resolve(String(candidate)) === path.resolve(destination)) artifactReads++;
      return originalReadFileSync(candidate, ...args);
    };
    JSON.parse = function (...args) {
      parses++;
      return originalParse.apply(JSON, args);
    };
    JSON.stringify = function (value, replacer, space) {
      if (space !== undefined) prettySerializations++;
      return originalStringify.call(JSON, value, replacer, space);
    };
    let reused;
    try {
      reused = artifacts.saveReportArtifact(root, file, built.report, {}, built.accounting);
    } finally {
      fs.readFileSync = originalReadFileSync;
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
    }
    assert.strictEqual(artifactReads, 1, "reuse derives all accounting from the existing validation read");
    assert.strictEqual(parses, 1, "reuse counts the graph returned by the existing validation parse");
    assert.strictEqual(prettySerializations, 0, "reuse does not serialize a replacement artifact");
    assert.deepStrictEqual({ id: reused.id, path: reused.path }, { id: created.id, path: created.path });
    assert.strictEqual(reused.accounting.graphMaterialization.createdEnvelope.status, "not_applied");
    assert.strictEqual(reused.accounting.graphMaterialization.reuseParsedArtifact.status, "applied");
    assert.strictEqual(
      reused.accounting.graphMaterialization.reuseParsedArtifact.graph.logicalJsonUtf8Bytes,
      compactUtf8Bytes(savedArtifact)
    );
    assert.strictEqual(
      reused.accounting.serialization.conservativePotentialStringUtf8Bytes,
      reused.accounting.reportIdentity.logicalUtf8Bytes
        + reused.accounting.readback.rawArtifactString.logicalUtf8Bytes
        + reused.accounting.readback.validationIdentity.logicalUtf8Bytes,
      "reuse graph proxies are not folded into string materialization totals"
    );
    assert.deepStrictEqual(fs.readFileSync(destination), durableBefore);

    const originalMeasure = reportContract.measureLogicalJsonGraphV1;
    let legacyGraphWalks = 0;
    artifactReads = 0;
    parses = 0;
    prettySerializations = 0;
    fs.readFileSync = (candidate, ...args) => {
      if (path.resolve(String(candidate)) === path.resolve(destination)) artifactReads++;
      return originalReadFileSync(candidate, ...args);
    };
    JSON.parse = function (...args) {
      parses++;
      return originalParse.apply(JSON, args);
    };
    JSON.stringify = function (value, replacer, space) {
      if (space !== undefined) prettySerializations++;
      return originalStringify.call(JSON, value, replacer, space);
    };
    reportContract.measureLogicalJsonGraphV1 = (...args) => {
      legacyGraphWalks++;
      return originalMeasure(...args);
    };
    let legacy;
    try {
      legacy = artifacts.saveReportArtifact(root, file, built.report);
    } finally {
      fs.readFileSync = originalReadFileSync;
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
      reportContract.measureLogicalJsonGraphV1 = originalMeasure;
    }
    assert.strictEqual(artifactReads, 1);
    assert.strictEqual(parses, 1);
    assert.strictEqual(prettySerializations, 0);
    assert.strictEqual(legacyGraphWalks, 0, "legacy reuse adds no report or artifact graph traversal");
    assert.deepStrictEqual(legacy.accounting.reportEnrichment, {
      status: "not_applied",
      reason: "unavailable",
    });
    assert.strictEqual(Object.hasOwn(legacy.accounting.reportEnrichment, "accounting"), false);
    assert.strictEqual(legacy.id, created.id);
    assert.deepStrictEqual(legacy.accounting.graphMaterialization.reuseParsedArtifact, {
      status: "not_applied",
      reason: "unavailable",
    });
    assert.deepStrictEqual(legacy.accounting.graphMaterialization.conservativePotential, {
      status: "not_applied",
      reason: "unavailable",
    });

    const legacyFile = path.join(root, "legacy.ink");
    fs.writeFileSync(legacyFile, "Legacy\n-> END\n");
    const legacyReport = { ...built.report, runs: [new Date(0)] };
    const legacyCreated = artifacts.saveReportArtifact(root, legacyFile, legacyReport);
    assert.deepStrictEqual(legacyCreated.accounting.graphMaterialization.createdEnvelope, {
      status: "not_applied",
      reason: "unavailable",
    });
    assert.deepStrictEqual(legacyCreated.accounting.graphMaterialization.conservativePotential, {
      status: "not_applied",
      reason: "unavailable",
    });
    const legacySaved = JSON.parse(fs.readFileSync(path.join(root, ...legacyCreated.path.split("/")), "utf8"));
    assert.deepStrictEqual(legacySaved.report.runs, ["1970-01-01T00:00:00.000Z"],
      "unaccounted legacy creates preserve the existing serializer's behavior");

    const tainted = { ...built.accounting, privateMarker };
    const projected = artifacts.saveReportArtifact(root, file, built.report, {}, tainted);
    assert.strictEqual(JSON.stringify(projected.accounting).includes(privateMarker), false,
      "the finalization receipt projects the trusted numeric schema instead of copying arbitrary keys");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
