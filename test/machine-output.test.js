const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const {
  MAX_STANDARD_MACHINE_RESPONSE_BYTES,
  machineFindingSummaries,
  projectMachineReport,
} = require("../dist/machine-output");

function finding(kind, index, extra = {}) {
  return {
    id: `${kind}:${String(index).padStart(16, "0")}`,
    kind,
    path: [`PRIVATE STORY CHOICE ${index}`],
    choiceIndices: [index],
    finalText: `PRIVATE STORY PROSE ${index}`,
    variables: { secret: `PRIVATE VARIABLE ${index}` },
    witness: { choiceText: [`PRIVATE WITNESS ${index}`], choiceIndices: [index] },
    replay: { tool: "playtest_story", choices: [index], storySeed: 1 },
    ...extra,
  };
}

function largeReport() {
  const runtimeErrors = Array.from({ length: 2_000 }, (_, index) => finding("runtime.error", index, {
    sourceLocation: { file: `${"deep/".repeat(100)}story.ink`, line: index + 1, approximate: true },
  }));
  const endingsFound = Array.from({ length: 2_000 }, (_, index) => finding("ending.reached", index));
  return {
    schemaVersion: 1,
    inkcheckVersion: "0.6.0-test",
    storyFingerprint: { algorithm: "sha256", source: "compiled-story", value: "a".repeat(64) },
    effectiveConfiguration: {
      search: "portfolio",
      concurrency: 4,
      minRepro: true,
      storySeed: 1,
      limits: { maxDepth: 100, maxStates: 1_000_000, storySeed: 1 },
      assertions: [{ id: "PRIVATE ASSERTION", description: "PRIVATE RULE" }],
      goals: [{ id: "PRIVATE GOAL", description: "PRIVATE TARGET" }],
    },
    bindingLimit: "maxStates",
    compile: { success: true, issues: [] },
    explore: {
      statesExplored: 1_000_000,
      runtimeErrors,
      endingsFound,
      assertionResults: [],
      goalResults: [],
      visitedKnots: ["private_knot"],
      unvisitedKnots: [{ name: "private_unvisited", file: "story.ink", line: 999 }],
      runtimeWarnings: [],
      externalFunctionsStubbed: [],
      randomnessDetected: false,
      truncated: true,
      truncatedBy: { maxDepth: false, maxStates: true, beamWidth: false, frontier: false, memory: false, time: false },
      exhaustive: false,
      limits: { maxDepth: 100, maxStates: 1_000_000, storySeed: 1 },
      execution: {
        mode: "concurrent",
        requestedConcurrency: 4,
        effectiveConcurrency: 4,
        resources: {
          stateBudget: 1_000_000,
          heapEnvelopeBytes: 1_073_741_824,
          parentReserveBytes: 161_061_274,
          perWorkerHeapLimitBytes: 228_170_137,
          totalWorkerHeapLimitBytes: 912_680_550,
          peakTrackedHeapBytes: 734_003_200,
          aggregateMemoryStopped: false,
        },
        workers: [
          { pass: "dfs:last", granted: 200_000, consumed: 200_000, status: "completed", error: "PRIVATE WORKER ERROR" },
          { pass: "random:7", granted: 200_000, consumed: 150_000, status: "time" },
        ],
      },
      passes: Array.from({ length: 1_000 }, (_, index) => ({ pass: `PRIVATE PASS ${index}` })),
    },
    nextRun: {
      recommendation: "broaden",
      stop: false,
      flags: { maxDepth: 100, maxStates: 4_000_000 },
      rationale: "state budget remained productive",
      expectedGain: "more bounded evidence",
    },
    shadowDecision: { private: "PRIVATE POLICY DETAIL" },
  };
}

test("default machine detail stays bounded and keeps response truncation separate from search truncation", () => {
  const report = largeReport();
  const projected = projectMachineReport(report);
  const serialized = JSON.stringify(projected);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= MAX_STANDARD_MACHINE_RESPONSE_BYTES);
  assert.strictEqual(projected.response.detail, "standard");
  assert.strictEqual(projected.response.dataTruncated, true);
  assert.strictEqual(projected.response.explorationTruncated, true);
  assert.deepStrictEqual(projected.response.findings, { returned: 20, total: 4_000, omitted: 3_980, pageLimit: 20 });
  assert.strictEqual(projected.findings.length, 20);
  assert.strictEqual(projected.explore.runtimeErrorCount, 2_000);
  assert.strictEqual(projected.explore.endingCount, 2_000);
  assert.strictEqual(projected.effectiveConfiguration.concurrency, 4);
  assert.deepStrictEqual(projected.explore.execution, {
    mode: "concurrent",
    requestedConcurrency: 4,
    effectiveConcurrency: 4,
    resources: {
      stateBudget: 1_000_000,
      heapEnvelopeBytes: 1_073_741_824,
      parentReserveBytes: 161_061_274,
      perWorkerHeapLimitBytes: 228_170_137,
      totalWorkerHeapLimitBytes: 912_680_550,
      peakTrackedHeapBytes: 734_003_200,
      aggregateMemoryStopped: false,
    },
    workers: [
      { pass: "dfs:last", granted: 200_000, consumed: 200_000, status: "completed" },
      { pass: "random:7", granted: 200_000, consumed: 150_000, status: "time" },
    ],
  });
  assert.ok(!serialized.includes("PRIVATE STORY"));
  assert.ok(!serialized.includes("PRIVATE VARIABLE"));
  assert.ok(!serialized.includes("PRIVATE WITNESS"));
  assert.ok(!serialized.includes("PRIVATE ASSERTION"));
  assert.ok(!serialized.includes("PRIVATE POLICY"));
  assert.ok(!serialized.includes("PRIVATE WORKER ERROR"));
  assert.strictEqual(projected.findings[0].sourceLocation.pathTruncated, true);
});

test("summary, standard, and full detail form an explicit privacy and drill-down ladder", () => {
  const report = largeReport();
  const summary = projectMachineReport(report, "summary");
  const standard = projectMachineReport(report, "standard", 7);
  const full = projectMachineReport(report, "full");
  assert.strictEqual(summary.findings, undefined);
  assert.strictEqual(summary.response.findings.returned, 0);
  assert.strictEqual(summary.response.findings.omitted, 4_000);
  assert.strictEqual(standard.findings.length, 7);
  assert.strictEqual(standard.response.findings.omitted, 3_993);
  assert.strictEqual(full.response.dataTruncated, false);
  assert.strictEqual(full.explore.runtimeErrors.length, 2_000);
  assert.ok(JSON.stringify(full).includes("PRIVATE STORY PROSE"));
  assert.deepStrictEqual(machineFindingSummaries(report).map((item) => item.kind).slice(0, 2), [
    "runtime.error",
    "runtime.error",
  ]);
});

test("machine response limits reject unsafe caller values", () => {
  const report = largeReport();
  assert.throws(() => projectMachineReport(report, "standard", 0), /integer from 1 to 100/);
  assert.throws(() => projectMachineReport(report, "standard", 101), /integer from 1 to 100/);
});

test("large compile diagnostics remain actionable without exceeding the standard response bound", () => {
  const issues = Array.from({ length: 5_000 }, (_, index) => ({
    id: `compile.error:${String(index).padStart(16, "0")}`,
    kind: "compile.error",
    severity: "ERROR",
    file: `${"nested/".repeat(100)}story.ink`,
    line: index + 1,
    message: `Missing divert target_${index} ${"detail ".repeat(200)}`,
  }));
  const projected = projectMachineReport({
    schemaVersion: 1,
    inkcheckVersion: "0.6.0-test",
    bindingLimit: null,
    compile: { success: false, issues },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(projected), "utf8") <= MAX_STANDARD_MACHINE_RESPONSE_BYTES);
  assert.strictEqual(projected.compile.issueCount, 5_000);
  assert.strictEqual(projected.findings.length, 20);
  assert.match(projected.findings[0].message, /Missing divert target_0/);
  assert.ok(projected.findings[0].message.length <= 512);
  assert.strictEqual(projected.response.findings.omitted, 4_980);
});

test("MCP compact profile stays below the agent bootstrap target and routes later workflow operations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-compact-mcp-"));
  const story = path.join(root, "story.ink");
  fs.writeFileSync(story, "A bounded opening.\n* [Continue] A bounded ending.\n  -> END\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "dist", "server.js")],
    cwd: root,
    env: { ...process.env, INKCHECK_MCP_PROFILE: "compact" },
    stderr: "pipe",
  });
  const client = new Client({ name: "inkcheck-compact-profile-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.deepStrictEqual(
      catalog.tools.map((tool) => tool.name).sort(),
      ["compile_story", "inkcheck_capabilities", "inkcheck_workflow", "inspect_story", "start_search"]
    );
    const skillBytes = fs.readFileSync(path.join(__dirname, "..", "skills", "inkcheck", "SKILL.md")).byteLength;
    const toolCatalogBytes = Buffer.byteLength(JSON.stringify(catalog.tools), "utf8");
    const estimatedBootstrapTokens = Math.ceil((skillBytes + toolCatalogBytes) / 4);
    assert.ok(estimatedBootstrapTokens <= 3_000, `estimated bootstrap was ${estimatedBootstrapTokens} tokens`);

    const capabilitiesCall = await client.callTool({ name: "inkcheck_capabilities", arguments: {} });
    const discovered = JSON.parse(capabilitiesCall.content[0].text);
    assert.strictEqual(discovered.mcp.profile, "compact");
    assert.deepStrictEqual(discovered.mcp.fullProfileEnvironment, { INKCHECK_MCP_PROFILE: "full" });
    assert.deepStrictEqual(discovered.mcp.workflowOperations.inspect_search.required, ["file", "sessionCapability"]);

    const startedCall = await client.callTool({ name: "start_search", arguments: { file: story, maxStates: 100 } });
    const started = JSON.parse(startedCall.content[0].text);
    const inspectedCall = await client.callTool({
      name: "inkcheck_workflow",
      arguments: {
        operation: "inspect_search",
        request: { file: story, sessionCapability: started.sessionCapability },
      },
    });
    const inspected = JSON.parse(inspectedCall.content[0].text);
    assert.strictEqual(inspected.session.id, started.session.id);

    const invalidCall = await client.callTool({
      name: "inkcheck_workflow",
      arguments: { operation: "inspect_search", request: { file: story } },
    });
    assert.strictEqual(invalidCall.isError, true);
    assert.match(invalidCall.content[0].text, /sessionCapability/);
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP explore_story defaults to compact standard detail and requires explicit full disclosure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-machine-output-mcp-"));
  const story = path.join(root, "story.ink");
  fs.writeFileSync(story, "A private opening.\n* [Private choice] Private ending.\n  -> END\n");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "dist", "server.js")],
    cwd: root,
    env: { ...process.env, INKCHECK_MCP_PROFILE: "full" },
    stderr: "pipe",
  });
  const client = new Client({ name: "inkcheck-machine-output-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.ok(catalog.tools.some((tool) => tool.name === "story_stats"));
    assert.ok(catalog.tools.some((tool) => tool.name === "explore_story"));
    assert.ok(catalog.tools.some((tool) => tool.name === "inkcheck_workflow"));
    const inspectionCall = await client.callTool({ name: "inspect_story", arguments: { file: story } });
    const inspection = JSON.parse(inspectionCall.content[0].text);
    assert.strictEqual(inspection.response.detail, "summary");
    assert.strictEqual(inspection.recommendedNextOperation, "compile_story");

    const compileCall = await client.callTool({ name: "compile_story", arguments: { file: story } });
    const compiled = JSON.parse(compileCall.content[0].text);
    assert.strictEqual(compiled.response.detail, "standard");
    assert.strictEqual(compiled.compile.success, true);

    const statsCall = await client.callTool({ name: "story_stats", arguments: { file: story } });
    const storyStats = JSON.parse(statsCall.content[0].text);
    assert.strictEqual(storyStats.response.detail, "standard");
    assert.ok(storyStats.knot_list.length <= 20);

    const manyKnots = path.join(root, "many-knots.ink");
    fs.writeFileSync(manyKnots, Array.from({ length: 500 }, (_, index) => `== knot_${index}\n-> END`).join("\n"));
    const largeStatsCall = await client.callTool({ name: "story_stats", arguments: { file: manyKnots } });
    const largeStats = JSON.parse(largeStatsCall.content[0].text);
    assert.strictEqual(largeStats.knot_list.length, 20);
    assert.strictEqual(largeStats.response.knots.total, 500);
    assert.strictEqual(largeStats.response.dataTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(largeStats), "utf8") <= MAX_STANDARD_MACHINE_RESPONSE_BYTES);

    const compactCall = await client.callTool({
      name: "explore_story",
      arguments: { file: story, maxStates: 100 },
    });
    const compact = JSON.parse(compactCall.content[0].text);
    assert.strictEqual(compact.response.detail, "standard");
    assert.strictEqual(compact.explore.endingCount, 1);
    assert.strictEqual(compact.explore.endingsFound, undefined);
    assert.strictEqual(compact.effectiveConfiguration.concurrencyMode, "auto");
    assert.strictEqual(compact.effectiveConfiguration.concurrency, 4);
    assert.strictEqual(compact.explore.execution.activation.policyVersion, "single-pass-frontier-v3");
    assert.strictEqual(compact.explore.execution.activation.reason, "budget_below_pilot");
    assert.strictEqual(compact.explore.execution.activation.duplicateStateEvaluations, 0);
    assert.ok(!JSON.stringify(compact).includes("Private ending"));

    const sustainedCall = await client.callTool({
      name: "explore_story",
      arguments: {
        file: path.join(__dirname, "..", "examples", "early-choice-grid.ink"),
        maxStates: 100_000,
        maxDepth: 100,
        minRepro: false,
      },
    });
    const sustained = JSON.parse(sustainedCall.content[0].text);
    assert.strictEqual(sustained.effectiveConfiguration.concurrencyMode, "auto");
    assert.strictEqual(sustained.explore.execution.activation.decision, "activate_concurrent");
    assert.strictEqual(sustained.explore.execution.activation.reason, "pilot_open_frontier");
    assert.strictEqual(sustained.explore.execution.activation.duplicateStateEvaluations, 0);
    assert.ok(sustained.explore.execution.effectiveConcurrency >= 1);
    assert.ok(sustained.explore.statesExplored <= 100_000);

    const fullCall = await client.callTool({
      name: "explore_story",
      arguments: { file: story, maxStates: 100, detail: "full" },
    });
    const full = JSON.parse(fullCall.content[0].text);
    assert.strictEqual(full.response.detail, "full");
    assert.strictEqual(full.explore.endingsFound.length, 1);
    assert.ok(JSON.stringify(full).includes("Private ending"));
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
