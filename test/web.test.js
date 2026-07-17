const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const {
  SubmissionError,
  validateSubmission,
} = require("../dist/web-validation");
const {
  applyBrowserOrigin,
  createInkcheckWebServer,
  gracefulTimeoutSeconds,
  parseMultipartBody,
  webConfigFromEnv,
} = require("../dist/web");
const { FileHostedJobStore } = require("../dist/hosted-job-store");

const LIMITS = {
  maxBodyBytes: 5242880,
  maxFiles: 200,
  maxFileBytes: 2621440,
  maxDepth: 1000,
  maxStates: 100000,
};

function validBody(overrides = {}) {
  return {
    root: "main.ink",
    files: {
      "main.ink": "INCLUDE chapters/one.ink\n-> one",
      "chapters/one.ink": "=== one ===\nHello.\n-> END",
    },
    maxDepth: 30,
    maxStates: 500,
    authorized: true,
    privacyAcknowledged: true,
    ...overrides,
  };
}

function multipartBody(body = validBody()) {
  const data = new FormData();
  for (const [name, content] of Object.entries(body.files)) {
    data.append(`ink:${name}`, new Blob([content], { type: "text/plain" }), name);
  }
  data.append("root", body.root);
  if (body.runIntent !== undefined) data.append("runIntent", body.runIntent);
  if (body.assertions !== undefined) data.append("assertions", JSON.stringify(body.assertions));
  data.append("maxDepth", String(body.maxDepth));
  data.append("maxStates", String(body.maxStates));
  data.append("authorized", String(body.authorized));
  data.append("privacyAcknowledged", String(body.privacyAcknowledged));
  return data;
}

test("hosted submission accepts an authorized include bundle", () => {
  const result = validateSubmission(validBody(), LIMITS);
  assert.strictEqual(result.root, "main.ink");
  assert.strictEqual(result.files.length, 2);
  assert.strictEqual(result.maxStates, 500);
  assert.strictEqual(result.runIntent, "balanced");
});

test("hosted submission accepts only bounded typed story rules", () => {
  const assertions = [{
    id: "gold-nonnegative",
    description: "Gold never goes negative",
    when: "always",
    condition: {
      left: { variable: "gold" },
      operator: ">=",
      right: { literal: 0 },
    },
  }];
  const accepted = validateSubmission(validBody({ assertions }), LIMITS);
  assert.deepStrictEqual(accepted.assertions, assertions);
  assert.throws(
    () => validateSubmission(validBody({ assertions: [{ ...assertions[0], expression: "gold >= 0" }] }), LIMITS),
    /Invalid story rule/
  );
  assert.throws(
    () => validateSubmission(validBody({ assertions: [] }), LIMITS),
    /at least one assertion/
  );
});

test("hosted submission uses service ceilings when browser limits are omitted", () => {
  const { maxDepth, maxStates } = validateSubmission(
    validBody({ maxDepth: undefined, maxStates: undefined }),
    LIMITS
  );
  assert.strictEqual(maxDepth, LIMITS.maxDepth);
  assert.strictEqual(maxStates, LIMITS.maxStates);
});

test("hosted human intents choose bounded defaults while expert limits remain explicit", () => {
  const quick = validateSubmission(
    validBody({ runIntent: "quick", maxDepth: undefined, maxStates: undefined }),
    { ...LIMITS, maxStates: 1_000_000 }
  );
  assert.strictEqual(quick.runIntent, "quick");
  assert.strictEqual(quick.maxStates, 250_000);
  const explicit = validateSubmission(validBody({ runIntent: "quick", maxStates: 400_000 }), {
    ...LIMITS,
    maxStates: 1_000_000,
  });
  assert.strictEqual(explicit.maxStates, 400_000);
  assert.throws(
    () => validateSubmission(validBody({ runIntent: "overnight" }), LIMITS),
    /runIntent must be quick or balanced/
  );
});

test("hosted submission rejects unsafe paths and missing includes", () => {
  assert.throws(
    () => validateSubmission(validBody({ files: { "../story.ink": "-> END" } }), LIMITS),
    (error) => error instanceof SubmissionError && /normalized relative/.test(error.message)
  );
  assert.throws(
    () =>
      validateSubmission(
        validBody({ files: { "main.ink": "INCLUDE ../outside.ink" } }),
        LIMITS
      ),
    (error) => error instanceof SubmissionError && error.status === 422
  );
});

test("hosted submission requires authorization and privacy acknowledgement", () => {
  assert.throws(
    () => validateSubmission(validBody({ authorized: false }), LIMITS),
    /authorized to upload/
  );
  assert.throws(
    () => validateSubmission(validBody({ privacyAcknowledged: false }), LIMITS),
    /temporary hosted processing/
  );
  assert.throws(
    () => validateSubmission(validBody({ files: { "main.ink": "bad\0story" } }), LIMITS),
    /null byte/
  );
});

test("multipart upload preserves unchanged ink contents and relative paths", async () => {
  const expected = validBody();
  const request = new Request("http://localhost/api/check", {
    method: "POST",
    body: multipartBody(expected),
  });
  const contentType = request.headers.get("content-type");
  const encoded = Buffer.from(await request.arrayBuffer());
  const parsed = await parseMultipartBody(contentType, encoded);
  assert.deepStrictEqual(parsed.files, expected.files);
  assert.strictEqual(parsed.root, expected.root);
  assert.strictEqual(parsed.runIntent, undefined);
  const withRule = multipartBody(validBody({ assertions: [{
    id: "gold-nonnegative",
    when: "always",
    condition: { left: { variable: "gold" }, operator: ">=", right: { literal: 0 } },
  }] }));
  const rulesRequest = new Request("http://localhost/api/check", { method: "POST", body: withRule });
  const parsedRules = await parseMultipartBody(
    rulesRequest.headers.get("content-type"),
    Buffer.from(await rulesRequest.arrayBuffer())
  );
  assert.deepStrictEqual(parsedRules.assertions, [{
    id: "gold-nonnegative",
    when: "always",
    condition: { left: { variable: "gold" }, operator: ">=", right: { literal: 0 } },
  }]);
  assert.strictEqual(parsed.authorized, true);
  assert.strictEqual(parsed.privacyAcknowledged, true);
});

test("browser access allows only exact configured origins", () => {
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };
  applyBrowserOrigin(
    { headers: { origin: "https://secondlandings.com" } },
    response,
    ["https://secondlandings.com"]
  );
  assert.strictEqual(headers.get("Access-Control-Allow-Origin"), "https://secondlandings.com");
  assert.strictEqual(headers.get("Vary"), "Origin");
  assert.throws(
    () => applyBrowserOrigin(
      { headers: { origin: "https://not-secondlandings.example" } },
      response,
      ["https://secondlandings.com"]
    ),
    (error) => error instanceof SubmissionError && error.status === 403
  );
});

test("hosted cancellation retains a source-bound final progress window", async (t) => {
  const config = {
    ...webConfigFromEnv(),
    host: "127.0.0.1",
    port: 0,
    staticDir: path.join(__dirname, "..", "web"),
    rateLimit: 100,
  };
  let release;
  const server = createInkcheckWebServer({
    config,
    runner: async (submission, _config, options) => {
      options?.onProgress?.({
        schemaVersion: 1,
        sequence: 1,
        type: "progress",
        phase: "explore",
        elapsedMs: 50,
        statesExplored: 123,
        stateBudget: submission.maxStates,
        budgetFraction: 123 / submission.maxStates,
        endingsFound: 2,
        runtimeErrorsFound: 1,
        unvisitedKnots: 3,
      });
      await new Promise((resolve) => { release = resolve; options?.signal?.addEventListener("abort", resolve, { once: true }); });
      throw new Error("cancelled");
    },
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") { t.skip("the local execution sandbox forbids listening sockets"); return; }
    throw error;
  }
  t.after(() => { release?.(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const accepted = await fetch(`${base}/api/check`, {
    method: "POST",
    headers: { "X-Inkcheck-Async": "1" },
    body: multipartBody(),
  });
  const created = await accepted.json();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelled = await fetch(`${base}${created.job.cancelUrl}`, { method: "POST" });
  assert.strictEqual(cancelled.status, 202);
  const snapshot = await cancelled.json();
  assert.strictEqual(snapshot.job.status, "cancelled");
  assert.strictEqual(snapshot.job.resultWindow.trigger, "cancelled");
  assert.strictEqual(snapshot.job.resultWindow.work.statesExplored, 123);
  assert.strictEqual(snapshot.job.resultWindow.searchContinuing, false);
  assert.strictEqual(snapshot.job.progress.stopReason, "cancelled");
  assert.deepStrictEqual(snapshot.job.resultWindow.stableFindingIds, []);
  assert.strictEqual(snapshot.job.resultWindow.omittedFindingCount, 4);
  assert.match(snapshot.job.resultWindow.sourceFingerprint.value, /^[0-9a-f]{64}$/);
});

test("hosted progress survives restart without persisting uploaded story content", async (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-hosted-jobs-"));
  const config = {
    ...webConfigFromEnv(),
    host: "127.0.0.1",
    port: 0,
    staticDir: path.join(__dirname, "..", "web"),
    rateLimit: 100,
    jobStoreDir: directory,
  };
  let release;
  const first = createInkcheckWebServer({
    config,
    runner: async (submission, _config, options) => {
      options?.onProgress?.({
        schemaVersion: 1,
        sequence: 1,
        type: "progress",
        phase: "explore",
        elapsedMs: 25,
        statesExplored: 321,
        stateBudget: submission.maxStates,
        budgetFraction: 321 / submission.maxStates,
        endingsFound: 1,
        runtimeErrorsFound: 0,
        unvisitedKnots: 2,
      });
      await new Promise((resolve) => { release = resolve; });
      return {
        report: { compile: { success: true } },
        meta: { durationMs: 30, uploadedFiles: 2, uploadedBytes: 56, retained: false },
      };
    },
  });
  try {
    await new Promise((resolve, reject) => {
      first.once("error", reject);
      first.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    if (error?.code === "EPERM") { t.skip("the local execution sandbox forbids listening sockets"); return; }
    throw error;
  }
  const firstBase = `http://127.0.0.1:${first.address().port}`;
  const accepted = await fetch(`${firstBase}/api/check`, {
    method: "POST",
    headers: { "X-Inkcheck-Async": "1" },
    body: multipartBody(),
  });
  assert.strictEqual(accepted.status, 202);
  const created = await accepted.json();
  await new Promise((resolve) => first.close(resolve));

  const second = createInkcheckWebServer({ config, runner: async () => { throw new Error("recovered jobs must not rerun"); } });
  try {
    await new Promise((resolve, reject) => {
      second.once("error", reject);
      second.listen(0, "127.0.0.1", resolve);
    });
    const secondBase = `http://127.0.0.1:${second.address().port}`;
    const response = await fetch(`${secondBase}${created.job.statusUrl}`);
    assert.strictEqual(response.status, 200);
    const snapshot = await response.json();
    assert.strictEqual(snapshot.job.status, "failed");
    assert.match(snapshot.job.error, /service restarted/i);
    assert.strictEqual(snapshot.job.progress.type, "run_end");
    assert.strictEqual(snapshot.job.progress.stopReason, "service_restart");
    assert.strictEqual(snapshot.job.progress.statesExplored, 321);
    const stream = await fetch(`${secondBase}${created.job.eventUrl}`);
    const streamText = await stream.text();
    assert.match(streamText, /"statesExplored":321/);
    assert.match(streamText, /"status":"failed"/);
    const stored = fs.readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
      .join("\n");
    assert.doesNotMatch(stored, /main\.ink|chapters\/one\.ink|Hello|INCLUDE|one\.ink/);
    assert.doesNotMatch(stored, /"report"|"files"|"submission"|"content"/);
  } finally {
    await new Promise((resolve) => second.close(resolve));
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("hosted job store purges expired and malformed records", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-hosted-ttl-"));
  const store = new FileHostedJobStore(directory);
  const record = {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    token: "22222222-2222-4222-8222-222222222222",
    createdAt: 1_000,
    status: "failed",
    stateBudget: 1_000_000,
    sourceFingerprint: "a".repeat(64),
    events: [{
      schemaVersion: 1,
      sequence: 1,
      type: "run_end",
      elapsedMs: 10,
      statesExplored: 5,
      stateBudget: 1_000_000,
      budgetFraction: 0.000005,
      status: "failed",
      source: "must not survive the allowlist",
    }],
    nextSequence: 1,
    expiresAt: 2_000,
    submission: "must not survive the top-level allowlist",
  };
  store.save(record);
  const file = path.join(directory, `${record.id}.json`);
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /must not survive|submission/);
  fs.writeFileSync(path.join(directory, "broken.json"), "not json", { mode: 0o600 });
  assert.deepStrictEqual(store.load(2_000), []);
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.existsSync(path.join(directory, "broken.json")), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("web API validates input and returns a no-retention report", async (t) => {
  const config = {
    ...webConfigFromEnv(),
    host: "127.0.0.1",
    port: 0,
    staticDir: path.join(__dirname, "..", "web"),
    rateLimit: 100,
    accessCode: "pilot-code",
    allowedOrigins: ["https://secondlandings.com"],
  };
  let calls = 0;
  const usageEvents = [];
  const server = createInkcheckWebServer({
    config,
    usage: { record: (event, details) => usageEvents.push({ event, details }) },
    runner: async (submission, _config, options) => {
      calls++;
      options?.onProgress?.({
        schemaVersion: 1,
        sequence: 1,
        type: "progress",
        phase: "explore",
        elapsedMs: 4,
        statesExplored: 123,
        stateBudget: submission.maxStates,
        budgetFraction: 123 / submission.maxStates,
        endingsFound: 2,
        runtimeErrorsFound: 0,
        unvisitedKnots: 1,
      });
      options?.onProgress?.({
        schemaVersion: 1,
        sequence: 2,
        type: "discovery",
        elapsedMs: 4,
        statesExplored: 123,
        stateBudget: submission.maxStates,
        budgetFraction: 123 / submission.maxStates,
        endingsFound: 2,
        runtimeErrorsFound: 0,
        unvisitedKnots: 1,
        knotsVisited: 4,
        discoveries: {
          endings: 2,
          runtimeErrors: 0,
          knotsVisited: 4,
          visibleOutcomes: 2,
          assertionViolations: 0,
          goalsReached: 0,
          stagesReached: 0,
        },
      });
      return {
        report: { compile: { success: true }, root: submission.root },
        meta: {
          durationMs: 7,
          uploadedFiles: submission.files.length,
          uploadedBytes: submission.files.reduce((sum, file) => sum + file.bytes, 0),
          retained: false,
        },
      };
    },
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("the local execution sandbox forbids listening sockets");
      return;
    }
    throw error;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.strictEqual(health.status, 200);
  assert.strictEqual((await health.json()).ok, true);

  const preflight = await fetch(`${base}/api/check`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://secondlandings.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-inkcheck-access-code",
    },
  });
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(
    preflight.headers.get("access-control-allow-origin"),
    "https://secondlandings.com"
  );

  const rejectedOrigin = await fetch(`${base}/api/check`, {
    method: "OPTIONS",
    headers: { Origin: "https://malicious.example" },
  });
  assert.strictEqual(rejectedOrigin.status, 403);

  const pageView = await fetch(`${base}/api/event`, {
    method: "POST",
    headers: {
      Origin: "https://secondlandings.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event: "page_view" }),
  });
  assert.strictEqual(pageView.status, 204);
  assert.strictEqual(
    pageView.headers.get("access-control-allow-origin"),
    "https://secondlandings.com"
  );

  const invalidEvent = await fetch(`${base}/api/event`, {
    method: "POST",
    headers: {
      Origin: "https://secondlandings.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event: "visitor_identity" }),
  });
  assert.strictEqual(invalidEvent.status, 400);

  const unauthorized = await fetch(`${base}/api/check`, {
    method: "POST",
    body: multipartBody(),
  });
  assert.strictEqual(unauthorized.status, 401);

  const rejected = await fetch(`${base}/api/check`, {
    method: "POST",
    headers: {
      Origin: "https://secondlandings.com",
      "X-Inkcheck-Access-Code": "pilot-code",
      "X-Inkcheck-Async": "1",
    },
    body: multipartBody(validBody({ authorized: false })),
  });
  assert.strictEqual(rejected.status, 422);
  assert.strictEqual(calls, 0);

  const limitHit = await fetch(`${base}/api/check`, {
    method: "POST",
    headers: {
      Origin: "https://secondlandings.com",
      "X-Inkcheck-Access-Code": "pilot-code",
    },
    body: multipartBody(validBody({ maxStates: config.maxStates + 1 })),
  });
  assert.strictEqual(limitHit.status, 413);
  const limitBody = await limitHit.json();
  assert.match(limitBody.error, /Our bad/);
  assert.strictEqual(limitBody.issueUrl, "https://github.com/chaoz23/inkcheck/issues");
  assert.strictEqual(calls, 0);

  const accepted = await fetch(`${base}/api/check`, {
    method: "POST",
    headers: {
      Origin: "https://secondlandings.com",
      "X-Inkcheck-Access-Code": "pilot-code",
      "X-Inkcheck-Async": "1",
    },
    body: multipartBody(),
  });
  assert.strictEqual(accepted.status, 202);
  assert.strictEqual(
    accepted.headers.get("access-control-allow-origin"),
    "https://secondlandings.com"
  );
  const created = await accepted.json();
  assert.ok(["queued", "running"].includes(created.job.status));
  assert.match(created.job.statusUrl, /^\/api\/jobs\//);
  let body;
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await fetch(`${base}${created.job.statusUrl}`, {
      headers: { Origin: "https://secondlandings.com" },
    });
    body = await status.json();
    if (body.job.status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.strictEqual(body.job.status, "complete");
  assert.strictEqual(body.job.result.report.compile.success, true);
  assert.strictEqual(body.job.result.meta.retained, false);
  const stream = await fetch(`${base}${created.job.eventUrl}`, {
    headers: { Origin: "https://secondlandings.com" },
  });
  assert.strictEqual(stream.status, 200);
  const streamText = await stream.text();
  assert.match(streamText, /event: progress/);
  assert.match(streamText, /"statesExplored":123/);
  assert.match(streamText, /"type":"discovery"/);
  assert.match(streamText, /"knotsVisited":4/);
  assert.doesNotMatch(streamText, /main\.ink|chapters\/one\.ink|Hello/);
  assert.match(streamText, /"stopReason":"completed"/);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(usageEvents, [
    { event: "page_view", details: undefined },
    { event: "check_rejected", details: undefined },
    { event: "check_rejected", details: undefined },
    { event: "check_limit_hit", details: undefined },
    { event: "check_rejected", details: undefined },
    { event: "check_complete", details: { durationMs: 7 } },
  ]);
});

test("hosted config defaults keep depth and time bounded for the web", () => {
  const config = webConfigFromEnv();
  // maxDepth 1000 was the system's escalation ceiling, not a sane default: it
  // let a single deep-loop trail burn the whole state budget. 100 is generous
  // headroom over real story depths while staying an order of magnitude below
  // the ceiling (#71).
  assert.strictEqual(config.maxDepth, 100);
  // A 7m30s hosted wait that returned nothing is worse than a fast partial
  // report; the ceiling is now 5 minutes.
  assert.strictEqual(config.timeoutMs, 300_000);
});

test("gracefulTimeoutSeconds reserves a real margin below the hard deadline", () => {
  // 15% margin (>= 30s) so the CLI can flush a multi-MB partial report before
  // the SIGKILL backstop, instead of the old fixed 10s that lost the report.
  assert.strictEqual(gracefulTimeoutSeconds(300_000), 255);
  const budget = 300_000;
  const margin = budget / 1000 - gracefulTimeoutSeconds(budget);
  assert.ok(margin >= 30, `expected >= 30s margin, got ${margin}s`);
  // Large budgets scale the margin with the budget, not a fixed 10s.
  assert.ok(600 - gracefulTimeoutSeconds(600_000) >= 90);
  // Never returns less than 1s, even for tiny budgets.
  assert.strictEqual(gracefulTimeoutSeconds(1_000), 1);
  assert.strictEqual(gracefulTimeoutSeconds(2_000), 1);
});
