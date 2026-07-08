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
  const store = new FileUsageStore(file);
  const now = new Date("2026-07-08T12:00:00Z");

  store.record("page_view", {}, now);
  store.record("page_view", {}, now);
  store.record("support_click", {}, now);
  store.record("check_complete", { durationMs: 1250 }, now);
  store.record("check_rejected", {}, now);

  assert.deepStrictEqual(loadUsageData(file), {
    version: 1,
    days: {
      "2026-07-08": {
        pageViews: 2,
        supportClicks: 1,
        checksCompleted: 1,
        checksRejected: 1,
        totalCheckDurationMs: 1250,
      },
    },
  });
  const serialized = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(serialized, /request|address|agent|story|file/i);
});

test("usage report covers a fixed UTC window and handles quiet days", () => {
  const report = renderUsageReport({
    version: 1,
    days: {
      "2026-07-07": {
        pageViews: 4,
        supportClicks: 1,
        checksCompleted: 2,
        checksRejected: 1,
        totalCheckDurationMs: 3000,
      },
    },
  }, 2, new Date("2026-07-08T18:00:00Z"));
  assert.match(report, /2026-07-07 through 2026-07-08/);
  assert.match(report, /Page visits: 4/);
  assert.match(report, /Visit-to-check conversion: 50\.0%/);
  assert.match(report, /Average completed-check time: 1500 ms/);
});
