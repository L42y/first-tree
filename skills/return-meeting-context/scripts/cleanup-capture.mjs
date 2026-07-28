#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { assert, ensureDedicatedTempDir, parseArgs, readJson, requireAbsolute, within } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
assert(args.capture, "Required: --capture <capture.json>");
const capturePath = fs.realpathSync(requireAbsolute(args.capture, "--capture"));
const capture = readJson(capturePath);
const root = fs.realpathSync(requireAbsolute(capture.ephemeral_root, "capture.ephemeral_root"));
const allowedBase = ensureDedicatedTempDir("return-meeting-context-capture");
assert(
  within(allowedBase, root) && path.basename(root).startsWith("capture-"),
  "refusing to remove a non-ephemeral capture root",
);
assert(within(root, capturePath), "capture manifest is outside its ephemeral root");
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    capture_root_removed: !fs.existsSync(root),
  })}\n`,
);
