import { appendFileSync, close, open, watch } from "node:fs";
import { basename, dirname } from "node:path";

const [sentinelPath, eventsPath, locator] = process.argv.slice(2);
if (!sentinelPath || !eventsPath || !locator) {
  throw new Error("Usage: raw-access-monitor.mjs <sentinel-path> <events-path> <locator>");
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

const sentinelName = basename(sentinelPath);
const watcher = watch(dirname(sentinelPath), (eventType, filename) => {
  if (eventType === "rename" && filename?.toString() === sentinelName) {
    record("partial_raw_path_mutation");
  }
});
watcher.on("error", () => {
  record("partial_raw_monitor_error");
  watcher.close();
  process.exit(1);
});

process.send?.({ locator, type: "partial_raw_monitor_ready" });

function waitForReader() {
  open(sentinelPath, "w", (error, descriptor) => {
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
