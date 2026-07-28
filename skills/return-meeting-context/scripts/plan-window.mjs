#!/usr/bin/env node
import path from "node:path";
import {
  assert,
  CONFIG_SCHEMA,
  ensurePrivateStateDir,
  normalizeIso,
  parseArgs,
  readJson,
  readState,
  requireAbsolute,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
assert(args.config && args.end, "Required: --config <file> --end <ISO>");
const config = readJson(requireAbsolute(args.config, "--config"));
assert(config.schema === CONFIG_SCHEMA, `unsupported config schema: ${config.schema}`);
const stateDir = ensurePrivateStateDir(config.state_dir);
const state = readState(path.join(stateDir, "state.json"));
const end = normalizeIso(args.end, "--end");
const watermark = state.watermarks[`${config.provider}:${config.profile}`]?.value;
const startValue = watermark?.calendar_end ?? config.discovery?.bootstrap_start;
assert(startValue, "no prior watermark and config.discovery.bootstrap_start is missing");
const overlapSeconds = Number(config.discovery?.overlap_seconds ?? 300);
assert(
  Number.isInteger(overlapSeconds) && overlapSeconds >= 0 && overlapSeconds <= 86400,
  "config.discovery.overlap_seconds must be an integer from 0 to 86400",
);
const startDate = new Date(normalizeIso(startValue, "discovery start"));
const start = new Date(startDate.getTime() - overlapSeconds * 1000).toISOString();
assert(start < end, "planned discovery start must be earlier than end");
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    start,
    end,
    source: watermark?.calendar_end ? "watermark" : "bootstrap",
    overlap_seconds: overlapSeconds,
  })}\n`,
);
