const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runHumanCampaign, renderHumanResultWindow } = require("../dist/human-campaign");

const FIXTURE = path.join(__dirname, "fixtures", "search", "low-dedup-wide.ink");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-human-campaign-"));
  const file = path.join(root, "story.ink");
  fs.copyFileSync(FIXTURE, file);
  return { root, file };
}

test("human campaign emits immutable source-bound result windows without leaking its capability", async () => {
  const { root, file } = project();
  try {
    const result = await runHumanCampaign({
      file,
      mode: "fixed",
      totalStates: 146,
      windowStates: 73,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      maxDepth: 150,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
    });
    assert.ok(result.windows.length >= 1);
    assert.strictEqual(result.windows.at(-1).searchContinuing, false);
    assert.strictEqual(result.final.sessionCapability, undefined);
    for (const [index, window] of result.windows.entries()) {
      assert.strictEqual(window.sequence, index + 1);
      assert.match(window.id, /^window-[0-9a-f]{24}$/);
      assert.ok(window.sourceFingerprint);
      assert.match(window.reportId, /^report-[0-9a-f]{24}$/);
      assert.ok(Array.isArray(window.stableFindingIds));
      assert.match(renderHumanResultWindow(window), /uncertainty/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("human campaign cancellation preserves and returns the latest partial result window", async () => {
  const { root, file } = project();
  try {
    const result = await runHumanCampaign({
      file,
      mode: "fixed",
      totalStates: 1_000,
      windowStates: 73,
      maxElapsedSeconds: 60,
      maxDiskMb: 100,
      maxDepth: 150,
      longTailShare: 0,
      minLongTailProbes: 0,
      regressionReserveStates: 0,
      shouldCancel: () => true,
    });
    assert.strictEqual(result.status, "cancelled");
    assert.strictEqual(result.windows.length, 1);
    assert.strictEqual(result.windows[0].trigger, "cancelled");
    assert.strictEqual(result.windows[0].searchContinuing, false);
    assert.match(result.windows[0].reportId, /^report-[0-9a-f]{24}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
