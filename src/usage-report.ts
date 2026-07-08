#!/usr/bin/env node
import { loadUsageData, renderUsageReport } from "./usage";

function reportDays(args: string[]): number {
  if (args.length === 0) return 7;
  if (args.length !== 2 || args[0] !== "--days") {
    throw new Error("usage: node dist/usage-report.js [--days 1-400]");
  }
  const value = Number(args[1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 400) {
    throw new Error("--days must be an integer from 1 to 400");
  }
  return value;
}

try {
  const file = process.env.INKCHECK_WEB_USAGE_FILE;
  if (!file) throw new Error("INKCHECK_WEB_USAGE_FILE is not configured");
  console.log(renderUsageReport(loadUsageData(file), reportDays(process.argv.slice(2))));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not read usage data");
  process.exitCode = 1;
}
