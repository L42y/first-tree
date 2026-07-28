#!/usr/bin/env node

import { parseArgs, readJson, validateDecisionPacket } from "./lib.mjs";

try {
  const args = parseArgs(process.argv.slice(2), ["bundle", "output"]);
  const validated = validateDecisionPacket(readJson(args.bundle), readJson(args.output));
  process.stdout.write(`${JSON.stringify(validated.packet, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
