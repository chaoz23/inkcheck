import { parentPort, workerData, type MessagePort } from "worker_threads";
import {
  createPortfolioPassEngine,
  type ExploreOptions,
  type ExploreProgress,
  type ExploreResult,
  type PassTelemetry,
  type PortfolioPassKind,
} from "./explore";
import type { KnotInfo } from "./inklecate";

export interface AdaptivePassAssignment {
  index: number;
  pass: PortfolioPassKind;
}

export interface AdaptivePortfolioWorkerData {
  assignments: AdaptivePassAssignment[];
  storyJson: string;
  knots: KnotInfo[];
  externals: string[];
  options: ExploreOptions;
  memoryCapBytes: number;
  deadlineMs?: number;
  failPassForTest?: PortfolioPassKind;
  control: SharedArrayBuffer;
  port: MessagePort;
}

export interface AdaptiveRoundPassResult {
  index: number;
  label: string;
  granted: number;
  consumed: number;
  snapshot: ExploreResult;
  done: boolean;
  exhaustive: boolean;
  memoryStopped: boolean;
  timeStopped: boolean;
}

export interface AdaptiveFinalPassResult {
  index: number;
  result: ExploreResult;
  telemetry: PassTelemetry;
}

export type AdaptivePortfolioWorkerCommand =
  | { type: "run"; round: number; grants: Array<{ index: number; grant: number }> }
  | { type: "finalize" };

export type AdaptivePortfolioWorkerMessage =
  | { type: "ready" }
  | { type: "progress"; index: number; progress: ExploreProgress }
  | { type: "round"; round: number; results: AdaptiveRoundPassResult[] }
  | { type: "final"; results: AdaptiveFinalPassResult[] }
  | { type: "error"; error: string; pass?: PortfolioPassKind };

const data = workerData as AdaptivePortfolioWorkerData;
const control = new Int32Array(data.control);
const port = data.port;
const engines = new Map<number, ReturnType<typeof createPortfolioPassEngine>>();

function signal(message: AdaptivePortfolioWorkerMessage): void {
  port.postMessage(message);
  Atomics.add(control, 0, 1);
  Atomics.notify(control, 0);
}

try {
  for (const assignment of data.assignments) {
    const options: ExploreOptions = {
      ...data.options,
      memoryGuard: () => process.memoryUsage().heapUsed < data.memoryCapBytes,
      ...(data.deadlineMs === undefined ? {} : { timeGuard: () => Date.now() < data.deadlineMs! }),
      onProgress: (progress) => signal({ type: "progress", index: assignment.index, progress }),
    };
    engines.set(
      assignment.index,
      createPortfolioPassEngine(assignment.pass, data.storyJson, data.knots, data.externals, options)
    );
  }
  signal({ type: "ready" });
} catch (error) {
  signal({ type: "error", error: error instanceof Error ? error.message : String(error) });
}

parentPort?.on("message", (command: AdaptivePortfolioWorkerCommand) => {
  try {
    if (command.type === "run") {
      const results: AdaptiveRoundPassResult[] = [];
      for (const request of command.grants) {
        const assignment = data.assignments.find((item) => item.index === request.index);
        const engine = engines.get(request.index);
        if (!assignment || !engine) throw new Error(`worker does not own portfolio pass ${request.index}`);
        if (data.failPassForTest === assignment.pass) {
          throw new Error(`injected worker failure for ${assignment.pass}`);
        }
        const consumed = request.grant > 0 ? engine.run(request.grant) : 0;
        results.push({
          index: request.index,
          label: engine.label,
          granted: request.grant,
          consumed,
          snapshot: engine.snapshot(),
          done: engine.done(),
          exhaustive: engine.exhaustive(),
          memoryStopped: engine.stoppedForMemory(),
          timeStopped: engine.stoppedForTime(),
        });
      }
      signal({ type: "round", round: command.round, results });
      return;
    }
    const results = data.assignments.map((assignment) => {
      const engine = engines.get(assignment.index);
      if (!engine) throw new Error(`worker does not own portfolio pass ${assignment.index}`);
      return { index: assignment.index, result: engine.finalize(), telemetry: engine.telemetry() };
    });
    signal({ type: "final", results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pass = data.assignments.find((assignment) => message.includes(assignment.pass))?.pass;
    signal({ type: "error", error: message.slice(0, 512), ...(pass ? { pass } : {}) });
  }
});
