#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  assert,
  assertLockOwned,
  INPUT_SCHEMA,
  parseArgs,
  readJson,
  releaseLock,
  removeRunDir,
  requireAbsolute,
} from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
assert(args.analysis_input, "Required: --analysis-input <analysis-input.json>");
const inputPath = requireAbsolute(args.analysis_input, "--analysis-input");
const input = readJson(inputPath);
assert(input.schema === INPUT_SCHEMA, `unsupported analysis input schema: ${input.schema}`);
assert(path.dirname(inputPath) === input.run_dir, "analysis input must live at the run root");
assertLockOwned(input.lock_path, input.run_id);
removeRunDir(input.run_dir, input.temp_root);
releaseLock(input.lock_path, input.run_id);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    run_id: input.run_id,
    raw_projection_removed: !fs.existsSync(input.run_dir),
    state_advanced: false,
  })}\n`,
);
