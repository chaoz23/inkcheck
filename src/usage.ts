import * as fs from "fs";
import * as path from "path";

export type BrowserUsageEvent = "page_view" | "support_click";
export type UsageEvent = BrowserUsageEvent | "check_complete" | "check_rejected" | "check_limit_hit";

export interface DailyUsage {
  pageViews: number;
  supportClicks: number;
  checksCompleted: number;
  checksRejected: number;
  checkLimitHits: number;
  totalCheckDurationMs: number;
}

export interface UsageData {
  version: 1;
  days: Record<string, DailyUsage>;
}

export interface UsageDetails {
  durationMs?: number;
}

export interface UsageRecorder {
  record(event: UsageEvent, details?: UsageDetails, now?: Date): void;
}

const EMPTY_DAY: DailyUsage = {
  pageViews: 0,
  supportClicks: 0,
  checksCompleted: 0,
  checksRejected: 0,
  checkLimitHits: 0,
  totalCheckDurationMs: 0,
};

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function readUsageData(file: string): UsageData {
  if (!fs.existsSync(file)) return { version: 1, days: {} };
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<UsageData>;
  if (value.version !== 1 || !value.days || typeof value.days !== "object") {
    throw new Error("Usage data has an unsupported format");
  }
  for (const [date, day] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day || typeof day !== "object") {
      throw new Error("Usage data contains an invalid day");
    }
    const candidate = day as Partial<DailyUsage>;
    if (!Object.values({
      pageViews: candidate.pageViews,
      supportClicks: candidate.supportClicks,
      checksCompleted: candidate.checksCompleted,
      checksRejected: candidate.checksRejected,
      checkLimitHits: candidate.checkLimitHits ?? 0,
      totalCheckDurationMs: candidate.totalCheckDurationMs,
    }).every(isNonNegativeInteger)) {
      throw new Error("Usage data contains an invalid counter");
    }
    if (candidate.checkLimitHits === undefined) {
      candidate.checkLimitHits = 0;
    }
  }
  return value as UsageData;
}

export class FileUsageStore implements UsageRecorder {
  constructor(
    private readonly file: string,
    private readonly retentionDays = 400
  ) {}

  record(event: UsageEvent, details: UsageDetails = {}, now = new Date()): void {
    const data = readUsageData(this.file);
    const date = now.toISOString().slice(0, 10);
    const day = data.days[date] ?? { ...EMPTY_DAY };
    if (event === "page_view") day.pageViews++;
    else if (event === "support_click") day.supportClicks++;
    else if (event === "check_complete") {
      day.checksCompleted++;
      day.totalCheckDurationMs += Math.max(0, Math.round(details.durationMs ?? 0));
    } else if (event === "check_limit_hit") day.checkLimitHits++;
    else day.checksRejected++;
    data.days[date] = day;

    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - this.retentionDays);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    for (const storedDate of Object.keys(data.days)) {
      if (storedDate < cutoffDate) delete data.days[storedDate];
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(data)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

export function loadUsageData(file: string): UsageData {
  return readUsageData(file);
}

export function renderUsageReport(data: UsageData, days = 7, now = new Date()): string {
  if (!Number.isSafeInteger(days) || days < 1 || days > 400) {
    throw new Error("Report days must be an integer from 1 to 400");
  }
  const included: Array<[string, DailyUsage]> = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(now);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    included.push([key, data.days[key] ?? { ...EMPTY_DAY }]);
  }
  const total = included.reduce<DailyUsage>((sum, [, day]) => ({
    pageViews: sum.pageViews + day.pageViews,
    supportClicks: sum.supportClicks + day.supportClicks,
    checksCompleted: sum.checksCompleted + day.checksCompleted,
    checksRejected: sum.checksRejected + day.checksRejected,
    checkLimitHits: sum.checkLimitHits + day.checkLimitHits,
    totalCheckDurationMs: sum.totalCheckDurationMs + day.totalCheckDurationMs,
  }), { ...EMPTY_DAY });
  const conversion = total.pageViews > 0
    ? `${((total.checksCompleted / total.pageViews) * 100).toFixed(1)}%`
    : "n/a";
  const average = total.checksCompleted > 0
    ? `${Math.round(total.totalCheckDurationMs / total.checksCompleted)} ms`
    : "n/a";
  return [
    `Inkcheck usage — ${included[0][0]} through ${included[included.length - 1][0]} (UTC)`,
    `Page visits: ${total.pageViews}`,
    `Checks completed: ${total.checksCompleted}`,
    `Checks rejected: ${total.checksRejected}`,
    `Hosted limit hits: ${total.checkLimitHits}`,
    `Support-link clicks: ${total.supportClicks}`,
    `Visit-to-check conversion: ${conversion}`,
    `Average completed-check time: ${average}`,
  ].join("\n");
}
