#!/usr/bin/env node
import * as path from "path";
import {
  CompileResult,
  DEFAULT_MAX_DEPTH,
  KnotInfo,
  StoryShapeProfile,
  StorySemantics,
  compile,
  stats,
  scanKnots,
  scanExternals,
  scanInboundDiverts,
  scanShapeProfile,
  scanStorySemantics,
} from "./inklecate";
import {
  ExploreResult,
  ExploreProgress,
  DEFAULT_STORY_SEED,
  MAX_STORY_SEED,
  PortfolioWeights,
  UnvisitedKnotReport,
  classifyUnvisitedKnots,
  explore,
  exploreSharedResumable,
  exploreWithGoals,
  mergeMinRepro,
  validateAssertionsForStory,
  validateGoalsForStory,
} from "./explore";
import { NextRunAdvice, recommendNextRun } from "./advice";
import {
  buildHumanFindings,
  renderHumanFindings,
  truncationAdvice,
  unvisitedKnotHint,
} from "./human-report";
import {
  HumanProgressRenderer,
  ProgressOutcome,
  ProgressStatus,
  ProgressStopReason,
} from "./terminal-progress";
import {
  buildCompileFailureEnvelope,
  buildReportEnvelope,
  EffectiveReportConfiguration,
} from "./report-contract";
import {
  capabilities,
  ARTIFACT_SCHEMA_VERSION,
  inspectProject,
  renderCapabilitiesHuman,
  renderInspectionHuman,
} from "./discovery";
import { findDefaultProjectConfig, loadProjectConfig } from "./config";
import { createAgentKit, initProject, renderScaffoldResult } from "./scaffold";
import { createResourceGuards } from "./resource-guards";
import {
  explorePortfolioConcurrent,
  explorePortfolioPilotHandoffConcurrent,
} from "./concurrent-portfolio";
import {
  PortfolioConcurrencySetting,
  resolvePortfolioConcurrency,
} from "./concurrency-policy";
import {
  artifactProjectRoot,
  deleteReportArtifact,
  listReportFindings,
  listReportArtifacts,
  openReportFinding,
  openReportArtifact,
  pruneReportArtifacts,
  replayReportFinding,
  saveReportArtifact,
} from "./artifacts";
import {
  CHECKPOINT_ARTIFACT_SCHEMA_VERSION,
  listCheckpointArtifacts,
  loadCheckpointForResume,
  openCheckpointArtifact,
  saveCheckpointArtifact,
} from "./checkpoints";
import { renderHumanResultWindow, runHumanCampaign } from "./human-campaign";
import type { CampaignMode } from "./campaign-policy";

let activeProgressFailure: (() => void) | undefined;

function usage(message?: string): never {
  if (message) console.error(`inkcheck: ${message}\n`);
  console.error(`inkcheck — CI for ink stories

Usage: inkcheck <story.ink> [options]
       inkcheck campaign <story.ink> [campaign options]
       inkcheck capabilities [--json]
       inkcheck inspect <story.ink> [--json]
       inkcheck validate-config [inkcheck.yml] [--json]
       inkcheck init [directory] [--entrypoint story.ink] [--json]
       inkcheck agent-kit --format codex [directory] [--entrypoint story.ink] [--json]
       inkcheck artifacts list [--json]
       inkcheck artifacts show <report-id> [--json]
       inkcheck artifacts findings <report-id> [--limit N] [--cursor C] [--json]
       inkcheck artifacts finding <report-id> <finding-id> [--json]
       inkcheck artifacts replay <report-id> <finding-id> [--json]
       inkcheck artifacts delete <report-id> [--apply] [--json]
       inkcheck artifacts prune --keep N [--apply] [--json]
       inkcheck checkpoints list [--json]
       inkcheck checkpoints show <checkpoint-id> [--json]
       inkcheck resume <checkpoint-id> --max-states N [options]
       inkcheck mcp              Start the MCP server (stdio)

Options:
  --max-depth <n>    Max choices deep to explore, 1–1000 (default 100)
  --max-states <n>   Max story states to visit, 1–100000000 (default 10000000)
  --goal-states <n>  Additional directed-goal states, 1–100000000 (default 0)
  --seed <n>         Seed for the random-sampling slice, 1–4294967295 (default 1)
  --story-seed <n>   Initial Ink runtime RNG seed, 1–2147483646 (default 1)
  --search <mode>    Search: portfolio (default), shared, or shared-variable
  --concurrency <auto|n>  Workload-aware auto activation (default), or fixed ceiling 1-16
  --max-memory <mb>  Stop cleanly before heap use exceeds <mb> (default: 85% of the V8 heap limit)
  --max-time <s>     Stop cleanly after <s> seconds and return a partial report (default: no time limit)
  --max-frontier-states <n>  Shared search pending-checkpoint cap (default: none)
  --max-frontier-memory <mb> Shared search pending-checkpoint payload cap (default: none)
  --profile          Print the story's shape profile and suggested settings, without exploring
  --auto             Apply the shape profile: suggested depth (unless --max-depth given) and pass weights
  --next             After the check, apply the recommended escalation automatically (up to 3 reruns)
  --no-min-repro     Skip the small breadth-first repro-shortening slice
  --strict           Also fail on warnings, unvisited knots, truncation, or external stubs
  --human            Emit a prioritized human-readable fix list
  --json             Emit the full report as JSON
  --markdown         Emit a GitHub-friendly Markdown report
  --save-report      Atomically save a versioned local report artifact
  --save-checkpoint  Save an exact base-shared frontier when work remains
  --progress=<mode>  Write progress to stderr: auto, human, ndjson, or off (default auto in a terminal)

Campaign options:
  --mode <intent>         quick, balanced (default), deep, overnight, campaign, or fixed
  --deadline <ISO-time>   Return the latest partial result by this time
  --stop <policy>         knee (default for quick/deep modes) or ceilings
  --value <preference>    broad_qa (default), runtime_assertions, or outcomes
  --resource <posture>    scarce, balanced, or abundant
  --window-states <n>     Expert per-window state ceiling, up to 5000000
  --max-states <n>        Expert aggregate state ceiling, up to 100000000
  --max-time <s>          Expert aggregate elapsed-time ceiling, up to 604800
  --max-memory <mb>       Expert heap ceiling
  --max-disk <mb>         Expert report/checkpoint disk ceiling
  --json                  Emit machine-readable result-window metadata
`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "mcp") {
    require("./server");
    return;
  }
  if (args[0] === "capabilities") {
    if (args.some((arg, index) => index > 0 && arg !== "--json")) {
      usage("capabilities accepts only --json");
    }
    const value = capabilities();
    console.log(args.includes("--json") ? JSON.stringify(value, null, 2) : renderCapabilitiesHuman(value));
    return;
  }
  if (args[0] === "campaign") {
    let file: string | undefined;
    let mode: CampaignMode = "balanced";
    let resourcePreference: "scarce" | "balanced" | "abundant" | undefined;
    let valuePreference: "broad_qa" | "runtime_assertions" | "outcomes" | undefined;
    let stopPolicy: "ceilings" | "knee" | undefined;
    let totalStates: number | undefined;
    let windowStates: number | undefined;
    let maxElapsedSeconds: number | undefined;
    let maxMemoryMb: number | undefined;
    let maxDiskMb: number | undefined;
    let maxDepth: number | undefined;
    let seed: number | undefined;
    let storySeed: number | undefined;
    let deadlineAt: string | undefined;
    let json = false;
    const integer = (flag: string, raw: string | undefined, maximum: number): number => {
      const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) usage(`campaign: ${flag} requires an integer from 1 to ${maximum}`);
      return value;
    };
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--json") json = true;
      else if (["--mode", "--resource", "--value", "--stop", "--deadline", "--max-states", "--window-states", "--max-time", "--max-memory", "--max-disk", "--max-depth", "--seed", "--story-seed"].includes(arg)) {
        const value = args[++index];
        if (!value || value.startsWith("--")) usage(`campaign: ${arg} requires a value`);
        if (arg === "--mode") {
          if (!["quick", "balanced", "deep", "overnight", "campaign", "fixed"].includes(value)) usage("campaign: --mode must be quick, balanced, deep, overnight, campaign, or fixed");
          mode = value as CampaignMode;
        } else if (arg === "--resource") {
          if (!["scarce", "balanced", "abundant"].includes(value)) usage("campaign: --resource must be scarce, balanced, or abundant");
          resourcePreference = value as typeof resourcePreference;
        } else if (arg === "--value") {
          if (!["broad_qa", "runtime_assertions", "outcomes"].includes(value)) usage("campaign: --value must be broad_qa, runtime_assertions, or outcomes");
          valuePreference = value as typeof valuePreference;
        } else if (arg === "--stop") {
          if (!["ceilings", "knee"].includes(value)) usage("campaign: --stop must be knee or ceilings");
          stopPolicy = value as typeof stopPolicy;
        } else if (arg === "--deadline") {
          if (!Number.isFinite(Date.parse(value))) usage("campaign: --deadline must be an ISO date-time");
          deadlineAt = new Date(value).toISOString();
        } else if (arg === "--max-states") totalStates = integer(arg, value, 100_000_000);
        else if (arg === "--window-states") windowStates = integer(arg, value, 5_000_000);
        else if (arg === "--max-time") maxElapsedSeconds = integer(arg, value, 604_800);
        else if (arg === "--max-memory") maxMemoryMb = integer(arg, value, 1_000_000);
        else if (arg === "--max-disk") maxDiskMb = integer(arg, value, 1_000_000);
        else if (arg === "--max-depth") maxDepth = integer(arg, value, 1_000);
        else if (arg === "--seed") seed = integer(arg, value, 4_294_967_295);
        else storySeed = integer(arg, value, MAX_STORY_SEED);
      } else if (arg.startsWith("--")) usage(`campaign: unknown option: ${arg}`);
      else if (file) usage(`campaign: unexpected extra argument: ${arg}`);
      else file = arg;
    }
    try {
      file ??= findDefaultProjectConfig()?.entrypoint;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
    if (!file) usage("campaign: missing story file (or inkcheck.yml entrypoint)");
    if (mode === "fixed" && (totalStates === undefined || maxElapsedSeconds === undefined || maxDiskMb === undefined)) {
      usage("campaign: fixed mode requires --max-states, --max-time, and --max-disk");
    }
    let cancelRequested = false;
    const requestCancel = () => { cancelRequested = true; };
    process.once("SIGINT", requestCancel);
    process.once("SIGTERM", requestCancel);
    try {
      const result = await runHumanCampaign({
        file,
        mode,
        resourcePreference,
        valuePreference,
        stopPolicy,
        totalStates,
        windowStates,
        maxElapsedSeconds,
        maxMemoryMb,
        maxDiskMb,
        maxDepth,
        seed,
        storySeed,
        deadlineAt,
        shouldCancel: () => cancelRequested,
        ...(json ? {} : { onWindow: (window) => console.error(renderHumanResultWindow(window)) }),
      });
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`Campaign ${result.status}: ${result.windows.length} immutable result window${result.windows.length === 1 ? "" : "s"}. Reports remain under .inkcheck/reports/.`);
      if (result.final.session.findings.runtimeErrors > 0 || result.final.session.findings.assertionViolations > 0) process.exitCode = 1;
      return;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    } finally {
      process.off("SIGINT", requestCancel);
      process.off("SIGTERM", requestCancel);
    }
  }
  if (args[0] === "checkpoints") {
    const command = args[1];
    const json = args.includes("--json");
    const values = args.slice(2).filter((arg) => arg !== "--json");
    if (args.slice(2).some((arg) => arg.startsWith("--") && arg !== "--json")) {
      usage(`checkpoints: unknown option: ${args.slice(2).find((arg) => arg.startsWith("--") && arg !== "--json")}`);
    }
    let projectRoot = process.cwd();
    try {
      const config = findDefaultProjectConfig();
      if (config) projectRoot = path.dirname(config.path);
      if (command === "list" && values.length === 0) {
        const checkpoints = listCheckpointArtifacts(projectRoot);
        console.log(json
          ? JSON.stringify({ checkpointArtifactSchemaVersion: CHECKPOINT_ARTIFACT_SCHEMA_VERSION, checkpoints }, null, 2)
          : checkpoints.length
            ? checkpoints.map((checkpoint) => `${checkpoint.id}  ${checkpoint.totalGranted} granted  ${checkpoint.createdAt}  ${checkpoint.entrypoint}`).join("\n")
            : "No saved Inkcheck checkpoints.");
        return;
      }
      if (command === "show" && values.length === 1) {
        const opened = await openCheckpointArtifact(projectRoot, values[0]);
        console.log(json
          ? JSON.stringify(opened, null, 2)
          : `${opened.artifact.id}: ${opened.artifact.freshness}\nEntrypoint: ${opened.artifact.entrypoint}\nGrant: ${opened.artifact.totalGranted}\nSaved: ${opened.artifact.createdAt}`);
        return;
      }
      usage("checkpoints requires `list` or `show <checkpoint-id>` and optional --json");
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }
  if (args[0] === "artifacts") {
    const command = args[1];
    let json = false;
    let limit: number | undefined;
    let cursor: string | undefined;
    let keep: number | undefined;
    let apply = false;
    const values: string[] = [];
    for (let index = 2; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--json") json = true;
      else if (arg === "--apply") apply = true;
      else if (arg === "--limit" || arg === "--cursor" || arg === "--keep") {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) usage(`artifacts: ${arg} requires a value`);
        index += 1;
        if (arg === "--limit" || arg === "--keep") {
          if (!/^\d+$/.test(value)) usage(`artifacts: ${arg} must be an integer`);
          if (arg === "--limit") limit = Number(value);
          else keep = Number(value);
        } else cursor = value;
      } else if (arg.startsWith("--")) usage(`artifacts: unknown option: ${arg}`);
      else values.push(arg);
    }
    let projectRoot = process.cwd();
    try {
      const config = findDefaultProjectConfig();
      if (config) projectRoot = path.dirname(config.path);
      if (command === "list" && values.length === 0) {
        if (limit !== undefined || cursor !== undefined || keep !== undefined || apply) usage("artifacts list does not accept pagination or mutation options");
        const artifacts = listReportArtifacts(projectRoot);
        console.log(json
          ? JSON.stringify({ artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION, artifacts }, null, 2)
          : artifacts.length
            ? artifacts.map((artifact) => `${artifact.id}  ${artifact.createdAt}  ${artifact.entrypoint}`).join("\n")
            : "No saved Inkcheck report artifacts.");
        return;
      }
      if (command === "show" && values.length === 1) {
        if (limit !== undefined || cursor !== undefined || keep !== undefined || apply) usage("artifacts show does not accept pagination or mutation options");
        const opened = await openReportArtifact(projectRoot, values[0]);
        console.log(json
          ? JSON.stringify(opened, null, 2)
          : `${opened.artifact.id}: ${opened.artifact.freshness}\nEntrypoint: ${opened.artifact.entrypoint}\nSaved: ${opened.artifact.createdAt}`);
        return;
      }
      if (command === "findings" && values.length === 1) {
        if (keep !== undefined || apply) usage("artifacts findings does not accept mutation options");
        const page = await listReportFindings(projectRoot, values[0], { limit, cursor });
        console.log(json
          ? JSON.stringify(page, null, 2)
          : [
              `${page.artifact.id}: ${page.artifact.freshness}`,
              ...page.findings.map((finding) => `${finding.id}  ${finding.kind}  ${finding.section}`),
              ...(page.page.nextCursor ? [`Next cursor: ${page.page.nextCursor}`] : []),
            ].join("\n"));
        return;
      }
      if (command === "finding" && values.length === 2) {
        if (limit !== undefined || cursor !== undefined || keep !== undefined || apply) usage("artifacts finding does not accept pagination or mutation options");
        const opened = await openReportFinding(projectRoot, values[0], values[1]);
        console.log(json
          ? JSON.stringify(opened, null, 2)
          : `${opened.summary.id}: ${opened.summary.kind}\nReport: ${opened.artifact.id} (${opened.artifact.freshness})\nSection: ${opened.summary.section}\n${JSON.stringify(opened.finding, null, 2)}`);
        return;
      }
      if (command === "replay" && values.length === 2) {
        if (limit !== undefined || cursor !== undefined || keep !== undefined || apply) usage("artifacts replay does not accept pagination or mutation options");
        const replayed = await replayReportFinding(projectRoot, values[0], values[1]);
        console.log(json
          ? JSON.stringify(replayed, null, 2)
          : `${replayed.finding.id}: ${replayed.replay.replayStatus}\nStory seed: ${replayed.replay.storySeed}\nRuntime errors: ${replayed.replay.runtimeErrors.length}`);
        return;
      }
      if (command === "delete" && values.length === 1) {
        if (limit !== undefined || cursor !== undefined || keep !== undefined) usage("artifacts delete accepts only <report-id>, --apply, and --json");
        const result = deleteReportArtifact(projectRoot, values[0], apply);
        console.log(json
          ? JSON.stringify(result, null, 2)
          : `${result.applied ? "Deleted" : "Would delete"} ${result.candidates[0].id} (${result.bytes} bytes)${result.applied ? "" : "\nRun again with --apply to delete it."}`);
        return;
      }
      if (command === "prune" && values.length === 0 && keep !== undefined) {
        if (limit !== undefined || cursor !== undefined) usage("artifacts prune accepts only --keep N, --apply, and --json");
        const result = pruneReportArtifacts(projectRoot, keep, apply);
        console.log(json
          ? JSON.stringify(result, null, 2)
          : `${result.applied ? "Deleted" : "Would delete"} ${result.selectedCount} report(s) (${result.bytes} bytes); ${result.remainingCandidates} candidate(s) remain.${result.applied || result.selectedCount === 0 ? "" : "\nRun again with --apply to delete this batch."}`);
        return;
      }
      usage("artifacts requires list, show <report-id>, findings <report-id>, finding <report-id> <finding-id>, replay <report-id> <finding-id>, delete <report-id>, or prune --keep N");
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }
  if (args[0] === "validate-config") {
    const values = args.slice(1).filter((arg) => arg !== "--json");
    if (values.length > 1 || args.slice(1).some((arg) => arg.startsWith("--") && arg !== "--json")) {
      usage("validate-config accepts an optional config path and --json only");
    }
    try {
      const loaded = loadProjectConfig(values[0]);
      const result = {
        valid: true,
        schemaVersion: loaded.config.schemaVersion,
        configFile: loaded.path,
        entrypoint: loaded.entrypoint,
        config: loaded.config,
      };
      console.log(
        args.includes("--json")
          ? JSON.stringify(result, null, 2)
          : `Valid Inkcheck config v${result.schemaVersion}: ${result.configFile}\nEntrypoint: ${result.entrypoint}`
      );
      return;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }
  if (args[0] === "init" || args[0] === "agent-kit") {
    const command = args.shift() as "init" | "agent-kit";
    let directory = ".";
    let directorySpecified = false;
    let entrypoint: string | undefined;
    let format: string | undefined;
    let json = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--json") json = true;
      else if (arg === "--entrypoint") entrypoint = args[++index];
      else if (arg === "--format") format = args[++index];
      else if (arg.startsWith("--")) usage(`${command}: unknown option: ${arg}`);
      else if (directorySpecified) usage(`${command}: unexpected extra argument: ${arg}`);
      else {
        directory = arg;
        directorySpecified = true;
      }
    }
    if (entrypoint === undefined && args.includes("--entrypoint")) usage(`${command}: --entrypoint requires a path`);
    if (command === "agent-kit" && format !== "codex") usage("agent-kit requires --format codex");
    if (command === "init" && format !== undefined) usage("init does not accept --format");
    try {
      const result = command === "init"
        ? initProject(directory, entrypoint)
        : createAgentKit(directory, format, entrypoint);
      console.log(json ? JSON.stringify(result, null, 2) : renderScaffoldResult(result));
      return;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }
  let resumeCheckpointId: string | undefined;
  if (args[0] === "resume") {
    resumeCheckpointId = args[1];
    if (!resumeCheckpointId || resumeCheckpointId.startsWith("--")) {
      usage("resume requires a checkpoint ID and explicit --max-states N");
    }
    args.splice(0, 2);
  }
  const inspectMode = args[0] === "inspect";
  if (inspectMode) args.shift();
  let file: string | undefined;
  let maxDepth: number | undefined;
  let maxStates: number | undefined;
  let goalMaxStates: number | undefined;
  let seed: number | undefined;
  let storySeed: number | undefined;
  let search: "portfolio" | "shared" | "shared-variable" = "portfolio";
  let concurrency: PortfolioConcurrencySetting | undefined;
  let strict = false;
  let asJson = false;
  let asMarkdown = false;
  let asHuman = false;
  let saveReport = false;
  let saveCheckpoint = resumeCheckpointId !== undefined;
  let maxStatesSpecified = false;
  let minRepro = true;
  let minReproSpecified = false;
  let profileOnly = false;
  let auto = false;
  let followNext = false;
  let progressMode: "auto" | "human" | "ndjson" | "off" = process.stderr.isTTY ? "auto" : "off";
  let progressSpecified = false;
  let searchSpecified = false;
  let maxMemoryMb: number | undefined;
  let maxTimeSec: number | undefined;
  let maxFrontierStates: number | undefined;
  let maxFrontierMb: number | undefined;
  const boundedInt = (flag: string, raw: string | undefined, max: number): number => {
    const value = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      usage(`${flag} requires an integer from 1 to ${max}`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--max-depth") maxDepth = boundedInt(arg, args[++i], 1_000);
    else if (arg === "--max-states") {
      maxStatesSpecified = true;
      maxStates = boundedInt(arg, args[++i], 100_000_000);
    }
    else if (arg === "--goal-states") goalMaxStates = boundedInt(arg, args[++i], 100_000_000);
    else if (arg === "--seed") seed = boundedInt(arg, args[++i], 4_294_967_295);
    else if (arg === "--story-seed") storySeed = boundedInt(arg, args[++i], MAX_STORY_SEED);
    else if (arg === "--search" || arg.startsWith("--search=")) {
      searchSpecified = true;
      const mode = arg === "--search" ? args[++i] : arg.slice("--search=".length);
      if (mode !== "portfolio" && mode !== "shared" && mode !== "shared-variable") {
        usage("--search must be portfolio, shared, or shared-variable");
      }
      search = mode;
    }
    else if (arg === "--max-memory") maxMemoryMb = boundedInt(arg, args[++i], 1_000_000);
    else if (arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      const value = arg === "--concurrency" ? args[++i] : arg.slice("--concurrency=".length);
      concurrency = value === "auto" ? "auto" : boundedInt("--concurrency", value, 16);
    }
    else if (arg === "--max-time") maxTimeSec = boundedInt(arg, args[++i], 86_400);
    else if (arg === "--max-frontier-states") maxFrontierStates = boundedInt(arg, args[++i], 100_000_000);
    else if (arg === "--max-frontier-memory") maxFrontierMb = boundedInt(arg, args[++i], 1_000_000);
    else if (arg === "--profile") profileOnly = true;
    else if (arg === "--auto") auto = true;
    else if (arg === "--next") followNext = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--human") asHuman = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "--markdown") asMarkdown = true;
    else if (arg === "--save-report") saveReport = true;
    else if (arg === "--save-checkpoint") saveCheckpoint = true;
    else if (arg === "--no-min-repro") {
      minRepro = false;
      minReproSpecified = true;
    }
    else if (arg.startsWith("--progress=")) {
      progressSpecified = true;
      const mode = arg.slice("--progress=".length);
      if (!["auto", "human", "ndjson", "off"].includes(mode)) {
        usage("--progress must be auto, human, ndjson, or off");
      }
      if (mode === "auto" && !process.stderr.isTTY) progressMode = "off";
      else progressMode = mode as typeof progressMode;
    }
    else if (arg.startsWith("--")) usage(`unknown option: ${arg}`);
    else if (file) usage(`unexpected extra argument: ${arg}`);
    else file = arg;
  }
  let projectConfig;
  try {
    projectConfig = findDefaultProjectConfig();
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  let resumed: Awaited<ReturnType<typeof loadCheckpointForResume>> | undefined;
  if (resumeCheckpointId) {
    if (file) usage("resume reads its entrypoint from the checkpoint and does not accept a story path");
    if (!maxStatesSpecified) usage("resume requires explicit --max-states N as the new total grant");
    const projectRoot = projectConfig ? path.dirname(projectConfig.path) : process.cwd();
    try {
      resumed = await loadCheckpointForResume(projectRoot, resumeCheckpointId);
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
    file = resumed.entrypoint;
    if (searchSpecified && search !== "shared") usage("resume supports only --search=shared");
    search = "shared";
    minRepro = false;
    maxDepth ??= resumed.checkpoint.configuration.maxDepth;
    seed ??= resumed.checkpoint.configuration.seed;
    storySeed ??= resumed.checkpoint.configuration.storySeed;
    if (maxFrontierStates === undefined && resumed.checkpoint.configuration.maxPendingStates !== null) {
      maxFrontierStates = resumed.checkpoint.configuration.maxPendingStates;
    }
    const checkpointBytes = resumed.checkpoint.configuration.maxPendingBytes;
    if (maxFrontierMb === undefined && checkpointBytes !== null) {
      if (checkpointBytes % (1024 * 1024) !== 0) {
        usage("this checkpoint uses a byte-level frontier bound that the CLI cannot represent in MiB");
      }
      maxFrontierMb = checkpointBytes / (1024 * 1024);
    }
  }
  if (!file) file = projectConfig?.entrypoint;
  if (!file) usage("missing story file (or inkcheck.yml entrypoint)");
  if ([asJson, asMarkdown, asHuman].filter(Boolean).length > 1) {
    usage("--json, --markdown, and --human cannot be used together");
  }

  if (inspectMode) {
    if (asMarkdown || asHuman || profileOnly || auto || followNext || strict || !minRepro ||
        maxDepth !== undefined || maxStates !== undefined || goalMaxStates !== undefined || seed !== undefined || storySeed !== undefined ||
        concurrency !== undefined || maxMemoryMb !== undefined || maxTimeSec !== undefined || maxFrontierStates !== undefined || maxFrontierMb !== undefined || search !== "portfolio" ||
        progressSpecified || saveReport || saveCheckpoint || resumeCheckpointId !== undefined) {
      usage("inspect accepts a story path and optional --json only");
    }
    try {
      const value = inspectProject(file);
      console.log(asJson ? JSON.stringify(value, null, 2) : renderInspectionHuman(value));
      return;
    } catch (error) {
      usage(error instanceof Error ? error.message : String(error));
    }
  }

  const configDefaults = projectConfig?.config.ci;
  maxDepth ??= configDefaults?.maxDepth;
  maxStates ??= configDefaults?.maxStates;
  goalMaxStates ??= configDefaults?.goalMaxStates;
  seed ??= configDefaults?.seed;
  storySeed ??= configDefaults?.storySeed;
  storySeed ??= DEFAULT_STORY_SEED;
  maxMemoryMb ??= configDefaults?.maxMemoryMb;
  concurrency ??= configDefaults?.concurrency;
  maxTimeSec ??= configDefaults?.maxTimeSec;
  maxFrontierStates ??= configDefaults?.maxFrontierStates;
  maxFrontierMb ??= configDefaults?.maxFrontierMb;
  if (!resumeCheckpointId && !searchSpecified && configDefaults?.search) search = configDefaults.search;
  if (!strict && configDefaults?.strict) strict = true;
  if (!resumeCheckpointId && !minReproSpecified && configDefaults?.minRepro !== undefined) minRepro = configDefaults.minRepro;
  if ((maxFrontierStates !== undefined || maxFrontierMb !== undefined) && search === "portfolio") {
    usage("--max-frontier-states/--max-frontier-memory require --search shared or shared-variable");
  }
  if (saveCheckpoint && (search !== "shared" || minRepro || auto || followNext || (goalMaxStates ?? 0) > 0 || saveReport)) {
    usage("checkpoint persistence requires --search=shared --no-min-repro and does not support --auto, --next, --goal-states, or --save-report");
  }
  if (resumed && maxStates! <= resumed.checkpoint.state.totalGranted) {
    usage(`resume --max-states must be greater than the checkpoint's ${resumed.checkpoint.state.totalGranted}-state total grant`);
  }

  if (profileOnly) {
    if (saveCheckpoint) usage("--profile cannot save or resume a checkpoint");
    const profile = scanShapeProfile(file);
    if (asJson) {
      console.log(JSON.stringify({ profile }, null, 2));
    } else {
      console.log(renderProfile(file, profile, maxDepth));
    }
    return;
  }

  const profile = auto ? scanShapeProfile(file) : undefined;
  // Explicit flags always win over the profile; --auto never lowers a limit.
  const autoDepth =
    profile && maxDepth === undefined && profile.suggested.maxDepth > DEFAULT_MAX_DEPTH
      ? profile.suggested.maxDepth
      : undefined;
  if (autoDepth !== undefined) maxDepth = autoDepth;

  const baselineMaxStates = maxStates ?? 10_000_000;
  const additionalGoalStates = goalMaxStates ?? 0;
  if (baselineMaxStates + additionalGoalStates > 100_000_000) {
    usage("--max-states + --goal-states must not exceed 100000000");
  }
  const totalMaxStates = baselineMaxStates + additionalGoalStates;
  let resolvedConcurrency: ReturnType<typeof resolvePortfolioConcurrency>;
  try {
    resolvedConcurrency = resolvePortfolioConcurrency(concurrency, search, additionalGoalStates);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  const reportConfiguration: EffectiveReportConfiguration = {
    search,
    concurrency: resolvedConcurrency.ceiling,
    concurrencyMode: resolvedConcurrency.mode,
    ...(resolvedConcurrency.fallbackReason
      ? { concurrencyFallbackReason: resolvedConcurrency.fallbackReason }
      : {}),
    minRepro,
    strict,
    maxMemoryMb: maxMemoryMb ?? null,
    maxTimeSec: maxTimeSec ?? null,
    maxFrontierStates: maxFrontierStates ?? null,
    maxFrontierMb: maxFrontierMb ?? null,
    goalMaxStates: additionalGoalStates,
    storySeed,
    ...(projectConfig?.config.assertions?.length ? { assertions: projectConfig.config.assertions } : {}),
    ...(projectConfig?.config.goals?.length ? { goals: projectConfig.config.goals } : {}),
  };
  const startedAt = Date.now();
  let sequence = 0;
  let statesExplored = resumed?.checkpoint.state.statesExplored ?? 0;
  const selectedProgressMode = progressMode as "auto" | "human" | "ndjson" | "off";
  const humanProgress = selectedProgressMode === "auto" || selectedProgressMode === "human"
    ? new HumanProgressRenderer(process.stderr, selectedProgressMode)
    : undefined;
  type DiscoveryChanges = {
    endings: number;
    runtimeErrors: number;
    knotsVisited: number;
    visibleOutcomes: number;
    assertionViolations: number;
    goalsReached: number;
    stagesReached: number;
  };
  const discoveryTotals: DiscoveryChanges = {
    endings: 0,
    runtimeErrors: 0,
    knotsVisited: 0,
    visibleOutcomes: 0,
    assertionViolations: 0,
    goalsReached: 0,
    stagesReached: 0,
  };
  const discoveryKeys = Object.keys(discoveryTotals) as (keyof DiscoveryChanges)[];
  const emitProgress = (
    type: "run_start" | "phase_start" | "progress" | "discovery" | "phase_end" | "run_end",
    details: {
      phase?: "compile" | "source_scan" | "explore" | "min_repro" | "report";
      pass?: string;
      endingsFound?: number;
      runtimeErrorsFound?: number;
      unvisitedKnots?: number;
      visibleOutcomes?: number;
      assertionViolations?: number;
      goalsReached?: number;
      stagesReached?: number;
      discoveryEvents?: number;
      statesSinceLastDiscovery?: number | null;
      knotsVisited?: number;
      discoveries?: DiscoveryChanges;
      status?: ProgressStatus;
      stopReason?: ProgressStopReason;
      outcome?: ProgressOutcome;
    } = {}
  ) => {
    const event = {
        schemaVersion: 1,
        sequence: ++sequence,
        type,
        elapsedMs: Date.now() - startedAt,
        statesExplored,
        stateBudget: totalMaxStates,
        baselineStateBudget: baselineMaxStates,
        goalStateBudget: additionalGoalStates,
        budgetFraction: Math.min(1, statesExplored / totalMaxStates),
        ...details,
      };
    if (selectedProgressMode === "ndjson") process.stderr.write(JSON.stringify(event) + "\n");
    humanProgress?.handle(event);
  };

  let terminalProgressEmitted = false;
  const finishProgress = (
    status: ProgressStatus,
    stopReason: ProgressStopReason,
    details: Parameters<typeof emitProgress>[1] = {}
  ) => {
    if (terminalProgressEmitted) return;
    terminalProgressEmitted = true;
    process.off("SIGINT", cancelOnSigint);
    process.off("SIGTERM", cancelOnSigterm);
    activeProgressFailure = undefined;
    emitProgress("run_end", { ...details, status, stopReason });
  };
  const cancelOnSigint = () => {
    finishProgress("cancelled", "cancelled");
    process.exit(130);
  };
  const cancelOnSigterm = () => {
    finishProgress("cancelled", "cancelled");
    process.exit(143);
  };
  process.once("SIGINT", cancelOnSigint);
  process.once("SIGTERM", cancelOnSigterm);
  activeProgressFailure = () => finishProgress("error", "error");

  emitProgress("run_start");
  emitProgress("phase_start", { phase: "compile" });
  const compiled = await compile(file);
  const { storyJson: _compiledStoryJson, ...compileReport } = compiled;
  emitProgress("phase_end", { phase: "compile" });

  const persistReport = (value: Record<string, unknown>) => {
    const projectRoot = artifactProjectRoot(file!, projectConfig?.path);
    const reference = saveReportArtifact(projectRoot, file!, value);
    console.error(`saved report ${reference.id} (${reference.path})`);
    return reference;
  };

  if (!compiled.success) {
    emitProgress("phase_start", { phase: "report" });
    const failureReport = buildCompileFailureEnvelope(
      compileReport,
      file,
      reportConfiguration
    );
    const artifact = saveReport ? persistReport(failureReport) : undefined;
    if (asJson) {
      console.log(
        JSON.stringify(
          artifact ? { ...failureReport, artifact } : failureReport,
          null,
          2
        )
      );
    } else if (asMarkdown) {
      console.log(renderCompileFailureMarkdown(compiled));
    } else if (asHuman) {
      console.log(renderHumanFindings(buildHumanFindings({ compile: compiled })));
    } else {
      console.log(`✗ compile failed — ${compiled.errors} error(s), ${compiled.warnings} warning(s)\n`);
      for (const i of compiled.issues) console.log(`  ${i.raw}`);
    }
    emitProgress("phase_end", { phase: "report" });
    finishProgress("complete", "compile_error", { outcome: "compile_error" });
    process.exitCode = 1;
    return;
  }

  emitProgress("phase_start", { phase: "source_scan" });
  const knots = scanKnots(file);
  const externals = scanExternals(file);
  const semantics = scanStorySemantics(file);
  const st = await stats(file);
  const inboundDiverts = scanInboundDiverts(file);
  const configuredAssertions = projectConfig?.config.assertions ?? [];
  const configuredGoals = projectConfig?.config.goals ?? [];
  if (saveCheckpoint && (configuredAssertions.length > 0 || configuredGoals.length > 0)) {
    usage("checkpoint persistence does not yet support configured assertions or goals");
  }
  if (additionalGoalStates > 0 && configuredGoals.length === 0) {
    usage("--goal-states requires at least one configured goal");
  }
  try {
    validateAssertionsForStory(compiled.storyJson!, knots, externals, configuredAssertions);
    validateGoalsForStory(compiled.storyJson!, knots, externals, configuredGoals);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  // The recommender uses the shape profile for a better deepen target even
  // when --auto was not requested; the scan is cheap and deterministic.
  const adviceProfile = profile ?? scanShapeProfile(file);
  emitProgress("phase_end", { phase: "source_scan" });

  // Memory guard: a V8 heap OOM cannot be caught after the fact, so stop
  // cleanly before it. The cap is an explicit --max-memory, or 85% of the
  // V8 old-space limit (which honors any --max-old-space-size the user set).
  const { memoryCapBytes, deadlineMs, memoryGuard, timeGuard } = createResourceGuards({
    maxMemoryMb,
    ...(maxTimeSec === undefined ? {} : { maxTimeMs: maxTimeSec * 1000 }),
  });

  let nextCheckpoint: ReturnType<typeof exploreSharedResumable>["checkpoint"];
  const runCheck = (bounds: { maxDepth?: number; maxStates?: number; seed?: number }): ExploreResult => {
    const runStates = bounds.maxStates ?? 10_000_000;
    if (runStates + additionalGoalStates > 100_000_000) {
      usage("baseline maxStates + goalMaxStates must not exceed 100000000");
    }
    const reproStates = minRepro && runStates > 1 ? Math.max(1, Math.floor(runStates * 0.1)) : 0;
    const portfolioStates = runStates - reproStates;
    // Progress accumulates across --next escalations, so offset by the
    // states already spent in earlier runs.
    const statesBase = statesExplored;
    emitProgress("phase_start", { phase: "explore" });
    const exploreOptions = {
      maxDepth: bounds.maxDepth,
      maxStates: Math.max(1, portfolioStates),
      seed: bounds.seed,
      storySeed,
      weights: profile?.suggested.weights,
      memoryGuard,
      timeGuard,
      sharedMaxPendingStates: maxFrontierStates,
      sharedMaxPendingBytes: maxFrontierMb === undefined ? undefined : maxFrontierMb * 1024 * 1024,
      preserveTurnState: semantics.usesTurns,
      preserveRandomState: semantics.usesRandomness,
      randomnessDetected: semantics.usesRandomness,
      onProgress: (progress: ExploreProgress) => {
        statesExplored = saveCheckpoint ? progress.statesExplored : statesBase + progress.statesExplored;
        const progressDetails = {
          pass: progress.pass,
          endingsFound: progress.endingsFound,
          runtimeErrorsFound: progress.runtimeErrorsFound,
          unvisitedKnots: progress.unvisitedKnots,
          visibleOutcomes: progress.visibleOutcomes,
          assertionViolations: progress.assertionViolations,
          goalsReached: progress.goalsReached,
          stagesReached: progress.stagesReached,
          discoveryEvents: progress.discoveryEvents,
          statesSinceLastDiscovery: progress.statesSinceLastDiscovery,
        };
        emitProgress("progress", progressDetails);
        const currentDiscoveries: DiscoveryChanges = {
          endings: progress.endingsFound,
          runtimeErrors: progress.runtimeErrorsFound,
          knotsVisited: Math.max(0, knots.length - progress.unvisitedKnots),
          visibleOutcomes: progress.visibleOutcomes,
          assertionViolations: progress.assertionViolations,
          goalsReached: progress.goalsReached,
          stagesReached: progress.stagesReached,
        };
        const nextTotals = { ...discoveryTotals };
        const discoveries = { ...discoveryTotals };
        for (const key of discoveryKeys) {
          nextTotals[key] = Math.max(currentDiscoveries[key], discoveryTotals[key]);
          discoveries[key] = nextTotals[key] - discoveryTotals[key];
        }
        if (Object.values(discoveries).some((value) => value > 0)) {
          Object.assign(discoveryTotals, nextTotals);
          emitProgress("discovery", {
            ...progressDetails,
            endingsFound: nextTotals.endings,
            runtimeErrorsFound: nextTotals.runtimeErrors,
            unvisitedKnots: Math.max(0, knots.length - nextTotals.knotsVisited),
            visibleOutcomes: nextTotals.visibleOutcomes,
            assertionViolations: nextTotals.assertionViolations,
            goalsReached: nextTotals.goalsReached,
            stagesReached: nextTotals.stagesReached,
            knotsVisited: nextTotals.knotsVisited,
            discoveries,
          });
        }
      },
    };
    let checked: ExploreResult;
    if (saveCheckpoint) {
      const continuation = exploreSharedResumable(
        compiled.storyJson!,
        knots,
        externals,
        exploreOptions,
        resumed?.checkpoint
      );
      checked = continuation.result;
      nextCheckpoint = continuation.checkpoint;
    } else {
      const configuredOptions = {
        ...exploreOptions,
        weights: profile?.suggested.weights,
        assertions: configuredAssertions,
        goals: configuredGoals,
        goalMaxStates: additionalGoalStates,
      };
      checked = resolvedConcurrency.executor === "auto-handoff"
        ? explorePortfolioPilotHandoffConcurrent(compiled.storyJson!, knots, externals, {
            ...configuredOptions,
            concurrency: resolvedConcurrency.ceiling,
            memoryCapBytes,
            deadlineMs,
          })
        : resolvedConcurrency.executor === "fixed-concurrent"
          ? explorePortfolioConcurrent(compiled.storyJson!, knots, externals, {
              ...configuredOptions,
              concurrency: resolvedConcurrency.ceiling,
              memoryCapBytes,
              deadlineMs,
            })
        : exploreWithGoals(compiled.storyJson!, knots, externals, configuredOptions, search);
    }
    statesExplored = saveCheckpoint ? checked.statesExplored : statesBase + checked.statesExplored;
    emitProgress("phase_end", { phase: "explore" });
    if (reproStates > 0) {
      emitProgress("phase_start", { phase: "min_repro" });
      const bfs = explore(compiled.storyJson!, knots, externals, {
        maxDepth: bounds.maxDepth,
        maxStates: reproStates,
        strategy: "bfs",
        storySeed,
        memoryGuard,
      timeGuard,
        preserveTurnState: semantics.usesTurns,
        preserveRandomState: semantics.usesRandomness,
        randomnessDetected: semantics.usesRandomness,
        assertions: configuredAssertions,
      });
      checked = mergeMinRepro(checked, bfs);
      statesExplored = statesBase + checked.statesExplored;
      emitProgress("phase_end", { phase: "min_repro" });
    }
    return classifyUnvisitedKnots(checked, inboundDiverts);
  };

  let report: ExploreResult;
  try {
    report = runCheck({ maxDepth, maxStates, seed });
  } catch (error) {
    if (resumed && error instanceof RangeError) usage(error.message);
    throw error;
  }
  let advice = recommendNextRun(report, adviceProfile);
  const runs: {
    run: number;
    flags: NextRunAdvice["flags"];
    statesExplored: number;
    endings: number;
    runtimeErrors: number;
    visitedKnots: number;
    recommendation: string;
  }[] = [];
  const summarize = (run: number, flags: NextRunAdvice["flags"], checked: ExploreResult) => ({
    run,
    flags,
    statesExplored: checked.statesExplored,
    endings: checked.endingsFound.length,
    runtimeErrors: checked.runtimeErrors.length,
    visitedKnots: checked.visitedKnots.length,
    recommendation: advice.recommendation,
  });
  runs.push(summarize(1, { ...report.limits }, report));
  if (followNext) {
    // Escalation loop: apply the recommendation, rerun, stop on a stop/
    // investigate verdict, a fixpoint, or after three escalations.
    while (!advice.stop && runs.length <= 3) {
      const previous = report;
      const flags = {
        ...advice.flags,
        maxStates: Math.min(advice.flags.maxStates, 100_000_000 - additionalGoalStates),
      };
      console.error(
        `↻ ${advice.recommendation}: rerunning with --max-depth ${flags.maxDepth} --max-states ${flags.maxStates}${flags.seed !== undefined ? ` --seed ${flags.seed}` : ""}`
      );
      report = runCheck(flags);
      advice = recommendNextRun(report, adviceProfile);
      const unchanged =
        report.endingsFound.length === previous.endingsFound.length &&
        report.runtimeErrors.length === previous.runtimeErrors.length &&
        report.visitedKnots.length === previous.visitedKnots.length;
      if (unchanged && !report.exhaustive) {
        advice = {
          ...advice,
          recommendation: "stop",
          stop: true,
          rationale: `fixpoint: the escalated run found no new endings, runtime errors, or knots compared with the previous run. Previously: ${advice.rationale}`,
          expectedGain: "none — consecutive runs at increased limits changed nothing",
        };
      }
      runs.push(summarize(runs.length + 1, flags, report));
    }
  }

  const outputReport = buildReportEnvelope({
    compile: compileReport,
    stats: st,
    ...(profile ? { profile } : {}),
    explore: report,
    nextRun: advice,
    ...(followNext ? { runs } : {}),
    storyJson: compiled.storyJson!,
    configuration: reportConfiguration,
  });
  let checkpointOutput: Record<string, unknown> | undefined;
  if (saveCheckpoint) {
    if (nextCheckpoint) {
      const projectRoot = artifactProjectRoot(file!, projectConfig?.path);
      const reference = await saveCheckpointArtifact(projectRoot, file!, nextCheckpoint);
      checkpointOutput = {
        saved: true,
        ...reference,
        ...(resumeCheckpointId ? { resumedFrom: resumeCheckpointId } : {}),
      };
      console.error(`saved checkpoint ${reference.id} (${reference.path})`);
      if (reference.pruned.length > 0) {
        console.error(`pruned ${reference.pruned.length} older checkpoint(s): ${reference.pruned.join(", ")}`);
      }
    } else {
      checkpointOutput = {
        saved: false,
        ...(resumeCheckpointId ? { resumedFrom: resumeCheckpointId } : {}),
        reason: report.exhaustive ? "complete" : "not_resumable",
      };
      console.error(report.exhaustive
        ? "search completed; no resumable checkpoint was needed"
        : "run ended without resumable state; no checkpoint was created");
    }
  }
  const artifact = saveReport ? persistReport(outputReport) : undefined;
  emitProgress("phase_start", { phase: "report" });
  if (asJson) {
    console.log(
      JSON.stringify(
          {
            ...outputReport,
            ...(artifact ? { artifact } : {}),
            ...(checkpointOutput ? { checkpoint: checkpointOutput } : {}),
          },
        null,
        2
      )
    );
  } else if (asMarkdown) {
    console.log(renderMarkdown(compiled, st, report, advice));
  } else if (asHuman) {
    console.log(renderHumanFindings(buildHumanFindings(outputReport)));
  } else {
    console.log(
      `✓ compiled — ${st.words ?? "?"} words, ${st.knots ?? knots.length} knots, ${st.choices ?? "?"} choices`
    );
    for (const i of compiled.issues) console.log(`  ${i.raw}`);
    if (profile) {
      const w = profile.suggested.weights;
      console.log(
        `⚙ auto: shape profile applied — depth ${maxDepth ?? DEFAULT_MAX_DEPTH}${autoDepth !== undefined ? ` (raised from ${DEFAULT_MAX_DEPTH})` : ""}, weights dfs ${Math.round((w.last + w.first + w.insideOut) * 100)}% / beam ${Math.round(w.beam * 100)}% / random ${Math.round(w.random * 100)}%`
      );
      for (const reason of profile.suggested.rationale) console.log(`    ${reason}`);
    }
    const limitParts = [
      `depth ${report.limits.maxDepth}`,
      `${report.limits.maxStates} baseline states`,
    ];
    if (report.limits.goalMaxStates) limitParts.push(`${report.limits.goalMaxStates} additional goal states`);
    if (report.limits.seed !== undefined) limitParts.push(`seed ${report.limits.seed}`);
    const coverageFlag = report.exhaustive
      ? " — exhaustive (every reachable state visited)"
      : report.truncated
        ? " — truncated"
        : "";
    console.log(
      `✓ explored ${report.statesExplored} states within limits (${limitParts.join(", ")})${coverageFlag} — ${report.endingsFound.length} distinct terminal state(s)`
    );
    for (const e of report.endingsFound.slice(0, 10)) {
      console.log(`    terminal via [${e.path.join(" → ") || "linear"}]: "${e.finalText.split("\n").pop()}"`);
    }
    if (report.runtimeErrors.length) {
      console.log(`✗ ${report.runtimeErrors.length} runtime error(s):`);
      for (const e of report.runtimeErrors)
        console.log(
          `    ${e.message}\n      repro: [${e.path.join(" → ")}]${e.foundBy ? ` (found by ${e.foundBy})` : ""}`
        );
    }
    const violatedAssertions = report.assertionResults.filter((result) => result.status === "violated");
    if (violatedAssertions.length) {
      console.log(`✗ ${violatedAssertions.length} story assertion(s) violated:`);
      for (const result of violatedAssertions) {
        const violation = result.violations[0];
        console.log(
          `    ${result.id}${result.description ? ` — ${result.description}` : ""}\n      observed: ${JSON.stringify(violation.observedValues)}\n      repro: [${violation.path.join(" → ") || "linear"}]`
        );
      }
    }
    if (report.goalResults?.length) {
      console.log(`◎ ${report.goalResults.filter((goal) => goal.status === "reached").length}/${report.goalResults.length} search goal(s) reached:`);
      for (const goal of report.goalResults) {
        console.log(
          `    ${goal.id}: ${goal.status}${goal.witness ? `\n      repro: [${goal.witness.path.join(" → ") || "linear"}]` : goal.closestObserved ? `\n      closest observed: ${JSON.stringify(goal.closestObserved.observedValues)}` : ""}`
        );
        for (const stage of goal.stages ?? []) {
          console.log(`      ${stage.id}: ${stage.status}${stage.blockedBy ? ` (blocked by ${stage.blockedBy})` : stage.witness ? ` — [${stage.witness.path.join(" → ") || "linear"}]` : ""}`);
        }
      }
    }
    if (report.unvisitedKnots.length) {
      console.log(
        `⚠ ${report.unvisitedKnots.length} knot(s) never visited on any explored path — unreached is not necessarily unreachable:`
      );
      for (const k of report.unvisitedKnots)
        console.log(`    ${k.name} (${humanLocation(k.file, k.line)}) — ${unvisitedKnotHint(k)}`);
    }
    if (report.runtimeWarnings.length) {
      console.log(`⚠ ${report.runtimeWarnings.length} runtime warning(s):`);
      for (const w of report.runtimeWarnings) console.log(`    ${w}`);
    }
    if (report.externalFunctionsStubbed.length) {
      console.log(
        `⚠ ${report.externalFunctionsStubbed.length} EXTERNAL function(s) were stubbed to 0; coverage is conditional: ${report.externalFunctionsStubbed.join(", ")}`
      );
    }
    if (report.randomnessDetected) {
      console.log(
        `⚠ random behavior detected; this run is reproducible with story seed ${report.limits.storySeed}, but does not enumerate every possible story seed`
      );
    }
    if (report.truncatedBy.memory) {
      console.log(
        `⚠ stopped early at ${report.statesExplored} states to stay under the memory guard (${Math.round(memoryCapBytes / 1048576)} MB) — the results above are partial but complete as far as they go`
      );
    } else if (report.truncatedBy.time) {
      console.log(
        `⚠ stopped early at ${report.statesExplored} states after the ${maxTimeSec}s time budget — the results above are partial but complete as far as they go`
      );
    } else if (report.truncated) {
      console.log(`⚠ coverage is partial, not a proof — ${truncationAdvice(report)}`);
    }
    if (advice.recommendation === "deepen" || advice.recommendation === "broaden" || advice.recommendation === "reseed") {
      console.log(
        `→ next run (${advice.recommendation}): --max-depth ${advice.flags.maxDepth} --max-states ${advice.flags.maxStates}${advice.flags.seed !== undefined ? ` --seed ${advice.flags.seed}` : ""} — ${advice.expectedGain}`
      );
    } else if (advice.recommendation === "investigate") {
      console.log(`→ next: investigate — ${advice.rationale}`);
    }
  }
  emitProgress("phase_end", { phase: "report" });
  const stopReason: ProgressStopReason = report.exhaustive
    ? "exhaustive"
    : report.truncatedBy.worker
      ? "worker_failure"
      : report.truncatedBy.memory
        ? "memory_limit"
        : report.truncatedBy.time
          ? "time_limit"
          : report.truncatedBy.frontier
            ? "frontier_limit"
            : report.truncatedBy.maxDepth
              ? "depth_limit"
              : report.truncatedBy.maxStates
                ? "state_budget"
                : report.truncatedBy.beamWidth
                  ? "beam_width"
                  : "completed";
  const assertionFail = report.assertionResults.some((result) => result.status === "violated");
  const hardFail = report.runtimeErrors.length > 0 || assertionFail;
  const softFail =
    strict &&
    (compiled.warnings > 0 ||
      report.unvisitedKnots.length > 0 ||
      report.runtimeWarnings.length > 0 ||
      report.truncated ||
      report.externalFunctionsStubbed.length > 0);
  finishProgress("complete", stopReason, {
    outcome: hardFail ? "issues_found" : softFail ? "review_required" : "clean",
    endingsFound: report.endingsFound.length,
    runtimeErrorsFound: report.runtimeErrors.length,
    unvisitedKnots: report.unvisitedKnots.length,
  });
  process.exitCode = hardFail || softFail ? 1 : 0;
}

function escapeCell(value: unknown): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderProfile(file: string, profile: StoryShapeProfile, userMaxDepth?: number): string {
  const w = profile.suggested.weights;
  const lines = [
    `Story shape profile for ${file} (static scan; no exploration run)`,
    "",
    `  knots: ${profile.knots} (+${profile.functions} function(s))`,
    `  variables: ${profile.variables}, assignments: ${profile.varAssignments} (${Math.round(profile.earlyAssignmentShare * 100)}% in the first third)`,
    `  choice lines: ${profile.choiceLines}`,
    `  longest divert path: ${profile.longestKnotPath} knot(s), ~${profile.choiceDepthEstimate} choice point(s)${profile.hasCycles ? " — loops present, so this is a lower bound" : ""}`,
    "",
    "Suggested settings (apply with --auto):",
    `  --max-depth ${userMaxDepth ?? profile.suggested.maxDepth}${userMaxDepth !== undefined ? " (your flag wins over the profile)" : ""}`,
    `  pass weights: dfs:last ${Math.round(w.last * 100)}% / dfs:first ${Math.round(w.first * 100)}% / dfs:inside-out ${Math.round(w.insideOut * 100)}% / beam ${Math.round(w.beam * 100)}% / random ${Math.round(w.random * 100)}%`,
    "",
    "Why:",
    ...profile.suggested.rationale.map((reason) => `  - ${reason}`),
  ];
  return lines.join("\n");
}

function humanLocation(file: string, line: number | null | undefined): string {
  return `${file}${line ? ` line ${line}` : ""}`;
}

function renderCompileFailureMarkdown(compiled: CompileResult): string {
  const lines = ["# inkcheck report", "", "❌ **Compilation failed.**", ""];
  for (const issue of compiled.issues) {
    const location = issue.file ? `${humanLocation(issue.file, issue.line)}: ` : "";
    lines.push(`- **${issue.severity}** ${location}${issue.message}`);
  }
  return lines.join("\n");
}

function renderMarkdown(
  compiled: CompileResult,
  storyStats: Record<string, number>,
  report: ExploreResult,
  advice?: NextRunAdvice
): string {
  const complete =
    !report.truncated && report.externalFunctionsStubbed.length === 0 && !report.randomnessDetected;
  const assertionViolations = report.assertionResults.filter((result) => result.status === "violated");
  const status = report.runtimeErrors.length && assertionViolations.length
    ? "❌ **Runtime and story-rule failures found.**"
    : report.runtimeErrors.length
      ? "❌ **Runtime failures found.**"
      : assertionViolations.length
        ? "❌ **Story assertion failures found.**"
        : complete
          ? "✅ **Choice traversal completed within the configured limits.**"
          : "⚠️ **Results have coverage limitations; see below.**";
  const lines = [
    "# inkcheck report",
    "",
    status,
    "",
    "| Check | Result |",
    "| --- | ---: |",
    `| Compile errors | ${compiled.errors} |`,
    `| Compile warnings | ${compiled.warnings} |`,
    `| Words | ${storyStats.words ?? "unknown"} |`,
    `| States explored | ${report.statesExplored} |`,
    `| Depth limit | ${report.limits.maxDepth} |`,
    `| Baseline state budget | ${report.limits.maxStates} |`,
    ...(report.limits.goalMaxStates ? [
      `| Additional goal state budget | ${report.limits.goalMaxStates} |`,
      `| Total state budget | ${report.limits.totalMaxStates ?? report.limits.maxStates + report.limits.goalMaxStates} |`,
    ] : []),
    ...(report.limits.seed !== undefined ? [`| Search sampling seed | ${report.limits.seed} |`] : []),
    `| Story runtime seed | ${report.limits.storySeed} |`,
    `| Truncated | ${report.truncated ? "yes" : "no"} |`,
    `| Exhaustive | ${report.exhaustive ? "yes" : "no"} |`,
    `| Distinct terminal states | ${report.endingsFound.length} |`,
    `| Runtime errors | ${report.runtimeErrors.length} |`,
    `| Assertion violations | ${assertionViolations.length} |`,
    ...(report.goalResults?.length ? [`| Search goals reached | ${report.goalResults.filter((goal) => goal.status === "reached").length}/${report.goalResults.length} |`] : []),
    `| Unvisited knots | ${report.unvisitedKnots.length} |`,
  ];
  if (report.runtimeErrors.length) {
    lines.push("", "## Runtime errors", "");
    for (const error of report.runtimeErrors) {
      lines.push(
        `- ${escapeCell(error.message)} — path: ${error.path.join(" → ") || "linear"}${error.foundBy ? ` — found by \`${error.foundBy}\`` : ""}`
      );
    }
  }
  if (assertionViolations.length) {
    lines.push("", "## Story assertion violations", "");
    for (const result of assertionViolations) {
      const violation = result.violations[0];
      lines.push(
        `- \`${result.id}\`${result.description ? ` — ${escapeCell(result.description)}` : ""}; observed \`${escapeCell(JSON.stringify(violation.observedValues))}\`; path: ${violation.path.join(" → ") || "linear"}`
      );
    }
  }
  if (report.goalResults?.length) {
    lines.push("", "## Search goals", "");
    for (const goal of report.goalResults) {
      lines.push(`- \`${goal.id}\`: **${goal.status}**${goal.witness ? ` — path: ${goal.witness.path.join(" → ") || "linear"}` : goal.closestObserved ? ` — closest observed: \`${escapeCell(JSON.stringify(goal.closestObserved.observedValues))}\`` : ""}`);
      for (const stage of goal.stages ?? []) {
        lines.push(`  - \`${stage.id}\`: **${stage.status}**${stage.blockedBy ? ` — blocked by \`${stage.blockedBy}\`` : stage.witness ? ` — path: ${stage.witness.path.join(" → ") || "linear"}` : ""}`);
      }
    }
  }
  if (report.unvisitedKnots.length) {
    lines.push("", "## Unvisited knots", "");
    lines.push("Unreached within this run is not necessarily unreachable.", "");
    for (const knot of report.unvisitedKnots)
      lines.push(`- \`${knot.name}\` (${humanLocation(knot.file, knot.line)}) — ${unvisitedKnotHint(knot)}`);
  }
  const limitations: string[] = [];
  if (report.truncated) {
    limitations.push(
      `Coverage is partial, not a proof: ${truncationAdvice(report)}.`
    );
  }
  if (report.externalFunctionsStubbed.length) {
    limitations.push(`EXTERNAL functions were stubbed to zero: ${report.externalFunctionsStubbed.join(", ")}.`);
  }
  if (report.randomnessDetected) {
    limitations.push(`Random behavior was detected; this run is reproducible with story seed ${report.limits.storySeed}, but every possible story seed was not enumerated.`);
  }
  if (advice && advice.recommendation !== "stop") {
    limitations.push(
      advice.recommendation === "investigate"
        ? `Suggested next step: investigate — ${advice.rationale}`
        : `Suggested next run (${advice.recommendation}): \`--max-depth ${advice.flags.maxDepth} --max-states ${advice.flags.maxStates}${advice.flags.seed !== undefined ? ` --seed ${advice.flags.seed}` : ""}\` — ${advice.expectedGain}.`
    );
  }
  if (limitations.length) lines.push("", "## Coverage limitations", "", ...limitations.map((x) => `- ${x}`));
  return lines.join("\n");
}

main().catch((e) => {
  activeProgressFailure?.();
  console.error(e);
  process.exit(1);
});
