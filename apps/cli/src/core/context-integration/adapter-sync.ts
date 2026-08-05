import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextIntegrationProvider } from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import semver from "semver";
import { channelConfig } from "../channel.js";
import {
  assertContextMutationCanStart,
  readActiveContextAccountClientId,
  withAccountStateMutationLock,
} from "./account-state-guard.js";
import { assertContextAdapterPayloadHealthy } from "./adapter-payload-health.js";
import { planContextIntegrationInstall } from "./installer.js";
import { readContextIntegrationInstallManifest } from "./manifest.js";
import { repairContextIntegrationOperation } from "./operation.js";
import type { ContextIntegrationProviderDriver } from "./provider-driver.js";
import { createContextIntegrationProviderDriver } from "./provider-factory.js";
import { resolveContextIntegrationRelease } from "./release.js";

const SYNC_TTL_MS = 10 * 60 * 1000;

type AdapterSyncReceipt = {
  schemaVersion: 1;
  accountClientId: string;
  channel: "prod" | "staging" | "dev";
  provider: ContextIntegrationProvider;
  sessionId: string;
  challenge: string;
  fromAdapterVersion: string;
  fromAdapterDigest: string;
  targetAdapterVersion: string;
  targetAdapterDigest: string;
  expiresAt: string;
};

export type AdapterSyncAction = {
  code: "adapter_sync_required";
  command: string;
  challenge: string;
};

export function issueAdapterSyncAction(
  input: {
    provider: ContextIntegrationProvider;
    sessionId: string;
    suppliedAdapterDigest: string;
  },
  options: { releaseRoot?: string; coreRoot?: string; driver?: ContextIntegrationProviderDriver } = {},
): AdapterSyncAction {
  cleanupExpiredAdapterSyncReceipts(input.provider);
  assertSessionId(input.sessionId);
  const accountClientId = readActiveContextAccountClientId();
  const installed = readContextIntegrationInstallManifest(input.provider);
  const release = resolveContextIntegrationRelease(options.releaseRoot, { coreRoot: options.coreRoot });
  const target = release.manifest.providers[input.provider];
  if (
    !installed?.adapterVersion ||
    installed.loaderProtocolVersion !== 1 ||
    installed.channel !== channelConfig.channel ||
    installed.adapterDigest !== input.suppliedAdapterDigest
  ) {
    throw new AdapterSyncRejectedError(
      "The installed First Tree Context state cannot be safely updated automatically. Run an explicit Context repair.",
    );
  }
  try {
    assertContextAdapterPayloadHealthy(options.driver ?? createContextIntegrationProviderDriver(input.provider), {
      adapterVersion: installed.adapterVersion,
      adapterDigest: installed.adapterDigest,
    });
  } catch (error) {
    throw new AdapterSyncRejectedError(
      `The installed First Tree Context payload is not healthy enough for automatic update: ${message(error)}`,
    );
  }
  if (!semver.valid(installed.adapterVersion) || !semver.valid(target.adapterVersion)) {
    throw new AdapterSyncRejectedError(
      "The First Tree Context adapter version is invalid; explicit repair is required.",
    );
  }
  if (semver.gte(installed.adapterVersion, target.adapterVersion)) {
    throw new AdapterSyncRejectedError(
      semver.gt(installed.adapterVersion, target.adapterVersion)
        ? "The installed First Tree Context adapter is newer than this CLI; automatic downgrade is refused."
        : "The installed First Tree Context adapter bytes do not match this CLI; explicit repair is required.",
    );
  }
  const challenge = randomBytes(24).toString("hex");
  const receipt: AdapterSyncReceipt = {
    schemaVersion: 1,
    accountClientId,
    channel: channelConfig.channel,
    provider: input.provider,
    sessionId: input.sessionId,
    challenge,
    fromAdapterVersion: installed.adapterVersion,
    fromAdapterDigest: installed.adapterDigest,
    targetAdapterVersion: target.adapterVersion,
    targetAdapterDigest: target.adapterDigest,
    expiresAt: new Date(Date.now() + SYNC_TTL_MS).toISOString(),
  };
  writeReceipt(receipt);
  return {
    code: "adapter_sync_required",
    challenge,
    command: `${channelConfig.binName} --json context adapter-sync --provider ${input.provider} --challenge ${challenge}`,
  };
}

export function synchronizeContextAdapter(
  driver: ContextIntegrationProviderDriver,
  challenge: string,
  dependencies: {
    releaseRoot?: string;
    coreRoot?: string;
    planInstall?: typeof planContextIntegrationInstall;
    repairOperation?: typeof repairContextIntegrationOperation;
  } = {},
): {
  updated: true;
  provider: ContextIntegrationProvider;
  currentSessionAdoption: "reload_optional" | "next_session";
} {
  return withAccountStateMutationLock(() => {
    assertContextMutationCanStart();
    const receipt = readReceipt(driver.provider, challenge);
    const accountClientId = readActiveContextAccountClientId();
    const release = resolveContextIntegrationRelease(dependencies.releaseRoot, { coreRoot: dependencies.coreRoot });
    const installed = readContextIntegrationInstallManifest(driver.provider);
    const target = release.manifest.providers[driver.provider];
    if (
      receipt.accountClientId !== accountClientId ||
      receipt.channel !== channelConfig.channel ||
      receipt.provider !== driver.provider ||
      Date.parse(receipt.expiresAt) <= Date.now() ||
      !installed ||
      installed.adapterVersion !== receipt.fromAdapterVersion ||
      installed.adapterDigest !== receipt.fromAdapterDigest ||
      target.adapterVersion !== receipt.targetAdapterVersion ||
      target.adapterDigest !== receipt.targetAdapterDigest ||
      !semver.valid(receipt.fromAdapterVersion) ||
      !semver.valid(receipt.targetAdapterVersion) ||
      !semver.lt(receipt.fromAdapterVersion, receipt.targetAdapterVersion)
    ) {
      throw new AdapterSyncRejectedError(
        "First Tree Context changed after the automatic update action was issued. Run an explicit Context repair.",
      );
    }
    const plan = (dependencies.planInstall ?? planContextIntegrationInstall)(driver, {
      releaseRoot: dependencies.releaseRoot,
    });
    if (
      plan.operation !== "repair" ||
      plan.previous?.adapterVersion !== receipt.fromAdapterVersion ||
      plan.previous.adapterDigest !== receipt.fromAdapterDigest ||
      plan.release.manifest.providers[driver.provider].adapterVersion !== receipt.targetAdapterVersion ||
      plan.release.manifest.providers[driver.provider].adapterDigest !== receipt.targetAdapterDigest
    ) {
      throw new AdapterSyncRejectedError("The exact automatic update plan no longer matches local Plugin state.");
    }
    assertReceiptAccountAndTargetStillCurrent(receipt, release.manifest.providers[driver.provider]);
    (dependencies.repairOperation ?? repairContextIntegrationOperation)(driver, plan, {});
    assertReceiptAccountAndTargetStillCurrent(receipt, release.manifest.providers[driver.provider]);
    rmSync(receiptPath(driver.provider, challenge), { force: true });
    return {
      updated: true as const,
      provider: driver.provider,
      currentSessionAdoption:
        driver.provider === "claude-code" ? ("reload_optional" as const) : ("next_session" as const),
    };
  });
}

function assertReceiptAccountAndTargetStillCurrent(
  receipt: AdapterSyncReceipt,
  target: { adapterVersion: string; adapterDigest: string },
): void {
  const installed = readContextIntegrationInstallManifest(receipt.provider);
  if (
    readActiveContextAccountClientId() !== receipt.accountClientId ||
    target.adapterVersion !== receipt.targetAdapterVersion ||
    target.adapterDigest !== receipt.targetAdapterDigest ||
    (installed !== null &&
      installed.adapterVersion !== receipt.fromAdapterVersion &&
      (installed.adapterVersion !== receipt.targetAdapterVersion ||
        installed.adapterDigest !== receipt.targetAdapterDigest))
  ) {
    throw new AdapterSyncRejectedError("The active account or Context update target changed during adapter sync.");
  }
}

export function hasKnownGoodCompatibleContextAdapter(driver: ContextIntegrationProviderDriver): boolean {
  try {
    const installed = readContextIntegrationInstallManifest(driver.provider);
    if (
      installed?.channel !== channelConfig.channel ||
      installed.loaderProtocolVersion !== 1 ||
      !installed.adapterVersion ||
      !semver.valid(installed.adapterVersion)
    ) {
      return false;
    }
    assertContextAdapterPayloadHealthy(driver, {
      adapterVersion: installed.adapterVersion,
      adapterDigest: installed.adapterDigest,
    });
    return true;
  } catch {
    return false;
  }
}

export class AdapterSyncRejectedError extends Error {
  readonly code = "CONTEXT_ADAPTER_SYNC_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "AdapterSyncRejectedError";
  }
}

function writeReceipt(receipt: AdapterSyncReceipt): void {
  const path = receiptPath(receipt.provider, receipt.challenge);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readReceipt(provider: ContextIntegrationProvider, challenge: string): AdapterSyncReceipt {
  if (!/^[0-9a-f]{48}$/u.test(challenge)) throw new AdapterSyncRejectedError("Invalid Context update action.");
  try {
    const value = JSON.parse(readFileSync(receiptPath(provider, challenge), "utf8")) as Partial<AdapterSyncReceipt>;
    if (
      value.schemaVersion !== 1 ||
      value.provider !== provider ||
      value.challenge !== challenge ||
      typeof value.accountClientId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.fromAdapterVersion !== "string" ||
      typeof value.fromAdapterDigest !== "string" ||
      typeof value.targetAdapterVersion !== "string" ||
      typeof value.targetAdapterDigest !== "string" ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      !["prod", "staging", "dev"].includes(value.channel ?? "")
    ) {
      throw new Error("invalid receipt");
    }
    return value as AdapterSyncReceipt;
  } catch (error) {
    if (error instanceof AdapterSyncRejectedError) throw error;
    throw new AdapterSyncRejectedError("The automatic First Tree Context update action is missing or invalid.");
  }
}

function receiptPath(provider: ContextIntegrationProvider, challenge: string): string {
  return join(defaultHome(), "state", "context", "providers", provider, "adapter-sync", `${challenge}.json`);
}

function cleanupExpiredAdapterSyncReceipts(provider: ContextIntegrationProvider): void {
  const root = dirname(receiptPath(provider, "0".repeat(48)));
  let entries: string[];
  try {
    entries = readdirSync(root)
      .filter((entry) => /^[0-9a-f]{48}\.json$/u.test(entry))
      .sort((left, right) => statSync(join(root, left)).mtimeMs - statSync(join(root, right)).mtimeMs)
      .slice(0, 256);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { expiresAt?: unknown };
      if (typeof value.expiresAt === "string" && Date.parse(value.expiresAt) <= Date.now()) {
        rmSync(path, { force: true });
      }
    } catch {
      // Invalid evidence remains for fail-closed diagnosis.
    }
  }
}

function assertSessionId(value: string): void {
  if (value.length > 256 || !/^[0-9A-Za-z._:-]+$/u.test(value)) {
    throw new AdapterSyncRejectedError("The provider session identity is invalid.");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
