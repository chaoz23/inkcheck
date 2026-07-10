import { ExploreResult, PassTelemetry } from "./explore";
import { StoryShapeProfile } from "./inklecate";

export const MAX_DEPTH_CEILING = 1_000;
export const MAX_STATES_CEILING = 1_000_000;
export const MAX_SEED = 4_294_967_295;

/**
 * Machine-actionable advice for the next check (issue #30). The vocabulary
 * is a small closed set so agents can switch on it:
 *
 * - `stop` — the run proved everything it can prove; rerunning with bigger
 *   limits has no supporting evidence.
 * - `deepen` — paths were cut at the depth limit and content plausibly sits
 *   past it; rerun with the proposed `--max-depth`.
 * - `broaden` — the state budget ran out while passes were still
 *   discovering; rerun with the proposed `--max-states`.
 * - `reseed` — systematic passes saturated but random sampling was still
 *   finding endings; rerun with the proposed `--seed`.
 * - `investigate` — no flag change has evidence behind it; a human (or
 *   author-provided hints) should look at the cited knots instead.
 */
export type NextRunRecommendation = "stop" | "deepen" | "broaden" | "reseed" | "investigate";

export interface NextRunAdvice {
  recommendation: NextRunRecommendation;
  /** True when rerunning with different flags is not supported by evidence. */
  stop: boolean;
  /** Complete flag set for the proposed next run (unchanged values included). */
  flags: { maxDepth: number; maxStates: number; seed?: number };
  /** Which report fields drove the decision. */
  rationale: string;
  /** What the evidence says the next run may gain. */
  expectedGain: string;
}

/** A pass discovered something in the second half of its spend. */
function discoveredLate(pass: PassTelemetry): boolean {
  return (
    pass.lastDiscoveryAtState !== null &&
    pass.statesExplored > 0 &&
    pass.lastDiscoveryAtState >= pass.statesExplored / 2
  );
}

/**
 * Recommend the next run as a pure, deterministic function of one report
 * (plus an optional static shape profile for a better depth target). The
 * rationale always cites the fields that drove the decision, and proposed
 * flags never exceed the documented hard ceilings — when nothing above the
 * current limits is supported, the recommendation degrades to
 * `investigate`/`stop` instead.
 */
export function recommendNextRun(
  report: ExploreResult,
  profile?: StoryShapeProfile
): NextRunAdvice {
  const { maxDepth, maxStates, seed } = report.limits;
  const sameFlags = { maxDepth, maxStates, ...(seed !== undefined ? { seed } : {}) };

  const unvisited = report.unvisitedKnots;
  const inboundUnvisited = unvisited.filter(
    (k) => typeof k.inboundDiverts === "number" && k.inboundDiverts > 0
  );
  const orphanCandidates = unvisited.filter((k) => k.staticOrphanCandidate === true);

  if (report.exhaustive) {
    const orphanNote = orphanCandidates.length
      ? ` The ${orphanCandidates.length} unvisited knot(s) have no authored inbound divert, so no rerun can reach them — review them in the source.`
      : "";
    return {
      recommendation: "stop",
      stop: true,
      flags: sameFlags,
      rationale: `exhaustive is true: a systematic pass visited every reachable state within depth ${maxDepth} without hitting a limit.${orphanNote}`,
      expectedGain: "none — larger limits cannot find more at these settings",
    };
  }

  // Memory-bound runs must be handled before any "raise a limit" branch:
  // broadening or deepening only grows the frontier and state-hash set that
  // triggered the guard, so more budget makes an OOM more likely, not less.
  if (report.truncatedBy.memory) {
    return {
      recommendation: "investigate",
      stop: true,
      flags: sameFlags,
      rationale:
        "truncatedBy.memory is true: exploration stopped early to stay under the memory guard, so a bigger budget would hit the same wall sooner.",
      expectedGain:
        "none from a larger run — raise --max-old-space-size for more headroom, lower --max-states, or split the story and check parts separately",
    };
  }

  const passes = report.passes ?? [];
  const systematicLate = passes.some((p) => p.systematic && discoveredLate(p));
  const randomPass = passes.find((p) => p.pass.startsWith("random:"));
  const randomHot = randomPass !== undefined && discoveredLate(randomPass);
  const anyLate = systematicLate || randomHot;

  // Depth evidence is the strongest signal we have: on The Intercept,
  // depth 100 at a 1M budget reached content that depth 30 at 10M never did.
  if (report.truncatedBy.maxDepth && maxDepth < MAX_DEPTH_CEILING) {
    const profileTarget = profile ? profile.suggested.maxDepth : 0;
    const nextDepth = Math.min(MAX_DEPTH_CEILING, Math.max(maxDepth * 2, profileTarget));
    const knotEvidence = inboundUnvisited.length
      ? `${inboundUnvisited.length} unvisited knot(s) have inbound diverts in the source and `
      : "";
    return {
      recommendation: "deepen",
      stop: false,
      flags: { ...sameFlags, maxDepth: nextDepth },
      rationale: `truncatedBy.maxDepth is true: ${knotEvidence}paths were cut at ${maxDepth} choices deep while the state budget was not the only bound.`,
      expectedGain: inboundUnvisited.length
        ? `unvisited knots with inbound diverts (${inboundUnvisited
            .slice(0, 3)
            .map((k) => k.name)
            .join(", ")}${inboundUnvisited.length > 3 ? ", …" : ""}) may become reachable`
        : "content past the depth cut may become reachable",
    };
  }

  if (report.truncatedBy.maxStates && maxStates < MAX_STATES_CEILING && anyLate) {
    const hotPasses = passes.filter(discoveredLate).map((p) => p.pass);
    return {
      recommendation: "broaden",
      stop: false,
      flags: { ...sameFlags, maxStates: Math.min(MAX_STATES_CEILING, maxStates * 4) },
      rationale: `truncatedBy.maxStates is true and ${hotPasses.join(", ")} discovered in the second half of their spend (lastDiscoveryAtState), so the budget ran out while findings were still arriving.`,
      expectedGain: "passes that were still discovering get budget to continue",
    };
  }

  if (randomHot && !systematicLate && seed !== undefined) {
    const nextSeed = seed >= MAX_SEED ? 1 : seed + 1;
    return {
      recommendation: "reseed",
      stop: false,
      flags: { ...sameFlags, seed: nextSeed },
      rationale: `the systematic passes stopped discovering early but random:seed=${seed} was still finding (lastDiscoveryAtState in its second half); a different seed samples different early-choice combinations at the same cost.`,
      expectedGain: "different random walks may reach ending/state combinations this seed missed",
    };
  }

  const atCeilings =
    (!report.truncatedBy.maxDepth || maxDepth >= MAX_DEPTH_CEILING) &&
    (!report.truncatedBy.maxStates || maxStates >= MAX_STATES_CEILING);
  const knotPointer = inboundUnvisited.length
    ? ` Start with the ${inboundUnvisited.length} unvisited knot(s) with inbound diverts — the conditions guarding their diverts may never hold.`
    : orphanCandidates.length
      ? ` The ${orphanCandidates.length} unvisited knot(s) are static orphan candidates; only a source change can reach them.`
      : "";
  return {
    recommendation: "investigate",
    stop: true,
    flags: sameFlags,
    rationale: atCeilings
      ? `the binding limit(s) are already at their hard ceiling(s) (depth ${maxDepth}, states ${maxStates}), so no flag increase is possible.${knotPointer}`
      : `every pass stopped discovering in the first half of its spend (lastDiscoveryAtState), so raising limits has weak evidence behind it.${knotPointer}`,
    expectedGain:
      "none from flags alone — author-guided hints or manual review of the cited knots is the productive next step",
  };
}
