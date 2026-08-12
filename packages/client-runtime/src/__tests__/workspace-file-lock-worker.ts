import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export type WorkspaceLockWorker = Readonly<{
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

export function spawnWorkspaceLockWorker(lockPath: string): WorkspaceLockWorker {
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
