import { spawnSync, execSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const INK_VERSION = "1.2.1";
const INKLECATE_SHA256: Record<string, string> = {
  "inklecate_linux.zip": "1997ff5bca618c90003ecd5fecb286e7468abb955005a2a185042949642f8fb5",
  "inklecate_mac.zip": "200aae0b4471b38142465559a0640baf143e87fc9a236c68d08e1adde48053cf",
  "inklecate_windows.zip": "96bc130f57d134faf3d52019f36ce0879ea015fa7e84d280ccc1a9c8d376843f",
};

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
  const archive = Buffer.from(await res.arrayBuffer());
  const actualHash = createHash("sha256").update(archive).digest("hex");
  const expectedHash = INKLECATE_SHA256[platformZip()];
  if (actualHash !== expectedHash) {
    throw new Error(
      `Refusing inklecate ${INK_VERSION}: SHA-256 mismatch for ${platformZip()} (expected ${expectedHash}, got ${actualHash})`
    );
  }
  fs.writeFileSync(zipPath, archive);
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
    `inkcheck-${process.pid}-${randomUUID()}.json`
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
  if (fs.existsSync(outFile)) {
    if (success) result.storyJson = fs.readFileSync(outFile, "utf8");
    fs.rmSync(outFile, { force: true });
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

export interface StorySemantics {
  usesTurns: boolean;
  usesRandomness: boolean;
}

/**
 * Conservatively detect Ink features whose hidden runtime state can affect
 * future branches. False positives cost exploration work; false negatives can
 * hide behavior, so prose-like matches intentionally err on the safe side.
 */
export function scanStorySemantics(
  inkFile: string,
  seen: Set<string> = new Set()
): StorySemantics {
  const abs = path.resolve(inkFile);
  if (seen.has(abs) || !fs.existsSync(abs)) return { usesTurns: false, usesRandomness: false };
  seen.add(abs);
  let usesTurns = false;
  let usesRandomness = false;
  for (const line of fs.readFileSync(abs, "utf8").split(/\r?\n/)) {
    const code = line.replace(/\/\/.*$/, "");
    if (/\b(?:TURNS|TURNS_SINCE)\s*\(/.test(code)) usesTurns = true;
    if (/\b(?:RANDOM|SEED_RANDOM|LIST_RANDOM)\s*\(/.test(code) || /\{\s*~/.test(code)) {
      usesRandomness = true;
    }
    const inc = code.match(/^\s*INCLUDE\s+(.+?)\s*$/);
    if (inc) {
      const child = scanStorySemantics(path.join(path.dirname(abs), inc[1]), seen);
      usesTurns ||= child.usesTurns;
      usesRandomness ||= child.usesRandomness;
    }
  }
  return { usesTurns, usesRandomness };
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

/**
 * Scan ink source (following INCLUDEs) for divert and thread targets,
 * counting direct textual references to each root target name. Comments are
 * stripped first. Used to triage unvisited knots: a knot no authored divert
 * points to is a static orphan candidate, while a knot with inbound diverts
 * was more likely cut off by the run's depth/state limits. Conservative by
 * design — it counts references in the source, not proven reachability.
 */
export function scanInboundDiverts(
  inkFile: string,
  seen: Set<string> = new Set()
): Record<string, number> {
  const abs = path.resolve(inkFile);
  if (seen.has(abs) || !fs.existsSync(abs)) return {};
  seen.add(abs);
  const counts: Record<string, number> = {};
  const source = fs.readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const line of source.split(/\r?\n/)) {
    const code = line.replace(/\/\/.*$/, "");
    const inc = code.match(/^\s*INCLUDE\s+(.+?)\s*$/);
    if (inc) {
      const child = scanInboundDiverts(path.join(path.dirname(abs), inc[1]), seen);
      for (const [name, count] of Object.entries(child)) {
        counts[name] = (counts[name] ?? 0) + count;
      }
      continue;
    }
    for (const match of code.matchAll(/(?:->|<-)\s*([A-Za-z_][A-Za-z0-9_.]*)/g)) {
      const root = match[1].split(".")[0];
      counts[root] = (counts[root] ?? 0) + 1;
    }
  }
  return counts;
}

export interface StoryShapeProfile {
  knots: number;
  functions: number;
  variables: number;
  varAssignments: number;
  /** Share of variable assignments in the first third of the (flattened) source. */
  earlyAssignmentShare: number;
  /** Total authored choice lines. */
  choiceLines: number;
  /** True when the knot divert graph contains a cycle. */
  hasCycles: boolean;
  /** Knots along the longest cycle-free divert path from the story start. */
  longestKnotPath: number;
  /**
   * Choice-bearing knots along that path — a static lower bound on how many
   * choices deep a playthrough can go (loops and gathers can go deeper).
   */
  choiceDepthEstimate: number;
  suggested: {
    maxDepth: number;
    weights: { last: number; first: number; insideOut: number; beam: number; random: number };
    rationale: string[];
  };
}

interface KnotSegment {
  name: string; // "(root)" for pre-knot content
  isFunction: boolean;
  choiceLines: number;
  divertTargets: string[];
}

function collectSegments(
  inkFile: string,
  seen: Set<string>,
  segments: KnotSegment[],
  counters: { variables: number },
  flattenedLines: string[],
  assignmentPositions: number[]
): void {
  const abs = path.resolve(inkFile);
  if (seen.has(abs) || !fs.existsSync(abs)) return;
  seen.add(abs);
  const source = fs.readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rawLine of source.split(/\r?\n/)) {
    const code = rawLine.replace(/\/\/.*$/, "");
    const inc = code.match(/^\s*INCLUDE\s+(.+?)\s*$/);
    if (inc) {
      collectSegments(
        path.join(path.dirname(abs), inc[1]),
        seen,
        segments,
        counters,
        flattenedLines,
        assignmentPositions
      );
      continue;
    }
    flattenedLines.push(code);
    const knot = code.match(/^\s*={2,}\s*(function\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
    if (knot) {
      segments.push({ name: knot[2], isFunction: !!knot[1], choiceLines: 0, divertTargets: [] });
      continue;
    }
    const current = segments[segments.length - 1];
    if (/^\s*VAR\s+[A-Za-z_]/.test(code)) counters.variables++;
    if (/^\s*~\s*(temp\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(=[^=]|\+=|-=|\+\+|--)/.test(code)) {
      assignmentPositions.push(flattenedLines.length);
    }
    if (/^\s*[*+]/.test(code)) current.choiceLines++;
    for (const match of code.matchAll(/(?:->|<-)\s*([A-Za-z_][A-Za-z0-9_.]*)/g)) {
      current.divertTargets.push(match[1].split(".")[0]);
    }
  }
}

/**
 * Cheap static profile of a story's shape (issue #27), used to pick better
 * default limits and portfolio weights before the first exploration state is
 * spent. Heuristic by design: the depth estimate is a lower bound (loops and
 * gathers deepen real playthroughs), and assignment positions are measured
 * over the include-flattened source. Deterministic and source-only — no
 * compilation or story execution.
 */
export function scanShapeProfile(inkFile: string): StoryShapeProfile {
  const segments: KnotSegment[] = [
    { name: "(root)", isFunction: false, choiceLines: 0, divertTargets: [] },
  ];
  const counters = { variables: 0 };
  const flattenedLines: string[] = [];
  const assignmentPositions: number[] = [];
  collectSegments(inkFile, new Set(), segments, counters, flattenedLines, assignmentPositions);
  const totalLines = Math.max(1, flattenedLines.length);

  const knots = segments.filter((seg) => seg.name !== "(root)" && !seg.isFunction);
  const functions = segments.filter((seg) => seg.isFunction).length;
  const knownKnots = new Set(knots.map((k) => k.name));

  // Build the divert graph over "(root)" + non-function knots.
  const nodes = ["(root)", ...knots.map((k) => k.name)];
  const nodeIndex = new Map(nodes.map((name, i) => [name, i]));
  const weight = nodes.map((name) => {
    const seg = segments.find((sg) => sg.name === name && !sg.isFunction);
    return seg && seg.choiceLines > 0 ? 1 : 0;
  });
  const edges: number[][] = nodes.map(() => []);
  for (const seg of segments) {
    if (seg.isFunction) continue;
    const from = nodeIndex.get(seg.name);
    if (from === undefined) continue;
    for (const target of seg.divertTargets) {
      const to = nodeIndex.get(target);
      if (to !== undefined && knownKnots.has(target)) edges[from].push(to);
    }
  }

  // Tarjan strongly connected components (iterative), then longest path on
  // the condensation DAG weighted by choice-bearing knots per component.
  const n = nodes.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const comp = new Array<number>(n).fill(-1);
  let nextIndex = 0;
  let compCount = 0;
  let hasCycles = false;
  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) continue;
    const work: { v: number; edgeIdx: number }[] = [{ v: start, edgeIdx: 0 }];
    while (work.length) {
      const frame = work[work.length - 1];
      const v = frame.v;
      if (frame.edgeIdx === 0) {
        index[v] = low[v] = nextIndex++;
        stack.push(v);
        onStack[v] = true;
      }
      let advanced = false;
      while (frame.edgeIdx < edges[v].length) {
        const w = edges[v][frame.edgeIdx++];
        if (w === v) hasCycles = true; // self-loop
        if (index[w] === -1) {
          work.push({ v: w, edgeIdx: 0 });
          advanced = true;
          break;
        }
        if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      }
      if (advanced) continue;
      if (low[v] === index[v]) {
        let member = -1;
        let size = 0;
        do {
          member = stack.pop()!;
          onStack[member] = false;
          comp[member] = compCount;
          size++;
        } while (member !== v);
        if (size > 1) hasCycles = true;
        compCount++;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1];
        low[parent.v] = Math.min(low[parent.v], low[v]);
      }
    }
  }
  const compWeight = new Array<number>(compCount).fill(0);
  const compSize = new Array<number>(compCount).fill(0);
  for (let v = 0; v < n; v++) {
    compWeight[comp[v]] += weight[v];
    compSize[comp[v]] += 1;
  }
  const compEdges: Set<number>[] = Array.from({ length: compCount }, () => new Set());
  for (let v = 0; v < n; v++) {
    for (const w of edges[v]) {
      if (comp[v] !== comp[w]) compEdges[comp[v]].add(comp[w]);
    }
  }
  // Tarjan numbers components in reverse topological order, so iterating
  // components in increasing order visits successors before predecessors.
  const bestWeight = new Array<number>(compCount).fill(0);
  const bestSize = new Array<number>(compCount).fill(0);
  for (let c = 0; c < compCount; c++) {
    let maxW = 0;
    let maxS = 0;
    for (const next of compEdges[c]) {
      if (bestWeight[next] > maxW) maxW = bestWeight[next];
      if (bestSize[next] > maxS) maxS = bestSize[next];
    }
    bestWeight[c] = compWeight[c] + maxW;
    bestSize[c] = compSize[c] + maxS;
  }
  const rootComp = comp[0];
  const choiceDepthEstimate = bestWeight[rootComp];
  const longestKnotPath = bestSize[rootComp];

  const choiceLines = segments.reduce((sum, seg) => sum + (seg.isFunction ? 0 : seg.choiceLines), 0);
  const varAssignments = assignmentPositions.length;
  const earlyAssignmentShare =
    varAssignments === 0
      ? 0
      : assignmentPositions.filter((line) => line <= totalLines / 3).length / varAssignments;

  const rationale: string[] = [];
  const suggestedMaxDepth = Math.min(1000, Math.max(30, choiceDepthEstimate * 2));
  if (suggestedMaxDepth > 30) {
    rationale.push(
      `static divert paths pass ${choiceDepthEstimate} choice-bearing knots, so the default depth of 30 would cut them off; suggesting ${suggestedMaxDepth} with headroom`
    );
  }
  if (hasCycles) {
    rationale.push("the story has loops, so the static depth estimate is a lower bound");
  }
  let weights = { last: 0.195, first: 0.195, insideOut: 0.26, beam: 0.15, random: 0.2 };
  if (counters.variables === 0) {
    weights = { last: 0.3, first: 0.3, insideOut: 0.4, beam: 0, random: 0 };
    rationale.push(
      "no variables: distinct early-choice state combinations are impossible, so the deterministic DFS orderings cover the space best"
    );
  } else if (earlyAssignmentShare >= 0.5 && counters.variables >= 3 && varAssignments >= 3) {
    weights = { last: 0.125, first: 0.125, insideOut: 0.15, beam: 0.25, random: 0.35 };
    rationale.push(
      `${Math.round(earlyAssignmentShare * 100)}% of variable assignments happen in the first third of the story, so early-choice state combinations matter; weighting the diversity beam and random sampling up`
    );
  } else {
    rationale.push("no strong shape signal; keeping the default portfolio split");
  }

  return {
    knots: knots.length,
    functions,
    variables: counters.variables,
    varAssignments,
    earlyAssignmentShare,
    choiceLines,
    hasCycles,
    longestKnotPath,
    choiceDepthEstimate,
    suggested: { maxDepth: suggestedMaxDepth, weights, rationale },
  };
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
