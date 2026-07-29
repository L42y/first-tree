import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWorkspaceFileLock } from "../runtime/workspace-file-lock.js";

type LockWorker = Readonly<{
  child: ChildProcessWithoutNullStreams;
  hasLine: (line: string) => boolean;
  waitForLine: (line: string) => Promise<void>;
  waitForExit: () => Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  stderr: () => string;
}>;

const LOCK_MODULE_URL = pathToFileURL(
  fileURLToPath(new URL("../runtime/workspace-file-lock.ts", import.meta.url)),
).href;

const LOCK_WORKER_SCRIPT = `
const { acquireWorkspaceFileLock } = await import(${JSON.stringify(LOCK_MODULE_URL)});
const lockPath = process.argv[1];
let reportedContention = false;
const lock = await acquireWorkspaceFileLock(lockPath, {
  timeoutMs: 10_000,
  onContention: () => {
    if (reportedContention) return;
    reportedContention = true;
    process.stdout.write("busy\\n");
  },
});
process.stdout.write("acquired\\n");
await new Promise((resolve) => {
  process.stdin.once("data", resolve);
  process.stdin.once("end", resolve);
});
await lock.release();
`;

describe("workspace file lock", () => {
  let sandbox: string;
  let workers: LockWorker[];

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "ft-workspace-lock-"));
    workers = [];
  });

  afterEach(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill("SIGKILL");
      }
    }
    await Promise.allSettled(workers.map((worker) => worker.waitForExit()));
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("keeps a live successor attached while a third contender observes a dead owner's artifact", async () => {
    const lockPath = join(sandbox, "managed-skills.lock");
    writeFileSync(lockPath, "dead owner residue\n", { mode: 0o600 });
    const original = lstatSync(lockPath);

    const successor = spawnLockWorker(lockPath);
    workers.push(successor);
    await successor.waitForLine("acquired");

    const third = spawnLockWorker(lockPath);
    workers.push(third);
    await third.waitForLine("busy");
    expect(third.hasLine("acquired")).toBe(false);
    expectSameInode(lockPath, original.dev, original.ino);

    successor.child.kill("SIGKILL");
    await successor.waitForExit();
    await third.waitForLine("acquired");
    expectSameInode(lockPath, original.dev, original.ino);

    third.child.stdin.end("release\n");
    const thirdExit = await third.waitForExit();
    expect(thirdExit, third.stderr()).toEqual({ code: 0, signal: null });
    expectSameInode(lockPath, original.dev, original.ino);
  }, 20_000);

  it("leaves the stable lock file in place after release", async () => {
    const lockPath = join(sandbox, "managed-skills.lock");
    const first = await acquireWorkspaceFileLock(lockPath, { timeoutMs: 1_000 });
    const original = lstatSync(lockPath);
    await first.release();
    expectSameInode(lockPath, original.dev, original.ino);

    const second = await acquireWorkspaceFileLock(lockPath, { timeoutMs: 1_000 });
    await second.release();
    expectSameInode(lockPath, original.dev, original.ino);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked lock file", async () => {
    const outside = join(sandbox, "outside");
    const lockPath = join(sandbox, "runtime", "managed-skills.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(outside, "preserve\n");
    symlinkSync(outside, lockPath);

    await expect(acquireWorkspaceFileLock(lockPath, { timeoutMs: 1_000 })).rejects.toThrow(
      "workspace lock is a symlink",
    );
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
  });
});

function spawnLockWorker(lockPath: string): LockWorker {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", LOCK_WORKER_SCRIPT, lockPath],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = new Set<string>();
  const waiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
  let stderr = "";
  let settledExit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  let resolveExit: (result: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>) => void = () => {};
  const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolveExitPromise) => {
    resolveExit = resolveExitPromise;
  });

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    lines.add(line);
    for (const waiter of waiters.get(line) ?? []) waiter.resolve();
    waiters.delete(line);
  });
  child.once("exit", (code, signal) => {
    settledExit = { code, signal };
    resolveExit(settledExit);
    for (const [line, pending] of waiters) {
      for (const waiter of pending) {
        waiter.reject(new Error(`lock worker exited before "${line}" (${code ?? signal}): ${stderr}`));
      }
    }
    waiters.clear();
  });

  return {
    child,
    hasLine: (line) => lines.has(line),
    waitForLine: (line) => {
      if (lines.has(line)) return Promise.resolve();
      if (settledExit) {
        return Promise.reject(
          new Error(`lock worker exited before "${line}" (${settledExit.code ?? settledExit.signal}): ${stderr}`),
        );
      }
      return new Promise<void>((resolveLine, rejectLine) => {
        const pending = waiters.get(line) ?? [];
        pending.push({ resolve: resolveLine, reject: rejectLine });
        waiters.set(line, pending);
      });
    },
    waitForExit: () => (settledExit ? Promise.resolve(settledExit) : exited),
    stderr: () => stderr,
  };
}

function expectSameInode(lockPath: string, device: number, inode: number): void {
  const current = lstatSync(lockPath);
  expect(current.isFile()).toBe(true);
  expect(current.dev).toBe(device);
  expect(current.ino).toBe(inode);
}
