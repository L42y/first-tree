import { appendFileSync, closeSync, openSync } from "node:fs";

const [sentinelPath, eventsPath, locator] = process.argv.slice(2);
if (!sentinelPath || !eventsPath || !locator) {
  throw new Error("Usage: raw-access-monitor.mjs <sentinel-path> <events-path> <locator>");
}

const pauseState = new Int32Array(new SharedArrayBuffer(4));

while (true) {
  const descriptor = openSync(sentinelPath, "w");
  appendFileSync(
    eventsPath,
    `${JSON.stringify({
      locator,
      timestamp: new Date().toISOString(),
      type: "partial_raw_access_attempt",
    })}\n`,
    "utf8",
  );
  closeSync(descriptor);
  Atomics.wait(pauseState, 0, 0, 25);
}
