"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { test } = require("node:test");
const YAML = require("yaml");
const { validateReleaseEvent, validateTagCheckout } = require("../scripts/release-event-gate");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "release-event-gate.js");
const pkg = { name: "inkcheck", version: "0.7.2" };
const lock = { ...pkg, lockfileVersion: 3, packages: { "": { ...pkg } } };
const published = (tag = "v0.7.2", overrides = {}) => ({
  action: "published", release: { tag_name: tag, draft: false, prerelease: false, ...overrides },
});
const options = (target, event = published(), ref = `refs/tags/${event.release.tag_name}`) => ({
  target, eventName: "release", event, ref, packageJson: pkg, packageLock: lock,
});

// These workflows use only this small expression subset. Evaluate their actual
// conditions so a missing job guard cannot hide behind the validator's tests.
function expressionValue(value, github) {
  assert.match(value, /^\$\{\{.*\}\}$/);
  return Function("github", "startsWith", `return (${value.slice(3, -2)});`)(
    github, (text, prefix) => typeof text === "string" && text.startsWith(prefix),
  );
}

test("release workflows skip audit prereleases and non-version releases before side effects", () => {
  for (const target of ["publish", "deploy"]) {
    const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, ".github", "workflows", `${target}.yml`), "utf8"));
    const job = workflow.jobs[target];
    assert.deepEqual(workflow.on.release.types, ["published"]);
    for (const release of [
      published("inkbench-2026-08-evidence", { prerelease: true }).release,
      published("v0.7.3-beta.1", { prerelease: true }).release,
      published("inkbench-2026-08-evidence").release,
      published("audit-archive").release,
    ]) {
      assert.equal(expressionValue(job.if, { event_name: "release", event: { release } }), false);
    }
    assert.equal(expressionValue(job.if, { event_name: "release", event: published() }), true);
    assert.equal(expressionValue(job.if, { event_name: "workflow_dispatch" }), true);
    assert.equal(expressionValue(job.if, { event_name: "push", event: {} }), false);
    const gate = job.steps.findIndex((step) => step.run === `node scripts/release-event-gate.js ${target}`);
    assert.ok(gate >= 0, "the exact payload/identity gate must run");
    assert.ok(job.steps.slice(0, gate).every((step) => !step.run), "gate precedes all shell side effects");
    assert.ok(job.steps.slice(gate + 1).some((step) => /npm publish|ssh -i/.test(step.run ?? "")));
  }
});

test("stable product releases require exact matching event, package, and lock identities", () => {
  for (const target of ["publish", "deploy"]) {
    assert.equal(validateReleaseEvent(options(target)).tag, "v0.7.2");
    for (const event of [published("inkbench-2026-08-evidence", { prerelease: true }),
      published("v0.7.2", { prerelease: true }), published("v0.7.2", { draft: true }),
      { ...published(), action: "edited" }]) {
      assert.throws(() => validateReleaseEvent(options(target, event)));
    }
    for (const tag of ["audit", "vfoo", "v01.7.2", "v0.7.2-rc.1", "v0.7.2+audit", "v0.7.2\n"]) {
      assert.throws(() => validateReleaseEvent(options(target, published(tag))));
    }
    assert.throws(() => validateReleaseEvent(options(target, published("v0.7.3"))), /package/);
    assert.throws(() => validateReleaseEvent(options(target, published(), "refs/heads/main")), /ref disagree/);
    assert.throws(() => validateReleaseEvent({ ...options(target), packageLock: { ...lock, version: "0.7.1" } }), /package-lock/);
    assert.throws(() => validateReleaseEvent({ ...options(target), packageLock: { ...lock, packages: { "": { ...pkg, name: "other" } } } }), /package-lock/);
  }
});

test("manual publish requires an exact product tag; manual deploy continues to follow main", () => {
  const manual = { ...options("publish"), eventName: "workflow_dispatch", event: {} };
  assert.equal(validateReleaseEvent(manual).sourceRef, "refs/tags/v0.7.2");
  for (const ref of ["refs/heads/main", "refs/heads/v0.7.2", "refs/tags/inkbench-2026-08-evidence", "refs/tags/v0.7.2-beta.1"]) {
    assert.throws(() => validateReleaseEvent({ ...manual, ref }));
  }
  assert.deepEqual(validateReleaseEvent({ target: "deploy", eventName: "workflow_dispatch", ref: "refs/heads/other" }), {
    target: "deploy", sourceRef: "refs/heads/main", tag: null,
  });
  const deploy = YAML.parse(fs.readFileSync(path.join(ROOT, ".github", "workflows", "deploy.yml"), "utf8"));
  assert.equal(expressionValue(deploy.jobs.deploy.steps[0].with.ref, { event_name: "workflow_dispatch", ref: "refs/heads/other" }), "main");
  const remote = deploy.jobs.deploy.steps.find((step) => /ssh -i/.test(step.run ?? "")).run;
  assert.match(remote, /git symbolic-ref --quiet --short HEAD/);
  assert.match(remote, /git pull --ff-only origin main/);
  assert.match(remote, /cd -- \$remote_app_dir;/);
  const quoteLine = remote.split("\n").find((line) => line.trim().startsWith("printf -v remote_app_dir "));
  assert.ok(quoteLine, "quote the configured path before constructing the remote command");
  if (process.platform !== "win32") {
    const appDir = "/tmp/Inkcheck's path; $(printf injected)";
    const quoted = spawnSync("bash", ["-c", `${quoteLine}\nprintf '%s' "$remote_app_dir"`], {
      env: { ...process.env, APP_DIR: appDir }, encoding: "utf8",
    });
    assert.equal(quoted.status, 0, quoted.stderr);
    const decoded = spawnSync("bash", ["-c", `set -- ${quoted.stdout}; printf '%s' "$1"`], { encoding: "utf8" });
    assert.equal(decoded.status, 0, decoded.stderr);
    assert.equal(decoded.stdout, appDir, "spaces, apostrophes and command syntax remain literal path text");
  }
});

test("gate CLI binds publication to the selected tag commit and fails closed", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inkcheck-release-gate-"));
  const git = (...args) => execFileSync("git", args, { cwd: temp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--quiet");
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(path.join(temp, "package-lock.json"), JSON.stringify(lock));
    git("add", "package.json", "package-lock.json");
    git("-c", "user.name=Release gate test", "-c", "user.email=release-test@example.invalid", "commit", "--quiet", "-m", "fixture");
    git("-c", "user.name=Release gate test", "-c", "user.email=release-test@example.invalid", "tag", "-a", "v0.7.2", "-m", "fixture tag");
    validateTagCheckout("refs/tags/v0.7.2", temp);
    const eventPath = path.join(temp, "event.json");
    fs.writeFileSync(eventPath, JSON.stringify(published()));
    const env = { ...process.env, GITHUB_EVENT_NAME: "release", GITHUB_EVENT_PATH: eventPath, GITHUB_REF: "refs/tags/v0.7.2" };
    const run = (target, overrides = {}) => spawnSync(process.execPath, [SCRIPT, target], { cwd: temp, env: { ...env, ...overrides }, encoding: "utf8" });
    const valid = run("publish");
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /exact tag v0.7.2/);
    const branch = run("publish", { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" });
    assert.equal(branch.status, 1);
    assert.equal(branch.stdout, "");
    assert.equal(run("publish", { GITHUB_EVENT_NAME: "workflow_dispatch" }).status, 0);
    fs.writeFileSync(eventPath, JSON.stringify(published("inkbench-2026-08-evidence", { prerelease: true })));
    assert.equal(run("deploy", { GITHUB_REF: "refs/tags/inkbench-2026-08-evidence" }).status, 1);
    assert.equal(run("deploy", { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/other" }).status, 0);
    git("-c", "user.name=Release gate test", "-c", "user.email=release-test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "different commit");
    assert.throws(() => validateTagCheckout("refs/tags/v0.7.2", temp), /HEAD must equal/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
