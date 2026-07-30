import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  ContextIntegrationBinding,
  ContextIntegrationConfig,
  ContextIntegrationInstallManifest,
  LegacyContextIntegrationConfig,
} from "@first-tree/shared";
import {
  contextIntegrationConfigSchema,
  contextIntegrationInstallManifestSchema,
  legacyContextIntegrationConfigSchema,
} from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import { channelConfig } from "../channel.js";
import { readActiveContextAccountClientId } from "./account-state-guard.js";
import {
  assertContextIntegrationConfig,
  preserveLegacyContextIntegrationBackup,
  readContextIntegrationConfig,
  removeContextBindings,
  replaceContextIntegrationConfig,
  withContextIntegrationLock,
  writeContextBinding,
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
  schemaVersion: 1;
  operationId: string;
  accountClientId: string;
  provider: ContextIntegrationBinding["provider"];
  operation: "enable" | "disable" | "repair";
  phase: "prepared" | "provider_changed" | "binding_changed" | "rollback_failed";
  previousBindings: ContextIntegrationBinding[];
  previousInstallManifest: ContextIntegrationInstallManifest | null;
  providerInstalled: boolean;
  providerEnabled: boolean;
  marketplaceSourceExisted: boolean;
  recoveryMarketplaceRoot: string | null;
  startedAt: string;
};

type ParsedOperationJournal = OperationJournal & {
  legacyPreviousConfig: LegacyContextIntegrationConfig | null;
};

export function enableContextIntegrationOperation(
  driver: ContextIntegrationProviderDriver,
  plan: ContextIntegrationInstallPlan,
  binding: ContextIntegrationBinding,
  expectedConfig: ContextIntegrationConfig,
  expectedAccountClientId: string,
  dependencies: {
    install?: typeof installContextIntegration;
    writeBinding?: typeof writeContextBinding;
  } = {},
): { pluginOperation: ContextIntegrationInstallPlan["operation"] } {
  return withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    assertExpectedAccount(expectedAccountClientId);
    assertContextIntegrationConfig(expectedConfig);
    const snapshot = captureOperationSnapshot(driver, expectedConfig);
    const journal = createOperationJournal("enable", driver, snapshot);
    let providerChanged = false;
    let bindingChanged = false;
    try {
      if (plan.operation !== "unchanged") {
        providerChanged = true;
        (dependencies.install ?? installContextIntegration)(driver, plan);
        writeOperationJournal({ ...journal, phase: "provider_changed" });
      }
      (dependencies.writeBinding ?? writeContextBinding)(binding, {
        allowReplace: true,
        expectedPrevious:
          expectedConfig.bindings.find(
            (candidate) =>
              candidate.provider === binding.provider &&
              JSON.stringify(candidate.project) === JSON.stringify(binding.project),
          ) ?? null,
      });
      bindingChanged = true;
      writeOperationJournal({ ...journal, phase: "binding_changed" });
      completeOperation(snapshot);
      return { pluginOperation: plan.operation };
    } catch (error) {
      rollbackOperation(driver, snapshot, { providerChanged, bindingChanged }, journal, error);
    }
  });
}

export function disableContextIntegrationOperation(
  provider: ContextIntegrationBinding["provider"],
  input: {
    project: ContextIntegrationBinding["project"];
    expectedConfig: ContextIntegrationConfig;
    expectedAccountClientId: string;
  },
  dependencies: {
    removeBindings?: typeof removeContextBindings;
  } = {},
): {
  removed: ContextIntegrationBinding[];
  remaining: ContextIntegrationBinding[];
} {
  return withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    assertExpectedAccount(input.expectedAccountClientId);
    assertContextIntegrationConfig(input.expectedConfig);
    const providerBindings = input.expectedConfig.bindings.filter((binding) => binding.provider === provider);
    return (dependencies.removeBindings ?? removeContextBindings)(provider, {
      project: input.project,
      expectedProviderBindings: providerBindings,
    });
  });
}

export function repairContextIntegrationOperation(
  driver: ContextIntegrationProviderDriver,
  plan: ContextIntegrationInstallPlan,
  dependencies: {
    install?: typeof installContextIntegration;
  } = {},
): void {
  withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    const config = readContextIntegrationConfig();
    const snapshot = captureOperationSnapshot(driver, config);
    const journal = createOperationJournal("repair", driver, snapshot);
    let providerChanged = false;
    try {
      providerChanged = true;
      (dependencies.install ?? installContextIntegration)(driver, plan);
      writeOperationJournal({ ...journal, phase: "provider_changed" });
      completeOperation(snapshot);
    } catch (error) {
      rollbackOperation(driver, snapshot, { providerChanged, bindingChanged: false }, journal, error);
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
      `The existing ${driver.provider} Context Plugin lacks a complete First Tree rollback source. Run \`${channelConfig.binName} context repair --provider ${driver.provider}\` before changing bindings.`,
    );
  }
  if (probe.installed && !probe.enabled) {
    throw new Error(
      `The ${driver.provider} Context Plugin is installed but disabled. Enable it with the provider's native Plugin controls before changing bindings; no state was changed.`,
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
    schemaVersion: 1,
    operationId: basename(snapshot.recoveryRoot),
    accountClientId: snapshot.accountClientId,
    provider: driver.provider,
    operation,
    phase: "prepared",
    previousBindings: snapshot.config.bindings,
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
  changed: { providerChanged: boolean; bindingChanged: boolean },
  journal: OperationJournal,
  originalError: unknown,
): never {
  const rollbackErrors: unknown[] = [];
  let configMatches = false;
  try {
    configMatches = sameConfig(readContextIntegrationConfig(), snapshot.config);
  } catch {}
  if (changed.bindingChanged || !configMatches) {
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
      `First Tree Context operation failed and could not fully restore Plugin, manifest, and binding state. Run \`${channelConfig.binName} context repair --provider ${driver.provider}\` before retrying.`,
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
      throw new Error(
        `The incomplete Context operation belongs to ${journal.provider}. Run repair for that provider first.`,
      );
    }
    const recoveryRoot = join(defaultHome(), "state", "context", "operation-recovery", journal.operationId);
    const expectedMarketplace = join(recoveryRoot, "marketplace");
    if (journal.recoveryMarketplaceRoot !== null && journal.recoveryMarketplaceRoot !== expectedMarketplace) {
      throw new Error("The incomplete Context operation recovery path is invalid.");
    }
    const snapshot: OperationSnapshot = {
      accountClientId: journal.accountClientId,
      config: { schemaVersion: 2, bindings: journal.previousBindings },
      installManifest: journal.previousInstallManifest,
      providerInstalled: journal.providerInstalled,
      providerEnabled: journal.providerEnabled,
      marketplaceSourceExisted: journal.marketplaceSourceExisted,
      recoveryRoot,
      recoveryMarketplaceRoot: journal.recoveryMarketplaceRoot,
    };
    if (readActiveContextAccountClientId() !== snapshot.accountClientId) {
      throw new Error(
        "The incomplete Context operation belongs to a different local First Tree Computer/account state. Switch back before recovery.",
      );
    }
    const errors: unknown[] = [];
    try {
      if (journal.legacyPreviousConfig) preserveLegacyContextIntegrationBackup(journal.legacyPreviousConfig);
      replaceContextIntegrationConfig(snapshot.config);
    } catch (error) {
      errors.push(error);
    }
    try {
      restoreProviderSnapshot(driver, snapshot);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Could not recover the incomplete First Tree Context operation.");
    }
    completeOperation(snapshot);
    return true;
  });
}

function operationJournalPath(): string {
  return join(defaultHome(), "state", "context", "operation-journal.json");
}

export function inspectContextIntegrationOperation(): {
  provider: ContextIntegrationBinding["provider"];
  operation: OperationJournal["operation"];
  phase: OperationJournal["phase"];
} | null {
  const journal = readOperationJournal();
  return journal
    ? {
        provider: journal.provider,
        operation: journal.operation,
        phase: journal.phase,
      }
    : null;
}

function readOperationJournal(): ParsedOperationJournal | null {
  try {
    const parsed = JSON.parse(readFileSync(operationJournalPath(), "utf8")) as Partial<OperationJournal>;
    const operationIdValid =
      typeof parsed.operationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed.operationId);
    if (
      parsed.schemaVersion !== 1 ||
      !operationIdValid ||
      typeof parsed.accountClientId !== "string" ||
      !/^client_[a-f0-9]{8}$/u.test(parsed.accountClientId) ||
      (parsed.provider !== "claude-code" && parsed.provider !== "codex") ||
      (parsed.operation !== "enable" && parsed.operation !== "disable" && parsed.operation !== "repair") ||
      !["prepared", "provider_changed", "binding_changed", "rollback_failed"].includes(parsed.phase ?? "") ||
      !Array.isArray(parsed.previousBindings) ||
      typeof parsed.providerInstalled !== "boolean" ||
      typeof parsed.providerEnabled !== "boolean" ||
      typeof parsed.marketplaceSourceExisted !== "boolean" ||
      (parsed.recoveryMarketplaceRoot !== null && typeof parsed.recoveryMarketplaceRoot !== "string") ||
      typeof parsed.startedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.startedAt))
    ) {
      throw new Error("invalid operation journal");
    }
    const previous = parseOperationJournalBindings(parsed.previousBindings);
    const previousInstallManifest =
      parsed.previousInstallManifest === null
        ? null
        : contextIntegrationInstallManifestSchema.parse(parsed.previousInstallManifest);
    if (parsed.providerInstalled && (!previousInstallManifest || !parsed.recoveryMarketplaceRoot)) {
      throw new Error("installed provider recovery state is incomplete");
    }
    if (parsed.providerInstalled && !parsed.providerEnabled) {
      throw new Error("disabled provider recovery state cannot be restored exactly");
    }
    return {
      ...(parsed as OperationJournal),
      previousBindings: previous.bindings,
      previousInstallManifest,
      legacyPreviousConfig: previous.legacyConfig,
    };
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`Invalid First Tree Context operation journal at ${operationJournalPath()}.`, { cause: error });
  }
}

function parseOperationJournalBindings(value: unknown): {
  bindings: ContextIntegrationBinding[];
  legacyConfig: LegacyContextIntegrationConfig | null;
} {
  const current = contextIntegrationConfigSchema.safeParse({
    schemaVersion: 2,
    bindings: value,
  });
  if (current.success) return { bindings: current.data.bindings, legacyConfig: null };
  const legacy = legacyContextIntegrationConfigSchema.parse({ schemaVersion: 1, bindings: value });
  return {
    bindings: contextIntegrationConfigSchema.parse({
      schemaVersion: 2,
      bindings: legacy.bindings.map((binding) => ({
        provider: binding.provider,
        project: { kind: "path", root: binding.checkoutRoot },
        organizationId: binding.organizationId,
      })),
    }).bindings,
    legacyConfig: legacy,
  };
}

function assertNoIncompleteOperation(): void {
  const incomplete = inspectContextIntegrationOperation();
  if (incomplete) {
    throw new Error(
      `A First Tree Context Plugin/binding operation is incomplete. Run \`${channelConfig.binName} context repair --provider ${incomplete.provider}\` before retrying.`,
    );
  }
}

function assertExpectedAccount(expectedAccountClientId: string): void {
  if (readActiveContextAccountClientId() !== expectedAccountClientId) {
    throw new Error(
      "The active First Tree Computer/account changed after the displayed Context plan. Re-run the command for the current account.",
    );
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

function sameConfig(left: ContextIntegrationConfig, right: ContextIntegrationConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
