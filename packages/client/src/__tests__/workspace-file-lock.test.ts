import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWorkspaceFileLock, WorkspaceFileLockTimeoutError } from "../runtime/workspace-file-lock.js";
import { spawnWorkspaceLockWorker, type WorkspaceLockWorker } from "./workspace-file-lock-worker.js";

describe("workspace file lock", () => {
  let sandbox: string;
  let workers: WorkspaceLockWorker[];

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

    const successor = spawnWorkspaceLockWorker(lockPath);
    workers.push(successor);
    await successor.waitForLine("acquired");

    const third = spawnWorkspaceLockWorker(lockPath);
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

  it("throws a typed timeout under real cross-process contention", async () => {
    const lockPath = join(sandbox, "managed-skills.lock");
    const holder = spawnWorkspaceLockWorker(lockPath);
    workers.push(holder);
    await holder.waitForLine("acquired");

    await expect(acquireWorkspaceFileLock(lockPath, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      WorkspaceFileLockTimeoutError,
    );
    expect(holder.hasLine("acquired")).toBe(true);

    holder.child.stdin.end("release\n");
    const holderExit = await holder.waitForExit();
    expect(holderExit, holder.stderr()).toEqual({ code: 0, signal: null });
  });

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

function expectSameInode(lockPath: string, device: number, inode: number): void {
  const current = lstatSync(lockPath);
  expect(current.isFile()).toBe(true);
  expect(current.dev).toBe(device);
  expect(current.ino).toBe(inode);
}
