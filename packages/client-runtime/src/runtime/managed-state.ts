import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const RUNTIME_DIR = ".first-tree-workspace";

export const MANAGED_STATE_REL = join(RUNTIME_DIR, "managed.json");
export const MANAGED_SKILLS_JOURNAL_REL = join(RUNTIME_DIR, "managed-skills-journal.json");
export const MANAGED_SKILLS_LOCK_REL = join(RUNTIME_DIR, "managed-skills.lock");

export type LegacyManagedState = Readonly<{
  schemaVersion: 1;
  cliVersion: string | null;
  updatedAt: string;
  skills: readonly string[];
}>;

export type ManagedSkillEntry = Readonly<{
  key: `core:${string}` | `resource:${string}`;
  /** Workspace-relative target path. */
  target: string;
  requestedSlug: string;
  effectiveName: string;
  /** Source identity: bundled VERSION, inline DTO digest, or attachment id. */
  revision: string;
  /** Digest of the final installed bytes after all runtime transformations. */
  installedDigest: `sha256:${string}`;
}>;

export type ManagedState = Readonly<{
  schemaVersion: 2;
  /** Monotonic Team Resource snapshot fence. Zero means no authoritative snapshot has been applied. */
  resourceConfigVersion: number;
  updatedAt: string;
  skills: readonly ManagedSkillEntry[];
}>;

export type ManagedStateReadResult =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "legacy"; state: LegacyManagedState }>
  | Readonly<{ kind: "current"; state: ManagedState }>
  | Readonly<{ kind: "future"; schemaVersion: number }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export const MANAGED_SKILLS_JOURNAL_PHASES = [
  "prepared",
  "target_backed_up",
  "target_installed",
  "state_committed",
] as const;

export type ManagedSkillsJournalPhase = (typeof MANAGED_SKILLS_JOURNAL_PHASES)[number];

export type ManagedSkillsJournal = Readonly<{
  schemaVersion: 1;
  operationId: string;
  operation: "install" | "remove";
  phase: ManagedSkillsJournalPhase;
  /** Every path is workspace-relative and validated again before recovery. */
  target: string;
  staging: string | null;
  backup: string | null;
  expectedInstalledDigest: `sha256:${string}` | null;
  beforeState: ManagedState;
  afterState: ManagedState;
}>;

export type ManagedSkillsJournalReadResult =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "current"; journal: ManagedSkillsJournal }>
  | Readonly<{ kind: "future"; schemaVersion: number }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export function emptyManagedState(resourceConfigVersion = 0): ManagedState {
  return {
    schemaVersion: 2,
    resourceConfigVersion,
    updatedAt: new Date(0).toISOString(),
    skills: [],
  };
}

export function readManagedStateResult(workspacePath: string): ManagedStateReadResult {
  const raw = readJson(join(workspacePath, MANAGED_STATE_REL));
  if (raw.kind !== "value") return raw;
  const record = asRecord(raw.value);
  if (!record) return { kind: "invalid", reason: "managed state must be a JSON object" };
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return { kind: "invalid", reason: "managed state schemaVersion must be an integer" };
  }
  if (schemaVersion > 2) return { kind: "future", schemaVersion };
  if (schemaVersion === 1) return parseLegacyState(record);
  if (schemaVersion !== 2)
    return { kind: "invalid", reason: `unsupported managed state schemaVersion ${schemaVersion}` };
  return parseManagedState(record);
}

/** Convenience read for callers that only accept a valid v2 state. */
export function readManagedState(workspacePath: string): ManagedState | null {
  const result = readManagedStateResult(workspacePath);
  return result.kind === "current" ? result.state : null;
}

export function writeManagedState(workspacePath: string, state: ManagedState): ManagedState {
  const candidate = {
    ...state,
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
  } satisfies ManagedState;
  const persisted = parseEmbeddedManagedState(candidate);
  if (!persisted) {
    throw new Error("refusing to persist invalid managed state");
  }
  atomicWriteJson(join(workspacePath, MANAGED_STATE_REL), persisted);
  return persisted;
}

export function readManagedSkillsJournal(workspacePath: string): ManagedSkillsJournalReadResult {
  const raw = readJson(join(workspacePath, MANAGED_SKILLS_JOURNAL_REL));
  if (raw.kind !== "value") return raw;
  const record = asRecord(raw.value);
  if (!record) return { kind: "invalid", reason: "managed skills journal must be a JSON object" };
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return { kind: "invalid", reason: "managed skills journal schemaVersion must be an integer" };
  }
  if (schemaVersion > 1) return { kind: "future", schemaVersion };
  if (schemaVersion !== 1) {
    return { kind: "invalid", reason: `unsupported managed skills journal schemaVersion ${schemaVersion}` };
  }

  const operationId = readNonEmptyString(record.operationId);
  const operation = record.operation === "install" || record.operation === "remove" ? record.operation : null;
  const phase = MANAGED_SKILLS_JOURNAL_PHASES.find((candidate) => candidate === record.phase) ?? null;
  const target = readNonEmptyString(record.target);
  const staging = readNullableString(record.staging);
  const backup = readNullableString(record.backup);
  const expectedInstalledDigest =
    record.expectedInstalledDigest === null ? null : readSha256Digest(record.expectedInstalledDigest);
  const beforeState = parseEmbeddedManagedState(record.beforeState);
  const afterState = parseEmbeddedManagedState(record.afterState);

  if (!operationId || !operation || !phase || !target || staging === undefined || backup === undefined) {
    return { kind: "invalid", reason: "managed skills journal has invalid operation fields" };
  }
  if (record.expectedInstalledDigest !== null && !expectedInstalledDigest) {
    return { kind: "invalid", reason: "managed skills journal has invalid expectedInstalledDigest" };
  }
  if (!beforeState || !afterState) {
    return { kind: "invalid", reason: "managed skills journal has invalid beforeState/afterState" };
  }
  const transitionError = validateJournalTransition({
    operation,
    target,
    staging,
    backup,
    expectedInstalledDigest,
    beforeState,
    afterState,
  });
  if (transitionError) {
    return { kind: "invalid", reason: transitionError };
  }

  return {
    kind: "current",
    journal: {
      schemaVersion: 1,
      operationId,
      operation,
      phase,
      target,
      staging,
      backup,
      expectedInstalledDigest,
      beforeState,
      afterState,
    },
  };
}

function validateJournalTransition(
  journal: Readonly<{
    operation: ManagedSkillsJournal["operation"];
    target: string;
    staging: string | null;
    backup: string | null;
    expectedInstalledDigest: `sha256:${string}` | null;
    beforeState: ManagedState;
    afterState: ManagedState;
  }>,
): string | null {
  if (!isSafePersistedTarget(journal.target)) {
    return "managed skills journal target is outside an allowed Skill root";
  }
  if (journal.beforeState.resourceConfigVersion !== journal.afterState.resourceConfigVersion) {
    return "managed skills journal may not change the Team Resource version fence";
  }
  if (journal.staging && !isRelatedJournalTemporaryTarget(journal.target, journal.staging, ".staging")) {
    return "managed skills journal staging path does not belong to target";
  }
  if (journal.backup && !isRelatedJournalTemporaryTarget(journal.target, journal.backup, ".backup")) {
    return "managed skills journal backup path does not belong to target";
  }

  const beforeTargetEntries = journal.beforeState.skills.filter((entry) => entry.target === journal.target);
  const afterTargetEntries = journal.afterState.skills.filter((entry) => entry.target === journal.target);
  const unchangedOutsideTarget = statesMatchOutsideTarget(journal.beforeState, journal.afterState, journal.target);
  if (!unchangedOutsideTarget) {
    return "managed skills journal changes entries outside its target";
  }

  if (journal.operation === "install") {
    if (!journal.staging || !journal.expectedInstalledDigest) {
      return "install journal requires staging and expectedInstalledDigest";
    }
    if (afterTargetEntries.length !== 1 || afterTargetEntries[0]?.installedDigest !== journal.expectedInstalledDigest) {
      return "install journal afterState does not own target at expected digest";
    }
    if (
      beforeTargetEntries.length > 1 ||
      (beforeTargetEntries[0] && beforeTargetEntries[0].key !== afterTargetEntries[0]?.key)
    ) {
      return "install journal target ownership transition is invalid";
    }
    return null;
  }

  if (journal.staging !== null || !journal.backup || journal.expectedInstalledDigest !== null) {
    return "remove journal requires only a related backup path";
  }
  if (beforeTargetEntries.length !== 1 || afterTargetEntries.length !== 0) {
    return "remove journal beforeState/afterState target transition is invalid";
  }
  return null;
}

function isRelatedJournalTemporaryTarget(target: string, temporary: string, suffix: ".staging" | ".backup"): boolean {
  const targetParts = target.split("/");
  const temporaryParts = temporary.split("/");
  const targetName = targetParts.at(-1);
  const temporaryName = temporaryParts.at(-1);
  if (!targetName || !temporaryName) return false;
  if (targetParts.slice(0, -1).join("/") !== temporaryParts.slice(0, -1).join("/")) return false;
  const prefix = `.${targetName}.ft-`;
  if (!temporaryName.startsWith(prefix) || !temporaryName.endsWith(suffix)) return false;
  const token = temporaryName.slice(prefix.length, -suffix.length);
  return /^[a-f0-9]{4,64}$/u.test(token);
}

function statesMatchOutsideTarget(beforeState: ManagedState, afterState: ManagedState, target: string): boolean {
  const normalizedEntries = (state: ManagedState): string =>
    JSON.stringify(
      state.skills
        .filter((entry) => entry.target !== target)
        .sort((left, right) => left.key.localeCompare(right.key) || left.target.localeCompare(right.target)),
    );
  return normalizedEntries(beforeState) === normalizedEntries(afterState);
}

export function writeManagedSkillsJournal(workspacePath: string, journal: ManagedSkillsJournal): void {
  atomicWriteJson(join(workspacePath, MANAGED_SKILLS_JOURNAL_REL), journal);
}

export function clearManagedSkillsJournal(workspacePath: string): void {
  const journalPath = join(workspacePath, MANAGED_SKILLS_JOURNAL_REL);
  try {
    unlinkSync(journalPath);
    fsyncDirectory(dirname(journalPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseLegacyState(record: Record<string, unknown>): ManagedStateReadResult {
  const cliVersion = record.cliVersion === null || typeof record.cliVersion === "string" ? record.cliVersion : null;
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString();
  const skills = readStringArray(record.skills);
  return {
    kind: "legacy",
    state: {
      schemaVersion: 1,
      cliVersion,
      updatedAt,
      skills,
    },
  };
}

function parseManagedState(record: Record<string, unknown>): ManagedStateReadResult {
  const state = parseEmbeddedManagedState(record);
  if (!state) return { kind: "invalid", reason: "managed state v2 has invalid fields" };
  return { kind: "current", state };
}

function parseEmbeddedManagedState(value: unknown): ManagedState | null {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== 2) return null;
  const resourceConfigVersion = record.resourceConfigVersion;
  if (
    typeof resourceConfigVersion !== "number" ||
    !Number.isSafeInteger(resourceConfigVersion) ||
    resourceConfigVersion < 0
  ) {
    return null;
  }
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : null;
  if (!updatedAt || !Array.isArray(record.skills)) return null;
  const skills: ManagedSkillEntry[] = [];
  const targetOwners = new Map<string, ManagedSkillEntry["key"]>();
  for (const rawEntry of record.skills) {
    const entry = parseManagedSkillEntry(rawEntry);
    if (!entry) return null;
    const foldedTarget = entry.target.toLocaleLowerCase("en-US");
    const existingOwner = targetOwners.get(foldedTarget);
    if (existingOwner && existingOwner !== entry.key) return null;
    targetOwners.set(foldedTarget, entry.key);
    skills.push(entry);
  }
  return normalizeManagedState({
    schemaVersion: 2,
    resourceConfigVersion,
    updatedAt,
    skills,
  });
}

function parseManagedSkillEntry(value: unknown): ManagedSkillEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const key = readManagedSkillKey(record.key);
  const target = readNonEmptyString(record.target);
  const requestedSlug = readNonEmptyString(record.requestedSlug);
  const effectiveName = readNonEmptyString(record.effectiveName);
  const revision = readNonEmptyString(record.revision);
  const installedDigest = readSha256Digest(record.installedDigest);
  if (!key || !target || !requestedSlug || !effectiveName || !revision || !installedDigest) return null;
  if (
    !isSafePersistedTarget(target) ||
    !isSafePersistedSkillName(requestedSlug) ||
    !isSafePersistedSkillName(effectiveName)
  ) {
    return null;
  }
  const targetParts = target.split("/");
  const targetRoot = targetParts.slice(0, -1).join("/");
  const targetName = targetParts.at(-1);
  if (targetRoot === ".first-tree/resources/skills") {
    if (key !== `resource:${targetName}`) return null;
  } else if (targetName !== effectiveName) {
    return null;
  }
  if (key.startsWith("core:") && key !== `core:${requestedSlug}`) return null;
  return { key, target, requestedSlug, effectiveName, revision, installedDigest };
}

function isSafePersistedTarget(target: string): boolean {
  if (target.includes("\\") || target.includes("\0")) return false;
  const parts = target.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  const root = parts.slice(0, -1).join("/");
  const allowedRoot =
    root === ".agents/skills" ||
    root === ".claude/skills" ||
    root === ".cursor/skills" ||
    root === ".grok/skills" ||
    root === ".kimi-code/skills" ||
    root === ".opencode/skills" ||
    root === ".first-tree/resources/skills";
  return allowedRoot && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts.at(-1) ?? "");
}

function isSafePersistedSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name);
}

function normalizeManagedState(state: ManagedState): ManagedState {
  const unique = new Map<string, ManagedSkillEntry>();
  for (const entry of state.skills) {
    unique.set(`${entry.key}\0${entry.target}`, entry);
  }
  return {
    schemaVersion: 2,
    resourceConfigVersion: state.resourceConfigVersion,
    updatedAt: state.updatedAt,
    skills: [...unique.values()].sort(
      (left, right) => left.key.localeCompare(right.key) || left.target.localeCompare(right.target),
    ),
  };
}

function readManagedSkillKey(value: unknown): ManagedSkillEntry["key"] | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("core:") && value.length > "core:".length) return value as `core:${string}`;
  if (value.startsWith("resource:") && value.length > "resource:".length) return value as `resource:${string}`;
  return null;
}

function readSha256Digest(value: unknown): `sha256:${string}` | null {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) ? (value as `sha256:${string}`) : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type JsonReadResult =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "value"; value: unknown }>
  | Readonly<{ kind: "invalid"; reason: string }>;

function readJson(path: string): JsonReadResult {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "value", value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (error) {
    return {
      kind: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write failure.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some Windows/filesystem combinations.
    // The file itself was already fsynced and atomically renamed.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close only.
      }
    }
  }
}
