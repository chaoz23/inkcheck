import * as v8 from "v8";

export interface ResourceGuardOptions {
  maxMemoryMb?: number;
  maxTimeMs?: number;
  startedAtMs?: number;
  /** Heap headroom retained for constructing and flushing the final report. */
  finalizationMemoryReserveMb?: number;
  /** Time retained for constructing and flushing the final report. */
  finalizationTimeReserveMs?: number;
}

export interface ResourceGuards {
  memoryCapBytes: number;
  memorySearchLimitBytes: number;
  deadlineMs?: number;
  memoryGuard: () => boolean;
  timeGuard?: () => boolean;
  peakMemoryBytes: () => number;
}

/**
 * Process-scoped memory observed from Node. These values are environmental
 * facts, not deterministic search state or an ownership accounting model.
 */
export interface ProcessMemoryObservationV1 {
  schemaVersion: 1;
  scope: "process";
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  /** Deterministic logical estimate used only for the adjacent comparison. */
  comparedLogicalAccountedBytes: number;
  /** heapUsed minus the logical estimate; observational, not owner attribution. */
  unattributedBytes: number;
}

export function observeProcessMemory(accountedLogicalBytes = 0): ProcessMemoryObservationV1 {
  const usage = process.memoryUsage();
  const comparedLogicalAccountedBytes = Math.max(0, accountedLogicalBytes);
  return {
    schemaVersion: 1,
    scope: "process",
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    rssBytes: usage.rss,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers ?? 0,
    comparedLogicalAccountedBytes,
    unattributedBytes: usage.heapUsed - comparedLogicalAccountedBytes,
  };
}

/** Build the same pre-OOM and wall-clock guards for every execution surface. */
export function createResourceGuards(options: ResourceGuardOptions = {}): ResourceGuards {
  const memoryCapBytes = options.maxMemoryMb === undefined
    ? Math.floor(v8.getHeapStatistics().heap_size_limit * 0.85)
    : options.maxMemoryMb * 1024 * 1024;
  const requestedMemoryReserveBytes = (options.finalizationMemoryReserveMb ?? 0) * 1024 * 1024;
  const memoryReserveBytes = Math.min(
    Math.max(0, requestedMemoryReserveBytes),
    Math.max(0, memoryCapBytes - 1)
  );
  const memorySearchLimitBytes = memoryCapBytes - memoryReserveBytes;
  const timeReserveMs = Math.max(0, options.finalizationTimeReserveMs ?? 0);
  const deadlineMs = options.maxTimeMs === undefined
    ? undefined
    : (options.startedAtMs ?? Date.now()) + Math.max(0, options.maxTimeMs - timeReserveMs);
  let peakMemoryBytes = process.memoryUsage().heapUsed;
  const sampleMemory = (): number => {
    const current = process.memoryUsage().heapUsed;
    peakMemoryBytes = Math.max(peakMemoryBytes, current);
    return current;
  };
  return {
    memoryCapBytes,
    memorySearchLimitBytes,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    memoryGuard: () => sampleMemory() < memorySearchLimitBytes,
    ...(deadlineMs === undefined ? {} : { timeGuard: () => Date.now() < deadlineMs }),
    peakMemoryBytes: () => {
      sampleMemory();
      return peakMemoryBytes;
    },
  };
}
