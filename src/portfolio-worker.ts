import { parentPort, workerData, type MessagePort } from "worker_threads";
import {
  explore,
  exploreBeam,
  exploreRandom,
  type ExploreOptions,
  type ExploreProgress,
  type ExploreResult,
} from "./explore";
import type { KnotInfo } from "./inklecate";

export type PortfolioPassKind = "dfs:last" | "dfs:first" | "dfs:inside-out" | "beam:diversity" | "random";

export interface PortfolioWorkerData {
  pass: PortfolioPassKind;
  storyJson: string;
  knots: KnotInfo[];
  externals: string[];
  options: ExploreOptions;
  memoryCapBytes: number;
  deadlineMs?: number;
  failForTest?: boolean;
  control: SharedArrayBuffer;
  port: MessagePort;
}

export type PortfolioWorkerMessage =
  | { type: "progress"; progress: ExploreProgress }
  | { type: "result"; ok: true; result: ExploreResult }
  | { type: "result"; ok: false; error: string };

function run(data: PortfolioWorkerData): ExploreResult {
  if (data.failForTest) throw new Error(`injected worker failure for ${data.pass}`);
  const deadlineMs = data.deadlineMs;
  const options: ExploreOptions = {
    ...data.options,
    onProgress: (progress) => data.port.postMessage({ type: "progress", progress } satisfies PortfolioWorkerMessage),
    memoryGuard: () => process.memoryUsage().heapUsed < data.memoryCapBytes,
    ...(deadlineMs === undefined ? {} : { timeGuard: () => Date.now() < deadlineMs }),
  };
  if (data.pass === "beam:diversity") return exploreBeam(data.storyJson, data.knots, data.externals, options);
  if (data.pass === "random") return exploreRandom(data.storyJson, data.knots, data.externals, options);
  const priority = data.pass.slice("dfs:".length) as NonNullable<ExploreOptions["dfsChoicePriority"]>;
  return explore(data.storyJson, data.knots, data.externals, {
    ...options,
    strategy: "dfs",
    dfsChoicePriority: priority,
  });
}

const data = workerData as PortfolioWorkerData;
const control = new Int32Array(data.control);
let message: PortfolioWorkerMessage;
try {
  message = { type: "result", ok: true, result: run(data) };
} catch (error) {
  message = { type: "result", ok: false, error: error instanceof Error ? error.message : String(error) };
}
data.port.postMessage(message);
Atomics.store(control, 0, 1);
Atomics.notify(control, 0);
data.port.close();
parentPort?.close();
