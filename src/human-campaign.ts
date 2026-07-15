import { createHash } from "crypto";
import {
  cancelSearchSession,
  continueCampaign,
  openSessionReport,
  startCampaign,
  type SearchSessionResponse,
  type StartCampaignInput,
} from "./search-sessions";

export const HUMAN_CAMPAIGN_SCHEMA_VERSION = 1;

export type HumanWindowTrigger =
  | "actionable_evidence"
  | "review_interval"
  | "exhaustive"
  | "knee_observed"
  | "deadline"
  | "resource_ceiling"
  | "cancelled";

export interface HumanResultWindow {
  schemaVersion: 1;
  id: string;
  sequence: number;
  reportId: string;
  checkpointId?: string;
  sourceFingerprint: unknown;
  trigger: HumanWindowTrigger;
  searchContinuing: boolean;
  work: { statesExplored: number; totalStateCeiling: number; windows: number };
  findings: SearchSessionResponse["session"]["findings"];
  stableFindingIds: string[];
  omittedFindingCount: number;
  forecast: NonNullable<SearchSessionResponse["campaign"]>["decision"]["forecast"];
  allocation: NonNullable<SearchSessionResponse["campaign"]>["decision"]["latestAllocation"];
}

export interface HumanCampaignResult {
  schemaVersion: 1;
  status: "complete" | "stopped" | "cancelled";
  mode: string;
  windows: HumanResultWindow[];
  final: SearchSessionResponse;
}

export interface RunHumanCampaignInput extends StartCampaignInput {
  onWindow?: (window: HumanResultWindow) => void;
  shouldCancel?: () => boolean;
}

function trigger(response: SearchSessionResponse, prior?: SearchSessionResponse): HumanWindowTrigger {
  const reason = response.campaign?.stopReason;
  if (reason === "exhaustive") return "exhaustive";
  if (reason === "knee_observed") return "knee_observed";
  if (reason === "deadline" || reason === "time_ceiling") return "deadline";
  if (reason === "cancelled") return "cancelled";
  if (reason) return "resource_ceiling";
  const findings = response.session.findings;
  const before = prior?.session.findings;
  if (findings.runtimeErrors > (before?.runtimeErrors ?? 0)
    || findings.assertionViolations > (before?.assertionViolations ?? 0)) {
    return "actionable_evidence";
  }
  return "review_interval";
}

async function resultWindow(
  input: RunHumanCampaignInput,
  response: SearchSessionResponse,
  sequence: number,
  prior?: SearchSessionResponse
): Promise<HumanResultWindow> {
  if (!response.sessionCapability) throw new Error("campaign response did not retain its capability inside the human runner");
  if (!response.campaign) throw new Error("campaign response is missing campaign evidence");
  const opened = await openSessionReport({
    file: input.file,
    sessionCapability: response.sessionCapability,
    reportId: response.session.latestReportId,
  });
  const report = opened.report as { storyFingerprint?: unknown };
  const stableFindingIds = response.savedFindings.findings.map((finding) => finding.id);
  return {
    schemaVersion: HUMAN_CAMPAIGN_SCHEMA_VERSION,
    id: `window-${createHash("sha256").update(`${response.campaign.campaignId}:${sequence}:${response.session.latestReportId}`).digest("hex").slice(0, 24)}`,
    sequence,
    reportId: response.session.latestReportId,
    ...(response.session.latestCheckpointId ? { checkpointId: response.session.latestCheckpointId } : {}),
    sourceFingerprint: report.storyFingerprint ?? null,
    trigger: trigger(response, prior),
    searchContinuing: response.campaign.status === "active" && response.session.recoverable,
    work: {
      statesExplored: response.session.statesExplored,
      totalStateCeiling: response.campaign.ceilings.totalStates,
      windows: response.campaign.windows,
    },
    findings: response.session.findings,
    stableFindingIds,
    omittedFindingCount: Math.max(0, response.savedFindings.page.total - stableFindingIds.length),
    forecast: response.campaign.decision.forecast,
    allocation: response.campaign.decision.latestAllocation,
  };
}

export async function runHumanCampaign(input: RunHumanCampaignInput): Promise<HumanCampaignResult> {
  let response = await startCampaign({ ...input, findingLimit: 100 });
  if (!response.sessionCapability || !response.campaign) throw new Error("campaign did not return a resumable human result");
  const capability = response.sessionCapability;
  const windows: HumanResultWindow[] = [];
  let prior: SearchSessionResponse | undefined;
  for (;;) {
    let window = await resultWindow(input, response, windows.length + 1, prior);
    if (window.searchContinuing && input.shouldCancel?.()) {
      const cancelled = await cancelSearchSession({
        file: input.file,
        sessionCapability: capability,
        revision: response.session.revision,
      });
      if ("discarded" in cancelled) throw new Error("human campaign cancellation unexpectedly discarded evidence");
      response = { ...cancelled, sessionCapability: capability };
      window = await resultWindow(input, response, windows.length + 1, prior);
      windows.push(window);
      input.onWindow?.(window);
      break;
    }
    windows.push(window);
    input.onWindow?.(window);
    if (!window.searchContinuing) break;
    prior = response;
    response = await continueCampaign({
      file: input.file,
      sessionCapability: capability,
      revision: response.session.revision,
      findingLimit: 100,
    });
    response = { ...response, sessionCapability: capability };
  }
  const status = response.campaign?.stopReason === "cancelled"
    ? "cancelled"
    : response.session.status === "complete"
      ? "complete"
      : "stopped";
  return {
    schemaVersion: HUMAN_CAMPAIGN_SCHEMA_VERSION,
    status,
    mode: response.campaign?.decision.mode ?? input.mode ?? "fixed",
    windows,
    final: { ...response, sessionCapability: undefined },
  };
}

export function renderHumanResultWindow(window: HumanResultWindow): string {
  const forecast = window.forecast;
  const high = forecast.expectedNextWindow.meaningfulDiscoveries.high;
  const forecastText = high === null
    ? "forecast still learning"
    : `next window may add 0-${high} preferred discoveries`;
  return [
    `Window ${window.sequence} ready (${window.trigger.replaceAll("_", " ")})`,
    `  Report ${window.reportId} | ${window.work.statesExplored.toLocaleString()} of ${window.work.totalStateCeiling.toLocaleString()} state ceiling`,
    `  ${window.findings.runtimeErrors} runtime errors | ${window.findings.assertionViolations} assertion violations | ${window.findings.unvisitedKnots} unvisited knots`,
    `  ${forecastText}; ${forecast.uncertainty} uncertainty; ${window.searchContinuing ? "search can continue" : "final window"}`,
  ].join("\n");
}
