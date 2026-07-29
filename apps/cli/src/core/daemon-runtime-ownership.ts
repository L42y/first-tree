import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChannelName } from "@first-tree/shared/channel";

const LOCK_FORMAT_VERSION = 1;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const RECOVERY_GUARD_CLEANUP_RETRIES = 50;
const RECOVERY_GUARD_CLEANUP_RETRY_MS = 10;
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DaemonRuntimeMode = "foreground" | "service";

export type DaemonRuntimeOwner = {
  lockVersion: 1;
  instanceId: string;
  pid: number;
  processStartIdentity: string;
  channel: ChannelName;
  mode: DaemonRuntimeMode;
  version: string;
  startedAt: string;
  home: string;
};

export type DaemonRuntimeOwnershipInspection =
  | { state: "absent"; lockPath: string }
  | { state: "live"; lockPath: string; owner: DaemonRuntimeOwner }
  | { state: "stale"; lockPath: string; owner: DaemonRuntimeOwner; reason: string }
  | { state: "untrusted"; lockPath: string; owner?: DaemonRuntimeOwner; reason: string };

export type DaemonRuntimeOwnershipLease = {
  lockPath: string;
  owner: DaemonRuntimeOwner;
  quarantinedLockPath?: string;
  quarantinedRecoveryGuardPath?: string;
  release: () => boolean;
};

export const DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES = {
  alreadyRunning: "DAEMON_RUNTIME_ALREADY_RUNNING",
  untrustedLock: "DAEMON_RUNTIME_LOCK_UNTRUSTED",
  recoveryBusy: "DAEMON_RUNTIME_LOCK_RECOVERY_BUSY",
  io: "DAEMON_RUNTIME_LOCK_IO",
} as const;

export type DaemonRuntimeOwnershipErrorCode =
  (typeof DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES)[keyof typeof DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES];

export class DaemonRuntimeOwnershipError extends Error {
  constructor(
    readonly code: DaemonRuntimeOwnershipErrorCode,
    message: string,
    readonly lockPath: string,
    readonly owner?: DaemonRuntimeOwner,
  ) {
    super(message);
    this.name = "DaemonRuntimeOwnershipError";
  }
}

export function isDaemonRuntimeOwnershipError(error: unknown): error is DaemonRuntimeOwnershipError {
  return error instanceof DaemonRuntimeOwnershipError;
}

type ProcessStartInspection =
  | { state: "present"; identity: string }
  | { state: "gone" }
  | { state: "unknown"; reason: string };

type ParsedOwner = { ok: true; owner: DaemonRuntimeOwner } | { ok: false; reason: string };

type RecoveryGuard = {
  lockVersion: 1;
  instanceId: string;
  pid: number;
  processStartIdentity: string;
  startedAt: string;
};

type ParsedRecoveryGuard = { ok: true; guard: RecoveryGuard } | { ok: false; reason: string };

type RecoveryGuardInspection =
  | { state: "absent"; recoveryPath: string }
  | { state: "live"; recoveryPath: string; guard: RecoveryGuard }
  | { state: "stale"; recoveryPath: string; guard: RecoveryGuard; reason: string }
  | { state: "untrusted"; recoveryPath: string; guard?: RecoveryGuard; reason: string };

export function daemonRuntimeOwnershipPath(home: string): string {
  return join(canonicalHome(home, false), "state", "daemon-runtime.lock");
}

export function daemonRuntimeHomesEqual(left: string, right: string): boolean {
  return daemonRuntimeOwnershipPath(left) === daemonRuntimeOwnershipPath(right);
}

function recoveryGuardPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function canonicalHome(home: string, create: boolean): string {
  const absolute = resolve(home);
  if (!create && !existsSync(absolute)) return absolute;
  try {
    if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
    return realpathSync.native(absolute);
  } catch (error) {
    throw new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
      `Unable to resolve daemon home ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      join(absolute, "state", "daemon-runtime.lock"),
    );
  }
}

function isChannelName(value: unknown): value is ChannelName {
  return value === "dev" || value === "staging" || value === "prod";
}

function isDaemonRuntimeMode(value: unknown): value is DaemonRuntimeMode {
  return value === "foreground" || value === "service";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOwner(raw: string, expectedHome: string): ParsedOwner {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `invalid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isRecord(value)) return { ok: false, reason: "lock contents are not an object" };

  const { lockVersion, instanceId, pid, processStartIdentity, channel, mode, version, startedAt, home } = value;
  if (lockVersion !== LOCK_FORMAT_VERSION) {
    return { ok: false, reason: `unsupported lockVersion ${String(lockVersion)}` };
  }
  if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) {
    return { ok: false, reason: "instanceId is missing or invalid" };
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "pid is missing or invalid" };
  }
  if (
    typeof processStartIdentity !== "string" ||
    processStartIdentity.length === 0 ||
    processStartIdentity.length > 512
  ) {
    return { ok: false, reason: "processStartIdentity is missing or invalid" };
  }
  if (!isChannelName(channel)) return { ok: false, reason: "channel is missing or invalid" };
  if (!isDaemonRuntimeMode(mode)) return { ok: false, reason: "mode is missing or invalid" };
  if (typeof version !== "string" || version.length === 0 || version.length > 128) {
    return { ok: false, reason: "version is missing or invalid" };
  }
  if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) {
    return { ok: false, reason: "startedAt is missing or invalid" };
  }
  if (home !== expectedHome) {
    return { ok: false, reason: `lock home ${String(home)} does not match resolved home ${expectedHome}` };
  }

  return {
    ok: true,
    owner: {
      lockVersion,
      instanceId,
      pid,
      processStartIdentity,
      channel,
      mode,
      version,
      startedAt,
      home,
    },
  };
}

function parseRecoveryGuard(raw: string): ParsedRecoveryGuard {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `invalid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isRecord(value)) return { ok: false, reason: "recovery guard contents are not an object" };

  const { lockVersion, instanceId, pid, processStartIdentity, startedAt } = value;
  if (lockVersion !== LOCK_FORMAT_VERSION) {
    return { ok: false, reason: `unsupported lockVersion ${String(lockVersion)}` };
  }
  if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) {
    return { ok: false, reason: "instanceId is missing or invalid" };
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "pid is missing or invalid" };
  }
  if (
    typeof processStartIdentity !== "string" ||
    processStartIdentity.length === 0 ||
    processStartIdentity.length > 512
  ) {
    return { ok: false, reason: "processStartIdentity is missing or invalid" };
  }
  if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) {
    return { ok: false, reason: "startedAt is missing or invalid" };
  }
  return {
    ok: true,
    guard: {
      lockVersion,
      instanceId,
      pid,
      processStartIdentity,
      startedAt,
    },
  };
}

function inspectPidExistence(pid: number): "present" | "gone" | "unknown" {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "present";
    return "unknown";
  }
}

function inspectLinuxProcessStart(pid: number): ProcessStartInspection {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return { state: "unknown", reason: `/proc/${pid}/stat has no command terminator` };
    const fieldsAfterCommand = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const startTicks = fieldsAfterCommand[19];
    if (!startTicks || !/^\d+$/u.test(startTicks)) {
      return { state: "unknown", reason: `/proc/${pid}/stat has no valid process start ticks` };
    }
    return { state: "present", identity: `linux-proc-start-ticks:${startTicks}` };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "gone" };
    return {
      state: "unknown",
      reason: `unable to read /proc/${pid}/stat: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function inspectDarwinProcessStart(pid: number): ProcessStartInspection {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  if (result.error) {
    return { state: "unknown", reason: `unable to run ps: ${result.error.message}` };
  }
  const startedAt = result.stdout.trim();
  if (result.status === 0 && startedAt) {
    return { state: "present", identity: `darwin-ps-lstart:${startedAt}` };
  }
  const existence = inspectPidExistence(pid);
  if (existence === "gone") return { state: "gone" };
  return {
    state: "unknown",
    reason: result.stderr.trim() || `ps did not return a start identity for pid ${pid}`,
  };
}

function inspectWindowsProcessStart(pid: number): ProcessStartInspection {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { exit 3 }",
    "$creation = if ($null -eq $p.CreationDate) { '' } else { $p.CreationDate.ToUniversalTime().ToString('o') }",
    "[Console]::Out.Write($creation)",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: PROCESS_QUERY_TIMEOUT_MS },
  );
  if (result.status === 3) return { state: "gone" };
  if (result.error) {
    return { state: "unknown", reason: `unable to run PowerShell: ${result.error.message}` };
  }
  const creationTime = result.stdout.trim();
  if (result.status === 0 && creationTime) {
    return { state: "present", identity: `windows-cim-creation-time:${creationTime}` };
  }
  return {
    state: "unknown",
    reason: result.stderr.trim() || `PowerShell did not return a creation time for pid ${pid}`,
  };
}

function inspectProcessStart(pid: number): ProcessStartInspection {
  const existence = inspectPidExistence(pid);
  if (existence === "gone") return { state: "gone" };
  if (existence === "unknown") return { state: "unknown", reason: `unable to determine whether pid ${pid} exists` };
  if (process.platform === "linux") return inspectLinuxProcessStart(pid);
  if (process.platform === "darwin") return inspectDarwinProcessStart(pid);
  if (process.platform === "win32") return inspectWindowsProcessStart(pid);
  return { state: "unknown", reason: `process start identity is unsupported on ${process.platform}` };
}

function readOwnerInspection(lockPath: string, home: string): DaemonRuntimeOwnershipInspection {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent", lockPath };
    return {
      state: "untrusted",
      lockPath,
      reason: `unable to read lock: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = parseOwner(raw, home);
  if (!parsed.ok) return { state: "untrusted", lockPath, reason: parsed.reason };
  const process = inspectProcessStart(parsed.owner.pid);
  if (process.state === "gone") {
    return { state: "stale", lockPath, owner: parsed.owner, reason: `pid ${parsed.owner.pid} no longer exists` };
  }
  if (process.state === "unknown") {
    return { state: "untrusted", lockPath, owner: parsed.owner, reason: process.reason };
  }
  if (process.identity !== parsed.owner.processStartIdentity) {
    return {
      state: "stale",
      lockPath,
      owner: parsed.owner,
      reason: `pid ${parsed.owner.pid} was reused with a different process start identity`,
    };
  }
  return { state: "live", lockPath, owner: parsed.owner };
}

function readRecoveryGuardInspection(recoveryPath: string): RecoveryGuardInspection {
  let raw: string;
  try {
    raw = readFileSync(recoveryPath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent", recoveryPath };
    return {
      state: "untrusted",
      recoveryPath,
      reason: `unable to read recovery guard: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = parseRecoveryGuard(raw);
  if (!parsed.ok) return { state: "untrusted", recoveryPath, reason: parsed.reason };
  const process = inspectProcessStart(parsed.guard.pid);
  if (process.state === "gone") {
    return {
      state: "stale",
      recoveryPath,
      guard: parsed.guard,
      reason: `pid ${parsed.guard.pid} no longer exists`,
    };
  }
  if (process.state === "unknown") {
    return { state: "untrusted", recoveryPath, guard: parsed.guard, reason: process.reason };
  }
  if (process.identity !== parsed.guard.processStartIdentity) {
    return {
      state: "stale",
      recoveryPath,
      guard: parsed.guard,
      reason: `pid ${parsed.guard.pid} was reused with a different process start identity`,
    };
  }
  return { state: "live", recoveryPath, guard: parsed.guard };
}

export function inspectDaemonRuntimeOwnership(home: string): DaemonRuntimeOwnershipInspection {
  let resolvedHome: string;
  try {
    resolvedHome = canonicalHome(home, false);
  } catch (error) {
    if (isDaemonRuntimeOwnershipError(error)) {
      return { state: "untrusted", lockPath: error.lockPath, reason: error.message };
    }
    throw error;
  }
  const lockPath = join(resolvedHome, "state", "daemon-runtime.lock");
  const recoveryInspection = readRecoveryGuardInspection(recoveryGuardPath(lockPath));
  if (recoveryInspection.state === "live") {
    return {
      state: "untrusted",
      lockPath,
      reason: `stale-lock recovery is in progress at ${recoveryInspection.recoveryPath} by pid ${recoveryInspection.guard.pid}`,
    };
  }
  if (recoveryInspection.state === "stale") {
    return {
      state: "untrusted",
      lockPath,
      reason: `stale-lock recovery guard at ${recoveryInspection.recoveryPath} is abandoned: ${recoveryInspection.reason}`,
    };
  }
  if (recoveryInspection.state === "untrusted") {
    return {
      state: "untrusted",
      lockPath,
      reason: `recovery guard at ${recoveryInspection.recoveryPath} cannot be trusted: ${recoveryInspection.reason}`,
    };
  }
  return readOwnerInspection(lockPath, resolvedHome);
}

function tryWriteExclusiveJson(path: string, value: unknown): "created" | "exists" {
  let fd: number | null = null;
  let created = false;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(path, "wx", 0o600);
    created = true;
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    return "created";
  } catch (error) {
    if (!created && errorCode(error) === "EEXIST") return "exists";
    if (created) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the original write/fsync error below.
        }
        fd = null;
      }
      try {
        rmSync(path, { force: true });
      } catch {
        // A handled write failure should not leave a partial lock when cleanup is possible.
      }
    }
    throw new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
      `Unable to create daemon ownership file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function removeOwnedJson(path: string, instanceId: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(value) || value.instanceId !== instanceId) return false;
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

function removeOwnedRecoveryGuard(path: string, instanceId: string): boolean {
  for (let attempt = 0; attempt < RECOVERY_GUARD_CLEANUP_RETRIES; attempt += 1) {
    if (removeOwnedJson(path, instanceId)) return true;
    if (existsSync(path)) return false;
    if (attempt + 1 < RECOVERY_GUARD_CLEANUP_RETRIES) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECOVERY_GUARD_CLEANUP_RETRY_MS);
    }
  }
  return false;
}

function ownershipErrorFromInspection(inspection: Exclude<DaemonRuntimeOwnershipInspection, { state: "absent" }>) {
  if (inspection.state === "live") {
    return new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.alreadyRunning,
      `Daemon runtime ownership for ${inspection.owner.home} is already held by ${formatDaemonRuntimeOwner(
        inspection.owner,
      )}. Lock: ${inspection.lockPath}`,
      inspection.lockPath,
      inspection.owner,
    );
  }
  return new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
    `Refusing daemon startup because ${inspection.lockPath} cannot be trusted: ${inspection.reason}`,
    inspection.lockPath,
    inspection.owner,
  );
}

function recoveryGuardErrorFromInspection(
  inspection: Exclude<RecoveryGuardInspection, { state: "absent" | "stale" }>,
  lockPath: string,
): DaemonRuntimeOwnershipError {
  if (inspection.state === "live") {
    return new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
      `Refusing daemon startup because pid ${inspection.guard.pid} is recovering ${lockPath} under guard ${inspection.recoveryPath}`,
      lockPath,
    );
  }
  return new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
    `Refusing daemon startup because recovery guard ${inspection.recoveryPath} cannot be trusted: ${inspection.reason}`,
    lockPath,
  );
}

function quarantineStaleRecoveryGuard(recoveryPath: string, lockPath: string): string | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inspection = readRecoveryGuardInspection(recoveryPath);
    if (inspection.state === "absent") return undefined;
    if (inspection.state === "live" || inspection.state === "untrusted") {
      throw recoveryGuardErrorFromInspection(inspection, lockPath);
    }

    // Re-read immediately before the atomic rename so a concurrent recovery
    // that replaced this guard cannot be mistaken for the abandoned owner.
    const current = readRecoveryGuardInspection(recoveryPath);
    if (current.state === "absent") continue;
    if (current.state === "live" || current.state === "untrusted") {
      throw recoveryGuardErrorFromInspection(current, lockPath);
    }
    if (current.guard.instanceId !== inspection.guard.instanceId) continue;

    const quarantinePath = `${recoveryPath}.stale.${Date.now()}.${current.guard.instanceId}.${randomUUID()}`;
    try {
      renameSync(recoveryPath, quarantinePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw new DaemonRuntimeOwnershipError(
        DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
        `Unable to quarantine stale recovery guard ${recoveryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        lockPath,
      );
    }

    const quarantined = readRecoveryGuardInspection(quarantinePath);
    if (
      quarantined.state !== "untrusted" &&
      quarantined.state !== "absent" &&
      quarantined.guard.instanceId === current.guard.instanceId
    ) {
      return quarantinePath;
    }

    if (!existsSync(recoveryPath)) {
      try {
        renameSync(quarantinePath, recoveryPath);
      } catch (error) {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
          `Recovery guard ${recoveryPath} changed while being quarantined and could not be restored: ${
            error instanceof Error ? error.message : String(error)
          }`,
          lockPath,
        );
      }
    }
    throw new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
      `Recovery guard ${recoveryPath} changed while being quarantined; refusing daemon startup`,
      lockPath,
    );
  }

  throw new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
    `Recovery guard ${recoveryPath} changed repeatedly while establishing ownership`,
    lockPath,
  );
}

function makeLease(
  lockPath: string,
  owner: DaemonRuntimeOwner,
  quarantinedLockPath?: string,
  quarantinedRecoveryGuardPath?: string,
): DaemonRuntimeOwnershipLease {
  let released = false;
  return {
    lockPath,
    owner,
    quarantinedLockPath,
    quarantinedRecoveryGuardPath,
    release: () => {
      if (released) return false;
      released = true;
      return removeOwnedJson(lockPath, owner.instanceId);
    },
  };
}

export function acquireDaemonRuntimeOwnership(opts: {
  channel: ChannelName;
  mode: DaemonRuntimeMode;
  version: string;
  home: string;
}): DaemonRuntimeOwnershipLease {
  const home = canonicalHome(opts.home, true);
  const lockPath = join(home, "state", "daemon-runtime.lock");
  const recoveryPath = recoveryGuardPath(lockPath);
  const processStart = inspectProcessStart(process.pid);
  if (processStart.state !== "present") {
    const reason = processStart.state === "gone" ? "current process disappeared during startup" : processStart.reason;
    throw new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
      `Cannot establish the current daemon process start identity: ${reason}`,
      lockPath,
    );
  }

  const owner: DaemonRuntimeOwner = {
    lockVersion: LOCK_FORMAT_VERSION,
    instanceId: randomUUID(),
    pid: process.pid,
    processStartIdentity: processStart.identity,
    channel: opts.channel,
    mode: opts.mode,
    version: opts.version,
    startedAt: new Date().toISOString(),
    home,
  };

  let quarantinedRecoveryGuardPath = quarantineStaleRecoveryGuard(recoveryPath, lockPath);

  const firstAttempt = tryWriteExclusiveJson(lockPath, owner);
  if (firstAttempt === "created") {
    const racedRecovery = readRecoveryGuardInspection(recoveryPath);
    if (racedRecovery.state !== "absent") {
      removeOwnedJson(lockPath, owner.instanceId);
      if (racedRecovery.state === "live" || racedRecovery.state === "untrusted") {
        throw recoveryGuardErrorFromInspection(racedRecovery, lockPath);
      }
      throw new DaemonRuntimeOwnershipError(
        DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
        `Refusing daemon startup because abandoned stale-lock recovery raced this owner at ${recoveryPath}`,
        lockPath,
      );
    }
    return makeLease(lockPath, owner, undefined, quarantinedRecoveryGuardPath);
  }

  const firstInspection = readOwnerInspection(lockPath, home);
  if (firstInspection.state === "live" || firstInspection.state === "untrusted") {
    throw ownershipErrorFromInspection(firstInspection);
  }

  const recovery: RecoveryGuard = {
    lockVersion: LOCK_FORMAT_VERSION,
    instanceId: randomUUID(),
    pid: process.pid,
    processStartIdentity: processStart.identity,
    startedAt: new Date().toISOString(),
  };
  quarantinedRecoveryGuardPath = quarantineStaleRecoveryGuard(recoveryPath, lockPath) ?? quarantinedRecoveryGuardPath;
  if (tryWriteExclusiveJson(recoveryPath, recovery) === "exists") {
    const inspection = readRecoveryGuardInspection(recoveryPath);
    if (inspection.state === "live" || inspection.state === "untrusted") {
      throw recoveryGuardErrorFromInspection(inspection, lockPath);
    }
    throw new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
      `Refusing daemon startup because recovery ownership for ${lockPath} changed concurrently`,
      lockPath,
    );
  }

  let quarantinedLockPath: string | undefined;
  try {
    const guardedInspection = readOwnerInspection(lockPath, home);
    if (guardedInspection.state === "live" || guardedInspection.state === "untrusted") {
      throw ownershipErrorFromInspection(guardedInspection);
    }
    if (guardedInspection.state === "stale") {
      quarantinedLockPath = `${lockPath}.stale.${Date.now()}.${guardedInspection.owner.instanceId}.${recovery.instanceId}`;
      try {
        renameSync(lockPath, quarantinedLockPath);
      } catch (error) {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
          `Unable to quarantine stale daemon ownership file ${lockPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          lockPath,
          guardedInspection.owner,
        );
      }
    }

    // Exactly one retry is allowed after the stale owner has been isolated (or
    // after a colliding owner released between the first read and the guard).
    if (tryWriteExclusiveJson(lockPath, owner) === "exists") {
      const retryInspection = readOwnerInspection(lockPath, home);
      if (retryInspection.state === "absent") {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
          `Daemon ownership changed again while retrying ${lockPath}; refusing a second retry`,
          lockPath,
        );
      }
      throw ownershipErrorFromInspection(retryInspection);
    }
    return makeLease(lockPath, owner, quarantinedLockPath, quarantinedRecoveryGuardPath);
  } finally {
    // A concurrent stale-guard inspector may have atomically moved this guard
    // aside just before discovering the instance mismatch. Give that process a
    // bounded window to restore our live guard, then remove only our instance.
    removeOwnedRecoveryGuard(recoveryPath, recovery.instanceId);
  }
}

export function formatDaemonRuntimeOwner(owner: DaemonRuntimeOwner): string {
  return `instance ${owner.instanceId} (pid ${owner.pid}, start ${owner.processStartIdentity}, channel ${owner.channel}, mode ${owner.mode}, version ${owner.version}, since ${owner.startedAt})`;
}

export function formatDaemonRuntimeOwnerSummary(owner: DaemonRuntimeOwner): string {
  return `pid ${owner.pid}, ${owner.channel}/${owner.mode}, v${owner.version}, since ${owner.startedAt}`;
}
