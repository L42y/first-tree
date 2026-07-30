import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultHome, readConfigFile } from "@first-tree/shared/config";
import { channelConfig } from "../channel.js";

const heldAccountLocks = new Set<string>();

export function withAccountStateMutationLock<T>(action: () => T, home = defaultHome()): T {
  const release = acquireAccountStateMutationLock(home);
  try {
    return action();
  } finally {
    release();
  }
}

export async function withAccountStateMutationLockAsync<T>(action: () => Promise<T>, home = defaultHome()): Promise<T> {
  const release = acquireAccountStateMutationLock(home);
  try {
    return await action();
  } finally {
    release();
  }
}

export function assertContextMutationCanStart(home = defaultHome()): void {
  if (
    existsSync(join(home, "state", "client-switch.lock")) ||
    existsSync(join(home, "state", "client-switch-journal.json"))
  ) {
    throw new Error(
      "A First Tree client account switch is active or incomplete. Finish that login recovery before changing or recovering Context Plugin/binding state.",
    );
  }
}

export function assertClientSwitchCanStart(home = defaultHome()): void {
  const blockers = [
    join(home, "state", "context", "install.lock"),
    join(home, "state", "context", "install-journal.json"),
    join(home, "state", "context", "operation-journal.json"),
  ];
  if (blockers.some((path) => existsSync(path))) {
    throw new Error(
      `A First Tree Context Plugin/binding operation is active or incomplete. Run \`${channelConfig.binName} context repair --provider <claude-code|codex>\` for the affected provider before switching accounts.`,
    );
  }
}

export function readActiveContextAccountClientId(home = defaultHome()): string {
  const raw = readConfigFile(join(home, "config", "client.yaml"));
  const client = raw.client;
  const id = typeof client === "object" && client !== null ? (client as { id?: unknown }).id : null;
  if (typeof id !== "string" || !/^client_[a-f0-9]{8}$/u.test(id)) {
    throw new Error("First Tree Context requires the active logged-in Computer identity before mutating local state.");
  }
  return id;
}

function acquireAccountStateMutationLock(home: string): () => void {
  const path = join(home, "state", "account-state.lock");
  if (heldAccountLocks.has(path)) return () => undefined;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  removeStalePidLock(path);
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    throw new Error("Another First Tree account or Context state change is already running.", { cause: error });
  }
  heldAccountLocks.add(path);
  writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  return () => {
    heldAccountLocks.delete(path);
    closeSync(descriptor);
    rmSync(path, { force: true });
  };
}

function removeStalePidLock(path: string): void {
  try {
    const owner = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(owner) || owner <= 0) return;
    try {
      process.kill(owner, 0);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;
      if (code === "ESRCH") rmSync(path, { force: true });
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
