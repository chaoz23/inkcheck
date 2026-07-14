import * as v8 from "v8";

export interface ResourceGuardOptions {
  maxMemoryMb?: number;
  maxTimeMs?: number;
  startedAtMs?: number;
}

export interface ResourceGuards {
  memoryCapBytes: number;
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
  const deadlineMs = options.maxTimeMs === undefined
    ? undefined
    : (options.startedAtMs ?? Date.now()) + options.maxTimeMs;
  let peakMemoryBytes = process.memoryUsage().heapUsed;
  const sampleMemory = (): number => {
    const current = process.memoryUsage().heapUsed;
    peakMemoryBytes = Math.max(peakMemoryBytes, current);
    return current;
  };
  return {
    memoryCapBytes,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    memoryGuard: () => sampleMemory() < memoryCapBytes,
    ...(deadlineMs === undefined ? {} : { timeGuard: () => Date.now() < deadlineMs }),
    peakMemoryBytes: () => {
      sampleMemory();
      return peakMemoryBytes;
    },
  };
}
