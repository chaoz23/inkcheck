export type HumanProgressPhase = "compile" | "source_scan" | "explore" | "min_repro" | "report";

export interface HumanProgressEvent {
  type: "run_start" | "phase_start" | "progress" | "discovery" | "phase_end" | "run_end";
  phase?: HumanProgressPhase;
  pass?: string;
  elapsedMs: number;
  statesExplored: number;
  stateBudget: number;
  endingsFound?: number;
  runtimeErrorsFound?: number;
  unvisitedKnots?: number;
  knotsVisited?: number;
  assertionViolations?: number;
  discoveries?: {
    endings: number;
    runtimeErrors: number;
    knotsVisited: number;
    visibleOutcomes: number;
    assertionViolations: number;
    goalsReached: number;
    stagesReached: number;
  };
  exhaustive?: boolean;
}

export interface TerminalWriter {
  isTTY?: boolean;
  columns?: number;
  write(text: string): void;
}

const PHASE_LABEL: Record<HumanProgressPhase, string> = {
  compile: "Compiling story",
  source_scan: "Scanning structure",
  explore: "Exploring choices",
  min_repro: "Shortening repro paths",
  report: "Building report",
};

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 3))}...`;
}

export class HumanProgressRenderer {
  private rendered = false;
  private lastRenderedAt = 0;
  private lastStates = 0;
  private lastStateAt = 0;
  private rate = 0;

  constructor(private readonly writer: TerminalWriter, private readonly mode: "auto" | "human") {}

  handle(event: HumanProgressEvent): void {
    if (event.type === "run_start") return;
    if (event.type === "run_end") {
      this.finish();
      return;
    }
    const now = Date.now();
    if (event.type === "progress" || event.type === "discovery") {
      if (this.lastStateAt && now > this.lastStateAt && event.statesExplored > this.lastStates) {
        const instant = (event.statesExplored - this.lastStates) / ((now - this.lastStateAt) / 1000);
        this.rate = this.rate ? this.rate * 0.7 + instant * 0.3 : instant;
      }
      this.lastStates = event.statesExplored;
      this.lastStateAt = now;
      if (event.type === "progress" && now - this.lastRenderedAt < 700) return;
    }
    this.lastRenderedAt = now;
    this.render(event);
  }

  finish(): void {
    if (!this.rendered) return;
    if (this.mode === "auto" && this.writer.isTTY) this.writer.write("\n");
    this.rendered = false;
  }

  private render(event: HumanProgressEvent): void {
    const width = Math.max(44, this.writer.columns ?? 100);
    const label = event.phase ? PHASE_LABEL[event.phase] : "Working";
    let line: string;
    if (event.type === "discovery" && event.discoveries) {
      const found = [
        event.discoveries.runtimeErrors ? `+${event.discoveries.runtimeErrors} error${event.discoveries.runtimeErrors === 1 ? "" : "s"}` : "",
        event.discoveries.assertionViolations ? `+${event.discoveries.assertionViolations} rule failure${event.discoveries.assertionViolations === 1 ? "" : "s"}` : "",
        event.discoveries.endings ? `+${event.discoveries.endings} ending${event.discoveries.endings === 1 ? "" : "s"}` : "",
        event.discoveries.knotsVisited ? `+${event.discoveries.knotsVisited} knot${event.discoveries.knotsVisited === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      line = `Found ${found || "new story evidence"} at ${event.statesExplored.toLocaleString()} work states  |  ${duration(event.elapsedMs)} elapsed`;
    } else if (event.phase === "explore" || event.phase === "min_repro" || event.type === "progress") {
      const percent = event.stateBudget ? Math.floor((event.statesExplored / event.stateBudget) * 100) : 0;
      const throughput = this.rate >= 1 ? `  ${Math.round(this.rate).toLocaleString()} states/s` : "";
      const remaining = this.rate >= 10 && event.statesExplored < event.stateBudget
        ? `  ~${duration(((event.stateBudget - event.statesExplored) / this.rate) * 1000)} to budget`
        : "";
      const discoveries = [
        `${event.endingsFound ?? 0} endings`,
        `${event.runtimeErrorsFound ?? 0} errors`,
        event.unvisitedKnots === undefined ? "" : `${event.unvisitedKnots} knots unvisited`,
      ].filter(Boolean).join(", ");
      const coreLabel = width < 70 ? "Explore" : label;
      const pass = event.pass && width >= 96 ? ` (${event.pass})` : "";
      const core = `${coreLabel}${pass}: ${event.statesExplored.toLocaleString()} / ${event.stateBudget.toLocaleString()} work states (${percent}% budget)`;
      line = width < 70
        ? core
        : `${core}${throughput}${remaining}  |  ${discoveries}  |  ${duration(event.elapsedMs)} elapsed`;
    } else {
      line = `${label}  |  ${duration(event.elapsedMs)} elapsed`;
    }
    line = truncate(line, width);
    if (this.mode === "auto" && this.writer.isTTY) {
      this.writer.write(`\r\x1b[2K${line}`);
    } else {
      this.writer.write(`${line}\n`);
    }
    this.rendered = true;
  }
}
