import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ContextIntegrationBinding,
  type ContextIntegrationConfig,
  type ContextIntegrationProvider,
  contextIntegrationConfigSchema,
} from "@first-tree/shared";
import { defaultConfigDir, defaultHome } from "@first-tree/shared/config";
import { parse, stringify } from "yaml";
import { assertContextMutationCanStart, withAccountStateMutationLock } from "./account-state-guard.js";

const UNREADABLE_LOCK_STALE_MS = 5 * 60_000;
const heldLockPaths = new Set<string>();

export type ContextBindingStorePaths = {
  configPath: string;
  lockPath: string;
};

export function defaultContextBindingStorePaths(): ContextBindingStorePaths {
  return {
    configPath: join(defaultConfigDir(), "context.yaml"),
    lockPath: join(defaultHome(), "state", "context", "install.lock"),
  };
}

export function readContextIntegrationConfig(
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
): ContextIntegrationConfig {
  try {
    return contextIntegrationConfigSchema.parse(parse(readFileSync(paths.configPath, "utf8")));
  } catch (error) {
    if (isMissingFile(error)) {
      return { schemaVersion: 1, bindings: [] };
    }
    throw new Error(`Invalid First Tree Context binding config at ${paths.configPath}.`, { cause: error });
  }
}

export function findContextBinding(
  provider: ContextIntegrationProvider,
  checkoutRoot: string,
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
): ContextIntegrationBinding | null {
  return (
    readContextIntegrationConfig(paths).bindings.find(
      (binding) => binding.provider === provider && binding.checkoutRoot === checkoutRoot,
    ) ?? null
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
      (candidate) => candidate.provider === binding.provider && candidate.checkoutRoot === binding.checkoutRoot,
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
        left.provider.localeCompare(right.provider) || left.checkoutRoot.localeCompare(right.checkoutRoot),
    );
    writeContextIntegrationConfig({ schemaVersion: 1, bindings: nextBindings }, paths);
    return { previous, current: binding };
  }, paths);
}

export function removeContextBindings(
  provider: ContextIntegrationProvider,
  options: {
    checkoutRoot?: string;
    all?: boolean;
    expectedProviderBindings?: ContextIntegrationBinding[];
    paths?: ContextBindingStorePaths;
  } = {},
): { removed: ContextIntegrationBinding[]; remaining: ContextIntegrationBinding[] } {
  const paths = options.paths ?? defaultContextBindingStorePaths();
  return withContextIntegrationLock(() => {
    const config = readContextIntegrationConfig(paths);
    const providerBindings = config.bindings.filter((binding) => binding.provider === provider);
    if (options.expectedProviderBindings && !sameBindingSet(providerBindings, options.expectedProviderBindings)) {
      throw new ContextBindingsChangedError();
    }
    const removed = config.bindings.filter(
      (binding) =>
        binding.provider === provider && (options.all === true || binding.checkoutRoot === options.checkoutRoot),
    );
    const remaining = config.bindings.filter((binding) => !removed.includes(binding));
    writeContextIntegrationConfig({ schemaVersion: 1, bindings: remaining }, paths);
    return { removed, remaining };
  }, paths);
}

export function replaceContextIntegrationConfig(
  config: ContextIntegrationConfig,
  paths: ContextBindingStorePaths = defaultContextBindingStorePaths(),
): void {
  withContextIntegrationLock(() => writeContextIntegrationConfig(config, paths), paths);
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
      `This checkout is already connected to Team ${previous.organizationId}; replacing it with ${requested.organizationId} requires explicit confirmation.`,
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
      left.checkoutRoot === right.checkoutRoot &&
      left.repositoryKey === right.repositoryKey &&
      left.organizationId === right.organizationId)
  );
}

function sameBindingSet(
  left: readonly ContextIntegrationBinding[],
  right: readonly ContextIntegrationBinding[],
): boolean {
  if (left.length !== right.length) return false;
  const byIdentity = (binding: ContextIntegrationBinding): string =>
    `${binding.provider}\0${binding.checkoutRoot}\0${binding.repositoryKey}\0${binding.organizationId}`;
  const leftIdentities = left.map(byIdentity).sort();
  const rightIdentities = right.map(byIdentity).sort();
  return leftIdentities.every((identity, index) => identity === rightIdentities[index]);
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
