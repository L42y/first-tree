import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type ContextIntegrationConfig,
  type ContextIntegrationGrant,
  type ContextIntegrationInstallManifest,
  type ContextIntegrationProvider,
  type ContextPersistentActivationScope,
  contextIntegrationConfigSchema,
  contextIntegrationInstallManifestSchema,
} from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import { channelConfig } from "../channel.js";
import { readActiveContextAccountClientId } from "./account-state-guard.js";
import {
  assertContextIntegrationConfig,
  prepareContextGrantStoreForApply,
  readContextIntegrationConfig,
  removeContextGrants,
  replaceContextIntegrationConfig,
  withContextIntegrationLock,
  writeContextGrant,
} from "./context-binding-store.js";
import {
  type ContextIntegrationInstallPlan,
  clearContextIntegrationInstallJournal,
  contextIntegrationMarketplaceName,
  contextIntegrationMarketplaceSourcePath,
  installContextIntegration,
} from "./installer.js";
import {
  readContextIntegrationInstallManifest,
  removeContextIntegrationInstallManifest,
  writeContextIntegrationInstallManifest,
} from "./manifest.js";
import { contextPluginTreeDigest, verifyProviderInstalledContextPlugin } from "./payload-integrity.js";
import type { ContextIntegrationProviderDriver } from "./provider-driver.js";

type OperationSnapshot = {
  accountClientId: string;
  config: ContextIntegrationConfig;
  installManifest: ContextIntegrationInstallManifest | null;
  providerInstalled: boolean;
  providerEnabled: boolean;
  marketplaceSourceExisted: boolean;
  recoveryRoot: string;
  recoveryMarketplaceRoot: string | null;
};

type OperationJournal = {
  schemaVersion: 2;
  operationId: string;
  accountClientId: string;
  provider: ContextIntegrationProvider;
  operation: "enable" | "disable" | "repair";
  phase: "prepared" | "provider_changed" | "grant_changed" | "rollback_failed";
  previousConfig: ContextIntegrationConfig;
  previousInstallManifest: ContextIntegrationInstallManifest | null;
  providerInstalled: boolean;
  providerEnabled: boolean;
  marketplaceSourceExisted: boolean;
  recoveryMarketplaceRoot: string | null;
  startedAt: string;
};

export function enableContextIntegrationOperation(
  driver: ContextIntegrationProviderDriver,
  plan: ContextIntegrationInstallPlan,
  grant: ContextIntegrationGrant,
  expectedStore: { beforeFingerprint: string; afterFingerprint: string },
  expectedAccountClientId: string,
  dependencies: {
    install?: typeof installContextIntegration;
    writeGrant?: typeof writeContextGrant;
  } = {},
): { pluginOperation: ContextIntegrationInstallPlan["operation"] } {
  return withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    assertExpectedAccount(expectedAccountClientId);
    const expectedConfig = prepareContextGrantStoreForApply(
      expectedStore.beforeFingerprint,
      expectedStore.afterFingerprint,
      grant,
    );
    const snapshot = captureOperationSnapshot(driver, expectedConfig);
    const journal = createOperationJournal("enable", driver, snapshot);
    let providerChanged = false;
    let grantChanged = false;
    try {
      if (plan.operation !== "unchanged") {
        providerChanged = true;
        (dependencies.install ?? installContextIntegration)(driver, plan);
        writeOperationJournal({ ...journal, phase: "provider_changed" });
      }
      const result = (dependencies.writeGrant ?? writeContextGrant)(grant, { expectedConfig });
      grantChanged = result.created;
      writeOperationJournal({ ...journal, phase: "grant_changed" });
      completeOperation(snapshot);
      return { pluginOperation: plan.operation };
    } catch (error) {
      rollbackOperation(driver, snapshot, { providerChanged, grantChanged }, journal, error);
    }
  });
}

export function disableContextIntegrationOperation(
  provider: ContextIntegrationProvider,
  input: {
    organizationId: string;
    activationScope: ContextPersistentActivationScope;
    expectedConfig: ContextIntegrationConfig;
    expectedAccountClientId: string;
  },
  dependencies: { removeGrants?: typeof removeContextGrants } = {},
): { removed: ContextIntegrationGrant[]; remaining: ContextIntegrationGrant[] } {
  return withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    assertExpectedAccount(input.expectedAccountClientId);
    assertContextIntegrationConfig(input.expectedConfig);
    return (dependencies.removeGrants ?? removeContextGrants)(provider, {
      organizationId: input.organizationId,
      activationScope: input.activationScope,
      expectedConfig: input.expectedConfig,
    });
  });
}

export function repairContextIntegrationOperation(
  driver: ContextIntegrationProviderDriver,
  plan: ContextIntegrationInstallPlan,
  dependencies: { install?: typeof installContextIntegration } = {},
): void {
  withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    const snapshot = captureOperationSnapshot(driver, readContextIntegrationConfig());
    const journal = createOperationJournal("repair", driver, snapshot);
    try {
      (dependencies.install ?? installContextIntegration)(driver, plan);
      writeOperationJournal({ ...journal, phase: "provider_changed" });
      completeOperation(snapshot);
    } catch (error) {
      rollbackOperation(driver, snapshot, { providerChanged: true, grantChanged: false }, journal, error);
    }
  });
}

function captureOperationSnapshot(
  driver: ContextIntegrationProviderDriver,
  expectedConfig: ContextIntegrationConfig,
): OperationSnapshot {
  const accountClientId = readActiveContextAccountClientId();
  const installManifest = readContextIntegrationInstallManifest(driver.provider);
  const marketplaceName = installManifest?.marketplaceName ?? contextIntegrationMarketplaceName();
  const pluginName = installManifest?.pluginName ?? "first-tree-context";
  const probe = driver.probe(marketplaceName, pluginName);
  const operationId = randomUUID();
  const recoveryRoot = join(defaultHome(), "state", "context", "operation-recovery", operationId);
  const recoveryMarketplaceRoot = join(recoveryRoot, "marketplace");
  const stableMarketplaceRoot = contextIntegrationMarketplaceSourcePath(driver.provider);
  const marketplaceSourceExisted = existsSync(stableMarketplaceRoot);
  if (probe.installed && (!installManifest || !marketplaceSourceExisted)) {
    throw new Error(
      `The existing ${driver.provider} Context Plugin lacks a complete First Tree rollback source. Run \`${channelConfig.binName} context repair --provider ${driver.provider}\` before changing grants.`,
    );
  }
  if (probe.installed && !probe.enabled) {
    throw new Error(
      `The ${driver.provider} Context Plugin is installed but disabled. Enable it with the provider's native Plugin controls before changing grants; no state was changed.`,
    );
  }
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  if (marketplaceSourceExisted) cpSync(stableMarketplaceRoot, recoveryMarketplaceRoot, { recursive: true });
  return {
    accountClientId,
    config: expectedConfig,
    installManifest,
    providerInstalled: probe.installed,
    providerEnabled: probe.enabled,
    marketplaceSourceExisted,
    recoveryRoot,
    recoveryMarketplaceRoot: marketplaceSourceExisted ? recoveryMarketplaceRoot : null,
  };
}

function createOperationJournal(
  operation: OperationJournal["operation"],
  driver: ContextIntegrationProviderDriver,
  snapshot: OperationSnapshot,
): OperationJournal {
  const journal: OperationJournal = {
    schemaVersion: 2,
    operationId: basename(snapshot.recoveryRoot),
    accountClientId: snapshot.accountClientId,
    provider: driver.provider,
    operation,
    phase: "prepared",
    previousConfig: snapshot.config,
    previousInstallManifest: snapshot.installManifest,
    providerInstalled: snapshot.providerInstalled,
    providerEnabled: snapshot.providerEnabled,
    marketplaceSourceExisted: snapshot.marketplaceSourceExisted,
    recoveryMarketplaceRoot: snapshot.recoveryMarketplaceRoot,
    startedAt: new Date().toISOString(),
  };
  writeOperationJournal(journal);
  return journal;
}

function rollbackOperation(
  driver: ContextIntegrationProviderDriver,
  snapshot: OperationSnapshot,
  changed: { providerChanged: boolean; grantChanged: boolean },
  journal: OperationJournal,
  originalError: unknown,
): never {
  const rollbackErrors: unknown[] = [];
  if (changed.grantChanged || JSON.stringify(readContextIntegrationConfig()) !== JSON.stringify(snapshot.config)) {
    try {
      replaceContextIntegrationConfig(snapshot.config);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (changed.providerChanged) {
    try {
      restoreProviderSnapshot(driver, snapshot);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    writeOperationJournal({ ...journal, phase: "rollback_failed" });
    throw new AggregateError(
      [originalError, ...rollbackErrors],
      `First Tree Context operation failed and could not fully restore Plugin, manifest, and grant state. Run \`${channelConfig.binName} context repair --provider ${driver.provider}\` before retrying.`,
    );
  }
  completeOperation(snapshot);
  throw originalError;
}

function restoreProviderSnapshot(driver: ContextIntegrationProviderDriver, snapshot: OperationSnapshot): void {
  const stableMarketplaceRoot = contextIntegrationMarketplaceSourcePath(driver.provider);
  if (snapshot.providerInstalled && snapshot.installManifest && snapshot.recoveryMarketplaceRoot) {
    rmSync(stableMarketplaceRoot, { recursive: true, force: true });
    mkdirSync(dirname(stableMarketplaceRoot), { recursive: true, mode: 0o700 });
    cpSync(snapshot.recoveryMarketplaceRoot, stableMarketplaceRoot, { recursive: true });
    const restoredProbe = driver.install({
      marketplaceRoot: stableMarketplaceRoot,
      marketplaceName: snapshot.installManifest.marketplaceName,
      pluginName: snapshot.installManifest.pluginName,
    });
    verifyProviderInstalledContextPlugin(
      restoredProbe,
      contextPluginTreeDigest(join(stableMarketplaceRoot, "plugins", snapshot.installManifest.pluginName)),
    );
    writeContextIntegrationInstallManifest(snapshot.installManifest);
  } else {
    const current = readContextIntegrationInstallManifest(driver.provider);
    driver.uninstall({
      marketplaceName:
        current?.marketplaceName ?? snapshot.installManifest?.marketplaceName ?? contextIntegrationMarketplaceName(),
      pluginName: current?.pluginName ?? snapshot.installManifest?.pluginName ?? "first-tree-context",
    });
    rmSync(stableMarketplaceRoot, { recursive: true, force: true });
    if (snapshot.marketplaceSourceExisted && snapshot.recoveryMarketplaceRoot) {
      mkdirSync(dirname(stableMarketplaceRoot), { recursive: true, mode: 0o700 });
      cpSync(snapshot.recoveryMarketplaceRoot, stableMarketplaceRoot, { recursive: true });
    }
    if (snapshot.installManifest) writeContextIntegrationInstallManifest(snapshot.installManifest);
    else removeContextIntegrationInstallManifest(driver.provider);
  }
  clearContextIntegrationInstallJournal();
}

function completeOperation(snapshot: OperationSnapshot): void {
  rmSync(operationJournalPath(), { force: true });
  rmSync(snapshot.recoveryRoot, { recursive: true, force: true });
}

export function recoverContextIntegrationOperation(driver: ContextIntegrationProviderDriver): boolean {
  return withContextIntegrationLock(() => {
    const journal = readOperationJournal();
    if (!journal) return false;
    if (journal.provider !== driver.provider) {
      throw new Error(`The incomplete Context operation belongs to ${journal.provider}. Run repair for it first.`);
    }
    const recoveryRoot = join(defaultHome(), "state", "context", "operation-recovery", journal.operationId);
    const snapshot: OperationSnapshot = {
      accountClientId: journal.accountClientId,
      config: journal.previousConfig,
      installManifest: journal.previousInstallManifest,
      providerInstalled: journal.providerInstalled,
      providerEnabled: journal.providerEnabled,
      marketplaceSourceExisted: journal.marketplaceSourceExisted,
      recoveryRoot,
      recoveryMarketplaceRoot: journal.recoveryMarketplaceRoot,
    };
    if (readActiveContextAccountClientId() !== snapshot.accountClientId) {
      throw new Error("The incomplete Context operation belongs to a different local Computer/account state.");
    }
    replaceContextIntegrationConfig(snapshot.config);
    restoreProviderSnapshot(driver, snapshot);
    completeOperation(snapshot);
    return true;
  });
}

function operationJournalPath(): string {
  return join(defaultHome(), "state", "context", "operation-journal.json");
}

export function inspectContextIntegrationOperation(): Pick<
  OperationJournal,
  "operation" | "phase" | "provider"
> | null {
  const journal = readOperationJournal();
  return journal ? { provider: journal.provider, operation: journal.operation, phase: journal.phase } : null;
}

function readOperationJournal(): OperationJournal | null {
  try {
    const parsed = JSON.parse(readFileSync(operationJournalPath(), "utf8")) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 2 ||
      typeof parsed.operationId !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(parsed.operationId) ||
      typeof parsed.accountClientId !== "string" ||
      (parsed.provider !== "claude-code" && parsed.provider !== "codex") ||
      (parsed.operation !== "enable" && parsed.operation !== "disable" && parsed.operation !== "repair") ||
      !["prepared", "provider_changed", "grant_changed", "rollback_failed"].includes(String(parsed.phase)) ||
      typeof parsed.providerInstalled !== "boolean" ||
      typeof parsed.providerEnabled !== "boolean" ||
      typeof parsed.marketplaceSourceExisted !== "boolean" ||
      (parsed.recoveryMarketplaceRoot !== null && typeof parsed.recoveryMarketplaceRoot !== "string") ||
      typeof parsed.startedAt !== "string"
    ) {
      throw new Error("invalid operation journal");
    }
    return {
      ...(parsed as Omit<OperationJournal, "previousConfig" | "previousInstallManifest">),
      previousConfig: contextIntegrationConfigSchema.parse(parsed.previousConfig),
      previousInstallManifest:
        parsed.previousInstallManifest === null
          ? null
          : contextIntegrationInstallManifestSchema.parse(parsed.previousInstallManifest),
    };
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`Invalid First Tree Context operation journal at ${operationJournalPath()}.`, { cause: error });
  }
}

function assertNoIncompleteOperation(): void {
  const incomplete = inspectContextIntegrationOperation();
  if (incomplete) {
    throw new Error(
      `A First Tree Context Plugin/grant operation is incomplete. Run \`${channelConfig.binName} context repair --provider ${incomplete.provider}\` before retrying.`,
    );
  }
}

function assertExpectedAccount(expectedAccountClientId: string): void {
  if (readActiveContextAccountClientId() !== expectedAccountClientId) {
    throw new Error("The active First Tree Computer/account changed after the displayed Context plan. Re-run it.");
  }
}

function writeOperationJournal(journal: OperationJournal): void {
  const path = operationJournalPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
