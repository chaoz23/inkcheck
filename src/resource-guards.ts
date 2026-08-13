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
