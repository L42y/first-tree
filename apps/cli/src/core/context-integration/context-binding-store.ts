import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  type ContextIntegrationConfig,
  type ContextIntegrationGrant,
  type ContextIntegrationProject,
  type ContextIntegrationProvider,
  type ContextPersistentActivationScope,
  contextIntegrationConfigSchema,
  type LegacyContextIntegrationConfig,
  type LegacyV2ContextIntegrationConfig,
  legacyContextIntegrationConfigSchema,
  legacyV2ContextIntegrationConfigSchema,
} from "@first-tree/shared";
import { defaultConfigDir, defaultHome } from "@first-tree/shared/config";
import { parse, stringify } from "yaml";
import { assertContextMutationCanStart, withAccountStateMutationLock } from "./account-state-guard.js";

const UNREADABLE_LOCK_STALE_MS = 5 * 60_000;
const heldLockPaths = new Set<string>();

export type ContextGrantStorePaths = {
  configPath: string;
  lockPath: string;
  legacyV1BackupPath?: string;
  legacyV2BackupPath?: string;
};

export type ContextGrantMatch = {
  grant: ContextIntegrationGrant;
  priority: "directory" | "global";
};

export type ContextGrantStoreSnapshot = {
  kind: "missing" | "v1" | "v2" | "v3";
  config: ContextIntegrationConfig;
  fingerprint: string;
};

export function defaultContextGrantStorePaths(): ContextGrantStorePaths {
  return {
    configPath: join(defaultConfigDir(), "context.yaml"),
    lockPath: join(defaultHome(), "state", "context", "install.lock"),
    legacyV1BackupPath: join(defaultConfigDir(), "context.yaml.v1.bak"),
    legacyV2BackupPath: join(defaultConfigDir(), "context.yaml.v2.bak"),
  };
}

export function readContextIntegrationConfig(
  paths: ContextGrantStorePaths = defaultContextGrantStorePaths(),
): ContextIntegrationConfig {
  let raw: string;
  try {
    raw = readFileSync(paths.configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return emptyConfig();
    throw invalidConfig(paths, error);
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw invalidConfig(paths, error);
  }
  const current = contextIntegrationConfigSchema.safeParse(parsed);
  if (current.success) return current.data;
  const v2 = legacyV2ContextIntegrationConfigSchema.safeParse(parsed);
  if (v2.success) return withContextIntegrationLock(() => retireLegacyConfig(paths, v2.data, raw), paths);
  const v1 = legacyContextIntegrationConfigSchema.safeParse(parsed);
  if (v1.success) return withContextIntegrationLock(() => retireLegacyConfig(paths, v1.data, raw), paths);
  throw invalidConfig(paths, current.error);
}

/** Read and classify the grant store without creating, migrating, or backing up anything. */
export function inspectContextGrantStore(
  paths: ContextGrantStorePaths = defaultContextGrantStorePaths(),
): ContextGrantStoreSnapshot {
  let raw: string;
  try {
    raw = readFileSync(paths.configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return snapshot("missing", emptyConfig(), null);
    }
    throw invalidConfig(paths, error);
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw invalidConfig(paths, error);
  }
  const current = contextIntegrationConfigSchema.safeParse(parsed);
  if (current.success) return snapshot("v3", current.data, current.data);
  const v2 = legacyV2ContextIntegrationConfigSchema.safeParse(parsed);
  if (v2.success) return snapshot("v2", emptyConfig(), v2.data);
  const v1 = legacyContextIntegrationConfigSchema.safeParse(parsed);
  if (v1.success) return snapshot("v1", emptyConfig(), v1.data);
  throw invalidConfig(paths, current.error);
}

export function contextGrantStoreFingerprintAfterGrant(
  base: ContextGrantStoreSnapshot,
  grant: ContextIntegrationGrant,
): string {
  const grants = base.config.grants.some((candidate) => sameGrant(candidate, grant))
    ? base.config.grants
    : [...base.config.grants, grant].sort(compareGrants);
  return snapshot("v3", { schemaVersion: 3, grants }, { schemaVersion: 3, grants }).fingerprint;
}

/**
 * Validate the exact displayed store under the operation lock. The after
 * fingerprint permits only an idempotent retry of this exact grant (needed
 * after provider-owned Codex Hook consent); every unrelated add/remove fails.
 */
export function prepareContextGrantStoreForApply(
  expectedBeforeFingerprint: string,
  expectedAfterFingerprint: string,
  grant: ContextIntegrationGrant,
  paths: ContextGrantStorePaths = defaultContextGrantStorePaths(),
): ContextIntegrationConfig {
  const observed = inspectContextGrantStore(paths);
  if (observed.fingerprint === expectedBeforeFingerprint) {
    return observed.kind === "v3" || observed.kind === "missing"
      ? observed.config
      : readContextIntegrationConfig(paths);
  }
  if (observed.kind === "v3" && observed.fingerprint === expectedAfterFingerprint) {
    const exact = observed.config.grants.filter((candidate) => sameGrant(candidate, grant));
    if (exact.length === 1) return observed.config;
  }
  throw new ContextGrantsChangedError();
}

export function assertContextGrantStoreFingerprint(
  expectedFingerprint: string,
  paths: ContextGrantStorePaths = defaultContextGrantStorePaths(),
): void {
  if (inspectContextGrantStore(paths).fingerprint !== expectedFingerprint) throw new ContextGrantsChangedError();
}

export function resolveContextGrantCandidates(
  provider: ContextIntegrationProvider,
  project: ContextIntegrationProject,
  paths: ContextGrantStorePaths = defaultContextGrantStorePaths(),
): ContextGrantMatch[] {
  const grants = readContextIntegrationConfig(paths).grants.filter((grant) => grant.provider === provider);
  if (project.kind === "path") {
    const directory = grants
      .filter(
        (grant): grant is ContextIntegrationGrant & { activationScope: { kind: "directory"; root: string } } =>
          grant.activationScope.kind === "directory" && isPathAncestor(grant.activationScope.root, project.root),
      )
      .sort((left, right) => right.activationScope.root.length - left.activationScope.root.length);
    const deepest = directory[0]?.activationScope.root;
    if (deepest) {
      return deduplicateTeams(directory.filter((grant) => grant.activationScope.root === deepest)).map((grant) => ({
        grant,
        priority: "directory",
      }));
    }
  }
  return deduplicateTeams(grants.filter((grant) => grant.activationScope.kind === "global")).map((grant) => ({
    grant,
    priority: "global",
  }));
}

export function writeContextGrant(
  grant: ContextIntegrationGrant,
  options: {
    expectedConfig?: ContextIntegrationConfig;
    paths?: ContextGrantStorePaths;
  } = {},
): { created: boolean; current: ContextIntegrationGrant } {
  const paths = options.paths ?? defaultContextGrantStorePaths();
  return withContextIntegrationLock(() => {
    const config = readContextIntegrationConfig(paths);
    if (options.expectedConfig && !sameGrantSet(config.grants, options.expectedConfig.grants)) {
      throw new ContextGrantsChangedError();
    }
    const existing = config.grants.find((candidate) => sameGrant(candidate, grant));
    if (existing) return { created: false, current: existing };
    writeContextIntegrationConfig({ schemaVersion: 3, grants: [...config.grants, grant].sort(compareGrants) }, paths);
    return { created: true, current: grant };
  }, paths);
}

export function removeContextGrants(
  provider: ContextIntegrationProvider,
  input: {
    organizationId: string;
    activationScope: ContextPersistentActivationScope;
    expectedConfig?: ContextIntegrationConfig;
    paths?: ContextGrantStorePaths;
  },
): { removed: ContextIntegrationGrant[]; remaining: ContextIntegrationGrant[] } {
  const paths = input.paths ?? defaultContextGrantStorePaths();
  return withContextIntegrationLock(() => {
    const config = readContextIntegrationConfig(paths);
    if (input.expectedConfig && !sameGrantSet(config.grants, input.expectedConfig.grants)) {
      throw new ContextGrantsChangedError();
    }
    const removed = config.grants.filter(
      (grant) =>
        grant.provider === provider &&
        grant.organizationId === input.organizationId &&
        sameScope(grant.activationScope, input.activationScope),
    );
    const remaining = config.grants.filter((grant) => !removed.includes(grant));
    writeContextIntegrationConfig({ schemaVersion: 3, grants: remaining }, paths);
    return { removed, remaining };
  }, paths);
}

export function replaceContextIntegrationConfig(
  config: ContextIntegrationConfig,
  paths: ContextGrantStorePaths = defaultContextGrantStorePaths(),
): void {
  withContextIntegrationLock(() => writeContextIntegrationConfig(config, paths), paths);
}

export function assertContextIntegrationConfig(
  expected: ContextIntegrationConfig,
  paths: ContextGrantStorePaths = defaultContextGrantStorePaths(),
): void {
  if (!sameGrantSet(readContextIntegrationConfig(paths).grants, expected.grants)) throw new ContextGrantsChangedError();
}

export class ContextGrantsChangedError extends Error {
  constructor() {
    super("First Tree Context grants changed after the displayed plan. Run the command again.");
    this.name = "ContextGrantsChangedError";
  }
}

export function withContextIntegrationLock<T>(
  action: () => T,
  paths: ContextGrantStorePaths = defaultContextGrantStorePaths(),
): T {
  const home = dirname(dirname(dirname(paths.lockPath)));
  return withAccountStateMutationLock(() => {
    assertContextMutationCanStart(home);
    if (heldLockPaths.has(paths.lockPath)) return action();
    mkdirSync(dirname(paths.lockPath), { recursive: true, mode: 0o700 });
    removeStaleLock(paths.lockPath);
    let descriptor: number;
    try {
      descriptor = openSync(paths.lockPath, "wx", 0o600);
    } catch (error) {
      throw new Error("Another First Tree Context integration change is already running.", { cause: error });
    }
    try {
      heldLockPaths.add(paths.lockPath);
      writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      return action();
    } finally {
      heldLockPaths.delete(paths.lockPath);
      closeSync(descriptor);
      rmSync(paths.lockPath, { force: true });
    }
  }, home);
}

function emptyConfig(): ContextIntegrationConfig {
  return { schemaVersion: 3, grants: [] };
}

function snapshot(
  kind: ContextGrantStoreSnapshot["kind"],
  config: ContextIntegrationConfig,
  canonical: unknown,
): ContextGrantStoreSnapshot {
  return {
    kind,
    config,
    fingerprint: createHash("sha256").update(JSON.stringify({ kind, canonical })).digest("hex"),
  };
}

function writeContextIntegrationConfig(config: ContextIntegrationConfig, paths: ContextGrantStorePaths): void {
  const validated = contextIntegrationConfigSchema.parse(config);
  mkdirSync(dirname(paths.configPath), { recursive: true, mode: 0o700 });
  const tempPath = `${paths.configPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tempPath, stringify(validated), { mode: 0o600 });
    renameSync(tempPath, paths.configPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function retireLegacyConfig(
  paths: ContextGrantStorePaths,
  legacy: LegacyContextIntegrationConfig | LegacyV2ContextIntegrationConfig,
  originalBytes: string,
): ContextIntegrationConfig {
  const backupPath =
    legacy.schemaVersion === 2
      ? (paths.legacyV2BackupPath ?? `${paths.configPath}.v2.bak`)
      : (paths.legacyV1BackupPath ?? `${paths.configPath}.v1.bak`);
  preserveBackup(backupPath, legacy, originalBytes);
  const retired = emptyConfig();
  writeContextIntegrationConfig(retired, paths);
  return retired;
}

function preserveBackup(
  backupPath: string,
  legacy: LegacyContextIntegrationConfig | LegacyV2ContextIntegrationConfig,
  originalBytes: string,
): void {
  const schema =
    legacy.schemaVersion === 2 ? legacyV2ContextIntegrationConfigSchema : legacyContextIntegrationConfigSchema;
  if (existsSync(backupPath)) {
    const existing = statSync(backupPath);
    if (!existing.isFile() || (existing.mode & 0o777) !== 0o600) {
      throw new Error(`Invalid First Tree Context legacy backup at ${backupPath}.`);
    }
    schema.parse(parse(readFileSync(backupPath, "utf8")));
    return;
  }
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  writeFileSync(backupPath, originalBytes, { mode: 0o600, flag: "wx" });
}

function deduplicateTeams(grants: ContextIntegrationGrant[]): ContextIntegrationGrant[] {
  const seen = new Set<string>();
  return grants.filter((grant) => {
    if (seen.has(grant.organizationId)) return false;
    seen.add(grant.organizationId);
    return true;
  });
}

function sameGrant(left: ContextIntegrationGrant, right: ContextIntegrationGrant): boolean {
  return (
    left.provider === right.provider &&
    left.organizationId === right.organizationId &&
    sameScope(left.activationScope, right.activationScope)
  );
}

function sameScope(left: ContextPersistentActivationScope, right: ContextPersistentActivationScope): boolean {
  return (
    left.kind === right.kind && (left.kind === "global" || (right.kind === "directory" && left.root === right.root))
  );
}

function sameGrantSet(left: readonly ContextIntegrationGrant[], right: readonly ContextIntegrationGrant[]): boolean {
  if (left.length !== right.length) return false;
  const identities = (values: readonly ContextIntegrationGrant[]): string[] => values.map(grantKey).sort();
  return identities(left).every((identity, index) => identity === identities(right)[index]);
}

function compareGrants(left: ContextIntegrationGrant, right: ContextIntegrationGrant): number {
  return grantKey(left).localeCompare(grantKey(right));
}

function grantKey(grant: ContextIntegrationGrant): string {
  const scope = grant.activationScope.kind === "global" ? "global" : `directory:${grant.activationScope.root}`;
  return `${grant.provider}\0${grant.organizationId}\0${scope}`;
}

function isPathAncestor(ancestor: string, target: string): boolean {
  const path = relative(ancestor, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function invalidConfig(paths: ContextGrantStorePaths, cause: unknown): Error {
  return new Error(`Invalid First Tree Context grant config at ${paths.configPath}.`, { cause });
}

function removeStaleLock(lockPath: string): void {
  try {
    const owner = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        return;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;
        if (code === "EPERM") return;
        if (code === "ESRCH") {
          rmSync(lockPath, { force: true });
          return;
        }
        throw error;
      }
    }
    if (Date.now() - statSync(lockPath).mtimeMs > UNREADABLE_LOCK_STALE_MS) rmSync(lockPath, { force: true });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
