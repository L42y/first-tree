import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ChannelName } from "@first-tree/shared/channel";

const LOCK_FORMAT_VERSION = 1;
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const RECOVERY_GUARD_CLEANUP_RETRIES = 50;
const RECOVERY_GUARD_CLEANUP_RETRY_MS = 10;
const RECOVERY_FENCE_DRAIN_RETRIES = 3_000;
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

export type DaemonRuntimeRecoveryGuard = {
  lockVersion: 1;
  instanceId: string;
  pid: number;
  processStartIdentity: string;
  startedAt: string;
};

type RecoveryGuard = DaemonRuntimeRecoveryGuard;

type ParsedRecoveryGuard = { ok: true; guard: RecoveryGuard } | { ok: false; reason: string };

export type DaemonRuntimeRecoveryGuardInspection =
  | { state: "absent"; recoveryPath: string }
  | { state: "live"; recoveryPath: string; guard: RecoveryGuard }
  | { state: "stale"; recoveryPath: string; guard: RecoveryGuard; reason: string }
  | { state: "untrusted"; recoveryPath: string; guard?: RecoveryGuard; reason: string };

type RecoveryGuardInspection = DaemonRuntimeRecoveryGuardInspection;

export type DaemonRuntimeRecoveryEvidence = {
  lockPath: string;
  fence: DaemonRuntimeRecoveryGuardInspection;
  repairGuard: DaemonRuntimeRecoveryGuardInspection;
  repairSlots: Array<{ path: string; inspection: DaemonRuntimeRecoveryGuardInspection; ticket?: string }>;
  main: DaemonRuntimeOwnershipInspection;
  quarantineCandidates: Array<{
    path: string;
    fileIdentity?: string;
    inspection: DaemonRuntimeOwnershipInspection;
  }>;
  entrants: Array<{ path: string; inspection: DaemonRuntimeRecoveryGuardInspection }>;
};

export type DaemonRuntimeOwnershipRepairResult = {
  repaired: boolean;
  lockPath: string;
  reconciledState?: "owner" | "empty";
  restoredFrom?: string;
  evidence: DaemonRuntimeRecoveryEvidence;
};

export function daemonRuntimeOwnershipPath(home: string): string {
  return join(canonicalHome(home, false), "state", "daemon-runtime.lock");
}

export function daemonRuntimeHomesEqual(left: string, right: string): boolean {
  return daemonRuntimeOwnershipPath(left) === daemonRuntimeOwnershipPath(right);
}

function recoveryGuardPath(lockPath: string): string {
  return `${lockPath}.recovery`;
}

function recoveryMutationFencePath(lockPath: string): string {
  return `${lockPath}.recovery-fence`;
}

function ownershipRepairGuardPath(lockPath: string): string {
  return `${lockPath}.repair`;
}

function ownershipEntrantPath(lockPath: string, instanceId: string): string {
  return `${lockPath}.entrant.${instanceId}`;
}

function ownershipRepairSlotPath(lockPath: string, instanceId: string): string {
  return `${lockPath}.repair-slot.${instanceId}`;
}

function ownershipRepairTicketPath(lockPath: string, instanceId: string): string {
  return `${lockPath}.repair-ticket.${instanceId}`;
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

function listPathsWithPrefix(path: string, suffixPrefix: string): string[] {
  const directory = dirname(path);
  if (!existsSync(directory)) return [];
  const prefix = `${basename(path)}${suffixPrefix}`;
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(directory, name))
    .sort();
}

type RepairTicketInspection =
  | { state: "absent"; path: string }
  | { state: "valid"; path: string; guard: RecoveryGuard; ticket: string }
  | { state: "untrusted"; path: string; reason: string };

function readRepairTicketInspection(path: string): RepairTicketInspection {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent", path };
    return {
      state: "untrusted",
      path,
      reason: `unable to read repair ticket: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      state: "untrusted",
      path,
      reason: `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!isRecord(value) || typeof value.ticket !== "string" || !/^[1-9]\d*$/u.test(value.ticket)) {
    return { state: "untrusted", path, reason: "repair ticket is missing or invalid" };
  }
  const parsed = parseRecoveryGuard(raw);
  if (!parsed.ok) return { state: "untrusted", path, reason: parsed.reason };
  return { state: "valid", path, guard: parsed.guard, ticket: value.ticket };
}

function inspectDaemonRuntimeRecoveryEvidenceForResolvedHome(
  resolvedHome: string,
  lockPath: string,
): DaemonRuntimeRecoveryEvidence {
  return {
    lockPath,
    fence: readRecoveryGuardInspection(recoveryMutationFencePath(lockPath)),
    repairGuard: readRecoveryGuardInspection(ownershipRepairGuardPath(lockPath)),
    repairSlots: listPathsWithPrefix(lockPath, ".repair-slot.").map((path) => {
      const inspection = readRecoveryGuardInspection(path);
      const instanceId = inspection.state === "absent" ? undefined : inspection.guard?.instanceId;
      const ticket = instanceId
        ? readRepairTicketInspection(ownershipRepairTicketPath(lockPath, instanceId))
        : undefined;
      return {
        path,
        inspection,
        ticket: ticket?.state === "valid" ? ticket.ticket : undefined,
      };
    }),
    main: readOwnerInspection(lockPath, resolvedHome),
    quarantineCandidates: [
      ...listPathsWithPrefix(lockPath, ".stale."),
      ...listPathsWithPrefix(lockPath, ".repair-stale."),
    ].map((path) => ({
      path,
      fileIdentity: publishedFileIdentity(path),
      inspection: readOwnerInspection(path, resolvedHome),
    })),
    entrants: listPathsWithPrefix(lockPath, ".entrant.").map((path) => ({
      path,
      inspection: readRecoveryGuardInspection(path),
    })),
  };
}

export function inspectDaemonRuntimeRecoveryEvidence(home: string): DaemonRuntimeRecoveryEvidence {
  const resolvedHome = canonicalHome(home, false);
  const lockPath = join(resolvedHome, "state", "daemon-runtime.lock");
  return inspectDaemonRuntimeRecoveryEvidenceForResolvedHome(resolvedHome, lockPath);
}

function formatRecoveryGuardInspection(label: string, inspection: RecoveryGuardInspection): string {
  if (inspection.state === "absent") return `${label}=absent`;
  const holder = inspection.guard
    ? `instance ${inspection.guard.instanceId}, pid ${inspection.guard.pid}, start ${inspection.guard.processStartIdentity}`
    : "holder unavailable";
  const reason = inspection.state === "stale" || inspection.state === "untrusted" ? `, ${inspection.reason}` : "";
  return `${label}=${inspection.state} (${holder}${reason})`;
}

function formatOwnerInspection(label: string, inspection: DaemonRuntimeOwnershipInspection): string {
  if (inspection.state === "absent") return `${label}=absent`;
  if (inspection.state === "untrusted" && !inspection.owner) {
    return `${label}=untrusted (${inspection.reason})`;
  }
  const owner = inspection.owner;
  const reason = inspection.state === "stale" || inspection.state === "untrusted" ? `, ${inspection.reason}` : "";
  return `${label}=${inspection.state} (instance ${owner?.instanceId ?? "unknown"}, pid ${
    owner?.pid ?? "unknown"
  }, start ${owner?.processStartIdentity ?? "unknown"}${reason})`;
}

export function formatDaemonRuntimeRecoveryEvidence(evidence: DaemonRuntimeRecoveryEvidence): string[] {
  const lines = [
    formatRecoveryGuardInspection("fence", evidence.fence),
    formatRecoveryGuardInspection("repair-guard", evidence.repairGuard),
    formatOwnerInspection("main", evidence.main),
  ];
  if (evidence.repairSlots.length === 0) {
    lines.push("repair=none");
  } else {
    for (const slot of evidence.repairSlots) {
      lines.push(
        `${formatRecoveryGuardInspection(`repair ${slot.path}`, slot.inspection)}, ticket=${slot.ticket ?? "none"}`,
      );
    }
  }
  if (evidence.quarantineCandidates.length === 0) {
    lines.push("quarantine=none");
  } else {
    for (const candidate of evidence.quarantineCandidates) {
      lines.push(
        `${formatOwnerInspection(`quarantine ${candidate.path}`, candidate.inspection)}, file=${
          candidate.fileIdentity ?? "unavailable"
        }`,
      );
    }
    const candidateInstances = new Set(
      evidence.quarantineCandidates.flatMap((candidate) =>
        candidate.inspection.state === "live" || candidate.inspection.state === "stale"
          ? [candidate.inspection.owner.instanceId]
          : [],
      ),
    );
    if (candidateInstances.size > 1) {
      lines.push(`quarantine-ambiguity=${[...candidateInstances].join(",")}`);
    }
  }
  lines.push(`entrants=${evidence.entrants.length}`);
  return lines;
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
  const recoveryEvidence = inspectDaemonRuntimeRecoveryEvidenceForResolvedHome(resolvedHome, lockPath);
  const mutationFenceInspection = recoveryEvidence.fence;
  if (mutationFenceInspection.state !== "absent") {
    return {
      state: "untrusted",
      lockPath,
      reason: formatDaemonRuntimeRecoveryEvidence(recoveryEvidence).join("; "),
    };
  }
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

function tryWriteCompleteJsonTempExclusive(path: string, value: unknown): "created" | "exists" {
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
      `Unable to create complete ownership publication temp ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readInstanceId(path: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return isRecord(value) && typeof value.instanceId === "string" ? value.instanceId : undefined;
}

function publishedJsonFingerprint(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

function publishedFileIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
}

function assertExactStaleRecoveryRecord(
  path: string,
  instanceId: string,
  fingerprint: string,
  lockPath: string,
  label: string,
): RecoveryGuard {
  const inspection = readRecoveryGuardInspection(path);
  if (
    inspection.state === "stale" &&
    inspection.guard.instanceId === instanceId &&
    publishedJsonFingerprint(path) === fingerprint
  ) {
    return inspection.guard;
  }
  throw new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
    `${label} ${path} changed from exact stale instance ${instanceId}`,
    lockPath,
  );
}

function restoreQuarantinedFileIfAbsent(quarantinePath: string, path: string): boolean {
  try {
    // A hard link is an exclusive, non-overwriting restore: unlike rename on
    // POSIX it cannot replace a contender that claimed the canonical path.
    linkSync(quarantinePath, path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    return false;
  }
  try {
    rmSync(quarantinePath);
  } catch {
    // The canonical link is authoritative even if the quarantine alias remains.
  }
  return true;
}

function restoreQuarantinedFileWithRetries(quarantinePath: string, path: string): boolean {
  for (let attempt = 0; attempt < RECOVERY_GUARD_CLEANUP_RETRIES; attempt += 1) {
    if (restoreQuarantinedFileIfAbsent(quarantinePath, path)) return true;
    if (!existsSync(quarantinePath)) return false;
    if (attempt + 1 < RECOVERY_GUARD_CLEANUP_RETRIES) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECOVERY_GUARD_CLEANUP_RETRY_MS);
    }
  }
  return false;
}

function cleanupStaleOwnershipPublicationTemps(lockPath: string): void {
  const directory = dirname(lockPath);
  if (!existsSync(directory)) return;
  const prefix = `${basename(lockPath)}.publish-temp.`;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const tempPath = join(directory, name);
    const inspection = readRecoveryGuardInspection(tempPath);
    if (inspection.state === "stale") removeOwnedJson(tempPath, inspection.guard.instanceId);
  }
}

type OwnershipPublicationKind =
  | "main"
  | "recovery"
  | "fence"
  | "entrant"
  | "repair-guard"
  | "repair-slot"
  | "repair-ticket";

function tryPublishCompleteJsonExclusive<T extends { instanceId: string }>(
  lockPath: string,
  path: string,
  kind: OwnershipPublicationKind,
  value: T,
): "created" | "exists" {
  const tempPath = `${lockPath}.publish-temp.${kind}.${value.instanceId}.${randomUUID()}`;
  if (tryWriteCompleteJsonTempExclusive(tempPath, value) === "exists") {
    throw new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
      `Unable to create unique ownership publication temp ${tempPath}`,
      lockPath,
    );
  }
  try {
    linkSync(tempPath, path);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return "exists";
    throw new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
      `Unable to publish ownership record ${path}: ${error instanceof Error ? error.message : String(error)}`,
      lockPath,
    );
  } finally {
    removeOwnedJson(tempPath, value.instanceId);
  }
  return "created";
}

function publishCompleteJson<T extends { instanceId: string }>(
  lockPath: string,
  path: string,
  kind: OwnershipPublicationKind,
  value: T,
): void {
  if (tryPublishCompleteJsonExclusive(lockPath, path, kind, value) === "created") return;
  throw new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
    `Unable to publish unique ownership record ${path}: the path already exists`,
    lockPath,
  );
}

function publishOwnershipEntrant(lockPath: string, entrant: RecoveryGuard): string {
  const entrantPath = ownershipEntrantPath(lockPath, entrant.instanceId);
  // The scanner ignores publish-temp paths. The hard link publishes the
  // already-fsynced inode atomically and cannot overwrite another path.
  publishCompleteJson(lockPath, entrantPath, "entrant", entrant);
  return entrantPath;
}

function removeOwnedJson(path: string, instanceId: string): boolean {
  if (readInstanceId(path) !== instanceId) return false;
  const cleanupPath = `${path}.cleanup.${instanceId}.${randomUUID()}`;
  try {
    renameSync(path, cleanupPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    return false;
  }
  if (readInstanceId(cleanupPath) !== instanceId) {
    restoreQuarantinedFileIfAbsent(cleanupPath, path);
    return false;
  }
  try {
    rmSync(cleanupPath);
    return true;
  } catch {
    restoreQuarantinedFileIfAbsent(cleanupPath, path);
    return false;
  }
}

function removeExactOwnedJson(path: string, instanceId: string, fingerprint: string): boolean {
  if (readInstanceId(path) !== instanceId || publishedJsonFingerprint(path) !== fingerprint) return false;
  const cleanupPath = `${path}.cleanup.${instanceId}.${randomUUID()}`;
  try {
    renameSync(path, cleanupPath);
  } catch {
    return false;
  }
  if (readInstanceId(cleanupPath) !== instanceId || publishedJsonFingerprint(cleanupPath) !== fingerprint) {
    restoreQuarantinedFileIfAbsent(cleanupPath, path);
    return false;
  }
  try {
    rmSync(cleanupPath);
    return true;
  } catch {
    restoreQuarantinedFileIfAbsent(cleanupPath, path);
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

function assertOwnedRecoveryGuard(recoveryPath: string, recovery: RecoveryGuard, lockPath: string): void {
  const inspection = readRecoveryGuardInspection(recoveryPath);
  if (inspection.state === "live" && inspection.guard.instanceId === recovery.instanceId) return;
  if (inspection.state === "untrusted") {
    throw recoveryGuardErrorFromInspection(inspection, lockPath);
  }
  throw new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
    `Recovery guard ${recoveryPath} is no longer held by exact instance ${recovery.instanceId}; refusing daemon startup`,
    lockPath,
  );
}

function mutationFenceError(
  inspection: Exclude<RecoveryGuardInspection, { state: "absent" }>,
  lockPath: string,
): DaemonRuntimeOwnershipError {
  if (inspection.state === "live") {
    return new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
      `Refusing daemon startup because pid ${inspection.guard.pid} is mutating ${lockPath} under fence ${inspection.recoveryPath}`,
      lockPath,
    );
  }
  return new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
    `Refusing daemon startup because ownership recovery fence ${inspection.recoveryPath} is present; inspect status or doctor, then run daemon repair-ownership`,
    lockPath,
  );
}

function assertNoRecoveryMutationFence(fencePath: string, lockPath: string): void {
  const inspection = readRecoveryGuardInspection(fencePath);
  if (inspection.state !== "absent") throw mutationFenceError(inspection, lockPath);
}

function assertOwnedRecoveryMutationFence(fencePath: string, recovery: RecoveryGuard, lockPath: string): void {
  const inspection = readRecoveryGuardInspection(fencePath);
  if (inspection.state === "live" && inspection.guard.instanceId === recovery.instanceId) return;
  if (inspection.state !== "absent") throw mutationFenceError(inspection, lockPath);
  throw new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
    `Ownership recovery fence ${fencePath} disappeared during main-lock mutation; refusing daemon startup`,
    lockPath,
  );
}

function drainOwnershipEntrants(lockPath: string, ownEntrantPath: string): void {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.entrant.`;
  for (let attempt = 0; attempt < RECOVERY_FENCE_DRAIN_RETRIES; attempt += 1) {
    let blocked = false;
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix)) continue;
      const entrantPath = join(directory, name);
      if (entrantPath === ownEntrantPath) continue;
      const inspection = readRecoveryGuardInspection(entrantPath);
      if (inspection.state === "absent") continue;
      if (inspection.state === "stale") {
        removeOwnedJson(entrantPath, inspection.guard.instanceId);
        continue;
      }
      if (inspection.state === "untrusted") {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
          `Refusing daemon startup because ownership entrant ${entrantPath} cannot be trusted: ${inspection.reason}`,
          lockPath,
        );
      }
      blocked = true;
    }
    if (!blocked) return;
    if (attempt + 1 < RECOVERY_FENCE_DRAIN_RETRIES) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECOVERY_GUARD_CLEANUP_RETRY_MS);
    }
  }
  throw new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
    `Timed out draining in-flight daemon ownership entrants before recovering ${lockPath}`,
    lockPath,
  );
}

type OwnershipRepairLease = {
  guard: RecoveryGuard;
  repairPath: string;
  repairFingerprint: string;
  assertOwned: () => void;
  release: () => void;
};

function repairOrderIsEarlier(leftTicket: string, leftId: string, rightTicket: string, rightId: string): boolean {
  const left = BigInt(leftTicket);
  const right = BigInt(rightTicket);
  return left < right || (left === right && leftId < rightId);
}

function assertOwnedOwnershipRepairGuard(
  repairPath: string,
  guard: RecoveryGuard,
  repairFingerprint: string,
  lockPath: string,
): void {
  const inspection = readRecoveryGuardInspection(repairPath);
  if (
    inspection.state === "live" &&
    inspection.guard.instanceId === guard.instanceId &&
    publishedJsonFingerprint(repairPath) === repairFingerprint
  ) {
    return;
  }
  throw new DaemonRuntimeOwnershipError(
    inspection.state === "untrusted"
      ? DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock
      : DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
    `Ownership repair guard ${repairPath} is not held by exact instance ${guard.instanceId}${
      inspection.state === "untrusted" ? `: ${inspection.reason}` : ""
    }`,
    lockPath,
  );
}

function acquireCanonicalOwnershipRepairGuard(
  lockPath: string,
  guard: RecoveryGuard,
): { repairPath: string; repairFingerprint: string } {
  const repairPath = ownershipRepairGuardPath(lockPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inspection = readRecoveryGuardInspection(repairPath);
    if (inspection.state === "live") {
      throw new DaemonRuntimeOwnershipError(
        DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
        `Ownership repair is already active at ${repairPath} under instance ${inspection.guard.instanceId}, pid ${inspection.guard.pid}`,
        lockPath,
      );
    }
    if (inspection.state === "untrusted") {
      throw new DaemonRuntimeOwnershipError(
        DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
        `Ownership repair guard ${repairPath} cannot be trusted: ${inspection.reason}`,
        lockPath,
      );
    }
    if (inspection.state === "stale") {
      const staleFingerprint = publishedJsonFingerprint(repairPath);
      if (!staleFingerprint || !removeExactOwnedJson(repairPath, inspection.guard.instanceId, staleFingerprint)) {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
          `Ownership repair guard ${repairPath} changed while reclaiming stale instance ${inspection.guard.instanceId}`,
          lockPath,
        );
      }
    }
    if (inspection.state === "stale") continue;
    if (tryPublishCompleteJsonExclusive(lockPath, repairPath, "repair-guard", guard) === "created") {
      const repairFingerprint = publishedJsonFingerprint(repairPath);
      if (!repairFingerprint) {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
          `Ownership repair guard ${repairPath} could not be fingerprinted after publication`,
          lockPath,
        );
      }
      assertOwnedOwnershipRepairGuard(repairPath, guard, repairFingerprint, lockPath);
      return { repairPath, repairFingerprint };
    }
  }
  throw new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
    `Ownership repair guard ${repairPath} changed repeatedly`,
    lockPath,
  );
}

function acquireOwnershipRepairLease(lockPath: string, processStartIdentity: string): OwnershipRepairLease {
  const guard: RecoveryGuard = {
    lockVersion: LOCK_FORMAT_VERSION,
    instanceId: randomUUID(),
    pid: process.pid,
    processStartIdentity,
    startedAt: new Date().toISOString(),
  };
  const slotPath = ownershipRepairSlotPath(lockPath, guard.instanceId);
  const ticketPath = ownershipRepairTicketPath(lockPath, guard.instanceId);
  publishCompleteJson(lockPath, slotPath, "repair-slot", guard);

  let released = false;
  let repairPath: string | undefined;
  let repairFingerprint: string | undefined;
  const release = () => {
    if (released) return;
    released = true;
    if (repairPath && repairFingerprint) removeExactOwnedJson(repairPath, guard.instanceId, repairFingerprint);
    removeOwnedJson(ticketPath, guard.instanceId);
    removeOwnedJson(slotPath, guard.instanceId);
  };

  try {
    let maxTicket = 0n;
    for (const path of listPathsWithPrefix(lockPath, ".repair-slot.")) {
      const inspection = readRecoveryGuardInspection(path);
      if (inspection.state === "stale") {
        removeOwnedJson(ownershipRepairTicketPath(lockPath, inspection.guard.instanceId), inspection.guard.instanceId);
        removeOwnedJson(path, inspection.guard.instanceId);
        continue;
      }
      if (inspection.state === "untrusted") {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
          `Repair slot ${path} cannot be trusted: ${inspection.reason}`,
          lockPath,
        );
      }
      if (inspection.state === "absent") continue;
      const ticket = readRepairTicketInspection(ownershipRepairTicketPath(lockPath, inspection.guard.instanceId));
      if (ticket.state === "untrusted") {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
          `Repair ticket ${ticket.path} cannot be trusted: ${ticket.reason}`,
          lockPath,
        );
      }
      if (ticket.state === "valid") {
        if (ticket.guard.instanceId !== inspection.guard.instanceId) {
          throw new DaemonRuntimeOwnershipError(
            DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
            `Repair ticket ${ticket.path} does not match slot instance ${inspection.guard.instanceId}`,
            lockPath,
          );
        }
        const value = BigInt(ticket.ticket);
        if (value > maxTicket) maxTicket = value;
      }
    }

    const ownTicket = (maxTicket + 1n).toString();
    publishCompleteJson(lockPath, ticketPath, "repair-ticket", { ...guard, ticket: ownTicket });

    for (let attempt = 0; attempt < RECOVERY_FENCE_DRAIN_RETRIES; attempt += 1) {
      let blocked = false;
      for (const path of listPathsWithPrefix(lockPath, ".repair-slot.")) {
        const inspection = readRecoveryGuardInspection(path);
        if (inspection.state === "absent") continue;
        if (inspection.state === "stale") {
          removeOwnedJson(
            ownershipRepairTicketPath(lockPath, inspection.guard.instanceId),
            inspection.guard.instanceId,
          );
          removeOwnedJson(path, inspection.guard.instanceId);
          continue;
        }
        if (inspection.state === "untrusted") {
          throw new DaemonRuntimeOwnershipError(
            DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
            `Repair slot ${path} cannot be trusted: ${inspection.reason}`,
            lockPath,
          );
        }
        if (inspection.guard.instanceId === guard.instanceId) continue;
        const ticket = readRepairTicketInspection(ownershipRepairTicketPath(lockPath, inspection.guard.instanceId));
        if (ticket.state === "absent") {
          blocked = true;
          continue;
        }
        if (ticket.state === "untrusted" || ticket.guard.instanceId !== inspection.guard.instanceId) {
          throw new DaemonRuntimeOwnershipError(
            DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
            `Repair ticket ${ticket.path} cannot be trusted${
              ticket.state === "untrusted" ? `: ${ticket.reason}` : ": instance mismatch"
            }`,
            lockPath,
          );
        }
        if (repairOrderIsEarlier(ticket.ticket, inspection.guard.instanceId, ownTicket, guard.instanceId)) {
          blocked = true;
        }
      }
      if (!blocked) {
        const acquired = acquireCanonicalOwnershipRepairGuard(lockPath, guard);
        repairPath = acquired.repairPath;
        repairFingerprint = acquired.repairFingerprint;
        return {
          guard,
          repairPath: acquired.repairPath,
          repairFingerprint: acquired.repairFingerprint,
          assertOwned: () =>
            assertOwnedOwnershipRepairGuard(acquired.repairPath, guard, acquired.repairFingerprint, lockPath),
          release,
        };
      }
      if (attempt + 1 < RECOVERY_FENCE_DRAIN_RETRIES) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RECOVERY_GUARD_CLEANUP_RETRY_MS);
      }
    }
    throw new DaemonRuntimeOwnershipError(
      DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
      `Timed out waiting for an earlier ownership repair for ${lockPath}`,
      lockPath,
    );
  } catch (error) {
    release();
    throw error;
  }
}

function assertOwnedMainLock(lockPath: string, home: string, owner: DaemonRuntimeOwner): void {
  const inspection = readOwnerInspection(lockPath, home);
  if (inspection.state === "live" && inspection.owner.instanceId === owner.instanceId) return;
  if (inspection.state === "live" || inspection.state === "untrusted") {
    throw ownershipErrorFromInspection(inspection);
  }
  throw new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
    `Daemon ownership ${lockPath} is no longer held by exact instance ${owner.instanceId}; refusing daemon startup`,
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

    restoreQuarantinedFileIfAbsent(quarantinePath, recoveryPath);
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

  const entrant: RecoveryGuard = {
    lockVersion: LOCK_FORMAT_VERSION,
    instanceId: owner.instanceId,
    pid: process.pid,
    processStartIdentity: processStart.identity,
    startedAt: new Date().toISOString(),
  };
  const fencePath = recoveryMutationFencePath(lockPath);
  cleanupStaleOwnershipPublicationTemps(lockPath);
  const entrantPath = publishOwnershipEntrant(lockPath, entrant);

  try {
    assertNoRecoveryMutationFence(fencePath, lockPath);
    let quarantinedRecoveryGuardPath = quarantineStaleRecoveryGuard(recoveryPath, lockPath);
    assertNoRecoveryMutationFence(fencePath, lockPath);

    const firstAttempt = tryPublishCompleteJsonExclusive(lockPath, lockPath, "main", owner);
    if (firstAttempt === "created") {
      const racedRecovery = readRecoveryGuardInspection(recoveryPath);
      const racedFence = readRecoveryGuardInspection(fencePath);
      if (racedRecovery.state !== "absent" || racedFence.state !== "absent") {
        removeOwnedJson(lockPath, owner.instanceId);
        if (racedFence.state !== "absent") throw mutationFenceError(racedFence, lockPath);
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
    assertNoRecoveryMutationFence(fencePath, lockPath);
    if (tryPublishCompleteJsonExclusive(lockPath, recoveryPath, "recovery", recovery) === "exists") {
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
    let quarantinedOwnerInstanceId: string | undefined;
    let ownerCreated = false;
    let fenceOwned = false;
    let safeToRemoveFence = false;
    try {
      assertOwnedRecoveryGuard(recoveryPath, recovery, lockPath);
      if (tryPublishCompleteJsonExclusive(lockPath, fencePath, "fence", recovery) === "exists") {
        const inspection = readRecoveryGuardInspection(fencePath);
        if (inspection.state !== "absent") throw mutationFenceError(inspection, lockPath);
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
          `Ownership recovery fence ${fencePath} changed while being acquired`,
          lockPath,
        );
      }
      fenceOwned = true;
      assertOwnedRecoveryGuard(recoveryPath, recovery, lockPath);
      assertOwnedRecoveryMutationFence(fencePath, recovery, lockPath);

      // Every acquisition publishes an entrant before checking the fence.
      // Once the fence exists, draining all older entrants closes the gap
      // between their last fence check and a possible main-lock write.
      drainOwnershipEntrants(lockPath, entrantPath);
      assertOwnedRecoveryGuard(recoveryPath, recovery, lockPath);
      assertOwnedRecoveryMutationFence(fencePath, recovery, lockPath);

      const guardedInspection = readOwnerInspection(lockPath, home);
      if (guardedInspection.state === "live" || guardedInspection.state === "untrusted") {
        safeToRemoveFence = true;
        throw ownershipErrorFromInspection(guardedInspection);
      }
      if (guardedInspection.state === "stale") {
        quarantinedOwnerInstanceId = guardedInspection.owner.instanceId;
        quarantinedLockPath = `${lockPath}.stale.${Date.now()}.${guardedInspection.owner.instanceId}.${recovery.instanceId}`;
        assertOwnedRecoveryGuard(recoveryPath, recovery, lockPath);
        assertOwnedRecoveryMutationFence(fencePath, recovery, lockPath);
        try {
          renameSync(lockPath, quarantinedLockPath);
        } catch (error) {
          safeToRemoveFence = errorCode(error) === "ENOENT";
          throw new DaemonRuntimeOwnershipError(
            DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.io,
            `Unable to quarantine stale daemon ownership file ${lockPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            lockPath,
            guardedInspection.owner,
          );
        }
        const movedOwner = readInstanceId(quarantinedLockPath);
        if (movedOwner !== guardedInspection.owner.instanceId) {
          safeToRemoveFence = restoreQuarantinedFileWithRetries(quarantinedLockPath, lockPath);
          throw new DaemonRuntimeOwnershipError(
            DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
            `Daemon ownership ${lockPath} changed while being quarantined; refusing daemon startup`,
            lockPath,
          );
        }
        try {
          assertOwnedRecoveryGuard(recoveryPath, recovery, lockPath);
          assertOwnedRecoveryMutationFence(fencePath, recovery, lockPath);
        } catch (error) {
          safeToRemoveFence = restoreQuarantinedFileWithRetries(quarantinedLockPath, lockPath);
          throw error;
        }
      } else {
        safeToRemoveFence = true;
      }

      // Exactly one retry is allowed after the stale owner has been isolated
      // (or after a colliding owner released while entrants were drained).
      assertOwnedRecoveryGuard(recoveryPath, recovery, lockPath);
      assertOwnedRecoveryMutationFence(fencePath, recovery, lockPath);
      if (tryPublishCompleteJsonExclusive(lockPath, lockPath, "main", owner) === "exists") {
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
      ownerCreated = true;
      assertOwnedRecoveryGuard(recoveryPath, recovery, lockPath);
      assertOwnedRecoveryMutationFence(fencePath, recovery, lockPath);
      assertOwnedMainLock(lockPath, home, owner);
      safeToRemoveFence = true;
      if (!removeOwnedRecoveryGuard(fencePath, recovery.instanceId)) {
        throw new DaemonRuntimeOwnershipError(
          DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
          `Unable to release exact ownership recovery fence ${fencePath}; refusing daemon startup`,
          lockPath,
        );
      }
      fenceOwned = false;
      assertOwnedMainLock(lockPath, home, owner);
      assertOwnedRecoveryGuard(recoveryPath, recovery, lockPath);
      return makeLease(lockPath, owner, quarantinedLockPath, quarantinedRecoveryGuardPath);
    } catch (error) {
      if (ownerCreated) removeOwnedJson(lockPath, owner.instanceId);
      if (quarantinedLockPath && existsSync(quarantinedLockPath)) {
        safeToRemoveFence =
          restoreQuarantinedFileWithRetries(quarantinedLockPath, lockPath) &&
          readInstanceId(lockPath) === quarantinedOwnerInstanceId;
      }
      if (fenceOwned && safeToRemoveFence && removeOwnedRecoveryGuard(fencePath, recovery.instanceId)) {
        fenceOwned = false;
      }
      throw error;
    } finally {
      // A concurrent stale-guard inspector may have atomically moved this guard
      // aside just before discovering the instance mismatch. Give that process
      // a bounded window to restore our live guard, then remove only our instance.
      removeOwnedRecoveryGuard(recoveryPath, recovery.instanceId);
      // An unresolved main-lock mutation deliberately leaves this fence in
      // place. Ordinary startup never auto-recovers it; the evidence-driven
      // repair command must reconcile main ownership before removing it.
      if (fenceOwned && safeToRemoveFence) removeOwnedRecoveryGuard(fencePath, recovery.instanceId);
    }
  } finally {
    removeOwnedJson(entrantPath, entrant.instanceId);
  }
}

function ownershipRepairError(lockPath: string, message: string): DaemonRuntimeOwnershipError {
  return new DaemonRuntimeOwnershipError(
    DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.untrustedLock,
    `Refusing daemon ownership repair for ${lockPath}: ${message}`,
    lockPath,
  );
}

export function repairDaemonRuntimeOwnership(homeInput: string): DaemonRuntimeOwnershipRepairResult {
  const home = canonicalHome(homeInput, true);
  const lockPath = join(home, "state", "daemon-runtime.lock");
  const fencePath = recoveryMutationFencePath(lockPath);
  const recoveryPath = recoveryGuardPath(lockPath);
  const processStart = inspectProcessStart(process.pid);
  if (processStart.state !== "present") {
    throw ownershipRepairError(
      lockPath,
      processStart.state === "gone" ? "current repair process disappeared" : processStart.reason,
    );
  }

  cleanupStaleOwnershipPublicationTemps(lockPath);
  const repair = acquireOwnershipRepairLease(lockPath, processStart.identity);
  let restoredFrom: string | undefined;
  let reconciledState: "owner" | "empty" | undefined;
  try {
    repair.assertOwned();
    let evidence = inspectDaemonRuntimeRecoveryEvidenceForResolvedHome(home, lockPath);
    if (evidence.fence.state === "absent") {
      repair.release();
      evidence = inspectDaemonRuntimeRecoveryEvidenceForResolvedHome(home, lockPath);
      return { repaired: false, lockPath, evidence };
    }
    if (evidence.fence.state === "live") {
      throw new DaemonRuntimeOwnershipError(
        DAEMON_RUNTIME_OWNERSHIP_ERROR_CODES.recoveryBusy,
        `Refusing repair because fence ${evidence.fence.recoveryPath} is live: instance ${
          evidence.fence.guard.instanceId
        }, pid ${evidence.fence.guard.pid}, start ${evidence.fence.guard.processStartIdentity}`,
        lockPath,
      );
    }
    if (evidence.fence.state === "untrusted") {
      throw ownershipRepairError(lockPath, `fence cannot be trusted: ${evidence.fence.reason}`);
    }
    const fenceInstanceId = evidence.fence.guard.instanceId;
    const fenceFingerprint = publishedJsonFingerprint(fencePath);
    if (!fenceFingerprint) throw ownershipRepairError(lockPath, "exact stale fence content cannot be fingerprinted");

    // The stale fence remains authoritative while repair waits out every
    // startup that was published before it and every later startup rejects.
    drainOwnershipEntrants(lockPath, "");
    repair.assertOwned();
    assertExactStaleRecoveryRecord(fencePath, fenceInstanceId, fenceFingerprint, lockPath, "Recovery fence");
    evidence = inspectDaemonRuntimeRecoveryEvidenceForResolvedHome(home, lockPath);
    if (evidence.main.state === "untrusted") {
      throw ownershipRepairError(lockPath, `canonical main owner is untrusted: ${evidence.main.reason}`);
    }
    // A historical quarantine need not carry the current fence suffix. Any
    // candidate can represent a previously returned lease, so repair scans
    // every owner quarantine before proving a canonical or safe-empty state.
    const ownerCandidates = evidence.quarantineCandidates;
    const untrustedCandidate = ownerCandidates.find((candidate) => candidate.inspection.state === "untrusted");
    if (untrustedCandidate?.inspection.state === "untrusted") {
      throw ownershipRepairError(
        lockPath,
        `quarantine candidate ${untrustedCandidate.path} is untrusted: ${untrustedCandidate.inspection.reason}`,
      );
    }

    const liveCandidates = ownerCandidates.filter(
      (
        candidate,
      ): candidate is {
        path: string;
        fileIdentity?: string;
        inspection: Extract<DaemonRuntimeOwnershipInspection, { state: "live" }>;
      } => candidate.inspection.state === "live",
    );
    const candidateKey = (candidate: {
      path: string;
      fileIdentity?: string;
      inspection: Extract<DaemonRuntimeOwnershipInspection, { state: "live" | "stale" }>;
    }): string => {
      if (!candidate.fileIdentity) {
        throw ownershipRepairError(lockPath, `candidate ${candidate.path} changed before its file identity was read`);
      }
      return `${candidate.inspection.owner.instanceId}:${candidate.fileIdentity}`;
    };
    const uniqueLiveCandidates = new Map(liveCandidates.map((candidate) => [candidateKey(candidate), candidate]));
    let canonicalLiveKey: string | undefined;
    if (evidence.main.state === "live") {
      const mainFileIdentity = publishedFileIdentity(lockPath);
      if (!mainFileIdentity) throw ownershipRepairError(lockPath, "live canonical main file identity is unavailable");
      canonicalLiveKey = `${evidence.main.owner.instanceId}:${mainFileIdentity}`;
      uniqueLiveCandidates.delete(canonicalLiveKey);
    }
    if (uniqueLiveCandidates.size + (canonicalLiveKey ? 1 : 0) > 1) {
      throw ownershipRepairError(
        lockPath,
        `multiple different live owner candidates exist: ${[
          ...(canonicalLiveKey ? [canonicalLiveKey] : []),
          ...uniqueLiveCandidates.keys(),
        ].join(", ")}`,
      );
    }

    const uniqueLiveCandidate = canonicalLiveKey ? undefined : uniqueLiveCandidates.values().next().value;

    let safeEmpty = false;
    if (evidence.main.state === "absent") {
      const staleCandidates = ownerCandidates.filter(
        (
          candidate,
        ): candidate is {
          path: string;
          fileIdentity?: string;
          inspection: Extract<DaemonRuntimeOwnershipInspection, { state: "stale" }>;
        } => candidate.inspection.state === "stale",
      );
      const uniqueStaleCandidates = new Map(staleCandidates.map((candidate) => [candidateKey(candidate), candidate]));
      const candidate =
        uniqueLiveCandidate ??
        (uniqueLiveCandidates.size === 0 && uniqueStaleCandidates.size === 1
          ? uniqueStaleCandidates.values().next().value
          : undefined);
      if (!candidate) {
        if (ownerCandidates.length === 0) {
          safeEmpty = true;
        } else {
          throw ownershipRepairError(
            lockPath,
            uniqueLiveCandidates.size === 0 && uniqueStaleCandidates.size > 1
              ? `canonical main is absent and stale candidates are ambiguous: ${[...uniqueStaleCandidates.keys()].join(
                  ", ",
                )}`
              : "canonical main is absent and no unique trusted quarantine candidate can restore it",
          );
        }
      } else {
        repair.assertOwned();
        assertExactStaleRecoveryRecord(fencePath, fenceInstanceId, fenceFingerprint, lockPath, "Recovery fence");
        if (!restoreQuarantinedFileWithRetries(candidate.path, lockPath)) {
          throw ownershipRepairError(
            lockPath,
            `failed to restore candidate ${candidate.path} without overwriting main`,
          );
        }
        restoredFrom = candidate.path;
      }
    } else if (evidence.main.state === "stale" && uniqueLiveCandidate) {
      const displacedMainPath = `${lockPath}.repair-stale.${Date.now()}.${evidence.main.owner.instanceId}.${repair.guard.instanceId}`;
      repair.assertOwned();
      assertExactStaleRecoveryRecord(fencePath, fenceInstanceId, fenceFingerprint, lockPath, "Recovery fence");
      try {
        renameSync(lockPath, displacedMainPath);
      } catch (error) {
        throw ownershipRepairError(
          lockPath,
          `failed to isolate stale canonical main: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (readInstanceId(displacedMainPath) !== evidence.main.owner.instanceId) {
        restoreQuarantinedFileWithRetries(displacedMainPath, lockPath);
        throw ownershipRepairError(lockPath, "canonical main changed while repair isolated it");
      }
      repair.assertOwned();
      assertExactStaleRecoveryRecord(fencePath, fenceInstanceId, fenceFingerprint, lockPath, "Recovery fence");
      if (!restoreQuarantinedFileWithRetries(uniqueLiveCandidate.path, lockPath)) {
        restoreQuarantinedFileWithRetries(displacedMainPath, lockPath);
        throw ownershipRepairError(lockPath, `failed to restore live candidate ${uniqueLiveCandidate.path}`);
      }
      restoredFrom = uniqueLiveCandidate.path;
    }

    const reconciledMain = readOwnerInspection(lockPath, home);
    if (reconciledMain.state === "live" || reconciledMain.state === "stale") {
      reconciledState = "owner";
    } else if (reconciledMain.state === "absent" && safeEmpty) {
      reconciledState = "empty";
    } else {
      throw ownershipRepairError(
        lockPath,
        reconciledMain.state === "untrusted"
          ? `reconciled main is untrusted: ${reconciledMain.reason}`
          : "reconciled main is absent",
      );
    }
    repair.assertOwned();
    assertExactStaleRecoveryRecord(fencePath, fenceInstanceId, fenceFingerprint, lockPath, "Recovery fence");

    const legacyGuard = readRecoveryGuardInspection(recoveryPath);
    if (legacyGuard.state === "live" || legacyGuard.state === "untrusted") {
      throw ownershipRepairError(
        lockPath,
        legacyGuard.state === "live"
          ? `legacy recovery guard is still live under instance ${legacyGuard.guard.instanceId}`
          : `legacy recovery guard is untrusted: ${legacyGuard.reason}`,
      );
    }
    if (legacyGuard.state === "stale") {
      if (legacyGuard.guard.instanceId !== fenceInstanceId) {
        throw ownershipRepairError(
          lockPath,
          `legacy recovery guard instance ${legacyGuard.guard.instanceId} does not match fence ${fenceInstanceId}`,
        );
      }
      if (!removeOwnedRecoveryGuard(recoveryPath, fenceInstanceId) && existsSync(recoveryPath)) {
        throw ownershipRepairError(lockPath, "failed to remove exact stale legacy recovery guard");
      }
    }
    repair.assertOwned();
    assertExactStaleRecoveryRecord(fencePath, fenceInstanceId, fenceFingerprint, lockPath, "Recovery fence");
    if (!removeExactOwnedJson(fencePath, fenceInstanceId, fenceFingerprint)) {
      throw ownershipRepairError(lockPath, "failed to remove exact stale recovery fence");
    }

    // Fence deletion is the repair linearization point. Main ownership is
    // immutable after this line; only the exact repair guard/election records
    // are released.
    repair.release();
    return {
      repaired: true,
      lockPath,
      reconciledState,
      restoredFrom,
      evidence: inspectDaemonRuntimeRecoveryEvidenceForResolvedHome(home, lockPath),
    };
  } finally {
    repair.release();
  }
}

export function formatDaemonRuntimeOwner(owner: DaemonRuntimeOwner): string {
  return `instance ${owner.instanceId} (pid ${owner.pid}, start ${owner.processStartIdentity}, channel ${owner.channel}, mode ${owner.mode}, version ${owner.version}, since ${owner.startedAt})`;
}

export function formatDaemonRuntimeOwnerSummary(owner: DaemonRuntimeOwner): string {
  return `pid ${owner.pid}, ${owner.channel}/${owner.mode}, v${owner.version}, since ${owner.startedAt}`;
}
