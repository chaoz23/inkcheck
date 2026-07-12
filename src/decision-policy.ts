import type { DiscoveryCurveSample, ExploreResult, PassTelemetry } from "./explore";

export const SHADOW_POLICY_VERSION = 1;
export const SHADOW_PROBE_FLOOR = 0.08;

export type ShadowAction =
  | "continue"
  | "reallocate"
  | "probe"
  | "stop_at_knee"
  | "stop_at_deadline"
  | "stop_at_resource_limit"
  | "stop_exhaustive";

export interface ValueTiers {
  critical: number;
  intent: number;
  authoredCoverage: number;
  terminalVariants: number;
  stateNovelty: number;
}

export interface ShadowAllocation {
  pass: string;
  currentShare: number;
  suggestedShare: number;
  probeFloor: number;
  recentValue: ValueTiers;
  reason: string;
}

export interface ShadowDecision {
  mode: "shadow";
  applied: false;
  policyVersion: number;
  action: ShadowAction;
  reason: string;
  bindingConstraint: "exhaustive" | "memory" | "time" | "states" | "depth" | null;
  uncertainty: {
    confidence: "low" | "moderate" | "high";
    curveCompacted: boolean;
    lateRecoveryObserved: boolean;
    note: string;
  };
  evidence: {
    statesExplored: number;
    discoveryEvents: number;
    statesSinceLastDiscovery: number | null;
    longestObservedDiscoveryGap: number | null;
    criticalEvidenceObserved: boolean;
  };
  allocation: ShadowAllocation[];
}

function zeroValue(): ValueTiers {
  return { critical: 0, intent: 0, authoredCoverage: 0, terminalVariants: 0, stateNovelty: 0 };
}

function isBeyondObservedRecovery(pass: PassTelemetry): boolean {
  const summary = pass.portfolioMarginalSummary ?? pass.discoverySummary;
  const dry = summary.statesSinceLastDiscovery;
  const longest = summary.longestObservedDiscoveryGap;
  return dry !== null && dry > Math.max(1_000, (longest ?? 0) * 2);
}

function recentValue(pass: PassTelemetry): ValueTiers {
  if (isBeyondObservedRecovery(pass)) return zeroValue();
  const samples = (pass.portfolioMarginalCurve ?? pass.discoveryCurve).slice(-3);
  return samples.reduce<ValueTiers>((value, sample) => ({
    critical: value.critical + sample.newRuntimeErrors + sample.newAssertionViolations,
    intent: value.intent + sample.newGoalsReached + sample.newStagesReached,
    authoredCoverage: value.authoredCoverage + sample.newKnots + sample.newVisibleOutcomes,
    terminalVariants: value.terminalVariants + sample.newEndings,
    stateNovelty: value.stateNovelty + sample.newUniqueStates,
  }), zeroValue());
}

function compareValue(a: ValueTiers, b: ValueTiers): number {
  return a.critical - b.critical
    || a.intent - b.intent
    || a.authoredCoverage - b.authoredCoverage
    || a.terminalVariants - b.terminalVariants
    || a.stateNovelty - b.stateNovelty;
}

function hasValue(value: ValueTiers): boolean {
  return Object.values(value).some((count) => count > 0);
}

function bindingConstraint(report: ExploreResult): ShadowDecision["bindingConstraint"] {
  if (report.exhaustive) return "exhaustive";
  if (report.truncatedBy.memory) return "memory";
  if (report.truncatedBy.time) return "time";
  if (report.truncatedBy.maxDepth) return "depth";
  if (report.truncatedBy.maxStates) return "states";
  return null;
}

function suggestedAllocation(passes: PassTelemetry[]): ShadowAllocation[] {
  if (!passes.length) return [];
  const values = passes.map(recentValue);
  const ranked = [...values].sort(compareValue).reverse();
  const best = ranked[0];
  const productive = values.map(hasValue);
  const floor = Math.min(SHADOW_PROBE_FLOOR, 1 / passes.length);
  const floorTotal = floor * passes.length;
  const discretionary = Math.max(0, 1 - floorTotal);
  const winners = Math.max(1, values.filter((value) => compareValue(value, best) === 0).length);
  const totalGranted = passes.reduce((total, pass) => total + pass.granted, 0);
  return passes.map((pass, index) => {
    const winner = compareValue(values[index], best) === 0;
    return {
      pass: pass.pass,
      currentShare: totalGranted > 0 ? pass.granted / totalGranted : 1 / passes.length,
      suggestedShare: floor + (winner ? discretionary / winners : 0),
      probeFloor: floor,
      recentValue: values[index],
      reason: winner
        ? "highest recent lexicographic value tier; receives discretionary shadow allocation"
        : productive[index]
          ? "recent findings remain, but a complementary pass ranks higher; protected probe floor retained"
          : "no retained recent value event; protected probe floor retained for possible late recovery",
    };
  });
}

export function recommendShadowDecision(report: ExploreResult): ShadowDecision {
  const summary = report.discoverySummary;
  const passes = report.passes ?? [];
  const allocation = suggestedAllocation(passes);
  const compacted = passes.some((pass) => {
    const curve = pass.portfolioMarginalCurve ?? pass.discoveryCurve;
    const passSummary = pass.portfolioMarginalSummary ?? pass.discoverySummary;
    return passSummary.discoveryEvents > curve.length;
  })
    || (summary !== undefined && summary.discoveryEvents > (report.discoveryCurve?.length ?? 0));
  const lateRecoveryObserved = passes.some((pass) => {
    const passSummary = pass.portfolioMarginalSummary ?? pass.discoverySummary;
    const longest = passSummary.longestObservedDiscoveryGap;
    return longest !== null
      && longest >= Math.max(10, Math.floor(pass.statesExplored * 0.1))
      && passSummary.discoveryEvents >= 2;
  });
  const criticalEvidenceObserved = passes.some((pass) =>
    pass.discoveryCurve.some((sample: DiscoveryCurveSample) => sample.runtimeErrorsFound > 0 || sample.assertionViolations > 0)
  );
  const constraint = bindingConstraint(report);
  const base = {
    mode: "shadow" as const,
    applied: false as const,
    policyVersion: SHADOW_POLICY_VERSION,
    bindingConstraint: constraint,
    uncertainty: {
      confidence: (report.exhaustive ? "high" : compacted || lateRecoveryObserved ? "low" : "moderate") as "low" | "moderate" | "high",
      curveCompacted: compacted,
      lateRecoveryObserved,
      note: report.exhaustive
        ? "reachable-state exhaustion is proven"
        : "bounded curves can contain unseen later peaks; this shadow decision is not coverage proof",
    },
    evidence: {
      statesExplored: report.statesExplored,
      discoveryEvents: summary?.discoveryEvents ?? 0,
      statesSinceLastDiscovery: summary?.statesSinceLastDiscovery ?? null,
      longestObservedDiscoveryGap: summary?.longestObservedDiscoveryGap ?? null,
      criticalEvidenceObserved,
    },
    allocation,
  };

  if (report.exhaustive) return { ...base, action: "stop_exhaustive", reason: "a systematic pass proved every reachable state exhausted" };
  if (report.truncatedBy.memory) return { ...base, action: "stop_at_resource_limit", reason: "the memory guard is binding; more state budget would not be safe" };
  if (report.truncatedBy.time) return { ...base, action: "stop_at_deadline", reason: "the configured wall-clock limit is binding" };
  if (!summary || summary.discoveryEvents === 0) return { ...base, action: "probe", reason: "no meaningful discovery has been observed; retain complementary probe floors" };

  const productive = allocation.filter((entry) => hasValue(entry.recentValue));
  const quiet = allocation.length - productive.length;
  if (productive.length > 0 && quiet > 0) {
    return { ...base, action: "reallocate", reason: "some passes retain recent value while quiet passes keep protected late-recovery floors" };
  }
  const dry = summary.statesSinceLastDiscovery ?? 0;
  const longest = summary.longestObservedDiscoveryGap ?? 0;
  if (summary.discoveryEvents >= 5 && dry > Math.max(1_000, longest * 2)) {
    return { ...base, action: "stop_at_knee", reason: "current dry distance exceeds twice the longest observed recovery gap; shadow knee candidate only" };
  }
  if (dry > longest && lateRecoveryObserved) {
    return { ...base, action: "probe", reason: "the run is dry, but measured late recovery keeps exploratory floors justified" };
  }
  return { ...base, action: "continue", reason: "meaningful yield remains within the observed recovery envelope" };
}
