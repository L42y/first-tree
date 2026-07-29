import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { tryLock, unlock } from "fs-native-extensions";

export type WorkspaceFileLock = Readonly<{
  release: () => Promise<void>;
}>;

export type AcquireWorkspaceFileLockOptions = Readonly<{
  timeoutMs: number;
  /** Test-only observation seam; lock ownership never depends on this callback. */
  onContention?: () => void;
}>;

/**
 * Hold a kernel-backed exclusive lock on one persistent file.
 *
 * The path is never renamed or removed. Every cooperating contender opens the
 * same inode, and the OS releases the lock if the owner process exits. This
 * avoids stale-file reclamation and its unavoidable inspect/unlink race.
 */
export async function acquireWorkspaceFileLock(
  lockPath: string,
  options: AcquireWorkspaceFileLockOptions,
): Promise<WorkspaceFileLock> {
  const handle = await openStableLockFile(lockPath);
  const startedAt = Date.now();
  let acquired = false;

  try {
    while (true) {
      if (tryLock(handle.fd)) {
        acquired = true;
        await assertStableLockFile(lockPath, handle);
        break;
      }
      options.onContention?.();
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new Error(`timed out waiting for managed skills workspace lock after ${options.timeoutMs}ms`);
      }
      await delay(Math.min(250, 25 + Math.floor((Date.now() - startedAt) / 10)));
    }
  } catch (error) {
    if (acquired) {
      try {
        unlock(handle.fd);
      } catch {
        // Closing the descriptor below also releases any held kernel lock.
      }
    }
    await handle.close();
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      let unlockError: unknown;
      try {
        unlock(handle.fd);
      } catch (error) {
        unlockError = error;
      }
      await handle.close();
      if (unlockError) throw unlockError;
    },
  };
}

async function openStableLockFile(lockPath: string): Promise<FileHandle> {
  try {
    const current = await lstat(lockPath);
    if (current.isSymbolicLink()) {
      throw new Error("managed skills workspace lock is a symlink; refusing to follow it");
    }
    if (!current.isFile()) {
      throw new Error("managed skills workspace lock is not a regular file; refusing to replace it");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle;
  try {
    handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("managed skills workspace lock is a symlink; refusing to follow it");
    }
    throw error;
  }

  try {
    await assertStableLockFile(lockPath, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertStableLockFile(lockPath: string, handle: FileHandle): Promise<void> {
  const [opened, current] = await Promise.all([handle.stat(), lstat(lockPath)]);
  if (
    !opened.isFile() ||
    !current.isFile() ||
    opened.nlink === 0 ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw new Error("managed skills workspace lock path changed while opening; refusing reconciliation");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
