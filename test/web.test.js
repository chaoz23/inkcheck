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
  parseMultipartBody,
  webConfigFromEnv,
} = require("../dist/web");

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
});

test("hosted submission uses service ceilings when browser limits are omitted", () => {
  const { maxDepth, maxStates } = validateSubmission(
    validBody({ maxDepth: undefined, maxStates: undefined }),
    LIMITS
  );
  assert.strictEqual(maxDepth, LIMITS.maxDepth);
  assert.strictEqual(maxStates, LIMITS.maxStates);
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
