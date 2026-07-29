import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [home, role, barrierDir] = process.argv.slice(2);

if (!home || !role || !barrierDir) {
  process.stderr.write("missing home, role, or barrier directory\n");
  process.exit(3);
}

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const originalExistsSync = fs.existsSync.bind(fs);
const originalMkdirSync = fs.mkdirSync.bind(fs);
const originalRealpathSync = fs.realpathSync.bind(fs);
const originalRenameSync = fs.renameSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);

originalMkdirSync(barrierDir, { recursive: true });
const lockPath = join(originalRealpathSync(home), "state", "daemon-runtime.lock");
const recoveryPath = `${lockPath}.recovery`;

function waitAtBarrier(name: string): void {
  originalWriteFileSync(join(barrierDir, `${role}.${name}.ready`), `${process.pid}\n`, "utf8");
  const releasePath = join(barrierDir, `${role}.${name}.go`);
  const deadline = Date.now() + 15_000;
  while (!originalExistsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out at ${role}.${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

Object.defineProperty(fs, "renameSync", {
  configurable: true,
  value: (oldPath: import("node:fs").PathLike, newPath: import("node:fs").PathLike): void => {
    const oldName = String(oldPath);
    const newName = String(newPath);
    if (role === "p1" && oldName === recoveryPath && newName.includes(".recovery.stale.")) {
      waitAtBarrier("guard-before-rename");
      originalRenameSync(oldPath, newPath);
      waitAtBarrier("guard-after-rename");
      return;
    }
    if ((role === "p2" || role === "p3") && oldName === lockPath && newName.includes(".lock.stale.")) {
      waitAtBarrier("owner-before-rename");
    }
    originalRenameSync(oldPath, newPath);
  },
});
syncBuiltinESMExports();

const { acquireDaemonRuntimeOwnership, isDaemonRuntimeOwnershipError } = await import(
  "../../core/daemon-runtime-ownership.js"
);

const lines = createInterface({ input: process.stdin });
process.stdout.write(`${JSON.stringify({ event: "ready", pid: process.pid })}\n`);

lines.once("line", () => {
  try {
    const lease = acquireDaemonRuntimeOwnership({
      channel: "dev",
      mode: "foreground",
      version: `test-race-${role}`,
      home,
    });
    process.stdout.write(`${JSON.stringify({ event: "acquired", pid: process.pid })}\n`);
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
