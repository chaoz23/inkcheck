import type { RuntimeErrorReport } from "./explore";

export interface RuntimeFindingIdentity {
  message: string;
  exactLocation: { file: string; line: number } | null;
}

/**
 * Stable runtime-finding identity. Approximate source mappings are mutable
 * witness metadata, while an exact runtime/compiler location may distinguish
 * otherwise identical generic failures.
 */
export function runtimeFindingIdentity(error: RuntimeErrorReport): RuntimeFindingIdentity {
  return {
    message: error.message,
    exactLocation: error.sourceLocation?.approximate === false
      ? { file: error.sourceLocation.file, line: error.sourceLocation.line }
      : null,
  };
}

/** Semantic benchmark key aligned with the public finding-ID contract. */
export function runtimeSemanticKey(error: RuntimeErrorReport): string {
  return JSON.stringify(runtimeFindingIdentity(error));
}

/** Mutable witness/location metadata, reported separately from semantic identity. */
export function runtimeMetadataKey(error: RuntimeErrorReport): string {
  const location = error.sourceLocation
    ? `${error.sourceLocation.file}:${error.sourceLocation.line}:${error.sourceLocation.approximate ? "approximate" : "exact"}`
    : "unknown";
  return `${error.message}|${location}`;
}
