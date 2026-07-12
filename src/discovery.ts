import * as fs from "fs";
import * as path from "path";
import { scanExternals, scanShapeProfile, scanStorySemantics } from "./inklecate";
import { VERSION } from "./version";
import { CONFIG_SCHEMA_VERSION } from "./config";

export const CAPABILITIES_SCHEMA_VERSION = 1;
export const PROJECT_INSPECTION_SCHEMA_VERSION = 1;
export const REPORT_SCHEMA_VERSION = 1;
export const MAX_INSPECT_VARIABLES = 200;
export const MAX_INSPECT_LOCATIONS = 20;
export const MAX_INSPECT_INCLUDES = 500;
export const MAX_INSPECT_KNOTS = 1_000;
export const MAX_INSPECT_EXTERNALS = 200;

export interface InkcheckCapabilities {
  schemaVersion: number;
  inkcheckVersion: string;
  schemas: { report: number; config: number; projectInspection: number };
  limits: {
    maxDepth: number;
    maxStates: number;
    maxGoalStates: number;
    maxTotalStates: number;
    defaultMaxDepth: number;
    defaultMaxStates: number;
    defaultGoalMaxStates: number;
  };
  searchModes: string[];
  features: {
    projectInspection: boolean;
    indexedWitnesses: boolean;
    assertions: boolean;
    goals: boolean;
    stagedGoals: boolean;
    resumableSearch: boolean;
  };
}

export function capabilities(): InkcheckCapabilities {
  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    schemas: {
      report: REPORT_SCHEMA_VERSION,
      config: CONFIG_SCHEMA_VERSION,
      projectInspection: PROJECT_INSPECTION_SCHEMA_VERSION,
    },
    limits: {
      maxDepth: 1_000,
      maxStates: 100_000_000,
      maxGoalStates: 100_000_000,
      maxTotalStates: 100_000_000,
      defaultMaxDepth: 100,
      defaultMaxStates: 10_000_000,
      defaultGoalMaxStates: 0,
    },
    searchModes: ["portfolio", "shared", "shared-variable"],
    features: {
      projectInspection: true,
      indexedWitnesses: true,
      assertions: true,
      goals: true,
      stagedGoals: true,
      resumableSearch: false,
    },
  };
}

interface SourceLocation {
  file: string;
  line: number;
}

interface VariableRecord {
  name: string;
  declaration?: SourceLocation;
  initialValue?: string | number | boolean | null;
  initialExpression?: string;
  reads: SourceLocation[];
  readCount: number;
  writes: Array<SourceLocation & { operation: string }>;
  writeCount: number;
}

function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/") || path.basename(file);
}

function parseLiteral(raw: string): { value?: string | number | boolean | null; expression?: string } {
  const text = raw.trim();
  if (text === "true") return { value: true };
  if (text === "false") return { value: false };
  if (text === "null") return { value: null };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return { value: Number(text) };
  const quoted = text.match(/^"([\s\S]*)"$/);
  if (quoted) return { value: quoted[1] };
  return { expression: text };
}

function locationPush(locations: SourceLocation[], location: SourceLocation): void {
  if (locations.length < MAX_INSPECT_LOCATIONS) locations.push(location);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export interface ProjectInspection {
  schemaVersion: number;
  inkcheckVersion: string;
  entrypoint: string;
  includes: string[];
  shape: ReturnType<typeof scanShapeProfile>;
  semantics: ReturnType<typeof scanStorySemantics>;
  externals: string[];
  knots: Array<SourceLocation & { name: string; kind: "knot" | "function" }>;
  variables: VariableRecord[];
  truncation: {
    includes: boolean;
    knots: boolean;
    externals: boolean;
    variables: boolean;
    locationsPerVariable: boolean;
  };
  recommendedNextOperation: "compile_story";
}

/** Deterministic, source-only project discovery for agents. */
export function inspectProject(entryFile: string): ProjectInspection {
  const entry = path.resolve(entryFile);
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw new Error(`Ink entrypoint not found: ${entryFile}`);
  }
  const root = path.dirname(entry);
  const visited = new Set<string>();
  const includes: string[] = [];
  const knots: ProjectInspection["knots"] = [];
  const variables = new Map<string, VariableRecord>();
  const codeLines: Array<{
    code: string;
    location: SourceLocation;
    assignmentName?: string;
    assignmentOperation?: string;
  }> = [];
  let locationsTruncated = false;

  const variable = (name: string): VariableRecord => {
    let record = variables.get(name);
    if (!record) {
      record = { name, reads: [], readCount: 0, writes: [], writeCount: 0 };
      variables.set(name, record);
    }
    return record;
  };

  const visit = (file: string): void => {
    const abs = path.resolve(file);
    if (!isWithin(root, abs)) {
      throw new Error(`Unsafe INCLUDE outside project root: ${relativeFile(root, abs)}`);
    }
    if (visited.has(abs)) return;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(`Included Ink file not found: ${relativeFile(root, abs)}`);
    }
    visited.add(abs);
    const displayFile = relativeFile(root, abs);
    const source = fs.readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const code = lines[index].replace(/\/\/.*$/, "");
      const location = { file: displayFile, line: index + 1 };
      const include = code.match(/^\s*INCLUDE\s+(.+?)\s*$/);
      if (include) {
        const target = path.resolve(path.dirname(abs), include[1]);
        if (!isWithin(root, target)) {
          throw new Error(`Unsafe INCLUDE outside project root: ${include[1]}`);
        }
        includes.push(relativeFile(root, target));
        visit(target);
        continue;
      }
      const knot = code.match(/^\s*={2,}\s*(function\s+)?([A-Za-z_][A-Za-z0-9_]*)/);
      if (knot) {
        knots.push({ ...location, name: knot[2], kind: knot[1] ? "function" : "knot" });
      }
      const declaration = code.match(/^\s*VAR\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (declaration) {
        const record = variable(declaration[1]);
        record.declaration ??= location;
        const parsed = parseLiteral(declaration[2]);
        if (parsed.expression !== undefined) record.initialExpression ??= parsed.expression;
        else if (record.initialValue === undefined) record.initialValue = parsed.value;
      }
      const assignment = code.match(/^\s*~\s*(?:temp\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(\+\+|--|\+=|-=|=(?!=))/);
      if (assignment) {
        const record = variable(assignment[1]);
        record.writeCount++;
        if (record.writes.length < MAX_INSPECT_LOCATIONS) {
          record.writes.push({ ...location, operation: assignment[2] });
        } else locationsTruncated = true;
      }
      codeLines.push({
        code,
        location,
        assignmentName: assignment?.[1],
        assignmentOperation: assignment?.[2],
      });
    }
  };

  visit(entry);
  // Scan reads after collecting every declaration, so a variable referenced
  // before its declaration or in an earlier include is still summarized.
  for (const { code, location, assignmentName, assignmentOperation } of codeLines) {
    if (!/^\s*(?:~|\{|[-*+]\s*\{|->)/.test(code)) continue;
    const withoutStrings = code.replace(/"(?:\\.|[^"\\])*"/g, "");
    for (const name of variables.keys()) {
      const matches = new RegExp(`\\b${name}\\b`, "g");
      const occurrences = [...withoutStrings.matchAll(matches)].length;
      const writeOnlyTarget = assignmentName === name && assignmentOperation === "=" ? 1 : 0;
      const readOccurrences = Math.max(0, occurrences - writeOnlyTarget);
      if (readOccurrences === 0) continue;
      const record = variable(name);
      record.readCount += readOccurrences;
      const before = record.reads.length;
      locationPush(record.reads, location);
      if (before === MAX_INSPECT_LOCATIONS) locationsTruncated = true;
    }
  }
  const sortedVariables = [...variables.values()].sort((a, b) => a.name.localeCompare(b.name));
  const variablesTruncated = sortedVariables.length > MAX_INSPECT_VARIABLES;
  const sortedIncludes = [...new Set(includes)].sort();
  const sortedKnots = knots.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const sortedExternals = scanExternals(entry).sort();
  return {
    schemaVersion: PROJECT_INSPECTION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    entrypoint: relativeFile(root, entry),
    includes: sortedIncludes.slice(0, MAX_INSPECT_INCLUDES),
    shape: scanShapeProfile(entry),
    semantics: scanStorySemantics(entry),
    externals: sortedExternals.slice(0, MAX_INSPECT_EXTERNALS),
    knots: sortedKnots.slice(0, MAX_INSPECT_KNOTS),
    variables: sortedVariables.slice(0, MAX_INSPECT_VARIABLES),
    truncation: {
      includes: sortedIncludes.length > MAX_INSPECT_INCLUDES,
      knots: sortedKnots.length > MAX_INSPECT_KNOTS,
      externals: sortedExternals.length > MAX_INSPECT_EXTERNALS,
      variables: variablesTruncated,
      locationsPerVariable: locationsTruncated,
    },
    recommendedNextOperation: "compile_story",
  };
}

export function renderCapabilitiesHuman(value: InkcheckCapabilities): string {
  const enabled = Object.entries(value.features).filter(([, on]) => on).map(([name]) => name);
  const unavailable = Object.entries(value.features).filter(([, on]) => !on).map(([name]) => name);
  return [
    `Inkcheck ${value.inkcheckVersion} capabilities`,
    `Search modes: ${value.searchModes.join(", ")}`,
    `Limits: depth ${value.limits.maxDepth.toLocaleString()}, states ${value.limits.maxStates.toLocaleString()}`,
    `Available: ${enabled.join(", ")}`,
    `Not yet available: ${unavailable.join(", ")}`,
  ].join("\n");
}

export function renderInspectionHuman(value: ProjectInspection): string {
  return [
    `Ink project: ${value.entrypoint}`,
    `${value.includes.length} include(s), ${value.shape.knots} knot(s), ${value.shape.functions} function(s), ${value.variables.length} variable(s)`,
    `Choices: ${value.shape.choiceLines}; turns: ${value.semantics.usesTurns ? "yes" : "no"}; randomness: ${value.semantics.usesRandomness ? "yes" : "no"}`,
    `External functions: ${value.externals.length ? value.externals.join(", ") : "none"}`,
    "Next: compile the story before exploring it.",
  ].join("\n");
}
