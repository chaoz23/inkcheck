import { createHash } from "crypto";
import {
  CampaignAllocation,
  CampaignIntent,
  CampaignLedger,
  CampaignMode,
  CampaignPolicyInput,
  CampaignRecommendation,
  CampaignStopPolicy,
  CampaignValuePreference,
} from "./campaign-policy";

export const CAMPAIGN_CONTROL_SCHEMA_VERSION = 1;
export const CAMPAIGN_FORECAST_VERSION = 1;
export const CAMPAIGN_KNEE_DRY_WINDOWS = 3;

interface ModeDefaults {
  totalStates: number;
  windowStates: number;
  maxElapsedSeconds: number;
  maxDiskMb: number;
  resourcePreference: CampaignIntent;
  stopPolicy: CampaignStopPolicy;
}

const MODES: Record<Exclude<CampaignMode, "fixed">, ModeDefaults> = {
  quick: { totalStates: 250_000, windowStates: 50_000, maxElapsedSeconds: 60, maxDiskMb: 128, resourcePreference: "scarce", stopPolicy: "knee" },
  balanced: { totalStates: 1_000_000, windowStates: 100_000, maxElapsedSeconds: 600, maxDiskMb: 256, resourcePreference: "balanced", stopPolicy: "knee" },
  deep: { totalStates: 10_000_000, windowStates: 1_000_000, maxElapsedSeconds: 7_200, maxDiskMb: 1_024, resourcePreference: "abundant", stopPolicy: "knee" },
  overnight: { totalStates: 100_000_000, windowStates: 5_000_000, maxElapsedSeconds: 43_200, maxDiskMb: 4_096, resourcePreference: "abundant", stopPolicy: "knee" },
  campaign: { totalStates: 100_000_000, windowStates: 5_000_000, maxElapsedSeconds: 604_800, maxDiskMb: 8_192, resourcePreference: "abundant", stopPolicy: "ceilings" },
};

export interface CampaignControlRequest {
  mode?: CampaignMode;
  resourcePreference?: CampaignIntent;
  legacyIntent?: CampaignIntent;
  valuePreference?: CampaignValuePreference;
  stopPolicy?: CampaignStopPolicy;
  totalStates?: number;
  windowStates?: number;
  maxElapsedSeconds?: number;
  maxMemoryMb?: number;
  maxDiskMb?: number;
  deadlineAt?: string;
  longTailShare?: number;
  minLongTailProbes?: number;
  regressionReserveStates?: number;
}

export interface ResolvedCampaignControl {
  schemaVersion: 1;
  mode: CampaignMode;
  resourcePreference: CampaignIntent;
  valuePreference: CampaignValuePreference;
  stopPolicy: CampaignStopPolicy;
  totalStates: number;
  windowStates: number;
  maxElapsedSeconds: number;
  maxMemoryMb: number;
  maxDiskMb: number;
  deadlineAt?: string;
  longTailShare?: number;
  minLongTailProbes?: number;
  regressionReserveStates?: number;
  overrideKeys: string[];
}

export interface CampaignForecast {
  schemaVersion: 1;
  forecastVersion: 1;
  basis: "completed_campaign_windows";
  uncertainty: "high" | "medium";
  meaningfulYield: {
    preference: CampaignValuePreference;
    shared: { windows: number; states: number; discoveries: number; perMillionStates: number | null };
  };
  knee: {
    status: "insufficient_evidence" | "not_observed" | "candidate";
    consecutiveDryWindows: number;
    threshold: number;
    reason: string;
  };
  throughput: { observedWindowMs: number; statesPerSecond: number | null };
  resources: {
    peakMemoryBytes: number;
    peakMemoryDeltaBytes: number | null;
    currentDiskBytes: number;
    diskDeltaBytes: number | null;
  };
  expectedNextWindow: {
    statesUpperBound: number;
    meaningfulDiscoveries: { low: 0; high: number | null };
    basis: "recent_observed_rate" | "insufficient_evidence";
  };
  disclosure: string;
}

export interface CampaignDecisionExplanation {
  policyId: string;
  policyVersion: number;
  mode: CampaignMode;
  resourcePreference: CampaignIntent;
  valuePreference: CampaignValuePreference;
  stopPolicy: CampaignStopPolicy;
  overrides: string[];
  latestAllocation?: {
    id: string;
    purpose: CampaignAllocation["purpose"];
    grantedStates: number;
    consumedStates: number;
    reason: string;
  };
  forecast: CampaignForecast;
  bindingConstraint: string | null;
  permitsMoreWork: string[];
  drilldown: { reportId?: string; findingsTool: "get_finding"; curvesTool: "open_report" };
}

function requiredInteger(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`fixed campaign mode requires ${name}`);
  return value;
}

export function resolveCampaignControl(input: CampaignControlRequest, defaultMemoryMb: number): ResolvedCampaignControl {
  const mode = input.mode ?? (input.legacyIntent ? "fixed" : "balanced");
  const defaults = mode === "fixed" ? undefined : MODES[mode];
  const totalStates = input.totalStates ?? (defaults?.totalStates ?? requiredInteger(input.totalStates, "totalStates"));
  const fixedResource = input.resourcePreference ?? input.legacyIntent ?? "balanced";
  const fixedWindow = Math.max(1, Math.min(
    fixedResource === "scarce" ? 250_000 : fixedResource === "balanced" ? 1_000_000 : 5_000_000,
    Math.floor(totalStates * (fixedResource === "scarce" ? 0.05 : 0.1))
  ));
  const values = {
    totalStates,
    windowStates: input.windowStates ?? defaults?.windowStates ?? fixedWindow,
    maxElapsedSeconds: input.maxElapsedSeconds ?? (defaults?.maxElapsedSeconds ?? requiredInteger(input.maxElapsedSeconds, "maxElapsedSeconds")),
    maxDiskMb: input.maxDiskMb ?? (defaults?.maxDiskMb ?? requiredInteger(input.maxDiskMb, "maxDiskMb")),
  };
  const overrideKeys = [
    "totalStates", "windowStates", "maxElapsedSeconds", "maxMemoryMb", "maxDiskMb", "deadlineAt",
    "resourcePreference", "valuePreference", "stopPolicy", "longTailShare", "minLongTailProbes", "regressionReserveStates",
  ].filter((key) => input[key as keyof CampaignControlRequest] !== undefined).sort();
  return {
    schemaVersion: CAMPAIGN_CONTROL_SCHEMA_VERSION,
    mode,
    resourcePreference: input.resourcePreference ?? input.legacyIntent ?? defaults?.resourcePreference ?? "balanced",
    valuePreference: input.valuePreference ?? "broad_qa",
    stopPolicy: input.stopPolicy ?? defaults?.stopPolicy ?? "ceilings",
    ...values,
    maxMemoryMb: input.maxMemoryMb ?? defaultMemoryMb,
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
    ...(input.longTailShare !== undefined ? { longTailShare: input.longTailShare } : {}),
    ...(input.minLongTailProbes !== undefined ? { minLongTailProbes: input.minLongTailProbes } : {}),
    ...(input.regressionReserveStates !== undefined ? { regressionReserveStates: input.regressionReserveStates } : {}),
    overrideKeys,
  };
}

export function campaignPolicyInput(control: ResolvedCampaignControl): CampaignPolicyInput {
  return {
    intent: control.resourcePreference,
    mode: control.mode,
    valuePreference: control.valuePreference,
    stopPolicy: control.stopPolicy,
    overrideKeys: control.overrideKeys,
    totalStates: control.totalStates,
    maxElapsedMs: control.maxElapsedSeconds * 1_000,
    maxMemoryBytes: control.maxMemoryMb * 1024 * 1024,
    maxDiskBytes: control.maxDiskMb * 1024 * 1024,
    maxConcurrency: 1,
    deadlineAt: control.deadlineAt,
    typicalWindowStates: control.windowStates,
    longTailShare: control.longTailShare,
    minLongTailProbes: control.minLongTailProbes,
    regressionReserveStates: control.regressionReserveStates,
  };
}

function meaningful(allocation: CampaignAllocation, preference: CampaignValuePreference): number {
  const value = allocation.yield;
  if (!value) return 0;
  if (preference === "runtime_assertions") return value.critical;
  if (preference === "outcomes") return value.terminalVariants;
  if (preference === "approved_goals") return value.intent;
  return value.critical + value.intent + value.authoredCoverage + value.terminalVariants;
}

function completed(ledger: CampaignLedger): CampaignAllocation[] {
  return ledger.allocations.filter((allocation) => allocation.status === "completed");
}

export function forecastCampaign(ledger: CampaignLedger): CampaignForecast {
  const windows = completed(ledger);
  const preference = ledger.policy.policyVersion >= 2 ? ledger.policy.control.valuePreference : "broad_qa";
  const states = windows.reduce((sum, window) => sum + (window.consumedStates ?? 0), 0);
  const discoveries = windows.reduce((sum, window) => sum + meaningful(window, preference), 0);
  let consecutiveDryWindows = 0;
  for (const window of [...windows].reverse()) {
    if (meaningful(window, preference) > 0) break;
    consecutiveDryWindows += 1;
  }
  const kneeStatus = windows.length < CAMPAIGN_KNEE_DRY_WINDOWS
    ? "insufficient_evidence"
    : consecutiveDryWindows >= CAMPAIGN_KNEE_DRY_WINDOWS
      ? "candidate"
      : "not_observed";
  const recent = windows.slice(-3);
  const recentStates = recent.reduce((sum, window) => sum + (window.consumedStates ?? 0), 0);
  const recentDiscoveries = recent.reduce((sum, window) => sum + meaningful(window, preference), 0);
  const nextStates = Math.min(
    ledger.policy.typicalWindowStates,
    Math.max(0, ledger.policy.ceilings.totalStates - ledger.spend.states)
  );
  const observedWindowMs = windows.reduce((sum, window) => sum + (window.provenance?.elapsedMs ?? 0), 0);
  const latestProvenance = windows.at(-1)?.provenance;
  const previousProvenance = windows.at(-2)?.provenance;
  return {
    schemaVersion: CAMPAIGN_CONTROL_SCHEMA_VERSION,
    forecastVersion: CAMPAIGN_FORECAST_VERSION,
    basis: "completed_campaign_windows",
    uncertainty: windows.length < 5 ? "high" : "medium",
    meaningfulYield: {
      preference,
      shared: {
        windows: windows.length,
        states,
        discoveries,
        perMillionStates: states > 0 ? Number((discoveries * 1_000_000 / states).toFixed(3)) : null,
      },
    },
    knee: {
      status: kneeStatus,
      consecutiveDryWindows,
      threshold: CAMPAIGN_KNEE_DRY_WINDOWS,
      reason: kneeStatus === "candidate"
        ? `${consecutiveDryWindows} consecutive windows produced no ${preference} yield; protected probes still bind`
        : kneeStatus === "insufficient_evidence"
          ? `at least ${CAMPAIGN_KNEE_DRY_WINDOWS} completed windows are required`
          : "recent bounded windows still contain preferred yield",
    },
    throughput: {
      observedWindowMs,
      statesPerSecond: observedWindowMs > 0 ? Number((states * 1_000 / observedWindowMs).toFixed(1)) : null,
    },
    resources: {
      peakMemoryBytes: ledger.spend.peakMemoryBytes,
      peakMemoryDeltaBytes: latestProvenance && previousProvenance
        ? latestProvenance.peakMemoryBytes - previousProvenance.peakMemoryBytes
        : null,
      currentDiskBytes: ledger.spend.currentDiskBytes,
      diskDeltaBytes: latestProvenance && previousProvenance
        ? latestProvenance.diskBytes - previousProvenance.diskBytes
        : null,
    },
    expectedNextWindow: {
      statesUpperBound: nextStates,
      meaningfulDiscoveries: {
        low: 0,
        high: recentStates > 0 ? Math.max(0, Math.ceil(recentDiscoveries * nextStates / recentStates)) : null,
      },
      basis: recentStates > 0 ? "recent_observed_rate" : "insufficient_evidence",
    },
    disclosure: `${preference === "runtime_assertions" ? "Exact resumable campaign windows currently contribute runtime-error evidence, not configured assertion evaluations. " : ""}This empirical range uses only completed windows from this campaign. It is not a probability, asymptote estimate, or coverage claim.`,
  };
}

export function campaignRecommendation(ledger: CampaignLedger): CampaignRecommendation {
  const stopPolicy = ledger.policy.policyVersion >= 2 ? ledger.policy.control.stopPolicy : "ceilings";
  return stopPolicy === "knee" && forecastCampaign(ledger).knee.status === "candidate" ? "stop_at_knee" : "continue";
}

function policyId(ledger: CampaignLedger): string {
  return `policy-${createHash("sha256").update(JSON.stringify(ledger.policy)).digest("hex").slice(0, 24)}`;
}

function moreWork(ledger: CampaignLedger): string[] {
  const reason = ledger.stopReason;
  if (!reason) return [];
  if (reason === "state_ceiling" || reason === "knee_observed") return ["start a new campaign with a larger state ceiling or stopPolicy=ceilings"];
  if (reason === "deadline" || reason === "time_ceiling") return ["start a new campaign with a later deadline or larger elapsed-time ceiling"];
  if (reason === "memory_ceiling") return ["start a new campaign with a larger memory ceiling on suitable hardware"];
  if (reason === "disk_ceiling") return ["prune artifacts or start a new campaign with a larger disk ceiling"];
  if (reason === "frontier_ceiling") return ["start a new campaign with a larger frontier ceiling on suitable hardware"];
  if (reason === "cost_ceiling") return ["start a new campaign with a larger cost ceiling"];
  if (reason === "cancelled" || reason === "source_changed") return ["start a new source-bound campaign"];
  return [];
}

export function explainCampaignDecision(ledger: CampaignLedger): CampaignDecisionExplanation {
  const control = ledger.policy.policyVersion >= 2 ? ledger.policy.control : {
    mode: "fixed" as const,
    resourcePreference: ledger.policy.intent,
    valuePreference: "broad_qa" as const,
    stopPolicy: "ceilings" as const,
    overrideKeys: [] as string[],
  };
  const latest = completed(ledger).at(-1);
  return {
    policyId: policyId(ledger),
    policyVersion: ledger.policy.policyVersion,
    mode: control.mode,
    resourcePreference: control.resourcePreference,
    valuePreference: control.valuePreference,
    stopPolicy: control.stopPolicy,
    overrides: control.overrideKeys,
    ...(latest ? {
      latestAllocation: {
        id: latest.id,
        purpose: latest.purpose,
        grantedStates: latest.grantedStates,
        consumedStates: latest.consumedStates ?? 0,
        reason: latest.reason,
      },
    } : {}),
    forecast: forecastCampaign(ledger),
    bindingConstraint: ledger.stopReason ?? null,
    permitsMoreWork: moreWork(ledger),
    drilldown: {
      ...(latest?.provenance?.reportId ? { reportId: latest.provenance.reportId } : {}),
      findingsTool: "get_finding",
      curvesTool: "open_report",
    },
  };
}
