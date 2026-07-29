import { appendFileSync, close, constants, open, watch } from "node:fs";
import { basename, dirname } from "node:path";

import { isProtectedPathMutation } from "./raw-access-monitor-lib.mjs";

const [sentinelPath, workspacePath, eventsPath, locator] = process.argv.slice(2);
if (!sentinelPath || !workspacePath || !eventsPath || !locator) {
  throw new Error("Usage: raw-access-monitor.mjs <sentinel-path> <workspace-path> <events-path> <locator>");
}

function record(type) {
  appendFileSync(
    eventsPath,
    `${JSON.stringify({
      locator,
      timestamp: new Date().toISOString(),
      type,
    })}\n`,
    "utf8",
  );
}

const watchTargets = [];
let protectedPath = sentinelPath;
while (true) {
  watchTargets.push({ directory: dirname(protectedPath), protectedName: basename(protectedPath) });
  if (protectedPath === workspacePath) break;
  const parent = dirname(protectedPath);
  if (parent === protectedPath) {
    throw new Error(`Sentinel path is outside the workspace boundary: ${sentinelPath}`);
  }
  protectedPath = parent;
}
const watchers = [];
for (const { directory, protectedName } of watchTargets) {
  const watcher = watch(directory, (eventType, filename) => {
    if (isProtectedPathMutation(eventType, filename, protectedName)) {
      record("partial_raw_path_mutation");
    }
  });
  watchers.push(watcher);
  watcher.on("error", () => {
    record("partial_raw_monitor_error");
    for (const candidate of watchers) candidate.close();
    process.exit(1);
  });
}

process.send?.({ locator, type: "partial_raw_monitor_ready" });

function waitForReader() {
  open(sentinelPath, constants.O_WRONLY, (error, descriptor) => {
    if (error !== null) {
      record("partial_raw_path_mutation");
      setTimeout(waitForReader, 25);
      return;
    }
    record("partial_raw_access_attempt");
    close(descriptor, () => setTimeout(waitForReader, 25));
  });
}

waitForReader();
