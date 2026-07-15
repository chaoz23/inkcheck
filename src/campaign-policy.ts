import { createHash } from "crypto";

export const CAMPAIGN_POLICY_SCHEMA_VERSION = 1;
export const CAMPAIGN_POLICY_VERSION = 2;

export type CampaignIntent = "scarce" | "balanced" | "abundant";
export type CampaignMode = "quick" | "balanced" | "deep" | "overnight" | "campaign" | "fixed";
export type CampaignValuePreference = "broad_qa" | "runtime_assertions" | "outcomes" | "approved_goals";
export type CampaignStopPolicy = "ceilings" | "knee";
export type CampaignPurpose = "typical" | "long_tail" | "regression" | "assertion" | "approved_goal";
export type CampaignRecommendation = "continue" | "stop_at_knee";
export type CampaignStopReason =
  | "exhaustive"
  | "knee_observed"
  | "state_ceiling"
  | "deadline"
  | "time_ceiling"
  | "memory_ceiling"
  | "disk_ceiling"
  | "cost_ceiling"
  | "concurrency_ceiling"
  | "frontier_ceiling"
  | "cancelled"
  | "source_changed";

export interface CampaignPolicyInput {
  intent: CampaignIntent;
  mode?: CampaignMode;
  valuePreference?: CampaignValuePreference;
  stopPolicy?: CampaignStopPolicy;
  overrideKeys?: string[];
  totalStates: number;
  maxElapsedMs: number;
  maxMemoryBytes: number;
  maxDiskBytes: number;
  maxConcurrency: number;
  deadlineAt?: string;
  maxCostMicrounits?: number;
  typicalWindowStates?: number;
  longTailShare?: number;
  minLongTailProbes?: number;
  regressionReserveStates?: number;
}

export interface CampaignPolicy {
  schemaVersion: 1;
  policyVersion: 2;
  intent: CampaignIntent;
  control: {
    mode: CampaignMode;
    resourcePreference: CampaignIntent;
    valuePreference: CampaignValuePreference;
    stopPolicy: CampaignStopPolicy;
    overrideKeys: string[];
  };
  ceilings: {
    totalStates: number;
    maxElapsedMs: number;
    maxMemoryBytes: number;
    maxDiskBytes: number;
    maxConcurrency: number;
    deadlineAt?: string;
    maxCostMicrounits?: number;
  };
  typicalWindowStates: number;
  longTail: {
    share: number;
    reservedStates: number;
    minProbes: number;
  };
  regressionReserveStates: number;
  disclosure: string;
}

export interface CampaignPartition {
  strategy?: "portfolio" | "shared" | "shared-variable";
  seed?: number;
  pathPrefix?: number[];
  checkpointId?: string;
  frontier?: string;
  goalId?: string;
  maxDepth?: number;
}

export interface CampaignAllocation {
  sequence: number;
  id: string;
  purpose: CampaignPurpose;
  grantedStates: number;
  createdAt: string;
  reason: string;
  partition: CampaignPartition;
  status: "allocated" | "completed";
  consumedStates?: number;
  completedAt?: string;
  stopReason?: string;
  yield?: {
    critical: number;
    intent: number;
    authoredCoverage: number;
    terminalVariants: number;
  };
  provenance?: {
    reportId: string;
    checkpointId?: string;
    elapsedMs: number;
    peakMemoryBytes: number;
    diskBytes: number;
  };
}

export interface CampaignLedger {
  schemaVersion: 1;
  policyVersion: 1 | 2;
  campaignId: string;
  bindingFingerprint: string;
  createdAt: string;
  status: "active" | "complete" | "invalidated";
  stopReason: CampaignStopReason | null;
  policy: CampaignPolicy;
  spend: {
    states: number;
    elapsedMs: number;
    peakMemoryBytes: number;
    currentDiskBytes: number;
    costMicrounits: number;
  };
  allocations: CampaignAllocation[];
  events: Array<{
    sequence: number;
    at: string;
    type: "campaign_started" | "run_allocated" | "run_completed" | "campaign_stopped" | "campaign_invalidated";
    allocationId?: string;
    purpose?: CampaignPurpose;
    states?: number;
    reason: string;
  }>;
}

export interface PlanCampaignInput {
  now: string;
  bindingFingerprint: string;
  recommendation: CampaignRecommendation;
  exhaustive?: boolean;
  partition?: CampaignPartition;
  pendingRegressionReplays?: number;
}

export interface AllocateDirectedCampaignRunInput {
  now: string;
  bindingFingerprint: string;
  purpose: "assertion" | "approved_goal";
  grantedStates: number;
  partition: CampaignPartition;
}

export interface CommitCampaignRunInput {
  now: string;
  bindingFingerprint: string;
  allocationId: string;
  consumedStates: number;
  peakMemoryBytes: number;
  currentDiskBytes: number;
  costMicrounits?: number;
  stopReason: string;
  yield?: CampaignAllocation["yield"];
  reportId?: string;
  checkpointId?: string;
  windowElapsedMs?: number;
}

export type CampaignPlan =
  | { action: "allocate"; ledger: CampaignLedger; allocation: CampaignAllocation }
  | { action: "wait"; ledger: CampaignLedger; reason: "concurrency_ceiling" }
  | { action: "stop"; ledger: CampaignLedger; reason: CampaignStopReason };

const PROFILES: Record<CampaignIntent, {
  typicalWindowShare: number;
  typicalWindowCap: number;
  longTailShare: number;
  minLongTailProbes: number;
  regressionReserveShare: number;
}> = {
  scarce: { typicalWindowShare: 0.05, typicalWindowCap: 250_000, longTailShare: 0.05, minLongTailProbes: 1, regressionReserveShare: 0.15 },
  balanced: { typicalWindowShare: 0.10, typicalWindowCap: 1_000_000, longTailShare: 0.15, minLongTailProbes: 2, regressionReserveShare: 0.10 },
  abundant: { typicalWindowShare: 0.10, typicalWindowCap: 5_000_000, longTailShare: 0.25, minLongTailProbes: 4, regressionReserveShare: 0.05 },
};

function integer(value: number, name: string, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer at least ${min}`);
}

function positiveFingerprint(value: string): void {
  if (!/^[A-Za-z0-9._:-]{8,256}$/.test(value)) {
    throw new Error("bindingFingerprint must be an opaque 8-256 character source/config fingerprint");
  }
}

function isoTime(value: string, name: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${name} must be an ISO date-time`);
  return time;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function campaignLedgerDigest(ledger: CampaignLedger): string {
  return stableHash(ledger);
}

function validatePartition(partition: CampaignPartition): CampaignPartition {
  const allowed = ["checkpointId", "frontier", "goalId", "maxDepth", "pathPrefix", "seed", "strategy"];
  if (Object.keys(partition).some((key) => !allowed.includes(key))) throw new Error("campaign partition contains an unknown key");
  if (partition.strategy !== undefined && !["portfolio", "shared", "shared-variable"].includes(partition.strategy)) {
    throw new Error("partition.strategy must be portfolio, shared, or shared-variable");
  }
  if (partition.seed !== undefined) integer(partition.seed, "partition.seed", 1);
  if (partition.maxDepth !== undefined) integer(partition.maxDepth, "partition.maxDepth", 1);
  if (partition.pathPrefix !== undefined) {
    if (!Array.isArray(partition.pathPrefix) || partition.pathPrefix.length > 1_000) throw new Error("partition.pathPrefix must contain at most 1000 choice indexes");
    partition.pathPrefix.forEach((choice, index) => integer(choice, `partition.pathPrefix[${index}]`, 0));
  }
  for (const key of ["checkpointId", "frontier", "goalId"] as const) {
    const value = partition[key];
    if (value !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error(`partition.${key} is invalid`);
  }
  return {
    ...(partition.strategy !== undefined ? { strategy: partition.strategy } : {}),
    ...(partition.seed !== undefined ? { seed: partition.seed } : {}),
    ...(partition.pathPrefix !== undefined ? { pathPrefix: [...partition.pathPrefix] } : {}),
    ...(partition.checkpointId !== undefined ? { checkpointId: partition.checkpointId } : {}),
    ...(partition.frontier !== undefined ? { frontier: partition.frontier } : {}),
    ...(partition.goalId !== undefined ? { goalId: partition.goalId } : {}),
    ...(partition.maxDepth !== undefined ? { maxDepth: partition.maxDepth } : {}),
  };
}

export function createCampaignPolicy(input: CampaignPolicyInput): CampaignPolicy {
  const profile = PROFILES[input.intent];
  if (!profile) throw new Error("campaign intent must be scarce, balanced, or abundant");
  integer(input.totalStates, "totalStates", 10);
  integer(input.maxElapsedMs, "maxElapsedMs", 1);
  integer(input.maxMemoryBytes, "maxMemoryBytes", 1);
  integer(input.maxDiskBytes, "maxDiskBytes", 1);
  integer(input.maxConcurrency, "maxConcurrency", 1);
  if (input.maxConcurrency > 1_000) throw new Error("maxConcurrency must not exceed 1000");
  if (input.maxCostMicrounits !== undefined) integer(input.maxCostMicrounits, "maxCostMicrounits", 0);
  if (input.deadlineAt !== undefined) isoTime(input.deadlineAt, "deadlineAt");
  const mode = input.mode ?? "fixed";
  if (!["quick", "balanced", "deep", "overnight", "campaign", "fixed"].includes(mode)) {
    throw new Error("campaign mode must be quick, balanced, deep, overnight, campaign, or fixed");
  }
  const valuePreference = input.valuePreference ?? "broad_qa";
  if (!["broad_qa", "runtime_assertions", "outcomes", "approved_goals"].includes(valuePreference)) {
    throw new Error("valuePreference must be broad_qa, runtime_assertions, outcomes, or approved_goals");
  }
  const stopPolicy = input.stopPolicy ?? "ceilings";
  if (!["ceilings", "knee"].includes(stopPolicy)) throw new Error("stopPolicy must be ceilings or knee");
  const overrideKeys = [...new Set(input.overrideKeys ?? [])].sort();
  if (overrideKeys.length > 32 || overrideKeys.some((key) => !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key))) {
    throw new Error("overrideKeys must contain at most 32 compact field names");
  }

  const typicalWindowStates = input.typicalWindowStates
    ?? Math.max(1, Math.min(profile.typicalWindowCap, Math.floor(input.totalStates * profile.typicalWindowShare)));
  integer(typicalWindowStates, "typicalWindowStates", 1);
  if (typicalWindowStates > input.totalStates) throw new Error("typicalWindowStates must not exceed totalStates");
  const longTailShare = input.longTailShare ?? profile.longTailShare;
  if (!Number.isFinite(longTailShare) || longTailShare < 0 || longTailShare > 0.9) {
    throw new Error("longTailShare must be from 0 to 0.9");
  }
  const minLongTailProbes = input.minLongTailProbes ?? profile.minLongTailProbes;
  integer(minLongTailProbes, "minLongTailProbes", 0);
  if (longTailShare === 0 && minLongTailProbes > 0) throw new Error("minLongTailProbes requires a positive longTailShare");
  const longTailReservedStates = Math.floor(input.totalStates * longTailShare);
  if (minLongTailProbes > longTailReservedStates) {
    throw new Error("long-tail reserve must provide at least one state per minimum probe");
  }
  const regressionReserveStates = input.regressionReserveStates
    ?? Math.floor(input.totalStates * profile.regressionReserveShare);
  integer(regressionReserveStates, "regressionReserveStates", 0);
  if (longTailReservedStates + regressionReserveStates >= input.totalStates) {
    throw new Error("long-tail and regression reserves must leave states for ordinary work");
  }

  return {
    schemaVersion: CAMPAIGN_POLICY_SCHEMA_VERSION,
    policyVersion: CAMPAIGN_POLICY_VERSION,
    intent: input.intent,
    control: {
      mode,
      resourcePreference: input.intent,
      valuePreference,
      stopPolicy,
      overrideKeys,
    },
    ceilings: {
      totalStates: input.totalStates,
      maxElapsedMs: input.maxElapsedMs,
      maxMemoryBytes: input.maxMemoryBytes,
      maxDiskBytes: input.maxDiskBytes,
      maxConcurrency: input.maxConcurrency,
      ...(input.deadlineAt ? { deadlineAt: new Date(input.deadlineAt).toISOString() } : {}),
      ...(input.maxCostMicrounits !== undefined ? { maxCostMicrounits: input.maxCostMicrounits } : {}),
    },
    typicalWindowStates,
    longTail: { share: longTailShare, reservedStates: longTailReservedStates, minProbes: minLongTailProbes },
    regressionReserveStates,
    disclosure: "Forecasts and knee signals describe bounded observed windows and are never proof of coverage, unreachability, or the absence of later discoveries.",
  };
}

export function createCampaignLedger(policy: CampaignPolicy, bindingFingerprint: string, now: string): CampaignLedger {
  positiveFingerprint(bindingFingerprint);
  isoTime(now, "now");
  const normalizedPolicy = createCampaignPolicy({
    intent: policy.intent,
    totalStates: policy.ceilings.totalStates,
    maxElapsedMs: policy.ceilings.maxElapsedMs,
    maxMemoryBytes: policy.ceilings.maxMemoryBytes,
    maxDiskBytes: policy.ceilings.maxDiskBytes,
    maxConcurrency: policy.ceilings.maxConcurrency,
    mode: policy.control.mode,
    valuePreference: policy.control.valuePreference,
    stopPolicy: policy.control.stopPolicy,
    overrideKeys: policy.control.overrideKeys,
    deadlineAt: policy.ceilings.deadlineAt,
    maxCostMicrounits: policy.ceilings.maxCostMicrounits,
    typicalWindowStates: policy.typicalWindowStates,
    longTailShare: policy.longTail.share,
    minLongTailProbes: policy.longTail.minProbes,
    regressionReserveStates: policy.regressionReserveStates,
  });
  if (JSON.stringify(normalizedPolicy) !== JSON.stringify(policy)) throw new Error("campaign policy is invalid or was modified after validation");
  const campaignId = `campaign-${stableHash({ policy: normalizedPolicy, bindingFingerprint, now }).slice(0, 24)}`;
  return {
    schemaVersion: CAMPAIGN_POLICY_SCHEMA_VERSION,
    policyVersion: CAMPAIGN_POLICY_VERSION,
    campaignId,
    bindingFingerprint,
    createdAt: new Date(now).toISOString(),
    status: "active",
    stopReason: null,
    policy: clone(normalizedPolicy),
    spend: { states: 0, elapsedMs: 0, peakMemoryBytes: 0, currentDiskBytes: 0, costMicrounits: 0 },
    allocations: [],
    events: [{ sequence: 1, at: new Date(now).toISOString(), type: "campaign_started", reason: `started ${policy.intent} campaign policy v${policy.policyVersion}` }],
  };
}

function elapsed(ledger: CampaignLedger, now: string): number {
  const difference = isoTime(now, "now") - isoTime(ledger.createdAt, "createdAt");
  if (difference < 0) throw new Error("now must not precede campaign creation");
  return difference;
}

function activeAllocations(ledger: CampaignLedger): CampaignAllocation[] {
  return ledger.allocations.filter((allocation) => allocation.status === "allocated");
}

function consumedBy(ledger: CampaignLedger, purpose: CampaignPurpose): number {
  return ledger.allocations.reduce((sum, allocation) => sum + (allocation.purpose === purpose ? allocation.consumedStates ?? 0 : 0), 0);
}

function stop(ledger: CampaignLedger, now: string, reason: CampaignStopReason, message: string): CampaignPlan {
  const next = clone(ledger);
  next.status = "complete";
  next.stopReason = reason;
  next.spend.elapsedMs = elapsed(next, now);
  next.events.push({ sequence: next.events.length + 1, at: new Date(now).toISOString(), type: "campaign_stopped", reason: message });
  return { action: "stop", ledger: next, reason };
}

function invalidate(ledger: CampaignLedger, now: string): CampaignPlan {
  const next = clone(ledger);
  next.status = "invalidated";
  next.stopReason = "source_changed";
  next.spend.elapsedMs = elapsed(next, now);
  next.events.push({ sequence: next.events.length + 1, at: new Date(now).toISOString(), type: "campaign_invalidated", reason: "source/config fingerprint changed; no further work was allocated" });
  return { action: "stop", ledger: next, reason: "source_changed" };
}

export function planCampaignRun(ledger: CampaignLedger, input: PlanCampaignInput): CampaignPlan {
  if (ledger.status !== "active") throw new Error(`campaign is ${ledger.status}`);
  positiveFingerprint(input.bindingFingerprint);
  if (input.bindingFingerprint !== ledger.bindingFingerprint) return invalidate(ledger, input.now);
  const elapsedMs = elapsed(ledger, input.now);
  if (ledger.policy.ceilings.deadlineAt && isoTime(input.now, "now") >= isoTime(ledger.policy.ceilings.deadlineAt, "deadlineAt")) {
    return stop(ledger, input.now, "deadline", "campaign deadline reached");
  }
  if (elapsedMs >= ledger.policy.ceilings.maxElapsedMs) return stop(ledger, input.now, "time_ceiling", "campaign elapsed-time ceiling reached");
  if (ledger.spend.peakMemoryBytes >= ledger.policy.ceilings.maxMemoryBytes) return stop(ledger, input.now, "memory_ceiling", "campaign memory ceiling reached");
  if (ledger.spend.currentDiskBytes >= ledger.policy.ceilings.maxDiskBytes) return stop(ledger, input.now, "disk_ceiling", "campaign disk ceiling reached");
  if (ledger.policy.ceilings.maxCostMicrounits !== undefined && ledger.spend.costMicrounits >= ledger.policy.ceilings.maxCostMicrounits) {
    return stop(ledger, input.now, "cost_ceiling", "campaign cost ceiling reached");
  }
  if (input.exhaustive) return stop(ledger, input.now, "exhaustive", "systematic search proved the configured reachable space exhaustive");
  const active = activeAllocations(ledger);
  if (active.length >= ledger.policy.ceilings.maxConcurrency) {
    return { action: "wait", ledger: clone(ledger), reason: "concurrency_ceiling" };
  }

  const pendingRegressionReplays = input.pendingRegressionReplays ?? 0;
  integer(pendingRegressionReplays, "pendingRegressionReplays", 0);
  const longTailCompleted = ledger.allocations.filter((allocation) => allocation.purpose === "long_tail" && allocation.status === "completed").length;
  const longTailActive = active.filter((allocation) => allocation.purpose === "long_tail").length;
  const longTailConsumed = consumedBy(ledger, "long_tail");
  const regressionConsumed = consumedBy(ledger, "regression");
  const stateCommitted = ledger.spend.states + active.reduce((sum, allocation) => sum + allocation.grantedStates, 0);
  const statesRemaining = ledger.policy.ceilings.totalStates - stateCommitted;
  if (statesRemaining <= 0) return stop(ledger, input.now, "state_ceiling", "campaign state ceiling is fully committed");
  const regressionOutstanding = Math.max(0, ledger.policy.regressionReserveStates - regressionConsumed
    - active.filter((allocation) => allocation.purpose === "regression").reduce((sum, allocation) => sum + allocation.grantedStates, 0));
  const longTailOutstanding = Math.max(0, ledger.policy.longTail.reservedStates - longTailConsumed
    - active.filter((allocation) => allocation.purpose === "long_tail").reduce((sum, allocation) => sum + allocation.grantedStates, 0));
  const ordinaryAvailable = Math.max(0, statesRemaining - regressionOutstanding - longTailOutstanding);
  const baseAllocationCount = ledger.allocations.filter((allocation) => allocation.purpose === "typical"
    || allocation.purpose === "long_tail" || allocation.purpose === "regression").length;

  let purpose: CampaignPurpose = "typical";
  let reason = "ordinary window continues broad bounded QA";
  if (pendingRegressionReplays > 0 && regressionConsumed < ledger.policy.regressionReserveStates) {
    purpose = "regression";
    reason = "protected regression reserve serves a pending exact replay";
  } else {
    const minimumTailOutstanding = longTailCompleted + longTailActive < ledger.policy.longTail.minProbes;
    const tailShareOutstanding = longTailConsumed < ledger.policy.longTail.reservedStates;
    if ((minimumTailOutstanding && baseAllocationCount > 0)
      || (ordinaryAvailable === 0 && longTailOutstanding > 0)
      || (input.recommendation === "stop_at_knee" && tailShareOutstanding)) {
      purpose = "long_tail";
      reason = input.recommendation === "stop_at_knee"
        ? "protected long-tail probe continues beyond a bounded knee observation"
        : "protected minimum long-tail probe is due";
    } else if (input.recommendation === "stop_at_knee") {
      return stop(ledger, input.now, "knee_observed", "ordinary work stopped after protected long-tail obligations; knee remains a bounded observation, not coverage proof");
    }
  }

  const protectedFromTypical = regressionOutstanding + longTailOutstanding;
  const purposeLimit = purpose === "regression"
    ? regressionOutstanding
    : purpose === "long_tail"
      ? longTailOutstanding
      : Math.max(0, statesRemaining - protectedFromTypical);
  const grantedStates = Math.min(statesRemaining, ledger.policy.typicalWindowStates, purposeLimit);
  if (grantedStates <= 0) {
    return stop(ledger, input.now, "state_ceiling", "no unreserved campaign states remain for this run purpose");
  }

  const next = clone(ledger);
  next.spend.elapsedMs = elapsedMs;
  const sequence = next.allocations.length + 1;
  const partition = validatePartition(input.partition ?? {});
  const allocation: CampaignAllocation = {
    sequence,
    id: `run-${stableHash({ campaignId: next.campaignId, sequence, purpose, grantedStates, partition }).slice(0, 24)}`,
    purpose,
    grantedStates,
    createdAt: new Date(input.now).toISOString(),
    reason,
    partition,
    status: "allocated",
  };
  next.allocations.push(allocation);
  next.events.push({ sequence: next.events.length + 1, at: allocation.createdAt, type: "run_allocated", allocationId: allocation.id, purpose, states: grantedStates, reason });
  return { action: "allocate", ledger: next, allocation: clone(allocation) };
}

export function allocateDirectedCampaignRun(
  ledger: CampaignLedger,
  input: AllocateDirectedCampaignRunInput
): { ledger: CampaignLedger; allocation: CampaignAllocation } {
  const completedBase = ledger.status === "complete"
    && (ledger.stopReason === "exhaustive" || ledger.stopReason === "state_ceiling");
  if (ledger.status !== "active" && !completedBase) throw new Error(`campaign is ${ledger.status}`);
  positiveFingerprint(input.bindingFingerprint);
  if (input.bindingFingerprint !== ledger.bindingFingerprint) {
    throw new Error("source/config fingerprint changed; invalidate the campaign before allocating directed work");
  }
  integer(input.grantedStates, "grantedStates", 1);
  const elapsedMs = elapsed(ledger, input.now);
  if (ledger.policy.ceilings.deadlineAt && isoTime(input.now, "now") >= isoTime(ledger.policy.ceilings.deadlineAt, "deadlineAt")) {
    throw new Error("campaign deadline reached before directed work could be allocated");
  }
  if (elapsedMs >= ledger.policy.ceilings.maxElapsedMs) throw new Error("campaign elapsed-time ceiling reached");
  if (ledger.spend.peakMemoryBytes >= ledger.policy.ceilings.maxMemoryBytes) throw new Error("campaign memory ceiling reached");
  if (ledger.spend.currentDiskBytes >= ledger.policy.ceilings.maxDiskBytes) throw new Error("campaign disk ceiling reached");
  if (ledger.policy.ceilings.maxCostMicrounits !== undefined
    && ledger.spend.costMicrounits >= ledger.policy.ceilings.maxCostMicrounits) {
    throw new Error("campaign cost ceiling reached");
  }
  if (activeAllocations(ledger).length >= ledger.policy.ceilings.maxConcurrency) {
    throw new Error("campaign concurrency ceiling is occupied");
  }
  const next = clone(ledger);
  next.spend.elapsedMs = elapsedMs;
  const sequence = next.allocations.length + 1;
  const partition = validatePartition(input.partition);
  const reason = input.purpose === "assertion"
    ? "explicit additive assertion window preserves protected broad QA"
    : "explicit additive approved-goal window preserves protected broad QA";
  const allocation: CampaignAllocation = {
    sequence,
    id: `run-${stableHash({ campaignId: next.campaignId, sequence, purpose: input.purpose, grantedStates: input.grantedStates, partition }).slice(0, 24)}`,
    purpose: input.purpose,
    grantedStates: input.grantedStates,
    createdAt: new Date(input.now).toISOString(),
    reason,
    partition,
    status: "allocated",
  };
  next.allocations.push(allocation);
  next.events.push({
    sequence: next.events.length + 1,
    at: allocation.createdAt,
    type: "run_allocated",
    allocationId: allocation.id,
    purpose: allocation.purpose,
    states: allocation.grantedStates,
    reason,
  });
  return { ledger: next, allocation: clone(allocation) };
}

export function commitCampaignRun(ledger: CampaignLedger, input: CommitCampaignRunInput): CampaignLedger {
  positiveFingerprint(input.bindingFingerprint);
  if (input.bindingFingerprint !== ledger.bindingFingerprint) throw new Error("source/config fingerprint changed; invalidate the campaign before committing work");
  const allocation = ledger.allocations.find((item) => item.id === input.allocationId);
  if (!allocation) throw new Error("campaign allocation was not found");
  const directed = allocation.purpose === "assertion" || allocation.purpose === "approved_goal";
  const completedBase = ledger.status === "complete"
    && (ledger.stopReason === "exhaustive" || ledger.stopReason === "state_ceiling");
  if (ledger.status !== "active" && !(directed && completedBase)) throw new Error(`campaign is ${ledger.status}`);
  if (allocation.status !== "allocated") throw new Error("campaign allocation was already completed");
  if (isoTime(input.now, "now") < isoTime(allocation.createdAt, "allocation.createdAt")) {
    throw new Error("run completion must not precede its allocation");
  }
  integer(input.consumedStates, "consumedStates", 0);
  integer(input.peakMemoryBytes, "peakMemoryBytes", 0);
  integer(input.currentDiskBytes, "currentDiskBytes", 0);
  const cost = input.costMicrounits ?? 0;
  integer(cost, "costMicrounits", 0);
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(input.stopReason)) throw new Error("stopReason must be a compact machine-readable value");
  if (input.yield) {
    for (const [key, value] of Object.entries(input.yield)) integer(value, `yield.${key}`, 0);
  }
  if (input.reportId !== undefined && !/^report-[0-9a-f]{24}$/.test(input.reportId)) throw new Error("reportId is invalid");
  if (input.checkpointId !== undefined && !/^checkpoint-[0-9a-f]{24}$/.test(input.checkpointId)) throw new Error("checkpointId is invalid");
  if (input.checkpointId !== undefined && input.reportId === undefined) throw new Error("checkpointId requires reportId provenance");
  if (input.windowElapsedMs !== undefined) integer(input.windowElapsedMs, "windowElapsedMs", 0);
  if (input.consumedStates > allocation.grantedStates) throw new Error("child run consumed more states than its allocation");
  const elapsedMs = elapsed(ledger, input.now);
  if (elapsedMs > ledger.policy.ceilings.maxElapsedMs) throw new Error("child result crossed the campaign elapsed-time ceiling");
  if (ledger.policy.ceilings.deadlineAt && isoTime(input.now, "now") > isoTime(ledger.policy.ceilings.deadlineAt, "deadlineAt")) {
    throw new Error("child result crossed the campaign deadline");
  }
  const memoryStop = input.stopReason === "maxMemory" || input.stopReason === "memory_ceiling";
  if (input.peakMemoryBytes > ledger.policy.ceilings.maxMemoryBytes && !memoryStop) {
    throw new Error("child result crossed the campaign memory ceiling without reporting a memory stop");
  }
  if (input.currentDiskBytes > ledger.policy.ceilings.maxDiskBytes) throw new Error("child result crossed the campaign disk ceiling");
  if (!directed && ledger.spend.states + input.consumedStates > ledger.policy.ceilings.totalStates) {
    throw new Error("child result crossed the campaign state ceiling");
  }
  if (ledger.policy.ceilings.maxCostMicrounits !== undefined
    && ledger.spend.costMicrounits + cost > ledger.policy.ceilings.maxCostMicrounits) {
    throw new Error("child result crossed the campaign cost ceiling");
  }
  const next = clone(ledger);
  const target = next.allocations.find((item) => item.id === input.allocationId) as CampaignAllocation;
  target.status = "completed";
  target.consumedStates = input.consumedStates;
  target.completedAt = new Date(input.now).toISOString();
  target.stopReason = input.stopReason;
  if (input.yield) target.yield = clone(input.yield);
  if (input.reportId) {
    target.provenance = {
      reportId: input.reportId,
      ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
      elapsedMs: input.windowElapsedMs ?? elapsedMs,
      peakMemoryBytes: input.peakMemoryBytes,
      diskBytes: input.currentDiskBytes,
    };
  }
  next.spend = {
    states: next.spend.states + (directed ? 0 : input.consumedStates),
    elapsedMs,
    peakMemoryBytes: Math.max(next.spend.peakMemoryBytes, input.peakMemoryBytes),
    currentDiskBytes: input.currentDiskBytes,
    costMicrounits: next.spend.costMicrounits + cost,
  };
  next.events.push({
    sequence: next.events.length + 1,
    at: target.completedAt,
    type: "run_completed",
    allocationId: target.id,
    purpose: target.purpose,
    states: input.consumedStates,
    reason: input.stopReason,
  });
  return next;
}

export function finishCampaignLedger(
  ledger: CampaignLedger,
  input: { now: string; bindingFingerprint: string; reason: Exclude<CampaignStopReason, "concurrency_ceiling" | "source_changed">; message: string }
): CampaignLedger {
  if (ledger.status !== "active") throw new Error(`campaign is ${ledger.status}`);
  positiveFingerprint(input.bindingFingerprint);
  if (input.bindingFingerprint !== ledger.bindingFingerprint) throw new Error("source/config fingerprint changed; invalidate the campaign instead");
  if (activeAllocations(ledger).length > 0) throw new Error("campaign cannot finish while a run allocation is active");
  if (!/^[\x20-\x7e]{1,256}$/.test(input.message)) throw new Error("campaign finish message must be compact printable text");
  const result = stop(ledger, input.now, input.reason, input.message);
  if (result.action !== "stop") throw new Error("campaign finish did not produce a terminal ledger");
  return result.ledger;
}
