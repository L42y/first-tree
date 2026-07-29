import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDaemonRuntimeOwnership,
  DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES,
  type DaemonRuntimeOwner,
  type DaemonRuntimeOwnershipLease,
  daemonRuntimeOwnershipPath,
  inspectDaemonRuntimeOwnership,
  isDaemonRuntimeOwnershipError,
} from "../core/daemon-runtime-ownership.js";

type ChildMessage = {
  event: "ready" | "acquired" | "recovery-guard-created" | "rejected" | "error";
  pid: number;
  mode?: "foreground" | "service";
  message?: string;
};

let root: string;
const leases: DaemonRuntimeOwnershipLease[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ft-daemon-owner-"));
});

afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
  rmSync(root, { recursive: true, force: true });
});

function acquire(
  home: string,
  channel: "dev" | "staging" | "prod" = "dev",
  mode: "foreground" | "service" = "foreground",
): DaemonRuntimeOwnershipLease {
  const lease = acquireDaemonRuntimeOwnership({ channel, mode, version: "0.0.0-test", home });
  leases.push(lease);
  return lease;
}

function rewriteOwner(lockPath: string, owner: DaemonRuntimeOwner): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

function parseOwner(lockPath: string): DaemonRuntimeOwner {
  return JSON.parse(readFileSync(lockPath, "utf8")) as DaemonRuntimeOwner;
}

function recoveryGuardPath(home: string): string {
  return `${daemonRuntimeOwnershipPath(home)}.recovery`;
}

function writeRecoveryGuard(
  home: string,
  guard: {
    lockVersion: 1;
    instanceId: string;
    pid: number;
    processStartIdentity: string;
    startedAt: string;
  },
): string {
  const path = recoveryGuardPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(guard, null, 2)}\n`, "utf8");
  return path;
}

function waitForChildMessage(child: ChildProcessWithoutNullStreams): () => Promise<ChildMessage> {
  const queued: ChildMessage[] = [];
  const waiting: Array<(message: ChildMessage) => void> = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as ChildMessage;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });
  return () => {
    const message = queued.shift();
    if (message) return Promise.resolve(message);
    return new Promise<ChildMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for daemon owner child")), 10_000);
      waiting.push((next) => {
        clearTimeout(timeout);
        resolve(next);
      });
    });
  };
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

describe("daemon runtime ownership", () => {
  it("records the authoritative owner fields and releases only its own instance", () => {
    const home = join(root, "home");
    const lease = acquire(home, "staging", "service");
    const owner = parseOwner(lease.lockPath);

    expect(owner).toMatchObject({
      lockVersion: 1,
      instanceId: lease.owner.instanceId,
      pid: process.pid,
      processStartIdentity: expect.stringMatching(/:/u),
      channel: "staging",
      mode: "service",
      version: "0.0.0-test",
      home: realpathSync(home),
    });
    expect(Date.parse(owner.startedAt)).not.toBeNaN();
    expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({ state: "live", owner });

    rewriteOwner(lease.lockPath, { ...owner, instanceId: randomUUID() });
    expect(lease.release()).toBe(false);
    expect(existsSync(lease.lockPath)).toBe(true);
  });

  it("lets the prod, staging, and dev default-home shapes run in parallel", () => {
    const prod = acquire(join(root, ".first-tree"), "prod");
    const staging = acquire(join(root, ".first-tree-staging"), "staging");
    const dev = acquire(join(root, ".first-tree-dev"), "dev");

    expect(new Set([prod.lockPath, staging.lockPath, dev.lockPath]).size).toBe(3);
    expect([prod, staging, dev].map((lease) => inspectDaemonRuntimeOwnership(lease.owner.home).state)).toEqual([
      "live",
      "live",
      "live",
    ]);
  });

  it("rejects foreground/service competition for the same resolved home with holder diagnostics", () => {
    const home = join(root, "shared");
    const service = acquire(home, "prod", "service");

    try {
      acquireDaemonRuntimeOwnership({ channel: "prod", mode: "foreground", version: "next", home });
      throw new Error("expected ownership collision");
    } catch (error) {
      expect(isDaemonRuntimeOwnershipError(error)).toBe(true);
      if (!isDaemonRuntimeOwnershipError(error)) return;
      expect(error.code).toBe(DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.alreadyRunning);
      expect(error.owner).toEqual(service.owner);
      expect(error.message).toContain(`pid ${process.pid}`);
      expect(error.message).toContain("channel prod");
      expect(error.message).toContain("mode service");
    }
  });

  it("rejects different channels that explicitly share one home", () => {
    const home = join(root, "shared-channel-home");
    acquire(home, "dev");

    expect(() =>
      acquireDaemonRuntimeOwnership({ channel: "staging", mode: "service", version: "0.0.0-test", home }),
    ).toThrow(/already held.*channel dev/u);
  });

  it("collapses lexical aliases onto the same resolved home key", () => {
    const home = join(root, "resolved");
    mkdirSync(join(root, "placeholder"), { recursive: true });
    const alias = join(root, "placeholder", "..", "resolved");
    acquire(home, "dev");

    expect(() =>
      acquireDaemonRuntimeOwnership({ channel: "dev", mode: "service", version: "0.0.0-test", home: alias }),
    ).toThrow(/already held/u);
  });

  it("allows multiple dev runtimes when their explicit homes differ", () => {
    const first = acquire(join(root, "dev-a"), "dev");
    const second = acquire(join(root, "dev-b"), "dev");

    expect(first.lockPath).not.toBe(second.lockPath);
    expect(inspectDaemonRuntimeOwnership(first.owner.home).state).toBe("live");
    expect(inspectDaemonRuntimeOwnership(second.owner.home).state).toBe("live");
  });

  it("releases normally so a later owner can acquire the same home", () => {
    const home = join(root, "release");
    const first = acquire(home);
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({ state: "absent" });

    const second = acquire(home, "dev", "service");
    expect(second.owner.instanceId).not.toBe(first.owner.instanceId);
  });

  it("quarantines a crash-stale lock and retries acquisition exactly once", () => {
    const home = join(root, "crash");
    const original = acquire(home);
    const staleOwner: DaemonRuntimeOwner = {
      ...original.owner,
      instanceId: randomUUID(),
      pid: 999_999_999,
      processStartIdentity: "test-dead-process:1",
    };
    expect(original.release()).toBe(true);
    rewriteOwner(original.lockPath, staleOwner);

    const recovered = acquire(home, "dev", "service");
    expect(recovered.quarantinedLockPath).toBeTruthy();
    expect(existsSync(recovered.quarantinedLockPath ?? "")).toBe(true);
    expect(parseOwner(recovered.quarantinedLockPath ?? "")).toEqual(staleOwner);
    expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({
      state: "live",
      owner: { instanceId: recovered.owner.instanceId },
    });
  });

  it("keeps a live recovery guard fail-closed with holder diagnostics", () => {
    const home = join(root, "live-recovery");
    const probe = acquire(home);
    expect(probe.release()).toBe(true);
    const recoveryPath = writeRecoveryGuard(home, {
      lockVersion: 1,
      instanceId: probe.owner.instanceId,
      pid: probe.owner.pid,
      processStartIdentity: probe.owner.processStartIdentity,
      startedAt: probe.owner.startedAt,
    });

    try {
      acquireDaemonRuntimeOwnership({ channel: "dev", mode: "foreground", version: "test", home });
      throw new Error("expected live recovery guard rejection");
    } catch (error) {
      expect(isDaemonRuntimeOwnershipError(error)).toBe(true);
      if (!isDaemonRuntimeOwnershipError(error)) return;
      expect(error.code).toBe(DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy);
      expect(error.message).toContain(`pid ${process.pid}`);
      expect(error.message).toContain(recoveryPath);
    }
    expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({
      state: "untrusted",
      reason: expect.stringContaining("recovery is in progress"),
    });
  });

  it("recovers a guard abandoned by a process crash before stale-owner cleanup", async () => {
    const home = join(root, "crashed-recovery");
    const original = acquire(home);
    const staleOwner: DaemonRuntimeOwner = {
      ...original.owner,
      instanceId: randomUUID(),
      pid: 999_999_999,
      processStartIdentity: "test-dead-process:recovery-owner",
    };
    expect(original.release()).toBe(true);
    rewriteOwner(original.lockPath, staleOwner);

    const fixture = fileURLToPath(new URL("./fixtures/daemon-runtime-owner-child.ts", import.meta.url));
    const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
    const crashed = spawn(process.execPath, ["--import", "tsx", fixture, home, "seed-recovery"], {
      cwd: cliRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const next = waitForChildMessage(crashed);

    try {
      expect((await next()).event).toBe("ready");
      crashed.stdin.write("go\n");
      const created = await next();
      expect(created.event).toBe("recovery-guard-created");
      crashed.kill("SIGKILL");
      expect(await waitForExit(crashed)).toBeNull();

      expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({
        state: "untrusted",
        reason: expect.stringContaining("is abandoned"),
      });

      const recovered = acquire(home, "dev", "service");
      expect(recovered.quarantinedRecoveryGuardPath).toBeTruthy();
      expect(existsSync(recovered.quarantinedRecoveryGuardPath ?? "")).toBe(true);
      expect(JSON.parse(readFileSync(recovered.quarantinedRecoveryGuardPath ?? "", "utf8"))).toMatchObject({
        pid: created.pid,
      });
      expect(recovered.quarantinedLockPath).toBeTruthy();
      expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({
        state: "live",
        owner: { instanceId: recovered.owner.instanceId },
      });
    } finally {
      if (crashed.exitCode === null && crashed.signalCode === null) crashed.kill("SIGKILL");
    }
  });

  it("fails closed without changing a corrupted recovery guard", () => {
    const home = join(root, "corrupt-recovery");
    const recoveryPath = recoveryGuardPath(home);
    mkdirSync(dirname(recoveryPath), { recursive: true });
    writeFileSync(recoveryPath, "{ definitely-not-json", "utf8");

    expect(() => acquireDaemonRuntimeOwnership({ channel: "dev", mode: "foreground", version: "test", home })).toThrow(
      /recovery guard .* cannot be trusted: invalid JSON/u,
    );
    expect(readFileSync(recoveryPath, "utf8")).toBe("{ definitely-not-json");
    expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({
      state: "untrusted",
      reason: expect.stringContaining("recovery guard"),
    });
  });

  it("treats a live reused pid with a different start identity as stale", () => {
    const home = join(root, "pid-reuse");
    const original = acquire(home);
    const staleOwner: DaemonRuntimeOwner = {
      ...original.owner,
      instanceId: randomUUID(),
      processStartIdentity: "test-reused-pid:older-process",
    };
    expect(original.release()).toBe(true);
    rewriteOwner(original.lockPath, staleOwner);

    expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({
      state: "stale",
      reason: expect.stringContaining("pid"),
    });
    const recovered = acquire(home);
    expect(recovered.quarantinedLockPath).toBeTruthy();
  });

  it("fails closed without changing a corrupted lock", () => {
    const home = join(root, "corrupt");
    const lockPath = daemonRuntimeOwnershipPath(home);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "{ definitely-not-json", "utf8");

    expect(() => acquireDaemonRuntimeOwnership({ channel: "dev", mode: "foreground", version: "test", home })).toThrow(
      /cannot be trusted: invalid JSON/u,
    );
    expect(readFileSync(lockPath, "utf8")).toBe("{ definitely-not-json");
    expect(inspectDaemonRuntimeOwnership(home)).toMatchObject({ state: "untrusted" });
  });

  it("allows only one concurrent process to enter runtime ownership for a shared home", async () => {
    const home = join(root, "concurrent");
    const fixture = fileURLToPath(new URL("./fixtures/daemon-runtime-owner-child.ts", import.meta.url));
    const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
    const first = spawn(process.execPath, ["--import", "tsx", fixture, home, "service"], {
      cwd: cliRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const second = spawn(process.execPath, ["--import", "tsx", fixture, home, "foreground"], {
      cwd: cliRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const nextFirst = waitForChildMessage(first);
    const nextSecond = waitForChildMessage(second);

    expect((await nextFirst()).event).toBe("ready");
    expect((await nextSecond()).event).toBe("ready");
    first.stdin.write("go\n");
    second.stdin.write("go\n");

    const results = await Promise.all([nextFirst(), nextSecond()]);
    expect(results.map((result) => result.event).sort()).toEqual(["acquired", "rejected"]);
    const winner = results[0]?.event === "acquired" ? first : second;
    const loser = winner === first ? second : first;
    winner.stdin.write("release\n");

    const [winnerExit, loserExit] = await Promise.all([waitForExit(winner), waitForExit(loser)]);
    expect(winnerExit).toBe(0);
    expect(loserExit).toBe(2);
    expect(inspectDaemonRuntimeOwnership(home).state).toBe("absent");
  });

  it("isolates one stale recovery guard under concurrent acquisition without admitting two owners", async () => {
    const home = join(root, "concurrent-recovery");
    const original = acquire(home);
    const staleOwner: DaemonRuntimeOwner = {
      ...original.owner,
      instanceId: randomUUID(),
      pid: 999_999_999,
      processStartIdentity: "test-dead-process:concurrent-recovery",
    };
    expect(original.release()).toBe(true);
    rewriteOwner(original.lockPath, staleOwner);
    writeRecoveryGuard(home, {
      lockVersion: 1,
      instanceId: randomUUID(),
      pid: 999_999_999,
      processStartIdentity: "test-dead-process:recovery-guard",
      startedAt: new Date().toISOString(),
    });

    const fixture = fileURLToPath(new URL("./fixtures/daemon-runtime-owner-child.ts", import.meta.url));
    const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
    const first = spawn(process.execPath, ["--import", "tsx", fixture, home, "service"], {
      cwd: cliRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const second = spawn(process.execPath, ["--import", "tsx", fixture, home, "foreground"], {
      cwd: cliRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const nextFirst = waitForChildMessage(first);
    const nextSecond = waitForChildMessage(second);

    expect((await nextFirst()).event).toBe("ready");
    expect((await nextSecond()).event).toBe("ready");
    first.stdin.write("go\n");
    second.stdin.write("go\n");

    const results = await Promise.all([nextFirst(), nextSecond()]);
    expect(results.map((result) => result.event).sort()).toEqual(["acquired", "rejected"]);
    const winner = results[0]?.event === "acquired" ? first : second;
    const loser = winner === first ? second : first;
    winner.stdin.write("release\n");

    const [winnerExit, loserExit] = await Promise.all([waitForExit(winner), waitForExit(loser)]);
    expect(winnerExit).toBe(0);
    expect(loserExit).toBe(2);
    const finalInspection = inspectDaemonRuntimeOwnership(home);
    const stateFiles = readdirSync(dirname(original.lockPath));
    expect(finalInspection, JSON.stringify({ finalInspection, stateFiles }, null, 2)).toMatchObject({
      state: "absent",
    });
    expect(stateFiles.some((name) => name.includes(".recovery.stale."))).toBe(true);
  });
});
