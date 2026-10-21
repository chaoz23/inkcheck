#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Pure authorization/identity check; no installs, network, or deployment. */
function validateReleaseEvent({ target, eventName, event, ref, packageJson, packageLock }) {
  if (!["publish", "deploy"].includes(target)) throw new Error("target must be publish or deploy");
  if (eventName === "workflow_dispatch" && target === "deploy") {
    return { target, sourceRef: "refs/heads/main", tag: null };
  }
  let tag;
  if (eventName === "release") {
    if (event?.action !== "published" || event.release?.prerelease !== false || event.release?.draft !== false) {
      throw new Error("only published, non-draft stable product releases are authorized");
    }
    tag = event.release.tag_name;
  } else if (eventName === "workflow_dispatch") {
    tag = typeof ref === "string" && ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : undefined;
  } else {
    throw new Error("only release and explicit manual dispatch events are authorized");
  }
  if (typeof tag !== "string" || tag !== tag.trim() || !STABLE_TAG.test(tag)) {
    throw new Error("select an exact stable product tag vX.Y.Z (no branch, prerelease, or build suffix)");
  }
  if (ref !== `refs/tags/${tag}`) throw new Error("event tag and checked-out workflow ref disagree");
  const version = tag.slice(1);
  const lockRoot = packageLock?.packages?.[""];
  if (packageJson?.name !== "inkcheck" || packageJson.version !== version ||
      packageLock?.name !== packageJson.name || packageLock.version !== version ||
      lockRoot?.name !== packageJson.name || lockRoot.version !== version) {
    throw new Error("product tag must match inkcheck package.json and both package-lock.json identities");
  }
  return { target, sourceRef: target === "deploy" ? "refs/heads/main" : ref, tag };
}

function validateTagCheckout(ref, cwd = process.cwd()) {
  const resolve = (revision) => execFileSync("git", ["rev-parse", "--verify", revision], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (resolve("HEAD") !== resolve(`${ref}^{commit}`)) {
    throw new Error("HEAD must equal the selected stable version tag commit");
  }
}

function main(target = process.argv[2], env = process.env, cwd = process.cwd()) {
  const readJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));
  const manualDeploy = target === "deploy" && env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const result = validateReleaseEvent({
    target,
    eventName: env.GITHUB_EVENT_NAME,
    event: manualDeploy ? undefined : readJson(env.GITHUB_EVENT_PATH),
    ref: env.GITHUB_REF,
    packageJson: manualDeploy ? undefined : readJson(path.join(cwd, "package.json")),
    packageLock: manualDeploy ? undefined : readJson(path.join(cwd, "package-lock.json")),
  });
  if (result.tag) validateTagCheckout(`refs/tags/${result.tag}`, cwd);
  process.stdout.write(result.target === "deploy"
    ? `Deployment authorized${result.tag ? ` by ${result.tag}` : " by manual dispatch"}; source is main.\n`
    : `Publish authorized from exact tag ${result.tag}; package and lock identities match.\n`);
  return result;
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`Release gate rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validateReleaseEvent, validateTagCheckout, main };
