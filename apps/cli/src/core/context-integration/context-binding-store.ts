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
  type ContextIntegrationBinding,
  type ContextIntegrationConfig,
  type ContextIntegrationProject,
  type ContextIntegrationProvider,
  contextIntegrationConfigSchema,
  type LegacyContextIntegrationConfig,
  legacyContextIntegrationConfigSchema,
} from "@first-tree/shared";
import { defaultConfigDir, defaultHome } from "@first-tree/shared/config";
import { parse, stringify } from "yaml";
import { assertContextMutationCanStart, withAccountStateMutationLock } from "./account-state-guard.js";

const UNREADABLE_LOCK_STALE_MS = 5 * 60_000;
const heldLockPaths = new Set<string>();

export type ContextBindingStorePaths = {
  configPath: string;
  lockPath: string;
  legacyBackupPath?: string;
};

export function defaultContextBindingStorePaths(): ContextBindingStorePaths {
  return {
    configPath: join(defaultConfigDir(), "context.yaml"),
    lockPath: join(defaultHome(), "state", "context", "install.lock"),
    legacyBackupPath: join(defaultConfigDir(), "context.yaml.v1.bak"),
  };
}

export function readContextIntegrationConfig(
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
): ContextIntegrationConfig {
  let raw: string;
  try {
    raw = readFileSync(paths.configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { schemaVersion: 2, bindings: [] };
    }
    throw new Error(`Invalid First Tree Context binding config at ${paths.configPath}.`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new Error(`Invalid First Tree Context binding config at ${paths.configPath}.`, { cause: error });
  }
  const current = contextIntegrationConfigSchema.safeParse(parsed);
  if (current.success) return current.data;
  const legacy = legacyContextIntegrationConfigSchema.safeParse(parsed);
  if (!legacy.success) {
    throw new Error(`Invalid First Tree Context binding config at ${paths.configPath}.`, {
      cause: current.error,
    });
  }
  return withContextIntegrationLock(() => migrateLegacyContextIntegrationConfig(paths), paths);
}

export function findContextBinding(
  provider: ContextIntegrationProvider,
  project: ContextIntegrationProject,
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
): ContextIntegrationBinding | null {
  const candidates = readContextIntegrationConfig(paths).bindings.filter((binding) => binding.provider === provider);
  if (project.kind === "pathless") {
    return candidates.find((binding) => binding.project.kind === "pathless") ?? null;
  }
  return (
    candidates
      .filter((binding) => binding.project.kind === "path" && isPathAncestor(binding.project.root, project.root))
      .sort((left, right) => projectSortKey(right.project).length - projectSortKey(left.project).length)[0] ?? null
  );
}

export function writeContextBinding(
  binding: ContextIntegrationBinding,
  options: {
    allowReplace?: boolean;
    expectedPrevious?: ContextIntegrationBinding | null;
    paths?: ContextBindingStorePaths;
  } = {},
): { previous: ContextIntegrationBinding | null; current: ContextIntegrationBinding } {
  const paths = options.paths ?? defaultContextBindingStorePaths();
  return withContextIntegrationLock(() => {
    const config = readContextIntegrationConfig(paths);
    const index = config.bindings.findIndex(
      (candidate) => candidate.provider === binding.provider && sameProject(candidate.project, binding.project),
    );
    const previous = index >= 0 ? (config.bindings[index] ?? null) : null;
    if ("expectedPrevious" in options && !sameBinding(previous, options.expectedPrevious ?? null)) {
      throw new ContextBindingsChangedError();
    }
    if (previous && previous.organizationId !== binding.organizationId && options.allowReplace !== true) {
      throw new ContextBindingReplacementRequiredError(previous, binding);
    }

    const nextBindings = [...config.bindings];
    if (index >= 0) {
      nextBindings[index] = binding;
    } else {
      nextBindings.push(binding);
    }
    nextBindings.sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        projectSortKey(left.project).localeCompare(projectSortKey(right.project)),
    );
    writeContextIntegrationConfig({ schemaVersion: 2, bindings: nextBindings }, paths);
    return { previous, current: binding };
  }, paths);
}

export function removeContextBindings(
  provider: ContextIntegrationProvider,
  options: {
    project: ContextIntegrationProject;
    expectedProviderBindings?: ContextIntegrationBinding[];
    paths?: ContextBindingStorePaths;
  },
): { removed: ContextIntegrationBinding[]; remaining: ContextIntegrationBinding[] } {
  const paths = options.paths ?? defaultContextBindingStorePaths();
  return withContextIntegrationLock(() => {
    const config = readContextIntegrationConfig(paths);
    const providerBindings = config.bindings.filter((binding) => binding.provider === provider);
    if (options.expectedProviderBindings && !sameBindingSet(providerBindings, options.expectedProviderBindings)) {
      throw new ContextBindingsChangedError();
    }
    const removed = config.bindings.filter(
      (binding) => binding.provider === provider && sameProject(binding.project, options.project),
    );
    const remaining = config.bindings.filter((binding) => !removed.includes(binding));
    writeContextIntegrationConfig({ schemaVersion: 2, bindings: remaining }, paths);
    return { removed, remaining };
  }, paths);
}

export function replaceContextIntegrationConfig(
  config: ContextIntegrationConfig,
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
): void {
  withContextIntegrationLock(() => writeContextIntegrationConfig(config, paths), paths);
}

export function preserveLegacyContextIntegrationBackup(
  config: LegacyContextIntegrationConfig,
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
): void {
  withContextIntegrationLock(() => preserveLegacyBackup(config, paths), paths);
}

export function assertContextIntegrationConfig(
  expected: ContextIntegrationConfig,
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
): void {
  const current = readContextIntegrationConfig(paths);
  if (!sameBindingSet(current.bindings, expected.bindings)) {
    throw new ContextBindingsChangedError();
  }
}

export class ContextBindingReplacementRequiredError extends Error {
  constructor(
    readonly previous: ContextIntegrationBinding,
    readonly requested: ContextIntegrationBinding,
  ) {
    super(
      `This project is already connected to Team ${previous.organizationId}; replacing it with ${requested.organizationId} requires explicit confirmation.`,
    );
    this.name = "ContextBindingReplacementRequiredError";
  }
}

export class ContextBindingsChangedError extends Error {
  constructor() {
    super("First Tree Context bindings changed after the displayed plan. Run the command again.");
    this.name = "ContextBindingsChangedError";
  }
}

function writeContextIntegrationConfig(config: ContextIntegrationConfig, paths: ContextBindingStorePaths): void {
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

export function withContextIntegrationLock<T>(
  action: () => T,
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
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
      throw new Error("Another First Tree Context integration change is already running.", {
        cause: error,
      });
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

function sameBinding(left: ContextIntegrationBinding | null, right: ContextIntegrationBinding | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.provider === right.provider &&
      sameProject(left.project, right.project) &&
      left.organizationId === right.organizationId)
  );
}

function sameBindingSet(
  left: readonly ContextIntegrationBinding[],
  right: readonly ContextIntegrationBinding[],
): boolean {
  if (left.length !== right.length) return false;
  const byIdentity = (binding: ContextIntegrationBinding): string =>
    `${binding.provider}\0${projectSortKey(binding.project)}\0${binding.organizationId}`;
  const leftIdentities = left.map(byIdentity).sort();
  const rightIdentities = right.map(byIdentity).sort();
  return leftIdentities.every((identity, index) => identity === rightIdentities[index]);
}

function migrateLegacyContextIntegrationConfig(paths: ContextBindingStorePaths): ContextIntegrationConfig {
  let raw: string;
  try {
    raw = readFileSync(paths.configPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { schemaVersion: 2, bindings: [] };
    throw error;
  }
  const parsed = parse(raw);
  const current = contextIntegrationConfigSchema.safeParse(parsed);
  if (current.success) return current.data;
  const legacy = legacyContextIntegrationConfigSchema.parse(parsed);
  preserveLegacyBackup(legacy, paths, raw);
  const migrated: ContextIntegrationConfig = {
    schemaVersion: 2,
    bindings: legacy.bindings.map((binding) => ({
      provider: binding.provider,
      project: { kind: "path", root: binding.checkoutRoot },
      organizationId: binding.organizationId,
    })),
  };
  writeContextIntegrationConfig(migrated, paths);
  return migrated;
}

function preserveLegacyBackup(
  config: LegacyContextIntegrationConfig,
  paths: ContextBindingStorePaths,
  originalBytes?: string,
): void {
  const backupPath = paths.legacyBackupPath ?? `${paths.configPath}.v1.bak`;
  if (existsSync(backupPath)) {
    const existing = statSync(backupPath);
    if (!existing.isFile() || (existing.mode & 0o777) !== 0o600) {
      throw new Error(`Invalid First Tree Context v1 backup at ${backupPath}.`);
    }
    legacyContextIntegrationConfigSchema.parse(parse(readFileSync(backupPath, "utf8")));
    return;
  }
  const validated = legacyContextIntegrationConfigSchema.parse(config);
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  writeFileSync(backupPath, originalBytes ?? stringify(validated), { mode: 0o600, flag: "wx" });
}

function sameProject(left: ContextIntegrationProject, right: ContextIntegrationProject): boolean {
  return left.kind === right.kind && (left.kind === "pathless" || (right.kind === "path" && left.root === right.root));
}

function projectSortKey(project: ContextIntegrationProject): string {
  return project.kind === "pathless" ? "\0pathless" : `path:${project.root}`;
}

function isPathAncestor(ancestor: string, target: string): boolean {
  const path = relative(ancestor, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs > UNREADABLE_LOCK_STALE_MS) rmSync(lockPath, { force: true });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
