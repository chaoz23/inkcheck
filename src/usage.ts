import * as fs from "fs";
import * as path from "path";
import { createHmac } from "crypto";

export type BrowserUsageEvent = "page_view" | "support_click";
export type UsageEvent = BrowserUsageEvent | "check_complete" | "check_rejected" | "check_limit_hit";

export interface DailyUsage {
  pageViews: number;
  externalPageViews: number;
  internalPageViews: number;
  browserTaggedPageViews: number;
  externalBrowserTaggedPageViews: number;
  internalBrowserTaggedPageViews: number;
  externalBrowserSketch: string;
  internalBrowserSketch: string;
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
  /** A browser-local random value, folded into one bit of today's sketch. */
  browserToken?: string;
  internal?: boolean;
}

export interface UsageRecorder {
  record(event: UsageEvent, details?: UsageDetails, now?: Date): void;
}

const EMPTY_DAY: DailyUsage = {
  pageViews: 0,
  externalPageViews: 0,
  internalPageViews: 0,
  browserTaggedPageViews: 0,
  externalBrowserTaggedPageViews: 0,
  internalBrowserTaggedPageViews: 0,
  externalBrowserSketch: "",
  internalBrowserSketch: "",
  supportClicks: 0,
  checksCompleted: 0,
  checksRejected: 0,
  checkLimitHits: 0,
  totalCheckDurationMs: 0,
};

const SKETCH_BITS = 2048;
const SKETCH_BYTES = SKETCH_BITS / 8;

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
    candidate.externalPageViews ??= 0;
    candidate.internalPageViews ??= 0;
    candidate.browserTaggedPageViews ??= 0;
    candidate.externalBrowserTaggedPageViews ??= candidate.internalPageViews > 0 && candidate.externalPageViews === 0
      ? 0
      : candidate.browserTaggedPageViews;
    candidate.internalBrowserTaggedPageViews ??= candidate.internalPageViews > 0 && candidate.externalPageViews === 0
      ? candidate.browserTaggedPageViews
      : 0;
    candidate.externalBrowserSketch ??= "";
    candidate.internalBrowserSketch ??= "";
    if (
      ![
        candidate.externalPageViews,
        candidate.internalPageViews,
        candidate.browserTaggedPageViews,
        candidate.externalBrowserTaggedPageViews,
        candidate.internalBrowserTaggedPageViews,
      ].every(isNonNegativeInteger) ||
      ![candidate.externalBrowserSketch, candidate.internalBrowserSketch].every((sketch) =>
        typeof sketch === "string" && (sketch === "" || Buffer.from(sketch, "base64").length === SKETCH_BYTES)
      )
    ) {
      throw new Error("Usage data contains an invalid browser estimate");
    }
  }
  return value as UsageData;
}

function sketchBytes(value: string): Buffer {
  if (!value) return Buffer.alloc(SKETCH_BYTES);
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== SKETCH_BYTES) throw new Error("Usage data contains an invalid browser estimate");
  return decoded;
}

function markSketch(value: string, fingerprint: Buffer): string {
  const sketch = sketchBytes(value);
  const index = fingerprint.readUInt16BE(0) % SKETCH_BITS;
  sketch[Math.floor(index / 8)] |= 1 << (index % 8);
  return sketch.toString("base64");
}

function mergeSketch(left: string, right: string): string {
  const merged = sketchBytes(left);
  const incoming = sketchBytes(right);
  for (let index = 0; index < SKETCH_BYTES; index += 1) merged[index] |= incoming[index];
  return merged.toString("base64");
}

function estimateSketch(value: string): number | undefined {
  if (!value) return undefined;
  const sketch = sketchBytes(value);
  let setBits = 0;
  for (const byte of sketch) {
    for (let bit = 0; bit < 8; bit += 1) setBits += (byte >> bit) & 1;
  }
  const empty = SKETCH_BITS - setBits;
  if (empty === SKETCH_BITS) return 0;
  if (empty === 0) return undefined;
  return Math.round(-SKETCH_BITS * Math.log(empty / SKETCH_BITS));
}

export class FileUsageStore implements UsageRecorder {
  private readonly browserKey?: string;
  private readonly retentionDays: number;

  constructor(
    private readonly file: string,
    browserKeyOrRetention?: string | number,
    retentionDays = 400
  ) {
    this.browserKey = typeof browserKeyOrRetention === "string" ? browserKeyOrRetention : undefined;
    this.retentionDays = typeof browserKeyOrRetention === "number" ? browserKeyOrRetention : retentionDays;
  }

  record(event: UsageEvent, details: UsageDetails = {}, now = new Date()): void {
    const data = readUsageData(this.file);
    const date = now.toISOString().slice(0, 10);
    const day = data.days[date] ?? { ...EMPTY_DAY };
    if (event === "page_view") {
      day.pageViews++;
      if (details.internal) day.internalPageViews++;
      else day.externalPageViews++;
      if (details.browserToken && this.browserKey) {
        // The same browser can be counted once within a calendar month, but the
        // digest intentionally changes next month so this cannot become a long-lived profile.
        const fingerprint = createHmac("sha256", this.browserKey)
          .update(`${date.slice(0, 7)}:${details.browserToken}`)
          .digest();
        if (details.internal) day.internalBrowserSketch = markSketch(day.internalBrowserSketch, fingerprint);
        else day.externalBrowserSketch = markSketch(day.externalBrowserSketch, fingerprint);
        day.browserTaggedPageViews++;
        if (details.internal) day.internalBrowserTaggedPageViews++;
        else day.externalBrowserTaggedPageViews++;
      }
    }
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
    externalPageViews: sum.externalPageViews + day.externalPageViews,
    internalPageViews: sum.internalPageViews + day.internalPageViews,
    browserTaggedPageViews: sum.browserTaggedPageViews + day.browserTaggedPageViews,
    externalBrowserTaggedPageViews: sum.externalBrowserTaggedPageViews + day.externalBrowserTaggedPageViews,
    internalBrowserTaggedPageViews: sum.internalBrowserTaggedPageViews + day.internalBrowserTaggedPageViews,
    externalBrowserSketch: "",
    internalBrowserSketch: "",
    supportClicks: sum.supportClicks + day.supportClicks,
    checksCompleted: sum.checksCompleted + day.checksCompleted,
    checksRejected: sum.checksRejected + day.checksRejected,
    checkLimitHits: sum.checkLimitHits + day.checkLimitHits,
    totalCheckDurationMs: sum.totalCheckDurationMs + day.totalCheckDurationMs,
  }), { ...EMPTY_DAY });
  const sketchesByMonth = new Map<string, { external: string; internal: string }>();
  for (const [date, day] of included) {
    const month = date.slice(0, 7);
    const current = sketchesByMonth.get(month) ?? { external: "", internal: "" };
    current.external = mergeSketch(current.external, day.externalBrowserSketch);
    current.internal = mergeSketch(current.internal, day.internalBrowserSketch);
    sketchesByMonth.set(month, current);
  }
  const externalEstimate = [...sketchesByMonth.values()].reduce((sum, sketch) => sum + (estimateSketch(sketch.external) ?? 0), 0);
  const internalEstimate = [...sketchesByMonth.values()].reduce((sum, sketch) => sum + (estimateSketch(sketch.internal) ?? 0), 0);
  const conversion = total.pageViews > 0
    ? `${((total.checksCompleted / total.pageViews) * 100).toFixed(1)}%`
    : "n/a";
  const average = total.checksCompleted > 0
    ? `${Math.round(total.totalCheckDurationMs / total.checksCompleted)} ms`
    : "n/a";
  return [
    `Inkcheck usage — ${included[0][0]} through ${included[included.length - 1][0]} (UTC)`,
    `Page visits: ${total.pageViews}`,
    `External page visits: ${total.externalPageViews}`,
    `Internal page visits: ${total.internalPageViews}`,
    `Estimated external unique browsers: ${externalEstimate} (calendar-month estimate; ${total.externalBrowserTaggedPageViews} tagged visits)`,
    `Estimated internal unique browsers: ${internalEstimate} (calendar-month estimate; ${total.internalBrowserTaggedPageViews} tagged visits)`,
    `Checks completed: ${total.checksCompleted}`,
    `Checks rejected: ${total.checksRejected}`,
    `Hosted limit hits: ${total.checkLimitHits}`,
    `Support-link clicks: ${total.supportClicks}`,
    `Visit-to-check conversion: ${conversion}`,
    `Average completed-check time: ${average}`,
  ].join("\n");
}
