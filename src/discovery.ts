import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { scanExternals, scanShapeProfile, scanStorySemantics } from "./inklecate";
import { VERSION } from "./version";
import { CONFIG_SCHEMA_VERSION } from "./config";
import {
  CHECKPOINT_ARTIFACT_SCHEMA_VERSION,
  DEFAULT_CHECKPOINT_GENERATIONS,
  DEFAULT_MAX_CHECKPOINT_BYTES,
  DEFAULT_MAX_PROJECT_CHECKPOINT_BYTES,
} from "./checkpoints";
import {
  DEFAULT_MCP_SESSION_WINDOW_STATES,
  MAX_MCP_SESSION_EVENTS,
  MAX_MCP_SESSION_FILES,
  MAX_MCP_SESSION_TOTAL_STATES,
  MAX_MCP_SESSION_RESPONSE_BYTES,
  MAX_MCP_SESSION_WINDOW_STATES,
  MAX_MCP_CAMPAIGN_WINDOWS,
  SEARCH_SESSION_SCHEMA_VERSION,
} from "./search-session-contract";
import {
  MAX_REGRESSION_PIN_BYTES,
  MAX_REGRESSION_PINS_PER_PROJECT,
  REGRESSION_ARTIFACT_SCHEMA_VERSION,
} from "./regression-contract";
import { CAMPAIGN_POLICY_SCHEMA_VERSION } from "./campaign-policy";
import {
  DEFAULT_AUTO_CONCURRENCY_CEILING,
  MAX_PORTFOLIO_CONCURRENCY,
} from "./concurrency-policy";
import type { AssertionCondition, AssertionOperand, AssertionOperator } from "./assertions";
import type { GoalDefinition } from "./goals";

export const CAPABILITIES_SCHEMA_VERSION = 1;
export const PROJECT_INSPECTION_SCHEMA_VERSION = 4;
export const REPORT_SCHEMA_VERSION = 1;
export const ARTIFACT_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_REPORT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_PROJECT_REPORT_BYTES = 1024 * 1024 * 1024;
export const MAX_REPORT_PRUNE_PER_RUN = 100;
export const MAX_INSPECT_VARIABLES = 200;
export const MAX_INSPECT_LOCATIONS = 20;
export const MAX_INSPECT_INCLUDES = 500;
export const MAX_INSPECT_KNOTS = 1_000;
export const MAX_INSPECT_EXTERNALS = 200;
export const MAX_INSPECT_GATES = 200;
export const DEFAULT_INSPECT_PAGE_SIZE = 50;
export const MAX_INSPECT_PAGE_SIZE = 100;
export const DEFAULT_INSPECT_SAMPLE_SIZE = 10;
export const MAX_INSPECTION_OVERVIEW_BYTES = 16 * 1024;

export interface InkcheckCapabilities {
  schemaVersion: number;
  inkcheckVersion: string;
  schemas: { report: number; config: number; projectInspection: number; artifact: number; checkpointArtifact: number; searchSession: number; regressionArtifact: number; campaignPolicy: number };
  limits: {
    maxDepth: number;
    maxStates: number;
    maxGoalStates: number;
    maxTotalStates: number;
    defaultMaxDepth: number;
    defaultMaxStates: number;
    defaultGoalMaxStates: number;
    defaultConcurrency: number;
    defaultConcurrencyMode: "auto";
    defaultAutoConcurrencyCeiling: number;
    maxConcurrency: number;
    maxStorySeed: number;
    defaultStorySeed: number;
    maxCheckpointBytes: number;
    maxProjectCheckpointBytes: number;
    checkpointGenerationsPerEntrypoint: number;
    maxReportBytes: number;
    maxProjectReportBytes: number;
    maxReportPrunePerRun: number;
    defaultMcpSessionWindowStates: number;
    maxMcpSessionWindowStates: number;
    maxMcpSessionTotalStates: number;
    maxMcpSessionFiles: number;
    maxMcpSessionEvents: number;
    maxMcpSessionResponseBytes: number;
    maxMcpCampaignWindows: number;
    maxRegressionPinBytes: number;
    maxRegressionPinsPerProject: number;
  };
  searchModes: string[];
  campaignModes: string[];
  campaignValuePreferences: string[];
  campaignStopPolicies: string[];
  resumableSearchSurfaces: string[];
  features: {
    projectInspection: boolean;
    indexedWitnesses: boolean;
    assertions: boolean;
    goals: boolean;
    stagedGoals: boolean;
    anytimeShadowDecision: boolean;
    concurrentPortfolio: boolean;
    localReportArtifacts: boolean;
    savedFindingLookup: boolean;
    resumableSearch: boolean;
    interactiveSearchSessions: boolean;
    sessionWitnessReplay: boolean;
    sessionRegressionPins: boolean;
    sessionGoalProbes: boolean;
    campaignDirectedChildren: boolean;
    campaignResultWindows: boolean;
    campaignPolicyControls: boolean;
    bundledAgentSkill: boolean;
    compactMachineOutput: boolean;
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
      artifact: ARTIFACT_SCHEMA_VERSION,
      checkpointArtifact: CHECKPOINT_ARTIFACT_SCHEMA_VERSION,
      searchSession: SEARCH_SESSION_SCHEMA_VERSION,
      regressionArtifact: REGRESSION_ARTIFACT_SCHEMA_VERSION,
      campaignPolicy: CAMPAIGN_POLICY_SCHEMA_VERSION,
    },
    limits: {
      maxDepth: 1_000,
      maxStates: 100_000_000,
      maxGoalStates: 100_000_000,
      maxTotalStates: 100_000_000,
      defaultMaxDepth: 100,
      defaultMaxStates: 10_000_000,
      defaultGoalMaxStates: 0,
      defaultConcurrency: DEFAULT_AUTO_CONCURRENCY_CEILING,
      defaultConcurrencyMode: "auto",
      defaultAutoConcurrencyCeiling: DEFAULT_AUTO_CONCURRENCY_CEILING,
      maxConcurrency: MAX_PORTFOLIO_CONCURRENCY,
      maxStorySeed: 2_147_483_646,
      defaultStorySeed: 1,
      maxCheckpointBytes: DEFAULT_MAX_CHECKPOINT_BYTES,
      maxProjectCheckpointBytes: DEFAULT_MAX_PROJECT_CHECKPOINT_BYTES,
      checkpointGenerationsPerEntrypoint: DEFAULT_CHECKPOINT_GENERATIONS,
      maxReportBytes: DEFAULT_MAX_REPORT_BYTES,
      maxProjectReportBytes: DEFAULT_MAX_PROJECT_REPORT_BYTES,
      maxReportPrunePerRun: MAX_REPORT_PRUNE_PER_RUN,
      defaultMcpSessionWindowStates: DEFAULT_MCP_SESSION_WINDOW_STATES,
      maxMcpSessionWindowStates: MAX_MCP_SESSION_WINDOW_STATES,
      maxMcpSessionTotalStates: MAX_MCP_SESSION_TOTAL_STATES,
      maxMcpSessionFiles: MAX_MCP_SESSION_FILES,
      maxMcpSessionEvents: MAX_MCP_SESSION_EVENTS,
      maxMcpSessionResponseBytes: MAX_MCP_SESSION_RESPONSE_BYTES,
      maxMcpCampaignWindows: MAX_MCP_CAMPAIGN_WINDOWS,
      maxRegressionPinBytes: MAX_REGRESSION_PIN_BYTES,
      maxRegressionPinsPerProject: MAX_REGRESSION_PINS_PER_PROJECT,
    },
    searchModes: ["portfolio", "shared", "shared-variable"],
    campaignModes: ["quick", "balanced", "deep", "overnight", "campaign", "fixed"],
    campaignValuePreferences: ["broad_qa", "runtime_assertions", "outcomes", "approved_goals"],
    campaignStopPolicies: ["ceilings", "knee"],
    resumableSearchSurfaces: ["cli", "mcp"],
    features: {
      projectInspection: true,
      indexedWitnesses: true,
      assertions: true,
      goals: true,
      stagedGoals: true,
      anytimeShadowDecision: true,
      concurrentPortfolio: true,
      localReportArtifacts: true,
      savedFindingLookup: true,
      resumableSearch: true,
      interactiveSearchSessions: true,
      sessionWitnessReplay: true,
      sessionRegressionPins: true,
      sessionGoalProbes: true,
      campaignDirectedChildren: true,
      campaignResultWindows: true,
      campaignPolicyControls: true,
      bundledAgentSkill: true,
      compactMachineOutput: true,
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

export interface GateRecord {
  expression: string;
  location: SourceLocation;
  supported: boolean;
  isCompound: boolean;
  referencedVariables: string[];
  operators: string[];
  assignmentSites: Array<{
    name: string;
    declaration?: SourceLocation;
    writes: Array<SourceLocation & { operation: string }>;
    writeCount: number;
  }>;
  unsupportedReason?: string;
  /** Present only when this source condition maps losslessly to Inkcheck's typed goal grammar. */
  probeCondition?: AssertionCondition;
  /** Why a statically supported Ink condition cannot yet become a bounded goal probe. */
  probeUnsupportedReason?: string;
}

export interface GateProbePlan {
  gate: GateRecord;
  goal: GoalDefinition;
  semantics: "additive_goal_probe";
  disclosure: string;
}

type GateToken =
  | { type: "identifier"; value: string }
  | { type: "number" | "string" | "boolean" | "null" | "operator" | "paren"; value: string };

function tokenizeGate(expression: string): { tokens?: GateToken[]; error?: string } {
  const tokens: GateToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    const string = rest.match(/^"(?:\\.|[^"\\])*"/);
    if (string) {
      tokens.push({ type: "string", value: string[0] });
      index += string[0].length;
      continue;
    }
    const operator = rest.match(/^(?:&&|\|\||==|!=|<=|>=|!|<|>)/);
    if (operator) {
      tokens.push({ type: "operator", value: operator[0] });
      index += operator[0].length;
      continue;
    }
    const paren = rest.match(/^[()]/);
    if (paren) {
      tokens.push({ type: "paren", value: paren[0] });
      index++;
      continue;
    }
    const number = rest.match(/^-?(?:\d+\.?\d*|\.\d+)/);
    if (number) {
      tokens.push({ type: "number", value: number[0] });
      index += number[0].length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      const value = identifier[0];
      tokens.push({ type: value === "true" || value === "false" ? "boolean" : value === "null" ? "null" : "identifier", value });
      index += value.length;
      continue;
    }
    return { error: `unsupported token \`${rest[0]}\`` };
  }
  return { tokens };
}

function inspectGateExpression(expression: string, declaredVariables: Set<string>): Pick<GateRecord, "supported" | "isCompound" | "referencedVariables" | "operators" | "unsupportedReason"> {
  const tokenized = tokenizeGate(expression);
  if (!tokenized.tokens) {
    return { supported: false, isCompound: false, referencedVariables: [], operators: [], unsupportedReason: tokenized.error };
  }
  const tokens = tokenized.tokens;
  const referencedVariables = [...new Set(tokens.filter((token) => token.type === "identifier" && declaredVariables.has(token.value)).map((token) => token.value))].sort();
  const operators = [...new Set(tokens.filter((token) => token.type === "operator").map((token) => token.value))].sort();
  const isCompound = operators.includes("&&") || operators.includes("||");
  const unsupportedIdentifier = tokens.find((token, index) => token.type === "identifier" && !declaredVariables.has(token.value) && tokens[index + 1]?.value === "(");
  if (unsupportedIdentifier) {
    return { supported: false, isCompound, referencedVariables, operators, unsupportedReason: `function calls are not supported (${unsupportedIdentifier.value}())` };
  }
  const unsupported = tokens.find((token) => token.type === "identifier" && !declaredVariables.has(token.value));
  if (unsupported) {
    return { supported: false, isCompound, referencedVariables, operators, unsupportedReason: `unknown or dynamic identifier \`${unsupported.value}\`` };
  }
  let position = 0;
  const peek = () => tokens[position];
  const consume = (value: string): boolean => {
    if (!peek() || peek().value !== value) return false;
    position++;
    return true;
  };
  const value = (): boolean => {
    const token = peek();
    if (!token) return false;
    if (token.type === "identifier" || token.type === "number" || token.type === "string" || token.type === "boolean" || token.type === "null") {
      position++;
      return true;
    }
    if (consume("(")) {
      const valid = orExpression();
      return valid && consume(")");
    }
    return false;
  };
  const comparison = (): boolean => {
    if (!value()) return false;
    if (peek()?.type === "operator" && ["==", "!=", "<", "<=", ">", ">="].includes(peek().value)) {
      position++;
      return value();
    }
    return true;
  };
  const unary = (): boolean => consume("!") ? unary() : comparison();
  const andExpression = (): boolean => {
    if (!unary()) return false;
    while (consume("&&")) {
      if (!unary()) return false;
    }
    return true;
  };
  const orExpression = (): boolean => {
    if (!andExpression()) return false;
    while (consume("||")) {
      if (!andExpression()) return false;
    }
    return true;
  };
  if (!orExpression() || position !== tokens.length) {
    return { supported: false, isCompound, referencedVariables, operators, unsupportedReason: "expression is outside the supported boolean comparison grammar" };
  }
  return { supported: true, isCompound, referencedVariables, operators };
}

function gateProbeCondition(
  expression: string,
  variables: Map<string, VariableRecord>
): { condition?: AssertionCondition; reason?: string } {
  const tokenized = tokenizeGate(expression);
  if (!tokenized.tokens) return { reason: tokenized.error };
  const tokens = tokenized.tokens;
  let position = 0;
  let reason: string | undefined;
  const peek = () => tokens[position];
  const consume = (value: string): boolean => {
    if (!peek() || peek().value !== value) return false;
    position++;
    return true;
  };
  const operand = (): AssertionOperand | undefined => {
    const token = peek();
    if (!token) return undefined;
    if (token.type === "identifier") {
      const record = variables.get(token.value);
      if (!record) {
        reason ??= `unknown or dynamic identifier \`${token.value}\``;
        return undefined;
      }
      position++;
      return { variable: token.value };
    }
    if (token.type === "number") {
      position++;
      return { literal: Number(token.value) };
    }
    if (token.type === "string") {
      position++;
      return { literal: JSON.parse(token.value) as string };
    }
    if (token.type === "boolean") {
      position++;
      return { literal: token.value === "true" };
    }
    if (token.type === "null") {
      position++;
      return { literal: null };
    }
    return undefined;
  };
  const primary = (): AssertionCondition | undefined => {
    if (consume("(")) {
      const nested = orExpression();
      if (!nested || !consume(")")) {
        reason ??= "expression is outside the supported boolean comparison grammar";
        return undefined;
      }
      return nested;
    }
    const left = operand();
    if (!left) {
      reason ??= "expression is outside the supported boolean comparison grammar";
      return undefined;
    }
    const operator = peek()?.value;
    if (operator && ["==", "!=", "<", "<=", ">", ">="].includes(operator)) {
      position++;
      const right = operand();
      if (!right) {
        reason ??= "comparison is missing a supported variable or literal";
        return undefined;
      }
      return { left, operator: operator as AssertionOperator, right };
    }
    if ("variable" in left && typeof variables.get(left.variable)?.initialValue === "boolean") {
      return { left, operator: "==", right: { literal: true } };
    }
    reason ??= "bare conditions require a declared boolean variable";
    return undefined;
  };
  const unary = (): AssertionCondition | undefined => {
    if (consume("!")) {
      const nested = unary();
      return nested ? { not: nested } : undefined;
    }
    return primary();
  };
  const andExpression = (): AssertionCondition | undefined => {
    let result = unary();
    if (!result) return undefined;
    while (consume("&&")) {
      const right = unary();
      if (!right) return undefined;
      result = "all" in result ? { all: [...result.all, right] } : { all: [result, right] };
    }
    return result;
  };
  const orExpression = (): AssertionCondition | undefined => {
    let result = andExpression();
    if (!result) return undefined;
    while (consume("||")) {
      const right = andExpression();
      if (!right) return undefined;
      result = "any" in result ? { any: [...result.any, right] } : { any: [result, right] };
    }
    return result;
  };
  const condition = orExpression();
  if (!condition || position !== tokens.length) return { reason: reason ?? "expression is outside the supported boolean comparison grammar" };
  return { condition };
}

function extractGateCandidates(code: string): string[] {
  const candidates: string[] = [];
  for (const match of code.matchAll(/\{([^{}]*)(?:\}|$)/g)) {
    const raw = match[1].trim();
    const expression = raw.endsWith(":") ? raw.slice(0, -1).trim() : raw;
    if (expression && (raw.endsWith(":") || /(?:&&|\|\||==|!=|<=|>=|[<>!]|\w\s*\()/.test(expression))) candidates.push(expression);
  }
  return candidates;
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
  gates: GateRecord[];
  truncation: {
    includes: boolean;
    knots: boolean;
    externals: boolean;
    variables: boolean;
    gates: boolean;
    locationsPerVariable: boolean;
  };
  recommendedNextOperation: "compile_story";
}

/** Complete deterministic inventory used to produce bounded overview and section pages. */
function inspectProjectInventory(entryFile: string): ProjectInspection {
  const entry = path.resolve(entryFile);
  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    throw new Error(`Ink entrypoint not found: ${entryFile}`);
  }
  const root = path.dirname(entry);
  const visited = new Set<string>();
  const includes: string[] = [];
  const knots: ProjectInspection["knots"] = [];
  const variables = new Map<string, VariableRecord>();
  const gateCandidates: Array<{ expression: string; location: SourceLocation }> = [];
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
      for (const expression of extractGateCandidates(code)) gateCandidates.push({ expression, location });
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
  const declaredVariables = new Set(variables.keys());
  const gates = gateCandidates.map(({ expression, location }) => {
    const inspected = inspectGateExpression(expression, declaredVariables);
    const probe = inspected.supported ? gateProbeCondition(expression, variables) : undefined;
    return {
      expression,
      location,
      ...inspected,
      ...(probe?.condition ? { probeCondition: probe.condition } : {}),
      ...(inspected.supported && probe?.reason ? { probeUnsupportedReason: probe.reason } : {}),
      assignmentSites: inspected.referencedVariables.map((name) => {
        const record = variables.get(name)!;
        return {
          name,
          ...(record.declaration ? { declaration: record.declaration } : {}),
          writes: record.writes,
          writeCount: record.writeCount,
        };
      }),
    };
  }).sort((a, b) => a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line || a.expression.localeCompare(b.expression));
  return {
    schemaVersion: PROJECT_INSPECTION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    entrypoint: relativeFile(root, entry),
    includes: sortedIncludes,
    shape: scanShapeProfile(entry),
    semantics: scanStorySemantics(entry),
    externals: sortedExternals,
    knots: sortedKnots,
    variables: sortedVariables,
    gates,
    truncation: {
      includes: sortedIncludes.length > MAX_INSPECT_INCLUDES,
      knots: sortedKnots.length > MAX_INSPECT_KNOTS,
      externals: sortedExternals.length > MAX_INSPECT_EXTERNALS,
      variables: variablesTruncated,
      gates: gates.length > MAX_INSPECT_GATES,
      locationsPerVariable: locationsTruncated,
    },
    recommendedNextOperation: "compile_story",
  };
}

/** Deterministic, source-only project overview for agents. */
export function inspectProject(entryFile: string): ProjectInspection {
  const inventory = inspectProjectInventory(entryFile);
  return {
    ...inventory,
    includes: inventory.includes.slice(0, MAX_INSPECT_INCLUDES),
    externals: inventory.externals.slice(0, MAX_INSPECT_EXTERNALS),
    knots: inventory.knots.slice(0, MAX_INSPECT_KNOTS),
    variables: inventory.variables.slice(0, MAX_INSPECT_VARIABLES),
    gates: inventory.gates.slice(0, MAX_INSPECT_GATES),
  };
}

/**
 * Select one source-stable, losslessly translatable condition for an explicit
 * additive goal probe. Source assignments remain evidence, never reachability proof.
 */
export function selectGateProbe(entryFile: string, location: SourceLocation): GateProbePlan {
  const inventory = inspectProjectInventory(entryFile);
  const gate = inventory.gates.find((item) => item.location.file === location.file && item.location.line === location.line);
  if (!gate) throw new Error(`No static condition gate found at ${location.file}:${location.line}`);
  if (!gate.supported) throw new Error(`Gate at ${location.file}:${location.line} is not supported: ${gate.unsupportedReason ?? "unknown reason"}`);
  if (!gate.probeCondition) {
    throw new Error(`Gate at ${location.file}:${location.line} cannot become a bounded probe: ${gate.probeUnsupportedReason ?? "unsupported condition"}`);
  }
  const id = `gate-${createHash("sha256").update(`${gate.location.file}\0${gate.location.line}\0${gate.expression}`).digest("hex").slice(0, 24)}`;
  return {
    gate,
    goal: {
      id,
      description: `Static gate at ${gate.location.file}:${gate.location.line}`,
      condition: gate.probeCondition,
    },
    semantics: "additive_goal_probe",
    disclosure: "The condition came from static source inspection. Assignment sites are factual source references, not proof that the condition is reachable or causally enabled by a particular path.",
  };
}

function compactPath(value: string): string {
  return value.length <= 256 ? value : `...${value.slice(-253)}`;
}

/** Compact MCP discovery response; detailed values and locations require an explicit section page. */
export function inspectProjectOverview(entryFile: string) {
  const inventory = inspectProjectInventory(entryFile);
  const result = {
    schemaVersion: PROJECT_INSPECTION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    entrypoint: compactPath(inventory.entrypoint),
    ...(inventory.entrypoint.length > 256 ? { entrypointPathTruncated: true as const } : {}),
    shape: inventory.shape,
    semantics: inventory.semantics,
    inventory: {
      includes: inventory.includes.length,
      externals: inventory.externals.length,
      knots: inventory.knots.length,
      variables: inventory.variables.length,
      gates: inventory.gates.length,
    },
    samples: {
      includes: inventory.includes.slice(0, DEFAULT_INSPECT_SAMPLE_SIZE).map((item) => ({
        path: compactPath(item),
        ...(item.length > 256 ? { pathTruncated: true as const } : {}),
      })),
      externals: inventory.externals.slice(0, DEFAULT_INSPECT_SAMPLE_SIZE).map((name) => ({
        name: boundedName(name),
        ...(name.length > 128 ? { nameTruncated: true as const } : {}),
      })),
      knots: inventory.knots.slice(0, DEFAULT_INSPECT_SAMPLE_SIZE).map((item) => ({
        name: boundedName(item.name),
        ...(item.name.length > 128 ? { nameTruncated: true as const } : {}),
        kind: item.kind,
        file: compactPath(item.file),
        ...(item.file.length > 256 ? { pathTruncated: true as const } : {}),
        line: item.line,
      })),
      variables: inventory.variables.slice(0, DEFAULT_INSPECT_SAMPLE_SIZE).map((item) => ({
        name: boundedName(item.name),
        ...(item.name.length > 128 ? { nameTruncated: true as const } : {}),
        readCount: item.readCount,
        writeCount: item.writeCount,
        ...(item.declaration ? { declaration: {
          file: compactPath(item.declaration.file),
          ...(item.declaration.file.length > 256 ? { pathTruncated: true as const } : {}),
          line: item.declaration.line,
        } } : {}),
      })),
      gates: inventory.gates.slice(0, DEFAULT_INSPECT_SAMPLE_SIZE).map((item) => ({
        location: { file: compactPath(item.location.file), line: item.location.line },
        supported: item.supported,
        isCompound: item.isCompound,
        referencedVariables: item.referencedVariables.map(boundedName),
      })),
    },
    response: {
      detail: "summary" as const,
      dataTruncated: inventory.includes.length > DEFAULT_INSPECT_SAMPLE_SIZE
        || inventory.externals.length > DEFAULT_INSPECT_SAMPLE_SIZE
        || inventory.knots.length > DEFAULT_INSPECT_SAMPLE_SIZE
        || inventory.variables.length > DEFAULT_INSPECT_SAMPLE_SIZE
        || inventory.gates.length > DEFAULT_INSPECT_SAMPLE_SIZE,
      sampleLimit: DEFAULT_INSPECT_SAMPLE_SIZE,
      drillDown: {
        tool: "inspect_story" as const,
        sections: ["includes", "externals", "knots", "variables", "gates"] as const,
        note: "Request one section for stable source-bound pages. Variable and gate pages explicitly reveal source expressions and locations.",
      },
      contentPolicy: "Counts and small name/location samples only; variable values, gate expressions, and full read/write locations are omitted.",
    },
    recommendedNextOperation: "compile_story" as const,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_INSPECTION_OVERVIEW_BYTES) {
    throw new Error(`bounded project-inspection overview exceeded ${MAX_INSPECTION_OVERVIEW_BYTES} bytes`);
  }
  return result;
}

function boundedName(value: string): string {
  return value.length <= 128 ? value : `${value.slice(0, 125)}...`;
}

export type InspectionSection = "includes" | "externals" | "knots" | "variables" | "gates";

function inspectionCursor(fingerprint: string, section: InspectionSection, offset: number): string {
  return `inspection-cursor-${Buffer.from(JSON.stringify({ v: 1, fingerprint, section, offset }), "utf8").toString("base64url")}`;
}

function inspectionOffset(fingerprint: string, section: InspectionSection, cursor?: string): number {
  if (!cursor) return 0;
  if (!cursor.startsWith("inspection-cursor-")) throw new Error("invalid source-inspection cursor");
  try {
    const value = JSON.parse(Buffer.from(cursor.slice("inspection-cursor-".length), "base64url").toString("utf8")) as {
      v?: unknown; fingerprint?: unknown; section?: unknown; offset?: unknown;
    };
    if (value.v !== 1 || value.fingerprint !== fingerprint || value.section !== section
      || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) throw new Error();
    return value.offset as number;
  } catch {
    throw new Error("invalid, stale, or foreign source-inspection cursor");
  }
}

export function inspectProjectSection(
  entryFile: string,
  section: InspectionSection,
  options: { limit?: number; cursor?: string } = {}
) {
  const limit = options.limit ?? DEFAULT_INSPECT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INSPECT_PAGE_SIZE) {
    throw new RangeError(`source-inspection page limit must be an integer from 1 to ${MAX_INSPECT_PAGE_SIZE}`);
  }
  const inventory = inspectProjectInventory(entryFile);
  const items = inventory[section];
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ entrypoint: inventory.entrypoint, section, items }))
    .digest("hex");
  const offset = inspectionOffset(fingerprint, section, options.cursor);
  if (offset > items.length) throw new Error("source-inspection cursor is beyond the immutable inventory");
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    schemaVersion: PROJECT_INSPECTION_SCHEMA_VERSION,
    inkcheckVersion: VERSION,
    entrypoint: inventory.entrypoint,
    inventoryFingerprint: { algorithm: "sha256" as const, value: fingerprint },
    section,
    items: page,
    page: {
      limit,
      returned: page.length,
      total: items.length,
      nextCursor: nextOffset < items.length ? inspectionCursor(fingerprint, section, nextOffset) : null,
    },
    contentPolicy: section === "variables"
      ? "Variable names, initial values/expressions, and bounded read/write locations are included because this section was explicitly requested."
      : section === "gates"
        ? "Gate expressions, supported-grammar status, referenced variables, and factual assignment sites are included because this section was explicitly requested. Assignment sites are not proof that a gate is reachable."
      : "Only the explicitly requested source-inventory section is included.",
    recommendedNextOperation: "compile_story" as const,
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
    `${value.includes.length} include(s), ${value.shape.knots} knot(s), ${value.shape.functions} function(s), ${value.variables.length} variable(s), ${value.gates.length} gate(s)`,
    `Choices: ${value.shape.choiceLines}; turns: ${value.semantics.usesTurns ? "yes" : "no"}; randomness: ${value.semantics.usesRandomness ? "yes" : "no"}`,
    `External functions: ${value.externals.length ? value.externals.join(", ") : "none"}`,
    "Next: compile the story before exploring it.",
  ].join("\n");
}
