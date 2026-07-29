import { createInterface } from "node:readline";
import {
  acquireDaemonRuntimeOwnership,
  type DaemonRuntimeMode,
  isDaemonRuntimeOwnershipError,
} from "../../core/daemon-runtime-ownership.js";

const [home, modeArg] = process.argv.slice(2);
const mode: DaemonRuntimeMode = modeArg === "service" ? "service" : "foreground";

if (!home) {
  process.stderr.write("missing home\n");
  process.exit(3);
}

const lines = createInterface({ input: process.stdin });
process.stdout.write(`${JSON.stringify({ event: "ready", pid: process.pid })}\n`);

lines.once("line", () => {
  try {
    const lease = acquireDaemonRuntimeOwnership({
      channel: "dev",
      mode,
      version: "test-child",
      home,
    });
    process.stdout.write(`${JSON.stringify({ event: "acquired", pid: process.pid, mode })}\n`);
    lines.once("line", () => {
      lease.release();
      process.exit(0);
    });
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        event: isDaemonRuntimeOwnershipError(error) ? "rejected" : "error",
        pid: process.pid,
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(isDaemonRuntimeOwnershipError(error) ? 2 : 3);
  }
});
