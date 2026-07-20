const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FileUsageStore,
  loadUsageData,
  renderUsageReport,
} = require("../dist/usage");

test("usage store persists only daily aggregate counters", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-usage-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "usage.json");
  const store = new FileUsageStore(file, "a".repeat(32));
  const now = new Date("2026-07-08T12:00:00Z");

  store.record("page_view", { browserToken: "browser-token-aaaaaaaaaa" }, now);
  store.record("page_view", { browserToken: "browser-token-aaaaaaaaaa" }, now);
  store.record("page_view", { browserToken: "browser-token-bbbbbbbbbb", internal: true }, now);
  store.record("support_click", {}, now);
  store.record("check_complete", { durationMs: 1250 }, now);
  store.record("check_rejected", {}, now);
  store.record("check_limit_hit", {}, now);

  assert.deepStrictEqual(loadUsageData(file), {
    version: 1,
    days: {
      "2026-07-08": {
        pageViews: 3,
        externalPageViews: 2,
        internalPageViews: 1,
        browserTaggedPageViews: 3,
        externalBrowserSketch: loadUsageData(file).days["2026-07-08"].externalBrowserSketch,
        internalBrowserSketch: loadUsageData(file).days["2026-07-08"].internalBrowserSketch,
        supportClicks: 1,
        checksCompleted: 1,
        checksRejected: 1,
        checkLimitHits: 1,
        totalCheckDurationMs: 1250,
      },
    },
  });
  const serialized = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(serialized, /request|address|agent|story|file|browser-token/i);
  const report = renderUsageReport(loadUsageData(file), 1, now);
  assert.match(report, /Estimated external unique browsers: 1 \(calendar-month estimate; 3 tagged visits\)/);
  assert.match(report, /Estimated internal unique browsers: 1 \(calendar-month estimate\)/);
});

test("usage report covers a fixed UTC window and handles quiet days", () => {
  const report = renderUsageReport({
    version: 1,
    days: {
      "2026-07-07": {
        pageViews: 4,
        externalPageViews: 0,
        internalPageViews: 0,
        browserTaggedPageViews: 0,
        externalBrowserSketch: "",
        internalBrowserSketch: "",
        supportClicks: 1,
        checksCompleted: 2,
        checksRejected: 1,
        checkLimitHits: 1,
        totalCheckDurationMs: 3000,
      },
    },
  }, 2, new Date("2026-07-08T18:00:00Z"));
  assert.match(report, /2026-07-07 through 2026-07-08/);
  assert.match(report, /Page visits: 4/);
  assert.match(report, /Estimated external unique browsers: 0 \(calendar-month estimate; 0 tagged visits\)/);
  assert.match(report, /Hosted limit hits: 1/);
  assert.match(report, /Visit-to-check conversion: 50\.0%/);
  assert.match(report, /Average completed-check time: 1500 ms/);
});
