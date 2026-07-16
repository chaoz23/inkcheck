export const DEFAULT_AUTO_CONCURRENCY_CEILING = 4;
export const MAX_PORTFOLIO_CONCURRENCY = 16;

export type PortfolioConcurrencySetting = "auto" | number;
export type ConcurrencyMode = "auto" | "fixed";
export type ConcurrencyFallbackReason = "search_mode" | "additive_goals";

export interface ResolvedPortfolioConcurrency {
  mode: ConcurrencyMode;
  ceiling: number;
  executor: "sequential" | "fixed-concurrent" | "auto-handoff";
  fallbackReason?: ConcurrencyFallbackReason;
}

export function resolvePortfolioConcurrency(
  setting: PortfolioConcurrencySetting | undefined,
  search: "portfolio" | "shared" | "shared-variable",
  goalMaxStates: number
): ResolvedPortfolioConcurrency {
  const requested = setting ?? "auto";
  if (requested !== "auto") {
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_PORTFOLIO_CONCURRENCY) {
      throw new RangeError(`concurrency must be auto or an integer from 1 to ${MAX_PORTFOLIO_CONCURRENCY}`);
    }
    if (requested > 1 && search !== "portfolio") {
      throw new Error("concurrency greater than 1 requires portfolio search");
    }
    if (requested > 1 && goalMaxStates > 0) {
      throw new Error("concurrency greater than 1 does not yet support additive goal states");
    }
    return {
      mode: "fixed",
      ceiling: requested,
      executor: requested > 1 ? "fixed-concurrent" : "sequential",
    };
  }

  if (search !== "portfolio") {
    return {
      mode: "auto",
      ceiling: 1,
      executor: "sequential",
      fallbackReason: "search_mode",
    };
  }
  if (goalMaxStates > 0) {
    return {
      mode: "auto",
      ceiling: 1,
      executor: "sequential",
      fallbackReason: "additive_goals",
    };
  }
  return {
    mode: "auto",
    ceiling: DEFAULT_AUTO_CONCURRENCY_CEILING,
    executor: "auto-handoff",
  };
}
