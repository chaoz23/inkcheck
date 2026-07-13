import * as fs from "fs";
import * as path from "path";
import { stringify } from "yaml";
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG_FILE, loadProjectConfig, parseProjectConfig } from "./config";
import { VERSION } from "./version";

export interface ScaffoldFile {
  path: string;
  status: "created" | "unchanged";
}

export interface ScaffoldResult {
  projectRoot: string;
  entrypoint: string;
  files: ScaffoldFile[];
}

interface PlannedFile {
  path: string;
  content: string;
}

function relativeInkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".inkcheck") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".ink")) {
        found.push(path.relative(root, absolute).split(path.sep).join("/"));
      }
      if (found.length > 100) return;
    }
  };
  visit(root);
  return found;
}

function chooseEntrypoint(root: string, requested?: string): string {
  if (requested) {
    const candidate = requested.split("\\").join("/");
    parseProjectConfig(stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, entrypoint: candidate }));
    if (!fs.existsSync(path.resolve(root, ...candidate.split("/")))) {
      throw new Error(`Entrypoint not found: ${candidate}`);
    }
    return candidate;
  }
  const candidates = relativeInkFiles(root);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error("No .ink files found; pass --entrypoint <relative/path.ink>");
  }
  throw new Error(
    `Multiple .ink files found; pass --entrypoint with the project root (${candidates.slice(0, 5).join(", ")}${candidates.length > 5 ? ", ..." : ""})`
  );
}

function applyPlan(root: string, planned: PlannedFile[]): ScaffoldFile[] {
  const conflicts = planned.filter(
    (file) => fs.existsSync(file.path) && fs.readFileSync(file.path, "utf8") !== file.content
  );
  if (conflicts.length) {
    throw new Error(
      `Refusing to overwrite existing file${conflicts.length === 1 ? "" : "s"}: ${conflicts
        .map((file) => path.relative(root, file.path).split(path.sep).join("/"))
        .join(", ")}`
    );
  }
  return planned.map((file) => {
    if (fs.existsSync(file.path)) return { path: file.path, status: "unchanged" };
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content, { encoding: "utf8", mode: 0o644 });
    return { path: file.path, status: "created" };
  });
}

function configContent(entrypoint: string): string {
  return stringify({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    entrypoint,
    ci: { maxDepth: 100, maxStates: 1_000_000, seed: 1, storySeed: 1, search: "portfolio", strict: true },
  });
}

export function initProject(directory = ".", requestedEntrypoint?: string): ScaffoldResult {
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Project directory not found: ${directory}`);
  const configPath = path.join(root, DEFAULT_CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    const loaded = loadProjectConfig(configPath);
    if (requestedEntrypoint) {
      const requested = path.resolve(root, ...requestedEntrypoint.split(/[\\/]/));
      if (requested !== loaded.entrypoint) throw new Error("Existing inkcheck.yml uses a different entrypoint");
    }
    return {
      projectRoot: root,
      entrypoint: loaded.config.entrypoint,
      files: [{ path: configPath, status: "unchanged" }],
    };
  }
  const entrypoint = chooseEntrypoint(root, requestedEntrypoint);
  const files = applyPlan(root, [{ path: configPath, content: configContent(entrypoint) }]);
  return { projectRoot: root, entrypoint, files };
}

function agentInstructions(entrypoint: string): string {
  return `# Inkcheck Agent Kit\n\nGenerated for Inkcheck ${VERSION}, config schema ${CONFIG_SCHEMA_VERSION}.\n\n- Inkcheck is a deterministic, non-AI QA engine. Do not claim bounded results prove full coverage.\n- Treat \`${entrypoint}\` and \`inkcheck.yml\` as the project contract. Explicitly ask before changing story prose.\n- Start with \`npx -y inkcheck@${VERSION} capabilities --json\`, then \`inspect ${entrypoint} --json\`.\n- Run \`npx -y inkcheck@${VERSION} --json\`; use stable finding IDs and indexed witnesses from the report.\n- Keep both the search \`seed\` and Ink runtime \`storySeed\` fixed when comparing runs; pass a finding's reported \`storySeed\` to \`playtest_story\`.\n- Replay a witness exactly before editing. After a fix, rerun the same configured check and classify it as fixed, still failing, or path changed.\n- Keep generated reports and checkpoints under \`.inkcheck/\`; they are ignored by default.\n`;
}

function workflow(): string {
  return `name: Inkcheck\n\non:\n  push:\n    paths:\n      - "**/*.ink"\n      - "inkcheck.yml"\n  pull_request:\n    paths:\n      - "**/*.ink"\n      - "inkcheck.yml"\n\njobs:\n  story-qa:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - name: Check Ink story\n        run: npx -y inkcheck@${VERSION} --markdown >> "$GITHUB_STEP_SUMMARY"\n`;
}

export function createAgentKit(
  directory = ".",
  format = "codex",
  requestedEntrypoint?: string
): ScaffoldResult {
  if (format !== "codex") throw new Error("agent-kit currently supports only --format codex");
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Project directory not found: ${directory}`);

  const configPath = path.join(root, DEFAULT_CONFIG_FILE);
  let entrypoint: string;
  const planned: PlannedFile[] = [];
  if (fs.existsSync(configPath)) {
    const loaded = loadProjectConfig(configPath);
    entrypoint = loaded.config.entrypoint;
  } else {
    entrypoint = chooseEntrypoint(root, requestedEntrypoint);
    planned.push({ path: configPath, content: configContent(entrypoint) });
  }
  planned.push(
    { path: path.join(root, ".github", "workflows", "inkcheck.yml"), content: workflow() },
    { path: path.join(root, ".inkcheck", ".gitignore"), content: "reports/\ncheckpoints/\n*.tmp\n" },
    { path: path.join(root, ".inkcheck", "AGENTS.md"), content: agentInstructions(entrypoint) }
  );
  return { projectRoot: root, entrypoint, files: applyPlan(root, planned) };
}

export function renderScaffoldResult(result: ScaffoldResult): string {
  return [
    `Inkcheck project: ${result.projectRoot}`,
    `Entrypoint: ${result.entrypoint}`,
    ...result.files.map((file) => `${file.status === "created" ? "Created" : "Unchanged"}: ${path.relative(result.projectRoot, file.path)}`),
  ].join("\n");
}
