import { createHash, randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  type AgentRuntimeConfig,
  parseTeamSkillMarkdown,
  type RuntimeProvider,
  type RuntimeResourceSkill,
  type RuntimeTeamSkillAttachmentEntry,
  type RuntimeTeamSkillEntry,
  runtimeTeamSkillSnapshotSchema,
  TEAM_SKILL_BUNDLE_LIMITS,
  TEAM_SKILL_OWNERSHIP_MARKER,
  TEAM_SKILL_RUNTIME_NAME_MAX,
} from "@first-tree/shared";
import { stringify as stringifyYaml } from "yaml";
import { CORE_SKILL_NAMES, resolveBundledSkillsRoot } from "./first-tree-skills/installer.js";
import {
  clearManagedSkillsJournal,
  emptyManagedState,
  MANAGED_SKILLS_JOURNAL_REL,
  MANAGED_SKILLS_LOCK_REL,
  type ManagedSkillEntry,
  type ManagedSkillsJournal,
  type ManagedSkillsJournalPhase,
  type ManagedState,
  readManagedSkillsJournal,
  readManagedStateResult,
  writeManagedSkillsJournal,
  writeManagedState,
} from "./managed-state.js";
import { extractTeamSkillBundle } from "./team-skill-bundle.js";
import { acquireWorkspaceFileLock, type WorkspaceFileLock } from "./workspace-file-lock.js";

const OWNERSHIP_MARKER = TEAM_SKILL_OWNERSHIP_MARKER;
const LEGACY_RESOURCE_SKILLS_ROOT = ".first-tree/resources/skills";
const MAX_SKILL_FILES = TEAM_SKILL_BUNDLE_LIMITS.files;
const MAX_SKILL_TOTAL_BYTES = TEAM_SKILL_BUNDLE_LIMITS.totalBytes;
const MAX_SKILL_FILE_BYTES = TEAM_SKILL_BUNDLE_LIMITS.fileBytes;
const MAX_SKILL_DEPTH = TEAM_SKILL_BUNDLE_LIMITS.depth;
const MAX_OWNERSHIP_MARKER_BYTES = 4 * 1024;
// Installed trees contain one Client-generated ownership marker and may
// contain a canonicalized SKILL.md. Archive extraction remains bound by the
// shared payload limits; these small, explicit allowances cover only managed
// metadata and manifest rewriting during staging/digest validation.
const MAX_INSTALLED_SKILL_FILES = MAX_SKILL_FILES + 1;
const MAX_INSTALLED_SKILL_TOTAL_BYTES = MAX_SKILL_TOTAL_BYTES + MAX_SKILL_FILE_BYTES + MAX_OWNERSHIP_MARKER_BYTES;
const MAX_SKILL_NAME_LENGTH = TEAM_SKILL_RUNTIME_NAME_MAX;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const TEAM_SKILL_DOWNLOAD_TIMEOUT_MS = 15_000;

const PROVIDER_SKILL_ROOTS: Readonly<Record<RuntimeProvider, string>> = {
  "claude-code": ".claude/skills",
  "claude-code-tui": ".claude/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
  "kimi-code": ".kimi-code/skills",
};

const ALLOWED_TARGET_ROOTS = new Set<string>([...Object.values(PROVIDER_SKILL_ROOTS), LEGACY_RESOURCE_SKILLS_ROOT]);

const RETIRED_CORE_SKILL_NAMES = ["first-tree-guide", "first-tree-kickoff", "first-tree-gitlab"] as const;
const ALL_KNOWN_CORE_SKILL_NAMES = [...CORE_SKILL_NAMES, ...RETIRED_CORE_SKILL_NAMES] as const;
const RESERVED_CORE_SLUGS = new Set<string>(CORE_SKILL_NAMES);
const WINDOWS_RESERVED_NAMES = new Set<string>([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export type TeamSkillSnapshot =
  | Readonly<{
      kind: "authoritative";
      resourceConfigVersion: number;
      entries: readonly RuntimeTeamSkillEntry[];
    }>
  | Readonly<{ kind: "unavailable" }>;

export type ManagedSkillAttachmentFetcher = (options: {
  id: string;
  maxBytes: number;
  timeoutMs: number;
}) => Promise<{ bytes: Buffer; size: number }>;

export type ReconciledTeamSkill = Readonly<{
  key: `resource:${string}`;
  name: string;
  description: string;
  target: string;
  revision: string;
  installedDigest: `sha256:${string}`;
}>;

export type ManagedSkillFailure = Readonly<{
  key: string;
  reason: string;
}>;

export type ReconcileManagedSkillsResult = Readonly<{
  ok: boolean;
  resourceConfigVersion: number;
  installed: readonly string[];
  skipped: readonly string[];
  removed: readonly string[];
  teamSkills: readonly ReconciledTeamSkill[];
  failures: readonly ManagedSkillFailure[];
  staleTeamSnapshot: boolean;
}>;

export type ManagedSkillsCheckpoint =
  | "prepared"
  | "target_backed_up"
  | "target_installed"
  | "state_committed"
  | "backup_cleaned";

export type ReconcileManagedSkillsOptions = Readonly<{
  workspace: string;
  provider: RuntimeProvider;
  teamSnapshot: TeamSkillSnapshot;
  log?: (message: string) => void;
  /** Test/build override. Production resolves the bundled client skills directory. */
  bundledSkillsRoot?: string;
  lockTimeoutMs?: number;
  /** Fault-injection seam used by deterministic crash-recovery tests. */
  testCrashAt?: ManagedSkillsCheckpoint;
  /** Ordinary failure seam used to exercise in-process rollback paths. */
  testFailureAt?: ManagedSkillsCheckpoint;
  /** Forces the rollback path to preserve its journal and abort reconciliation. */
  testRecoveryFailure?: boolean;
  fetchAttachment?: ManagedSkillAttachmentFetcher;
}>;

type DesiredManagedSkill = Readonly<{
  key: ManagedSkillEntry["key"];
  kind: "core" | "team";
  requestedSlug: string;
  description: string;
  revision: string;
  validationError: string | null;
  source:
    | Readonly<{ kind: "bundled-directory"; path: string }>
    | Readonly<{ kind: "inline-skill"; skill: RuntimeResourceSkill }>
    | Readonly<{ kind: "attachment-bundle"; descriptor: RuntimeTeamSkillAttachmentEntry }>
    | Readonly<{ kind: "unavailable" }>;
}>;

type AllocatedManagedSkill = Readonly<{
  desired: DesiredManagedSkill;
  effectiveName: string;
  target: string;
}>;

type StagedManagedSkill = Readonly<{
  allocated: AllocatedManagedSkill;
  staging: string;
  entry: ManagedSkillEntry;
  targetPrecondition: Readonly<{ kind: "absent" }> | Readonly<{ kind: "present"; proof: ManagedTargetOwnershipProof }>;
}>;

type ManagedTargetOwnershipProof =
  | Readonly<{
      kind: "marker";
      key: ManagedSkillEntry["key"];
      revision: string;
      digest: `sha256:${string}`;
    }>
  | Readonly<{
      kind: "ledger-digest";
      key: ManagedSkillEntry["key"];
      digest: `sha256:${string}`;
    }>
  | Readonly<{
      kind: "legacy-symlink";
      key: ManagedSkillEntry["key"];
      linkTarget: string;
    }>;

type MutableReconcileResult = {
  installed: string[];
  skipped: string[];
  removed: string[];
  teamSkills: ReconciledTeamSkill[];
  failures: ManagedSkillFailure[];
  staleTeamSnapshot: boolean;
};

type SkillTreeStats = {
  files: number;
  bytes: number;
};

class ManagedSkillsFatalError extends Error {}
class ManagedSkillsSimulatedCrash extends Error {}

const processMutexTails = new Map<string, Promise<void>>();

export function providerSkillRoot(provider: RuntimeProvider): string {
  return PROVIDER_SKILL_ROOTS[provider];
}

export function authoritativeTeamSkillSnapshot(
  resourceConfigVersion: number,
  skills: readonly RuntimeResourceSkill[],
): TeamSkillSnapshot {
  return {
    kind: "authoritative",
    resourceConfigVersion,
    entries: skills.map((skill) => ({ kind: "inline", ...skill })),
  };
}

export function teamSkillSnapshotFromConfig(config: AgentRuntimeConfig | null | undefined): TeamSkillSnapshot {
  if (!config) return { kind: "unavailable" };
  const rawSnapshot = config.payload.teamSkillSnapshot;
  if (rawSnapshot === undefined) {
    return authoritativeTeamSkillSnapshot(config.version, config.payload.resourceSkills);
  }
  const parsed = runtimeTeamSkillSnapshotSchema.safeParse(rawSnapshot);
  if (!parsed.success) return { kind: "unavailable" };
  return {
    kind: "authoritative",
    resourceConfigVersion: config.version,
    entries: parsed.data.entries,
  };
}

export async function reconcileManagedSkillsForConfig(
  workspace: string,
  provider: RuntimeProvider,
  config: AgentRuntimeConfig | null | undefined,
  log?: (message: string) => void,
  fetchAttachment?: ManagedSkillAttachmentFetcher,
): Promise<ReconcileManagedSkillsResult> {
  return reconcileManagedSkills({
    workspace,
    provider,
    teamSnapshot: teamSkillSnapshotFromConfig(config),
    log,
    fetchAttachment,
  });
}

export async function reconcileManagedSkills(
  options: ReconcileManagedSkillsOptions,
): Promise<ReconcileManagedSkillsResult> {
  return withProcessMutex(processMutexKey(options.workspace), async () => {
    const mutable: MutableReconcileResult = {
      installed: [],
      skipped: [],
      removed: [],
      teamSkills: [],
      failures: [],
      staleTeamSnapshot: false,
    };
    let lock: WorkspaceFileLock | null = null;
    try {
      assertManagedWorkspaceRootsSafe(options.workspace);
      lock = await acquireWorkspaceLock(options);
      await recoverPendingJournal(options.workspace, options.log);
      let state = await loadOrMigrateManagedState(options);

      const authoritative =
        options.teamSnapshot.kind === "authoritative" &&
        options.teamSnapshot.resourceConfigVersion >= state.resourceConfigVersion;
      if (
        options.teamSnapshot.kind === "authoritative" &&
        options.teamSnapshot.resourceConfigVersion < state.resourceConfigVersion
      ) {
        mutable.staleTeamSnapshot = true;
        options.log?.(
          `Managed skills ignored stale Team Resource snapshot v${options.teamSnapshot.resourceConfigVersion}; ` +
            `workspace fence is v${state.resourceConfigVersion}`,
        );
      }
      if (
        options.teamSnapshot.kind === "authoritative" &&
        options.teamSnapshot.resourceConfigVersion > state.resourceConfigVersion
      ) {
        state = persistStateMonotonic(options.workspace, {
          ...state,
          resourceConfigVersion: options.teamSnapshot.resourceConfigVersion,
        });
      }
      if (authoritative && options.teamSnapshot.kind === "authoritative") {
        state = await adoptLegacyResourceSkills(options.workspace, state, options.teamSnapshot.entries, options.log);
      } else if (options.teamSnapshot.kind === "unavailable") {
        options.log?.(
          "Managed skills Team Resource snapshot unavailable; preserving last-known-good Team Skills until control-plane recovery",
        );
      }

      const desiredSkills = await buildDesiredSkills(options, authoritative);
      const allocations = await allocateTargets(options.workspace, options.provider, state, desiredSkills);
      const successfulTargets = new Map<ManagedSkillEntry["key"], string>();
      const desiredKeys = new Set<ManagedSkillEntry["key"]>(desiredSkills.map((skill) => skill.key));

      for (const desired of desiredSkills) {
        const allocated = allocations.get(desired.key);
        if (!allocated) {
          mutable.failures.push({
            key: desired.key,
            reason: desired.validationError ?? "no safe provider-native target is available",
          });
          continue;
        }
        try {
          state = await ensureTargetOwnership(options.workspace, state, allocated);
          const existing = state.skills.find(
            (entry) =>
              entry.key === allocated.desired.key &&
              entry.target === allocated.target &&
              entry.revision === allocated.desired.revision,
          );
          if (existing) {
            const actualDigest = await digestManagedTarget(options.workspace, existing.target);
            const expectedDigest =
              allocated.desired.source.kind === "bundled-directory"
                ? await digestBundledFinalTree(
                    allocated.desired.source.path,
                    allocated.desired.key,
                    allocated.desired.revision,
                  )
                : existing.installedDigest;
            if (actualDigest === existing.installedDigest && expectedDigest === existing.installedDigest) {
              mutable.skipped.push(existing.key);
              successfulTargets.set(existing.key, existing.target);
              continue;
            }
          }
          const targetPrecondition = await captureInstallTargetPrecondition(
            options.workspace,
            allocated.target,
            state,
            allocated.desired.key,
          );
          const staged = await stageManagedSkill(options, allocated, targetPrecondition);
          state = await installStagedSkill(options, state, staged);
          mutable.installed.push(staged.entry.key);
          successfulTargets.set(staged.entry.key, staged.entry.target);
        } catch (error) {
          if (error instanceof ManagedSkillsSimulatedCrash || error instanceof ManagedSkillsFatalError) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          mutable.failures.push({ key: desired.key, reason });
          options.log?.(`Managed skill reconcile failed (${desired.key}): ${reason.slice(0, 300)}`);
        }
      }

      const entriesToRemove = state.skills.filter((entry) => {
        if (entry.key.startsWith("core:")) {
          if (!desiredKeys.has(entry.key)) return true;
          const successfulTarget = successfulTargets.get(entry.key);
          return successfulTarget !== undefined && successfulTarget !== entry.target;
        }
        if (!authoritative) return false;
        if (!desiredKeys.has(entry.key)) return true;
        const successfulTarget = successfulTargets.get(entry.key);
        return successfulTarget !== undefined && successfulTarget !== entry.target;
      });

      for (const entry of entriesToRemove) {
        try {
          state = await removeManagedEntry(options, state, entry);
          mutable.removed.push(`${entry.key}@${entry.target}`);
        } catch (error) {
          if (error instanceof ManagedSkillsSimulatedCrash || error instanceof ManagedSkillsFatalError) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          mutable.failures.push({ key: entry.key, reason: `cleanup ${entry.target}: ${reason}` });
          options.log?.(`Managed skill cleanup failed (${entry.key} at ${entry.target}): ${reason.slice(0, 300)}`);
        }
      }

      if (authoritative && options.teamSnapshot.kind === "authoritative") {
        mutable.teamSkills = await buildReconciledTeamRows(options.workspace, state, desiredSkills, successfulTargets);
      }
      return freezeResult(state.resourceConfigVersion, mutable);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      mutable.failures.push({ key: "workspace", reason });
      options.log?.(`Managed skills reconcile skipped: ${reason.slice(0, 300)}`);
      let resourceConfigVersion = 0;
      try {
        assertManagedWorkspaceRootsSafe(options.workspace);
        const stateResult = readManagedStateResult(options.workspace);
        if (stateResult.kind === "current") resourceConfigVersion = stateResult.state.resourceConfigVersion;
      } catch {
        // The original failure may itself be an unsafe managed root. Do not
        // follow that root merely to enrich a best-effort result field.
      }
      return freezeResult(resourceConfigVersion, mutable);
    } finally {
      try {
        await lock?.release();
      } catch (error) {
        // A cleanup failure must not turn a settled provider preflight into a
        // rejected handler start. Closing the descriptor releases only this
        // process's kernel lock and never removes a successor's lock path.
        options.log?.(
          `Managed skills lock cleanup failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
        );
      }
    }
  });
}

function freezeResult(resourceConfigVersion: number, result: MutableReconcileResult): ReconcileManagedSkillsResult {
  return Object.freeze({
    ok: result.failures.length === 0,
    resourceConfigVersion,
    installed: Object.freeze([...result.installed]),
    skipped: Object.freeze([...result.skipped]),
    removed: Object.freeze([...result.removed]),
    teamSkills: Object.freeze([...result.teamSkills]),
    failures: Object.freeze([...result.failures]),
    staleTeamSnapshot: result.staleTeamSnapshot,
  });
}

function processMutexKey(workspace: string): string {
  try {
    return realpathSync(resolve(workspace));
  } catch {
    // The guarded reconcile reports the original workspace error. The
    // lexical fallback only keeps concurrent failing calls serialized.
    return resolve(workspace);
  }
}

async function withProcessMutex<T>(workspace: string, task: () => Promise<T>): Promise<T> {
  const previous = processMutexTails.get(workspace) ?? Promise.resolve();
  let releaseTail = (): void => {};
  const current = new Promise<void>((resolveTail) => {
    releaseTail = resolveTail;
  });
  const tail = previous.then(() => current);
  processMutexTails.set(workspace, tail);
  await previous;
  try {
    return await task();
  } finally {
    releaseTail();
    if (processMutexTails.get(workspace) === tail) {
      processMutexTails.delete(workspace);
    }
  }
}

async function acquireWorkspaceLock(options: ReconcileManagedSkillsOptions): Promise<WorkspaceFileLock> {
  const lockRel = toPortablePath(MANAGED_SKILLS_LOCK_REL);
  const lockPath = resolveWorkspacePath(options.workspace, lockRel, "lock");
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  // The file is deliberately permanent: removing or renaming a lock inode
  // creates a publication race where two owners can hold different inodes.
  return acquireWorkspaceFileLock(lockPath, { timeoutMs });
}

async function loadOrMigrateManagedState(options: ReconcileManagedSkillsOptions): Promise<ManagedState> {
  const result = readManagedStateResult(options.workspace);
  if (result.kind === "current") return result.state;
  if (result.kind === "future") {
    throw new ManagedSkillsFatalError(
      `managed state schema v${result.schemaVersion} is newer than this client; refusing filesystem changes`,
    );
  }
  if (result.kind === "invalid") {
    throw new ManagedSkillsFatalError(`managed state is invalid; refusing filesystem changes: ${result.reason}`);
  }

  const legacyNames = result.kind === "legacy" ? result.state.skills : [];
  let bundledRoot: string | null = null;
  try {
    bundledRoot = options.bundledSkillsRoot ?? resolveBundledSkillsRoot();
  } catch {
    // Pair/ledger/marker ownership proofs still work without the current bundle.
  }
  const adopted: ManagedSkillEntry[] = [];
  const explicitlyManaged = new Set(legacyNames);
  for (const name of ALL_KNOWN_CORE_SKILL_NAMES) {
    const agentsTarget = `.agents/skills/${name}`;
    const claudeTarget = `.claude/skills/${name}`;
    const pairOwned = await isLegacyCorePair(options.workspace, name);
    const bundledPath = bundledRoot ? join(bundledRoot, name) : null;
    for (const target of [agentsTarget, claudeTarget]) {
      const digest = await digestLegacyTargetIfOwned(
        options.workspace,
        target,
        `core:${name}`,
        explicitlyManaged.has(name) || pairOwned,
        bundledPath,
      );
      if (!digest) continue;
      adopted.push({
        key: `core:${name}`,
        target,
        requestedSlug: name,
        effectiveName: name,
        revision: "legacy-v1",
        installedDigest: digest,
      });
    }
  }
  for (const name of legacyNames) {
    if (ALL_KNOWN_CORE_SKILL_NAMES.includes(name as (typeof ALL_KNOWN_CORE_SKILL_NAMES)[number])) continue;
    if (!isSafeSkillName(name)) continue;
    for (const root of [".agents/skills", ".claude/skills"]) {
      const target = `${root}/${name}`;
      const digest = await digestManagedTarget(options.workspace, target, { followExpectedLegacySymlink: true });
      if (!digest) continue;
      adopted.push({
        key: `core:${name}`,
        target,
        requestedSlug: name,
        effectiveName: name,
        revision: "legacy-v1",
        installedDigest: digest,
      });
    }
  }
  const migrated = writeManagedState(options.workspace, {
    ...emptyManagedState(),
    skills: adopted,
  });
  options.log?.(`Managed skills state migrated to v2 (${adopted.length} proven legacy target(s) adopted)`);
  return migrated;
}

async function isLegacyCorePair(workspace: string, name: string): Promise<boolean> {
  const claudePath = resolveWorkspacePath(workspace, `.claude/skills/${name}`, "target");
  try {
    const linkStat = await lstat(claudePath);
    if (!linkStat.isSymbolicLink()) return false;
    const target = toPortablePath(await readlink(claudePath));
    return target === `../../.agents/skills/${name}`;
  } catch {
    return false;
  }
}

async function digestLegacyTargetIfOwned(
  workspace: string,
  target: string,
  key: ManagedSkillEntry["key"],
  ownershipProven: boolean,
  bundledPath: string | null,
): Promise<`sha256:${string}` | null> {
  const marker = await readOwnershipMarker(workspace, target);
  if (marker?.key === key) {
    return digestManagedTarget(workspace, target, { followExpectedLegacySymlink: true });
  }
  const targetDigest = await digestManagedTarget(workspace, target, { followExpectedLegacySymlink: true });
  if (!targetDigest) return null;
  if (ownershipProven) return targetDigest;
  const bundledDigest = bundledPath ? await digestDirectoryIfPresent(bundledPath) : null;
  return bundledDigest === targetDigest ? targetDigest : null;
}

async function adoptLegacyResourceSkills(
  workspace: string,
  state: ManagedState,
  entries: readonly RuntimeTeamSkillEntry[],
  log?: (message: string) => void,
): Promise<ManagedState> {
  const additions: ManagedSkillEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "inline") continue;
    const skill: RuntimeResourceSkill = entry;
    if (!isSafeLegacyResourceId(skill.resourceId)) continue;
    const target = `${LEGACY_RESOURCE_SKILLS_ROOT}/${skill.resourceId}`;
    if (state.skills.some((entry) => entry.target === target)) continue;
    let actual: string;
    try {
      actual = await readFile(resolveWorkspacePath(workspace, `${target}/SKILL.md`, "legacy-resource-file"), "utf-8");
    } catch {
      continue;
    }
    if (actual !== buildLegacyResourceSkillMarkdown(skill)) continue;
    const digest = await digestManagedTarget(workspace, target);
    if (!digest) continue;
    let requestedSlug: string;
    try {
      requestedSlug = normalizeRequestedSlug(skill.name);
    } catch {
      continue;
    }
    additions.push({
      key: `resource:${skill.resourceId}`,
      target,
      requestedSlug,
      effectiveName: requestedSlug,
      revision: inlineSkillRevision(skill),
      installedDigest: digest,
    });
  }
  if (additions.length === 0) return state;
  log?.(`Managed skills adopted ${additions.length} legacy Team Skill target(s) for safe migration`);
  return persistStateMonotonic(workspace, { ...state, skills: [...state.skills, ...additions] });
}

function isSafeLegacyResourceId(resourceId: string): boolean {
  if (resourceId.length === 0 || resourceId.length > 255) return false;
  if (resourceId === "." || resourceId === "..") return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(resourceId);
}

async function buildDesiredSkills(
  options: ReconcileManagedSkillsOptions,
  authoritativeTeamSnapshot: boolean,
): Promise<DesiredManagedSkill[]> {
  let bundledRoot: string;
  try {
    bundledRoot = options.bundledSkillsRoot ?? resolveBundledSkillsRoot();
  } catch (error) {
    bundledRoot = join(options.workspace, ".first-tree-workspace", ".missing-bundled-skills");
    options.log?.(`Managed Core Skill bundle unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const desired: DesiredManagedSkill[] = [];
  for (const name of CORE_SKILL_NAMES) {
    const sourcePath = join(bundledRoot, name);
    let revision = "unavailable";
    let validationError: string | null = null;
    try {
      revision = await readRequiredVersion(sourcePath, name);
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      options.log?.(`Managed Core Skill rejected (core:${name}): ${validationError}`);
    }
    desired.push({
      key: `core:${name}`,
      kind: "core",
      requestedSlug: name,
      description: "",
      revision,
      validationError,
      source: { kind: "bundled-directory", path: sourcePath },
    });
  }
  if (!authoritativeTeamSnapshot || options.teamSnapshot.kind !== "authoritative") return desired;

  const sorted = [...options.teamSnapshot.entries].sort((left, right) =>
    left.resourceId.localeCompare(right.resourceId),
  );
  const resourceIdCounts = new Map<string, number>();
  for (const entry of sorted) {
    resourceIdCounts.set(entry.resourceId, (resourceIdCounts.get(entry.resourceId) ?? 0) + 1);
  }
  const emittedDuplicateIds = new Set<string>();
  for (const entry of sorted) {
    const key = `resource:${entry.resourceId}` as const;
    const revision = teamSkillEntryRevision(entry);
    const description = entry.kind === "unavailable" ? "Unavailable Team Skill" : entry.description || "No description";
    const source = teamSkillEntrySource(entry);
    if ((resourceIdCounts.get(entry.resourceId) ?? 0) > 1) {
      if (!emittedDuplicateIds.has(entry.resourceId)) {
        emittedDuplicateIds.add(entry.resourceId);
        options.log?.(`Managed Team Skill rejected (${key}): duplicate resourceId in authoritative snapshot`);
        desired.push({
          key,
          kind: "team",
          requestedSlug: "",
          description,
          revision,
          validationError: "duplicate resourceId in authoritative snapshot",
          source,
        });
      }
      continue;
    }
    if (entry.kind === "unavailable") {
      options.log?.(`Managed Team Skill unavailable (${key}): ${entry.reason}`);
      desired.push({
        key,
        kind: "team",
        requestedSlug: "",
        description,
        revision,
        validationError: entry.reason,
        source,
      });
      continue;
    }
    try {
      const requestedSlug = normalizeRequestedSlug(entry.name);
      if (RESERVED_CORE_SLUGS.has(requestedSlug)) {
        throw new Error(`Team Skill name "${entry.name}" is reserved by First Tree`);
      }
      desired.push({
        key,
        kind: "team",
        requestedSlug,
        description,
        revision,
        validationError: null,
        source,
      });
    } catch (error) {
      options.log?.(`Managed Team Skill rejected (${key}): ${error instanceof Error ? error.message : String(error)}`);
      // Keep the key in desired cleanup semantics by using an allocation that
      // cannot succeed. The caller records the failure and preserves old entries.
      desired.push({
        key,
        kind: "team",
        requestedSlug: "",
        description,
        revision,
        validationError: error instanceof Error ? error.message : String(error),
        source,
      });
    }
  }
  return desired;
}

async function allocateTargets(
  workspace: string,
  provider: RuntimeProvider,
  state: ManagedState,
  desired: readonly DesiredManagedSkill[],
): Promise<Map<ManagedSkillEntry["key"], AllocatedManagedSkill>> {
  const root = providerSkillRoot(provider);
  const occupied = new Map<string, ManagedSkillEntry["key"] | "unmanaged">();
  const onDiskSpellings = new Map<string, string>();
  try {
    for (const entry of await readdir(resolveWorkspacePath(workspace, root, "root"), { withFileTypes: true })) {
      const folded = entry.name.toLocaleLowerCase("en-US");
      occupied.set(folded, "unmanaged");
      onDiskSpellings.set(folded, entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of state.skills) {
    if (!entry.target.startsWith(`${root}/`)) continue;
    occupied.set(entry.effectiveName.toLocaleLowerCase("en-US"), entry.key);
  }

  const allocations = new Map<ManagedSkillEntry["key"], AllocatedManagedSkill>();
  for (const skill of desired) {
    if (!skill.requestedSlug || skill.validationError) continue;
    if (skill.kind === "core") {
      const target = `${root}/${skill.requestedSlug}`;
      const folded = skill.requestedSlug.toLocaleLowerCase("en-US");
      const owner = occupied.get(folded);
      if (owner === "unmanaged" && onDiskSpellings.get(folded) !== skill.requestedSlug) {
        // Do not create a second spelling that collides on case-insensitive
        // filesystems, even when the current test host is case-sensitive.
        continue;
      }
      if (
        owner !== undefined &&
        owner !== "unmanaged" &&
        owner !== skill.key &&
        !(await targetMarkerMatches(workspace, target, skill.key))
      ) {
        continue;
      }
      allocations.set(skill.key, { desired: skill, effectiveName: skill.requestedSlug, target });
      occupied.set(skill.requestedSlug.toLocaleLowerCase("en-US"), skill.key);
      continue;
    }

    const reusable = state.skills.find(
      (entry) =>
        entry.key === skill.key &&
        entry.requestedSlug === skill.requestedSlug &&
        entry.target.startsWith(`${root}/`) &&
        isSafeSkillName(entry.effectiveName),
    );
    if (reusable) {
      allocations.set(skill.key, {
        desired: skill,
        effectiveName: reusable.effectiveName,
        target: reusable.target,
      });
      occupied.set(reusable.effectiveName.toLocaleLowerCase("en-US"), skill.key);
      continue;
    }

    for (let suffix = 0; suffix < 10_000; suffix++) {
      const effectiveName =
        suffix === 0
          ? skill.requestedSlug
          : suffix === 1
            ? suffixSkillName(skill.requestedSlug, "-first-tree")
            : suffixSkillName(skill.requestedSlug, `-first-tree-${suffix}`);
      const target = `${root}/${effectiveName}`;
      const key = effectiveName.toLocaleLowerCase("en-US");
      const owner = occupied.get(key);
      if (owner === undefined || owner === skill.key || (await targetMarkerMatches(workspace, target, skill.key))) {
        allocations.set(skill.key, { desired: skill, effectiveName, target });
        occupied.set(key, skill.key);
        break;
      }
    }
  }
  return allocations;
}

async function ensureTargetOwnership(
  workspace: string,
  state: ManagedState,
  allocated: AllocatedManagedSkill,
): Promise<ManagedState> {
  const stateEntry = state.skills.find(
    (entry) => entry.key === allocated.desired.key && entry.target === allocated.target,
  );
  if (stateEntry) {
    const targetPath = resolveWorkspacePath(workspace, allocated.target, "target");
    if (await pathExists(targetPath)) {
      await proveManagedTargetOwnership(workspace, stateEntry);
    }
    return state;
  }
  const targetPath = resolveWorkspacePath(workspace, allocated.target, "target");
  let targetExists = true;
  try {
    await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") targetExists = false;
    else throw error;
  }
  if (!targetExists) return state;

  const marker = await readOwnershipMarker(workspace, allocated.target);
  if (marker?.key !== allocated.desired.key) {
    if (allocated.desired.kind === "core") {
      const sourceDigest =
        allocated.desired.source.kind === "bundled-directory"
          ? await digestDirectoryIfPresent(allocated.desired.source.path)
          : null;
      const targetDigest = await digestManagedTarget(workspace, allocated.target, {
        followExpectedLegacySymlink: true,
      });
      if (!sourceDigest || sourceDigest !== targetDigest) {
        throw new Error(`refusing to overwrite unowned Core Skill target ${allocated.target}`);
      }
    } else {
      throw new Error(`refusing to overwrite unowned Team Skill target ${allocated.target}`);
    }
  }
  const digest = await digestManagedTarget(workspace, allocated.target, { followExpectedLegacySymlink: true });
  if (!digest) throw new Error(`cannot adopt unreadable managed target ${allocated.target}`);
  return persistStateMonotonic(workspace, {
    ...state,
    skills: [
      ...state.skills,
      {
        key: allocated.desired.key,
        target: allocated.target,
        requestedSlug: allocated.desired.requestedSlug,
        effectiveName: allocated.effectiveName,
        revision: marker?.revision ?? "adopted",
        installedDigest: digest,
      },
    ],
  });
}

async function stageManagedSkill(
  options: ReconcileManagedSkillsOptions,
  allocated: AllocatedManagedSkill,
  targetPrecondition: StagedManagedSkill["targetPrecondition"],
): Promise<StagedManagedSkill> {
  const { workspace } = options;
  const targetPath = resolveWorkspacePath(workspace, allocated.target, "target");
  await mkdir(dirname(targetPath), { recursive: true });
  const stagingName = `.${basename(targetPath)}.ft-${randomBytes(8).toString("hex")}.staging`;
  const stagingPath = join(dirname(targetPath), stagingName);
  const staging = portableRelative(workspace, stagingPath);
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(stagingPath, { recursive: false, mode: 0o700 });
  try {
    if (allocated.desired.source.kind === "bundled-directory") {
      await copySanitizedSkillTree(allocated.desired.source.path, stagingPath);
    } else if (allocated.desired.source.kind === "inline-skill") {
      await writeInlineSkillTree(stagingPath, allocated);
    } else if (allocated.desired.source.kind === "attachment-bundle") {
      if (!options.fetchAttachment) throw new Error("Team Skill bundle download is unavailable");
      const descriptor = allocated.desired.source.descriptor;
      const downloaded = await options.fetchAttachment({
        id: descriptor.attachmentId,
        maxBytes: TEAM_SKILL_BUNDLE_LIMITS.compressedBytes,
        timeoutMs: TEAM_SKILL_DOWNLOAD_TIMEOUT_MS,
      });
      if (downloaded.size !== descriptor.sizeBytes || downloaded.bytes.byteLength !== descriptor.sizeBytes) {
        throw new Error(
          `Team Skill bundle size mismatch: expected ${descriptor.sizeBytes}, received ${downloaded.bytes.byteLength}`,
        );
      }
      await extractTeamSkillBundle(downloaded.bytes, stagingPath);
      await rewriteAttachmentSkillManifest(stagingPath, descriptor, allocated.effectiveName);
    } else {
      throw new Error("unavailable Team Skill cannot be staged");
    }
    await writeOwnershipMarker(stagingPath, allocated.desired.key, allocated.desired.revision);
    const metadata = await validateSkillManifest(stagingPath, allocated.effectiveName);
    if (allocated.desired.kind === "core" && metadata.name !== allocated.desired.requestedSlug) {
      throw new Error(
        `bundled Core Skill manifest name "${metadata.name}" does not match "${allocated.desired.requestedSlug}"`,
      );
    }
    const installedDigest = await digestDirectory(stagingPath);
    return {
      allocated,
      staging,
      targetPrecondition,
      entry: {
        key: allocated.desired.key,
        target: allocated.target,
        requestedSlug: allocated.desired.requestedSlug,
        effectiveName: allocated.effectiveName,
        revision: allocated.desired.revision,
        installedDigest,
      },
    };
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function captureInstallTargetPrecondition(
  workspace: string,
  target: string,
  state: ManagedState,
  key: ManagedSkillEntry["key"],
): Promise<StagedManagedSkill["targetPrecondition"]> {
  const targetPath = resolveWorkspacePath(workspace, target, "target");
  if (!(await pathExists(targetPath))) return { kind: "absent" };
  const entry = state.skills.find((candidate) => candidate.key === key && candidate.target === target);
  if (!entry) throw new Error(`cannot prove managed target ownership before staging ${target}`);
  return { kind: "present", proof: await proveManagedTargetOwnership(workspace, entry) };
}

async function installStagedSkill(
  options: ReconcileManagedSkillsOptions,
  beforeState: ManagedState,
  staged: StagedManagedSkill,
): Promise<ManagedState> {
  const afterState = replaceEntry(beforeState, staged.entry);
  const targetPath = resolveWorkspacePath(options.workspace, staged.entry.target, "target");
  const stagingPath = resolveWorkspacePath(options.workspace, staged.staging, "temporary");
  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.ft-${randomBytes(8).toString("hex")}.backup`);
  const backup = portableRelative(options.workspace, backupPath);
  const targetExists = await pathExists(targetPath);
  try {
    if (staged.targetPrecondition.kind === "absent") {
      if (targetExists) {
        throw new Error(`refusing to replace target created while staging ${staged.entry.target}`);
      }
    } else {
      if (!targetExists) {
        throw new Error(`managed target disappeared while staging ${staged.entry.target}`);
      }
      await assertManagedRootMatchesProof(
        resolveWorkspacePath(options.workspace, staged.entry.target, "target"),
        options.workspace,
        staged.targetPrecondition.proof,
        `managed target changed while staging ${staged.entry.target}`,
      );
    }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
  let journal: ManagedSkillsJournal = {
    schemaVersion: 1,
    operationId: randomBytes(16).toString("hex"),
    operation: "install",
    phase: "prepared",
    target: staged.entry.target,
    staging: staged.staging,
    backup: targetExists ? backup : null,
    expectedInstalledDigest: staged.entry.installedDigest,
    beforeState,
    afterState,
  };
  writeManagedSkillsJournal(options.workspace, journal);
  maybeFault(options, "prepared");
  try {
    if (targetExists) {
      await rename(targetPath, backupPath);
      if (staged.targetPrecondition.kind !== "present") {
        throw new Error(`managed target ownership proof is missing for ${staged.entry.target}`);
      }
      await assertManagedRootMatchesProof(
        backupPath,
        options.workspace,
        staged.targetPrecondition.proof,
        `managed target ownership changed before replacement ${staged.entry.target}`,
      );
      journal = writeJournalPhase(options.workspace, journal, "target_backed_up");
      maybeFault(options, "target_backed_up");
    }
    await rename(stagingPath, targetPath);
    journal = writeJournalPhase(options.workspace, journal, "target_installed");
    maybeFault(options, "target_installed");
    const persisted = persistStateMonotonic(options.workspace, afterState);
    journal = {
      ...journal,
      afterState: persisted,
      phase: "state_committed",
    };
    writeManagedSkillsJournal(options.workspace, journal);
    maybeFault(options, "state_committed");
    if (targetExists) await rm(backupPath, { recursive: true, force: true });
    maybeFault(options, "backup_cleaned");
    clearManagedSkillsJournal(options.workspace);
    return persisted;
  } catch (error) {
    if (error instanceof ManagedSkillsSimulatedCrash) throw error;
    await recoverFailedTransaction(options, "install");
    throw error;
  }
}

async function removeManagedEntry(
  options: ReconcileManagedSkillsOptions,
  beforeState: ManagedState,
  entry: ManagedSkillEntry,
): Promise<ManagedState> {
  assertManagedTarget(entry.target);
  const afterState = removeEntry(beforeState, entry);
  const targetPath = resolveWorkspacePath(options.workspace, entry.target, "target");
  if (!(await pathExists(targetPath))) {
    return persistStateMonotonic(options.workspace, afterState);
  }
  const ownershipProof = await proveManagedTargetOwnership(options.workspace, entry);
  const backupPath = join(dirname(targetPath), `.${basename(targetPath)}.ft-${randomBytes(8).toString("hex")}.backup`);
  const backup = portableRelative(options.workspace, backupPath);
  let journal: ManagedSkillsJournal = {
    schemaVersion: 1,
    operationId: randomBytes(16).toString("hex"),
    operation: "remove",
    phase: "prepared",
    target: entry.target,
    staging: null,
    backup,
    expectedInstalledDigest: null,
    beforeState,
    afterState,
  };
  writeManagedSkillsJournal(options.workspace, journal);
  maybeFault(options, "prepared");
  try {
    await rename(targetPath, backupPath);
    await assertManagedRootMatchesProof(
      backupPath,
      options.workspace,
      ownershipProof,
      `managed target ownership changed before removal ${entry.target}`,
    );
    journal = writeJournalPhase(options.workspace, journal, "target_backed_up");
    maybeFault(options, "target_backed_up");
    const persisted = persistStateMonotonic(options.workspace, afterState);
    journal = {
      ...journal,
      afterState: persisted,
      phase: "state_committed",
    };
    writeManagedSkillsJournal(options.workspace, journal);
    maybeFault(options, "state_committed");
    await rm(backupPath, { recursive: true, force: true });
    maybeFault(options, "backup_cleaned");
    clearManagedSkillsJournal(options.workspace);
    return persisted;
  } catch (error) {
    if (error instanceof ManagedSkillsSimulatedCrash) throw error;
    await recoverFailedTransaction(options, "removal");
    throw error;
  }
}

async function recoverFailedTransaction(
  options: ReconcileManagedSkillsOptions,
  operation: "install" | "removal",
): Promise<void> {
  try {
    if (options.testRecoveryFailure) {
      throw new Error("simulated managed skills recovery failure");
    }
    await recoverPendingJournal(options.workspace, options.log);
    const recovered = readManagedStateResult(options.workspace);
    if (recovered.kind !== "current") {
      throw new Error("managed state unavailable after transaction recovery");
    }
  } catch (error) {
    throw new ManagedSkillsFatalError(
      `managed skills ${operation} recovery failed; reconciliation aborted with journal preserved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function recoverPendingJournal(workspace: string, log?: (message: string) => void): Promise<void> {
  const result = readManagedSkillsJournal(workspace);
  if (result.kind === "missing") return;
  if (result.kind === "future") {
    throw new ManagedSkillsFatalError(
      `managed skills journal schema v${result.schemaVersion} is newer than this client`,
    );
  }
  if (result.kind === "invalid") {
    throw new ManagedSkillsFatalError(`managed skills journal is invalid: ${result.reason}`);
  }
  const journal = result.journal;
  assertManagedTarget(journal.target);
  if (journal.staging) assertTemporaryTarget(journal.staging, ".staging");
  if (journal.backup) assertTemporaryTarget(journal.backup, ".backup");

  const stateResult = readManagedStateResult(workspace);
  if (stateResult.kind === "future" || stateResult.kind === "invalid" || stateResult.kind === "legacy") {
    throw new ManagedSkillsFatalError("cannot recover managed skills journal against an unsafe managed state");
  }
  const currentState = stateResult.kind === "current" ? stateResult.state : journal.beforeState;
  if (currentState.resourceConfigVersion > journal.afterState.resourceConfigVersion) {
    throw new ManagedSkillsFatalError("managed skills journal would cross a newer Team Resource version fence");
  }

  const targetPath = resolveWorkspacePath(workspace, journal.target, "target");
  const stagingPath = journal.staging ? resolveWorkspacePath(workspace, journal.staging, "temporary") : null;
  const backupPath = journal.backup ? resolveWorkspacePath(workspace, journal.backup, "temporary") : null;
  const targetExists = await pathExists(targetPath);
  const backupExists = backupPath ? await pathExists(backupPath) : false;

  if (journal.operation === "install") {
    const actualDigest = targetExists ? await digestManagedTarget(workspace, journal.target) : null;
    if (actualDigest === journal.expectedInstalledDigest) {
      persistStateMonotonic(workspace, journal.afterState);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      if (backupPath) await rm(backupPath, { recursive: true, force: true });
      clearManagedSkillsJournal(workspace);
      log?.(`Managed skills recovered completed install transaction for ${journal.target}`);
      return;
    }
    if (journal.phase === "prepared" && targetExists && !backupExists) {
      persistStateMonotonic(workspace, journal.beforeState);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      clearManagedSkillsJournal(workspace);
      log?.(`Managed skills discarded prepared install transaction for ${journal.target}`);
      return;
    }
    if (backupExists && backupPath && !targetExists) {
      await rename(backupPath, targetPath);
      persistStateMonotonic(workspace, journal.beforeState);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      clearManagedSkillsJournal(workspace);
      log?.(`Managed skills rolled back interrupted install transaction for ${journal.target}`);
      return;
    }
    if (!backupExists && !targetExists) {
      persistStateMonotonic(workspace, journal.beforeState);
      if (stagingPath) await rm(stagingPath, { recursive: true, force: true });
      clearManagedSkillsJournal(workspace);
      log?.(`Managed skills discarded uncommitted install transaction for ${journal.target}`);
      return;
    }
    throw new ManagedSkillsFatalError(`cannot safely recover interrupted install for ${journal.target}`);
  }

  const currentMatchesAfter = stateEquivalent(currentState, journal.afterState);
  if (journal.phase === "prepared" && targetExists && !backupExists) {
    persistStateMonotonic(workspace, journal.beforeState);
    clearManagedSkillsJournal(workspace);
    log?.(`Managed skills discarded prepared removal transaction for ${journal.target}`);
    return;
  }
  if (!targetExists && currentMatchesAfter) {
    if (backupPath) await rm(backupPath, { recursive: true, force: true });
    clearManagedSkillsJournal(workspace);
    log?.(`Managed skills completed interrupted removal transaction for ${journal.target}`);
    return;
  }
  if (!targetExists && backupExists && backupPath) {
    await rename(backupPath, targetPath);
    persistStateMonotonic(workspace, journal.beforeState);
    clearManagedSkillsJournal(workspace);
    log?.(`Managed skills rolled back interrupted removal transaction for ${journal.target}`);
    return;
  }
  if (!targetExists && !backupExists && currentMatchesAfter) {
    clearManagedSkillsJournal(workspace);
    return;
  }
  throw new ManagedSkillsFatalError(`cannot safely recover interrupted removal for ${journal.target}`);
}

function persistStateMonotonic(workspace: string, candidate: ManagedState): ManagedState {
  const current = readManagedStateResult(workspace);
  if (current.kind === "future" || current.kind === "invalid" || current.kind === "legacy") {
    throw new ManagedSkillsFatalError("refusing to write managed state over an unsafe schema");
  }
  if (current.kind === "current" && current.state.resourceConfigVersion > candidate.resourceConfigVersion) {
    throw new ManagedSkillsFatalError(
      `refusing to lower Team Resource fence from v${current.state.resourceConfigVersion} ` +
        `to v${candidate.resourceConfigVersion}`,
    );
  }
  return writeManagedState(workspace, candidate);
}

function writeJournalPhase(
  workspace: string,
  journal: ManagedSkillsJournal,
  phase: ManagedSkillsJournalPhase,
): ManagedSkillsJournal {
  const next = { ...journal, phase };
  writeManagedSkillsJournal(workspace, next);
  return next;
}

function maybeFault(options: ReconcileManagedSkillsOptions, checkpoint: ManagedSkillsCheckpoint): void {
  if (options.testCrashAt === checkpoint) {
    throw new ManagedSkillsSimulatedCrash(`simulated managed skills crash at ${checkpoint}`);
  }
  if (options.testFailureAt === checkpoint) {
    throw new Error(`simulated managed skills failure at ${checkpoint}`);
  }
}

async function buildReconciledTeamRows(
  workspace: string,
  state: ManagedState,
  desired: readonly DesiredManagedSkill[],
  successfulTargets: ReadonlyMap<ManagedSkillEntry["key"], string>,
): Promise<ReconciledTeamSkill[]> {
  const rows: ReconciledTeamSkill[] = [];
  for (const skill of desired) {
    if (skill.kind !== "team") continue;
    const target = successfulTargets.get(skill.key);
    if (!target) continue;
    const entry = state.skills.find(
      (candidate) =>
        candidate.key === skill.key && candidate.target === target && candidate.revision === skill.revision,
    );
    if (!entry) continue;
    const actualDigest = await digestManagedTarget(workspace, target);
    if (actualDigest !== entry.installedDigest) continue;
    rows.push({
      key: skill.key as `resource:${string}`,
      name: entry.effectiveName,
      description: skill.description,
      target,
      revision: entry.revision,
      installedDigest: entry.installedDigest,
    });
  }
  return rows;
}

async function writeInlineSkillTree(stagingPath: string, allocated: AllocatedManagedSkill): Promise<void> {
  if (allocated.desired.source.kind !== "inline-skill") {
    throw new Error("inline Skill staging requires an inline source");
  }
  const skill = allocated.desired.source.skill;
  const metadata = stableJson(skill.metadata);
  const markdown = [
    "---",
    `name: ${JSON.stringify(allocated.effectiveName)}`,
    `description: ${JSON.stringify(skill.description || "No description")}`,
    `metadata: ${metadata}`,
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
  await writeFile(join(stagingPath, "SKILL.md"), markdown, { encoding: "utf-8", mode: 0o600 });
  await writeFile(join(stagingPath, "VERSION"), `${allocated.desired.revision}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

async function writeOwnershipMarker(
  stagingPath: string,
  key: ManagedSkillEntry["key"],
  revision: string,
): Promise<void> {
  await writeFile(join(stagingPath, OWNERSHIP_MARKER), ownershipMarkerContent(key, revision), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

function ownershipMarkerContent(key: ManagedSkillEntry["key"], revision: string): string {
  return `${JSON.stringify({ schemaVersion: 1, key, revision }, null, 2)}\n`;
}

async function proveManagedTargetOwnership(
  workspace: string,
  entry: ManagedSkillEntry,
): Promise<ManagedTargetOwnershipProof> {
  const targetPath = resolveWorkspacePath(workspace, entry.target, "target");
  const targetStat = await lstat(targetPath);
  if (targetStat.isSymbolicLink()) {
    const linkTarget = toPortablePath(await readlink(targetPath));
    if (
      entry.revision === "legacy-v1" &&
      entry.key.startsWith("core:") &&
      entry.target === `.claude/skills/${entry.key.slice("core:".length)}` &&
      linkTarget === `../../.agents/skills/${entry.key.slice("core:".length)}`
    ) {
      return { kind: "legacy-symlink", key: entry.key, linkTarget };
    }
    throw new Error(`refusing to mutate unowned managed Skill target ${entry.target}`);
  }
  if (!targetStat.isDirectory()) {
    throw new Error(`refusing to mutate non-directory managed Skill target ${entry.target}`);
  }

  const digest = await digestDirectory(targetPath);
  const marker = await readOwnershipMarkerAtRoot(targetPath);
  if (marker?.key === entry.key && marker.revision === entry.revision) {
    return {
      kind: "marker",
      key: entry.key,
      revision: entry.revision,
      digest,
    };
  }
  if (digest === entry.installedDigest) {
    return { kind: "ledger-digest", key: entry.key, digest };
  }
  throw new Error(`refusing to mutate unowned managed Skill target ${entry.target}`);
}

async function assertManagedRootMatchesProof(
  rootPath: string,
  workspace: string,
  proof: ManagedTargetOwnershipProof,
  errorMessage: string,
): Promise<void> {
  const workspaceRoot = realpathSync(resolve(workspace));
  const absoluteRoot = resolve(rootPath);
  if (absoluteRoot === workspaceRoot || !absoluteRoot.startsWith(`${workspaceRoot}${sep}`)) {
    throw new ManagedSkillsFatalError("managed Skill ownership proof path escapes workspace");
  }
  const rootStat = await lstat(absoluteRoot);
  if (proof.kind === "legacy-symlink") {
    if (!rootStat.isSymbolicLink() || toPortablePath(await readlink(absoluteRoot)) !== proof.linkTarget) {
      throw new Error(errorMessage);
    }
    return;
  }
  if (!rootStat.isDirectory()) throw new Error(errorMessage);
  const digest = await digestDirectory(absoluteRoot);
  if (digest !== proof.digest) throw new Error(errorMessage);
  if (proof.kind === "marker") {
    const marker = await readOwnershipMarkerAtRoot(absoluteRoot);
    if (marker?.key !== proof.key || marker.revision !== proof.revision) {
      throw new Error(errorMessage);
    }
  }
}

async function readOwnershipMarker(
  workspace: string,
  target: string,
): Promise<Readonly<{ key: ManagedSkillEntry["key"]; revision: string }> | null> {
  const targetRoot = resolveWorkspacePath(workspace, target, "target");
  try {
    if (!(await lstat(targetRoot)).isDirectory()) return null;
    return readOwnershipMarkerAtRoot(targetRoot);
  } catch {
    return null;
  }
}

async function readOwnershipMarkerAtRoot(
  targetRoot: string,
): Promise<Readonly<{ key: ManagedSkillEntry["key"]; revision: string }> | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(targetRoot, OWNERSHIP_MARKER), "utf-8"));
    if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.key !== "string" || typeof raw.revision !== "string") {
      return null;
    }
    if (!raw.key.startsWith("core:") && !raw.key.startsWith("resource:")) return null;
    return {
      // The prefix checks above narrow the runtime value to the persisted key contract.
      key: raw.key as ManagedSkillEntry["key"],
      revision: raw.revision,
    };
  } catch {
    return null;
  }
}

async function targetMarkerMatches(workspace: string, target: string, key: ManagedSkillEntry["key"]): Promise<boolean> {
  return (await readOwnershipMarker(workspace, target))?.key === key;
}

async function validateSkillManifest(
  stagingPath: string,
  expectedName: string,
): Promise<Readonly<{ name: string; description: string }>> {
  const markdown = await readFile(join(stagingPath, "SKILL.md"), "utf-8");
  let parsed: ReturnType<typeof parseTeamSkillMarkdown>;
  try {
    parsed = parseTeamSkillMarkdown(markdown);
  } catch (error) {
    throw new Error(`SKILL.md frontmatter is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !isRecord(parsed.frontmatter) ||
    typeof parsed.frontmatter.name !== "string" ||
    typeof parsed.frontmatter.description !== "string"
  ) {
    throw new Error("SKILL.md frontmatter requires string name and description");
  }
  if (parsed.frontmatter.name !== expectedName) {
    throw new Error(`SKILL.md name "${parsed.frontmatter.name}" does not match effective name "${expectedName}"`);
  }
  if (parsed.frontmatter.description.trim().length === 0) {
    throw new Error("SKILL.md description must not be empty");
  }
  return { name: parsed.frontmatter.name, description: parsed.frontmatter.description };
}

async function rewriteAttachmentSkillManifest(
  stagingPath: string,
  descriptor: RuntimeTeamSkillAttachmentEntry,
  effectiveName: string,
): Promise<void> {
  const path = join(stagingPath, "SKILL.md");
  const bytes = await readFile(path);
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("SKILL.md must be valid UTF-8");
  }
  let parsed: ReturnType<typeof parseTeamSkillMarkdown>;
  try {
    parsed = parseTeamSkillMarkdown(markdown);
  } catch (error) {
    throw new Error(`SKILL.md frontmatter is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    !isRecord(parsed.frontmatter) ||
    typeof parsed.frontmatter.name !== "string" ||
    typeof parsed.frontmatter.description !== "string"
  ) {
    throw new Error("SKILL.md frontmatter requires string name and description");
  }
  if (
    parsed.frontmatter.name.trim() !== descriptor.name ||
    parsed.frontmatter.description.trim() !== descriptor.description
  ) {
    throw new Error("Team Skill bundle manifest does not match its authoritative descriptor");
  }
  const frontmatter = stringifyYaml({ ...parsed.frontmatter, name: effectiveName }).trimEnd();
  const rewritten = `---\n${frontmatter}\n---\n${parsed.body}`;
  if (Buffer.byteLength(rewritten, "utf-8") > MAX_SKILL_FILE_BYTES) {
    throw new Error(`rewritten SKILL.md exceeds max size ${MAX_SKILL_FILE_BYTES}`);
  }
  await writeFile(path, rewritten, { encoding: "utf-8", mode: 0o600 });
}

async function copySanitizedSkillTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory()) throw new Error(`bundled Skill source is not a directory: ${sourceRoot}`);
  const stats: SkillTreeStats = { files: 0, bytes: 0 };
  await copySanitizedDirectory(sourceRoot, destinationRoot, "", 0, stats);
}

async function copySanitizedDirectory(
  sourceRoot: string,
  destinationRoot: string,
  relativeDir: string,
  depth: number,
  treeStats: SkillTreeStats,
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) throw new Error(`Skill bundle exceeds max directory depth ${MAX_SKILL_DEPTH}`);
  const sourceDir = relativeDir ? join(sourceRoot, ...relativeDir.split("/")) : sourceRoot;
  const destinationDir = relativeDir ? join(destinationRoot, ...relativeDir.split("/")) : destinationRoot;
  await mkdir(destinationDir, { recursive: true });
  const entries = (await readdir(sourceDir, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const caseInsensitiveNames = new Set<string>();
  for (const entry of entries) {
    const folded = entry.name.toLocaleLowerCase("en-US");
    if (caseInsensitiveNames.has(folded)) {
      throw new Error(`Skill bundle contains a case-insensitive path collision at ${relativeDir || "."}`);
    }
    caseInsensitiveNames.add(folded);
    if (!isPortableBundleSegment(entry.name)) {
      throw new Error(`Skill bundle contains an unsafe path segment: ${entry.name}`);
    }
    if (!relativeDir && entry.name === OWNERSHIP_MARKER) {
      throw new Error(`Skill bundle may not provide reserved file ${OWNERSHIP_MARKER}`);
    }
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(destinationDir, entry.name);
    const entryStat = await lstat(sourcePath);
    if (entryStat.isSymbolicLink()) throw new Error(`Skill bundle symlinks are not allowed: ${relativePath}`);
    if (entryStat.isDirectory()) {
      await copySanitizedDirectory(sourceRoot, destinationRoot, relativePath, depth + 1, treeStats);
      continue;
    }
    if (!entryStat.isFile()) throw new Error(`Skill bundle special files are not allowed: ${relativePath}`);
    treeStats.files++;
    treeStats.bytes += entryStat.size;
    if (treeStats.files > MAX_SKILL_FILES) throw new Error(`Skill bundle exceeds max file count ${MAX_SKILL_FILES}`);
    if (entryStat.size > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Skill bundle file exceeds max size ${MAX_SKILL_FILE_BYTES}: ${relativePath}`);
    }
    if (treeStats.bytes > MAX_SKILL_TOTAL_BYTES) {
      throw new Error(`Skill bundle exceeds max total bytes ${MAX_SKILL_TOTAL_BYTES}`);
    }
    const content = await readFile(sourcePath);
    await writeFile(destinationPath, content, { mode: entryStat.mode & 0o777 });
    await chmod(destinationPath, entryStat.mode & 0o777);
  }
}

function isPortableBundleSegment(name: string): boolean {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    containsControlCharacter(name) ||
    /[<>:"|?*]/u.test(name) ||
    name.endsWith(".") ||
    name.endsWith(" ")
  ) {
    return false;
  }
  const windowsBase = name.split(".", 1)[0]?.toLocaleLowerCase("en-US") ?? "";
  return !WINDOWS_RESERVED_NAMES.has(windowsBase);
}

async function digestManagedTarget(
  workspace: string,
  target: string,
  options?: Readonly<{ followExpectedLegacySymlink?: boolean }>,
): Promise<`sha256:${string}` | null> {
  assertManagedTarget(target);
  const path = resolveWorkspacePath(workspace, target, "target");
  try {
    const targetStat = await lstat(path);
    if (targetStat.isDirectory()) return await digestDirectory(path);
    if (targetStat.isSymbolicLink() && options?.followExpectedLegacySymlink) {
      const linked = resolve(dirname(path), await readlink(path));
      const [workspaceRealPath, linkedRealPath] = await Promise.all([realpath(workspace), realpath(linked)]);
      if (linkedRealPath !== workspaceRealPath && !linkedRealPath.startsWith(`${workspaceRealPath}${sep}`)) {
        return null;
      }
      const linkedStat = await stat(linkedRealPath);
      if (!linkedStat.isDirectory()) return null;
      return await digestDirectory(linkedRealPath);
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function digestDirectoryIfPresent(path: string): Promise<`sha256:${string}` | null> {
  try {
    const pathStat = await lstat(path);
    if (!pathStat.isDirectory()) return null;
    return await digestDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function digestDirectory(root: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  await hashDirectoryRecursive(root, "", hash, 0, { files: 0, bytes: 0 }, null);
  return `sha256:${hash.digest("hex")}`;
}

async function digestBundledFinalTree(
  root: string,
  key: ManagedSkillEntry["key"],
  revision: string,
): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  await hashDirectoryRecursive(
    root,
    "",
    hash,
    0,
    { files: 0, bytes: 0 },
    {
      name: OWNERSHIP_MARKER,
      content: Buffer.from(ownershipMarkerContent(key, revision), "utf-8"),
      mode: 0o600,
    },
  );
  return `sha256:${hash.digest("hex")}`;
}

async function hashDirectoryRecursive(
  root: string,
  relativeDir: string,
  hash: ReturnType<typeof createHash>,
  depth: number,
  treeStats: SkillTreeStats,
  virtualRootFile: Readonly<{ name: string; content: Buffer; mode: number }> | null,
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) throw new Error(`Skill tree exceeds max directory depth ${MAX_SKILL_DEPTH}`);
  const directory = relativeDir ? join(root, ...relativeDir.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  const names = entries.map((entry) => entry.name);
  if (!relativeDir && virtualRootFile) names.push(virtualRootFile.name);
  names.sort((left, right) => left.localeCompare(right));
  const caseInsensitiveNames = new Set<string>();
  for (const name of names) {
    const folded = name.toLocaleLowerCase("en-US");
    if (caseInsensitiveNames.has(folded)) {
      throw new Error(`Skill tree contains a case-insensitive path collision at ${relativeDir || "."}`);
    }
    caseInsensitiveNames.add(folded);
    const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
    if (!relativeDir && virtualRootFile?.name === name && !entryByName.has(name)) {
      if (virtualRootFile.content.byteLength > MAX_OWNERSHIP_MARKER_BYTES) {
        throw new Error(`Skill tree ownership marker exceeds max size ${MAX_OWNERSHIP_MARKER_BYTES}`);
      }
      treeStats.files++;
      treeStats.bytes += virtualRootFile.content.byteLength;
      if (
        treeStats.files > MAX_INSTALLED_SKILL_FILES ||
        treeStats.bytes > MAX_INSTALLED_SKILL_TOTAL_BYTES ||
        virtualRootFile.content.byteLength > MAX_SKILL_FILE_BYTES
      ) {
        throw new Error(`Skill tree exceeds configured bundle limits at ${relativePath}`);
      }
      hash.update(`file\0${relativePath}\0${virtualRootFile.mode & 0o111}\0${virtualRootFile.content.byteLength}\0`);
      hash.update(virtualRootFile.content);
      hash.update("\0");
      continue;
    }
    const entry = entryByName.get(name);
    if (!entry) throw new Error(`Skill tree entry disappeared while hashing: ${relativePath}`);
    const path = join(directory, name);
    const entryStat = await lstat(path);
    if (entryStat.isSymbolicLink()) throw new Error(`Skill tree symlinks are not allowed: ${relativePath}`);
    if (entryStat.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      await hashDirectoryRecursive(root, relativePath, hash, depth + 1, treeStats, virtualRootFile);
      continue;
    }
    if (!entryStat.isFile()) throw new Error(`Skill tree special files are not allowed: ${relativePath}`);
    if (!relativeDir && name === OWNERSHIP_MARKER && entryStat.size > MAX_OWNERSHIP_MARKER_BYTES) {
      throw new Error(`Skill tree ownership marker exceeds max size ${MAX_OWNERSHIP_MARKER_BYTES}`);
    }
    treeStats.files++;
    treeStats.bytes += entryStat.size;
    if (
      treeStats.files > MAX_INSTALLED_SKILL_FILES ||
      treeStats.bytes > MAX_INSTALLED_SKILL_TOTAL_BYTES ||
      entryStat.size > MAX_SKILL_FILE_BYTES
    ) {
      throw new Error(`Skill tree exceeds configured bundle limits at ${relativePath}`);
    }
    hash.update(`file\0${relativePath}\0${entryStat.mode & 0o111}\0${entryStat.size}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  }
}

function normalizeRequestedSlug(input: string): string {
  if (input.includes("/") || input.includes("\\") || containsControlCharacter(input)) {
    throw new Error("Skill name contains a path separator or control character");
  }
  const slug = input
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!isSafeSkillName(slug)) throw new Error(`Skill name "${input}" does not produce a safe slug`);
  return slug;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafeSkillName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_SKILL_NAME_LENGTH) return false;
  if (name === "." || name === ".." || WINDOWS_RESERVED_NAMES.has(name.toLocaleLowerCase("en-US"))) return false;
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function suffixSkillName(base: string, suffix: string): string {
  const trimmed = base.slice(0, MAX_SKILL_NAME_LENGTH - suffix.length).replace(/-+$/g, "");
  const result = `${trimmed}${suffix}`;
  if (!isSafeSkillName(result)) throw new Error(`cannot allocate safe suffixed Skill name for ${base}`);
  return result;
}

function inlineSkillRevision(skill: RuntimeResourceSkill): string {
  return `sha256:${createHash("sha256").update(stableJson(skill)).digest("hex")}`;
}

function inlineEntrySkill(entry: Extract<RuntimeTeamSkillEntry, { kind: "inline" }>): RuntimeResourceSkill {
  return {
    resourceId: entry.resourceId,
    name: entry.name,
    description: entry.description,
    body: entry.body,
    metadata: entry.metadata,
  };
}

function attachmentBundleRevision(entry: RuntimeTeamSkillAttachmentEntry): string {
  return `sha256:${createHash("sha256")
    .update("first-tree-attachment-bundle-v1\0")
    .update(entry.attachmentId)
    .update("\0")
    .update(String(entry.sizeBytes))
    .digest("hex")}`;
}

function teamSkillEntryRevision(entry: RuntimeTeamSkillEntry): string {
  if (entry.kind === "inline") return inlineSkillRevision(inlineEntrySkill(entry));
  if (entry.kind === "attachment-bundle") return attachmentBundleRevision(entry);
  return `unavailable:${createHash("sha256").update(entry.reason).digest("hex")}`;
}

function teamSkillEntrySource(entry: RuntimeTeamSkillEntry): DesiredManagedSkill["source"] {
  if (entry.kind === "inline") return { kind: "inline-skill", skill: inlineEntrySkill(entry) };
  if (entry.kind === "attachment-bundle") return { kind: "attachment-bundle", descriptor: entry };
  return { kind: "unavailable" };
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) throw new Error("Skill metadata is not JSON-serializable");
  return serialized;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

async function readRequiredVersion(sourcePath: string, name: string): Promise<string> {
  let version: string;
  try {
    version = (await readFile(join(sourcePath, "VERSION"), "utf-8")).trim();
  } catch (error) {
    throw new Error(`bundled Core Skill ${name} is missing VERSION: ${error instanceof Error ? error.message : error}`);
  }
  if (!version) throw new Error(`bundled Core Skill ${name} has an empty VERSION`);
  return version;
}

function buildLegacyResourceSkillMarkdown(skill: RuntimeResourceSkill): string {
  const metadata = Object.keys(skill.metadata).length > 0 ? JSON.stringify(skill.metadata) : "{}";
  return [
    "---",
    `name: ${JSON.stringify(skill.name)}`,
    `description: ${JSON.stringify(skill.description)}`,
    `metadata: ${metadata}`,
    "---",
    "",
    skill.body,
    "",
  ].join("\n");
}

function replaceEntry(state: ManagedState, entry: ManagedSkillEntry): ManagedState {
  return {
    ...state,
    skills: [
      ...state.skills.filter((candidate) => !(candidate.key === entry.key && candidate.target === entry.target)),
      entry,
    ],
  };
}

function removeEntry(state: ManagedState, entry: ManagedSkillEntry): ManagedState {
  return {
    ...state,
    skills: state.skills.filter((candidate) => !(candidate.key === entry.key && candidate.target === entry.target)),
  };
}

function stateEquivalent(left: ManagedState, right: ManagedState): boolean {
  if (left.resourceConfigVersion !== right.resourceConfigVersion) return false;
  const normalize = (state: ManagedState): string =>
    JSON.stringify(
      [...state.skills].sort(
        (leftEntry, rightEntry) =>
          leftEntry.key.localeCompare(rightEntry.key) || leftEntry.target.localeCompare(rightEntry.target),
      ),
    );
  return normalize(left) === normalize(right);
}

function assertManagedTarget(target: string): void {
  const parts = target.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    throw new ManagedSkillsFatalError(`unsafe managed Skill target: ${target}`);
  }
  const root = parts.slice(0, -1).join("/");
  if (!ALLOWED_TARGET_ROOTS.has(root) || parts.length < 3) {
    throw new ManagedSkillsFatalError(`managed Skill target is outside allowed roots: ${target}`);
  }
}

function assertTemporaryTarget(target: string, suffix: ".staging" | ".backup"): void {
  const parts = target.split("/");
  const root = parts.slice(0, -1).join("/");
  const name = parts.at(-1) ?? "";
  if (!ALLOWED_TARGET_ROOTS.has(root) || !name.startsWith(".") || !name.includes(".ft-") || !name.endsWith(suffix)) {
    throw new ManagedSkillsFatalError(`unsafe managed Skill transaction path: ${target}`);
  }
}

function assertManagedWorkspaceRootsSafe(workspace: string): void {
  resolveWorkspacePath(workspace, toPortablePath(MANAGED_SKILLS_LOCK_REL), "lock");
  for (const root of ALLOWED_TARGET_ROOTS) {
    resolveWorkspacePath(workspace, root, "root");
  }
}

function resolveWorkspacePath(
  workspace: string,
  portablePath: string,
  kind: "target" | "temporary" | "lock" | "root" | "legacy-resource-file",
): string {
  if (kind === "target") assertManagedTarget(portablePath);
  if (kind === "temporary") {
    if (portablePath.endsWith(".staging")) assertTemporaryTarget(portablePath, ".staging");
    else assertTemporaryTarget(portablePath, ".backup");
  }
  const workspaceRoot = realpathSync(resolve(workspace));
  if (!lstatSync(workspaceRoot).isDirectory()) {
    throw new ManagedSkillsFatalError(`managed skills workspace is not a directory: ${workspace}`);
  }
  const absolute = resolve(workspaceRoot, ...portablePath.split("/"));
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${sep}`)) {
    throw new ManagedSkillsFatalError(`${kind} path escapes workspace: ${portablePath}`);
  }
  assertExistingPathChainIsDirectory(
    workspaceRoot,
    absolute,
    kind === "root" || (kind === "temporary" && portablePath.endsWith(".staging")),
    kind,
    portablePath,
  );
  return absolute;
}

function assertExistingPathChainIsDirectory(
  workspaceRoot: string,
  absolutePath: string,
  includeLeaf: boolean,
  kind: string,
  portablePath: string,
): void {
  const relativePath = relative(workspaceRoot, absolutePath);
  const segments = relativePath.split(sep).filter(Boolean);
  const checkedSegments = includeLeaf ? segments : segments.slice(0, -1);
  let current = workspaceRoot;
  for (const segment of checkedSegments) {
    current = join(current, segment);
    let currentStats: ReturnType<typeof lstatSync>;
    try {
      currentStats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (currentStats.isSymbolicLink()) {
      throw new ManagedSkillsFatalError(`${kind} path has a symlinked managed ancestor: ${portablePath}`);
    }
    if (!currentStats.isDirectory()) {
      throw new ManagedSkillsFatalError(`${kind} path has a non-directory managed ancestor: ${portablePath}`);
    }
  }
}

function portableRelative(workspace: string, absolutePath: string): string {
  const workspaceRoot = realpathSync(resolve(workspace));
  const rel = relative(workspaceRoot, resolve(absolutePath));
  if (!rel || rel.startsWith("..") || resolve(workspaceRoot, rel) === workspaceRoot) {
    throw new ManagedSkillsFatalError(`transaction path escapes workspace: ${absolutePath}`);
  }
  return toPortablePath(rel);
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Kept as a named constant so tests can assert journal placement without
// reaching into implementation-only path construction.
export const MANAGED_SKILLS_RUNTIME_PATHS = Object.freeze({
  journal: toPortablePath(MANAGED_SKILLS_JOURNAL_REL),
  lock: toPortablePath(MANAGED_SKILLS_LOCK_REL),
});
