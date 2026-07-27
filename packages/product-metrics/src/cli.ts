#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadActivityCsv, loadJourneyCsv, loadVisitCsv } from "./io.js";
import { generateProductMetricReport } from "./metrics.js";
import type { VisitorIdentityBridge } from "./types.js";

function usage(): string {
  return [
    "Usage: first-tree-product-metrics \\",
    "  --journeys <user-journeys.csv> --activity <daily-activity.csv> \\",
    "  --as-of <ISO timestamp> [--time-zone Asia/Taipei] \\",
    "  [--visits <visitor-visits.csv>] [--visitor-identity-bridge available|unavailable] \\",
    "  [--output <report.json>]",
  ].join("\n");
}

function bridge(value: string | undefined): VisitorIdentityBridge {
  if (value === undefined || value === "unavailable") return "unavailable";
  if (value === "available") return value;
  throw new Error("--visitor-identity-bridge must be available or unavailable");
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      journeys: { type: "string" },
      activity: { type: "string" },
      visits: { type: "string" },
      "as-of": { type: "string" },
      "time-zone": { type: "string", default: "Asia/Taipei" },
      "visitor-identity-bridge": { type: "string", default: "unavailable" },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const journeyPath = parsed.values.journeys;
  const activityPath = parsed.values.activity;
  const asOf = parsed.values["as-of"];
  if (!journeyPath || !activityPath || !asOf) {
    throw new Error(`--journeys, --activity, and --as-of are required\n\n${usage()}`);
  }

  const [journeys, activity, visits] = await Promise.all([
    loadJourneyCsv(journeyPath),
    loadActivityCsv(activityPath),
    parsed.values.visits ? loadVisitCsv(parsed.values.visits) : Promise.resolve([]),
  ]);
  const report = generateProductMetricReport({
    version: 1,
    asOf,
    timeZone: parsed.values["time-zone"] ?? "Asia/Taipei",
    visitorData: parsed.values.visits ? "available" : "unavailable",
    visitorIdentityBridge: bridge(parsed.values["visitor-identity-bridge"]),
    journeys,
    activity,
    visits,
  });
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (parsed.values.output) {
    await writeFile(parsed.values.output, rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`product-metrics: ${message}\n`);
  process.exitCode = 1;
});
