import * as fs from "fs";
import * as path from "path";
import { parseDocument } from "yaml";
import { AssertionDefinition, parseAssertionDefinitions } from "./assertions";
import { GoalDefinition, parseGoalDefinitions } from "./goals";

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_CONFIG_FILE = "inkcheck.yml";

export interface InkcheckCiConfig {
  maxDepth?: number;
  maxStates?: number;
  seed?: number;
  storySeed?: number;
  search?: "portfolio" | "shared" | "shared-variable";
  /** Experimental fixed-allocation portfolio worker ceiling. */
  concurrency?: number;
  maxMemoryMb?: number;
  maxTimeSec?: number;
  /** Shared search only: explicit retained-checkpoint count envelope. */
  maxFrontierStates?: number;
  /** Shared search only: explicit retained-checkpoint payload envelope in MiB. */
  maxFrontierMb?: number;
  strict?: boolean;
  minRepro?: boolean;
  /** Additional directed-goal work; ordinary maxStates remains unchanged. */
  goalMaxStates?: number;
}

export interface InkcheckProjectConfig {
  schemaVersion: 1;
  entrypoint: string;
  ci?: InkcheckCiConfig;
  assertions?: AssertionDefinition[];
  goals?: GoalDefinition[];
}

export interface LoadedProjectConfig {
  path: string;
  projectRoot: string;
  entrypoint: string;
  config: InkcheckProjectConfig;
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid Inkcheck config:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigValidationError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: string[], at: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${at}.${key}: unknown key`);
  }
}

function boundedInteger(
  value: unknown,
  at: string,
  min: number,
  max: number,
  issues: string[]
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push(`${at}: expected an integer from ${min} to ${max}`);
    return undefined;
  }
  return value as number;
}

export function parseProjectConfig(source: string): InkcheckProjectConfig {
  const document = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length) {
    throw new ConfigValidationError(document.errors.map((error) => `YAML: ${error.message}`));
  }
  const value = document.toJS() as unknown;
  if (!record(value)) throw new ConfigValidationError(["root: expected a mapping"]);

  const issues: string[] = [];
  unknownKeys(value, ["schemaVersion", "entrypoint", "ci", "assertions", "goals"], "root", issues);
  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push(`schemaVersion: expected ${CONFIG_SCHEMA_VERSION}`);
  }
  if (typeof value.entrypoint !== "string" || !value.entrypoint.trim()) {
    issues.push("entrypoint: expected a non-empty relative .ink path");
  } else if (path.isAbsolute(value.entrypoint) || !value.entrypoint.toLowerCase().endsWith(".ink")) {
    issues.push("entrypoint: expected a relative .ink path");
  } else {
    const normalized = path.normalize(value.entrypoint);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      issues.push("entrypoint: must stay inside the project directory");
    }
  }

  let ci: InkcheckCiConfig | undefined;
  if (value.ci !== undefined) {
    if (!record(value.ci)) {
      issues.push("ci: expected a mapping");
    } else {
      unknownKeys(
        value.ci,
        ["maxDepth", "maxStates", "goalMaxStates", "seed", "storySeed", "search", "concurrency", "maxMemoryMb", "maxTimeSec", "maxFrontierStates", "maxFrontierMb", "strict", "minRepro"],
        "ci",
        issues
      );
      ci = {
        maxDepth: boundedInteger(value.ci.maxDepth, "ci.maxDepth", 1, 1_000, issues),
        maxStates: boundedInteger(value.ci.maxStates, "ci.maxStates", 1, 100_000_000, issues),
        goalMaxStates: boundedInteger(value.ci.goalMaxStates, "ci.goalMaxStates", 0, 100_000_000, issues),
        seed: boundedInteger(value.ci.seed, "ci.seed", 1, 4_294_967_295, issues),
        storySeed: boundedInteger(value.ci.storySeed, "ci.storySeed", 1, 2_147_483_646, issues),
        concurrency: boundedInteger(value.ci.concurrency, "ci.concurrency", 1, 16, issues),
        maxMemoryMb: boundedInteger(value.ci.maxMemoryMb, "ci.maxMemoryMb", 1, 1_000_000, issues),
        maxTimeSec: boundedInteger(value.ci.maxTimeSec, "ci.maxTimeSec", 1, 86_400, issues),
        maxFrontierStates: boundedInteger(value.ci.maxFrontierStates, "ci.maxFrontierStates", 1, 100_000_000, issues),
        maxFrontierMb: boundedInteger(value.ci.maxFrontierMb, "ci.maxFrontierMb", 1, 1_000_000, issues),
      };
      if (value.ci.search !== undefined) {
        if (!["portfolio", "shared", "shared-variable"].includes(value.ci.search as string)) {
          issues.push("ci.search: expected portfolio, shared, or shared-variable");
        } else ci.search = value.ci.search as InkcheckCiConfig["search"];
      }
      for (const key of ["strict", "minRepro"] as const) {
        if (value.ci[key] !== undefined && typeof value.ci[key] !== "boolean") {
          issues.push(`ci.${key}: expected true or false`);
        } else if (typeof value.ci[key] === "boolean") ci[key] = value.ci[key];
      }
      for (const key of Object.keys(ci) as Array<keyof InkcheckCiConfig>) {
        if (ci[key] === undefined) delete ci[key];
      }
      if ((ci.maxFrontierStates !== undefined || ci.maxFrontierMb !== undefined) && (ci.search ?? "portfolio") === "portfolio") {
        issues.push("ci.maxFrontierStates/ci.maxFrontierMb: require search: shared or shared-variable");
      }
      if ((ci.concurrency ?? 1) > 1 && (ci.search ?? "portfolio") !== "portfolio") {
        issues.push("ci.concurrency greater than 1 requires search: portfolio");
      }
    }
  }
  const assertions = parseAssertionDefinitions(value.assertions, "assertions", issues);
  const goals = parseGoalDefinitions(value.goals, "goals", issues);
  const baselineStates = ci?.maxStates ?? 10_000_000;
  const goalStates = ci?.goalMaxStates ?? 0;
  if (goalStates > 0 && !goals?.length) issues.push("ci.goalMaxStates: requires at least one goal");
  if (baselineStates + goalStates > 100_000_000) {
    issues.push("ci.maxStates + ci.goalMaxStates: must not exceed 100000000");
  }

  if (issues.length) throw new ConfigValidationError(issues);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    entrypoint: (value.entrypoint as string).split("\\").join("/"),
    ...(ci ? { ci } : {}),
    ...(assertions ? { assertions } : {}),
    ...(goals ? { goals } : {}),
  };
}

export function loadProjectConfig(configFile = DEFAULT_CONFIG_FILE): LoadedProjectConfig {
  const configPath = path.resolve(configFile);
  if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
    throw new ConfigValidationError([`config: file not found: ${configFile}`]);
  }
  const config = parseProjectConfig(fs.readFileSync(configPath, "utf8"));
  const projectRoot = path.dirname(configPath);
  const entrypoint = path.resolve(projectRoot, ...config.entrypoint.split("/"));
  if (!fs.existsSync(entrypoint) || !fs.statSync(entrypoint).isFile()) {
    throw new ConfigValidationError([`entrypoint: file not found: ${config.entrypoint}`]);
  }
  return { path: configPath, projectRoot, entrypoint, config };
}

export function findDefaultProjectConfig(directory = process.cwd()): LoadedProjectConfig | undefined {
  const configPath = path.join(directory, DEFAULT_CONFIG_FILE);
  return fs.existsSync(configPath) ? loadProjectConfig(configPath) : undefined;
}
