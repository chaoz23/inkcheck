#!/usr/bin/env node
"use strict";

const dns = require("node:dns/promises");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

function command(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isUnpublishedVersionError(error) {
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
  return /\bE404\b|404 Not Found/.test(stderr);
}

async function check(label, fn) {
  try {
    const detail = await fn();
    return { label, ok: true, detail };
  } catch (error) {
    return { label, ok: false, detail: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

async function preflight(root = process.cwd()) {
  const pkg = JSON.parse(fs.readFileSync(`${root}/package.json`, "utf8"));
  return Promise.all([
    check("dns github.com", async () => (await dns.lookup("github.com")).address),
    check("git clean", () => command("git", ["status", "--porcelain"]).length === 0 ? "clean" : Promise.reject(new Error("working tree has changes"))),
    check("github origin", () => command("git", ["ls-remote", "--exit-code", "origin", "HEAD"]).split("\t")[0]),
    check("npm identity", () => command("npm", ["whoami", "--registry=https://registry.npmjs.org/"])),
    check("package version", () => `${pkg.name}@${pkg.version}`),
    check("npm version unused", () => {
      try {
        command("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--json"]);
      } catch (error) {
        if (isUnpublishedVersionError(error)) return "available";
        throw error;
      }
      throw new Error(`${pkg.name}@${pkg.version} is already published`);
    }),
  ]);
}

async function main() {
  const checks = await preflight();
  for (const item of checks) process.stdout.write(`${item.ok ? "ok" : "not ok"} - ${item.label}: ${item.detail}\n`);
  if (checks.some((item) => !item.ok)) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { isUnpublishedVersionError, preflight };
