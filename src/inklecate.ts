import { spawnSync, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const INK_VERSION = "1.2.1";

export type Severity = "ERROR" | "WARNING" | "TODO" | "RUNTIME ERROR";

export interface Issue {
  severity: Severity;
  file: string;
  line: number | null;
  message: string;
  raw: string;
}

export interface CompileResult {
  success: boolean;
  issues: Issue[];
  errors: number;
  warnings: number;
  todos: number;
  /** Compiled story JSON (ink runtime format), present when compilation succeeded. */
  storyJson?: string;
}

export function parseIssue(raw: string): Issue {
  const m = raw.match(
    /^(ERROR|WARNING|RUNTIME ERROR|TODO):\s*(?:'([^']*)'\s*)?(?:line (\d+):\s*)?([\s\S]*)$/
  );
  if (!m) return { severity: "ERROR", file: "", line: null, message: raw, raw };
  return {
    severity: m[1] as Severity,
    file: m[2] ?? "",
    line: m[3] ? parseInt(m[3], 10) : null,
    message: m[4].trim(),
    raw,
  };
}

function cacheDir(): string {
  return path.join(os.homedir(), ".cache", "inkcheck");
}

function platformZip(): string {
  switch (process.platform) {
    case "darwin":
      return "inklecate_mac.zip";
    case "win32":
      return "inklecate_windows.zip";
    default:
      return "inklecate_linux.zip";
  }
}

async function downloadInklecate(dest: string): Promise<string> {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const url = `https://github.com/inkle/ink/releases/download/v${INK_VERSION}/${platformZip()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download inklecate from ${url}: HTTP ${res.status}`);
  const zipPath = path.join(dir, "inklecate.zip");
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  const unzip =
    process.platform === "win32"
      ? spawnSync("tar", ["-xf", zipPath, "-C", dir])
      : spawnSync("unzip", ["-o", "-q", zipPath, "-d", dir]);
  if (unzip.status !== 0) {
    throw new Error(`Failed to extract ${zipPath}: ${unzip.stderr?.toString() ?? "unknown error"}`);
  }
  fs.rmSync(zipPath);
  if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
  return dest;
}

let resolved: string | null = null;

/**
 * Locate inklecate: $INKLECATE_PATH, then PATH, then the inkcheck cache,
 * downloading the official release binary on first use if necessary.
 */
export async function resolveInklecate(): Promise<string> {
  if (resolved) return resolved;
  const envPath = process.env.INKLECATE_PATH;
  if (envPath && fs.existsSync(envPath)) return (resolved = envPath);
  try {
    const cmd = process.platform === "win32" ? "where inklecate" : "command -v inklecate";
    const p = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    if (p) return (resolved = p);
  } catch {
    /* not on PATH */
  }
  const binary = process.platform === "win32" ? "inklecate.exe" : "inklecate";
  const cached = path.join(cacheDir(), `inklecate-${INK_VERSION}`, binary);
  if (fs.existsSync(cached)) return (resolved = cached);
  return (resolved = await downloadInklecate(cached));
}

/**
 * Compile an .ink file. Always compiles with -c (count all visits) so the
 * exploration engine can measure knot coverage, and -j for parseable output.
 */
export async function compile(inkFile: string): Promise<CompileResult> {
  const inklecate = await resolveInklecate();
  const outFile = path.join(
    os.tmpdir(),
    `inkcheck-${process.pid}-${Date.now()}.json`
  );
  const proc = spawnSync(inklecate, ["-j", "-c", "-o", outFile, inkFile], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const issues: Issue[] = [];
  let success = false;
  for (const line of (proc.stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj["compile-success"] === "boolean") success = obj["compile-success"];
      if (Array.isArray(obj.issues)) for (const i of obj.issues) issues.push(parseIssue(i));
    } catch {
      // Non-JSON line (e.g. plain-mode output); parse directly.
      if (/^(ERROR|WARNING|RUNTIME ERROR|TODO):/.test(trimmed)) issues.push(parseIssue(trimmed));
    }
  }
  if (proc.error) {
    issues.push({
      severity: "ERROR",
      file: inkFile,
      line: null,
      message: `inklecate failed to run: ${proc.error.message}`,
      raw: String(proc.error),
    });
  }
  const result: CompileResult = {
    success,
    issues,
    errors: issues.filter((i) => i.severity === "ERROR" || i.severity === "RUNTIME ERROR").length,
    warnings: issues.filter((i) => i.severity === "WARNING").length,
    todos: issues.filter((i) => i.severity === "TODO").length,
  };
  if (success && fs.existsSync(outFile)) {
    result.storyJson = fs.readFileSync(outFile, "utf8");
    fs.rmSync(outFile);
  }
  return result;
}

/** Run inklecate -s and parse the "Key: value" stat lines. */
export async function stats(inkFile: string): Promise<Record<string, number>> {
  const inklecate = await resolveInklecate();
  const proc = spawnSync(inklecate, ["-s", inkFile], { encoding: "utf8" });
  const out: Record<string, number> = {};
  for (const line of (proc.stdout ?? "").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z ]+):\s+(\d+)\s*$/);
    if (m) out[m[1].trim().toLowerCase().replace(/ /g, "_")] = parseInt(m[2], 10);
  }
  return out;
}

export interface KnotInfo {
  name: string;
  isFunction: boolean;
  file: string;
  line: number;
}

/**
 * Scan ink source (following INCLUDEs) for knot declarations, so exploration
 * can report coverage against the full set of authored knots.
 */
export function scanKnots(inkFile: string, seen: Set<string> = new Set()): KnotInfo[] {
  const abs = path.resolve(inkFile);
  if (seen.has(abs) || !fs.existsSync(abs)) return [];
  seen.add(abs);
  const knots: KnotInfo[] = [];
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  lines.forEach((line: string, idx: number) => {
    const knot = line.match(/^\s*={2,}\s*(function\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
    if (knot) {
      knots.push({
        name: knot[2],
        isFunction: !!knot[1],
        file: path.basename(abs),
        line: idx + 1,
      });
      return;
    }
    const inc = line.match(/^\s*INCLUDE\s+(.+?)\s*$/);
    if (inc) knots.push(...scanKnots(path.join(path.dirname(abs), inc[1]), seen));
  });
  return knots;
}

/** Scan ink source (following INCLUDEs) for EXTERNAL function declarations. */
export function scanExternals(inkFile: string, seen: Set<string> = new Set()): string[] {
  const abs = path.resolve(inkFile);
  if (seen.has(abs) || !fs.existsSync(abs)) return [];
  seen.add(abs);
  const externals: string[] = [];
  for (const line of fs.readFileSync(abs, "utf8").split(/\r?\n/)) {
    const ext = line.match(/^\s*EXTERNAL\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (ext) externals.push(ext[1]);
    const inc = line.match(/^\s*INCLUDE\s+(.+?)\s*$/);
    if (inc) externals.push(...scanExternals(path.join(path.dirname(abs), inc[1]), seen));
  }
  return [...new Set(externals)];
}
