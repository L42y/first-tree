import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import {
  acquireDaemonRuntimeOwnership,
  type DaemonRuntimeMode,
  daemonRuntimeOwnershipPath,
  isDaemonRuntimeOwnershipError,
} from "../../core/daemon-runtime-ownership.js";

const [home, modeArg] = process.argv.slice(2);
const mode: DaemonRuntimeMode = modeArg === "service" ? "service" : "foreground";
const seedRecoveryGuard = modeArg === "seed-recovery";

if (!home) {
  process.stderr.write("missing home\n");
  process.exit(3);
}

const lines = createInterface({ input: process.stdin });
process.stdout.write(`${JSON.stringify({ event: "ready", pid: process.pid })}\n`);

lines.once("line", () => {
  try {
    if (seedRecoveryGuard) {
      const probe = acquireDaemonRuntimeOwnership({
        channel: "dev",
        mode: "foreground",
        version: "test-recovery-seed",
        home: `${home}.recovery-probe`,
      });
      const recoveryPath = `${daemonRuntimeOwnershipPath(home)}.recovery`;
      mkdirSync(dirname(recoveryPath), { recursive: true });
      writeFileSync(
        recoveryPath,
        `${JSON.stringify(
          {
            lockVersion: 1,
            instanceId: probe.owner.instanceId,
            pid: probe.owner.pid,
            processStartIdentity: probe.owner.processStartIdentity,
            startedAt: probe.owner.startedAt,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      probe.release();
      process.stdout.write(`${JSON.stringify({ event: "recovery-guard-created", pid: process.pid })}\n`);
      return;
    }

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
