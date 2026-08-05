import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextIntegrationProvider, ContextIntegrationReleaseManifest } from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import semver from "semver";
import { channelConfig } from "../channel.js";
import {
  assertContextMutationCanStart,
  readActiveContextAccountClientId,
  withAccountStateMutationLock,
} from "./account-state-guard.js";
import { assertContextAdapterPayloadHealthy } from "./adapter-payload-health.js";
import { readContextIntegrationInstallManifest } from "./manifest.js";
import type { ContextIntegrationProviderDriver } from "./provider-driver.js";
import { createContextIntegrationProviderDriver } from "./provider-factory.js";
import { resolveContextIntegrationRelease } from "./release.js";

const RECEIPT_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const ADOPTION_GENERATION_RE = /^[0-9a-f]{48}$/u;

type SessionLoadedReceipt = {
  schemaVersion: 1;
  accountClientId: string;
  provider: "claude-code";
  adapterVersion: string;
  adapterDigest: string;
  adoptionGeneration: string;
  sessionId: string;
  nonce: string;
  expiresAt: string;
};

type PendingReloadPlan = {
  schemaVersion: 1;
  accountClientId: string;
  provider: "claude-code";
  adapterVersion: string;
  adapterDigest: string;
  adoptionGeneration: string;
  planChallenge: string;
  boundSessionId: string | null;
  expiresAt: string;
};

type ConsumedReloadReceipt = {
  schemaVersion: 1;
  nonce: string;
  accountClientId: string;
  planChallenge: string;
  sessionId: string;
  expiresAt: string;
  consumedAt: string;
};

export function issueContextAdapterSessionLoadedReceipt(input: {
  provider: ContextIntegrationProvider;
  adapterDigest: string;
  adoptionGeneration: string;
  sessionId: string;
}): string | null {
  return withAccountStateMutationLock(() => {
    assertContextMutationCanStart();
    return issueContextAdapterSessionLoadedReceiptLocked(input);
  });
}

function issueContextAdapterSessionLoadedReceiptLocked(input: {
  provider: ContextIntegrationProvider;
  adapterDigest: string;
  adoptionGeneration: string;
  sessionId: string;
}): string | null {
  if (input.provider !== "claude-code") throw new ContextReloadReceiptError("Only Claude reloads use this receipt.");
  assertSessionId(input.sessionId);
  const obligation = inspectContextAdapterLoadedObservationObligation(input);
  if (obligation === null) {
    throw new ContextReloadReceiptError("This Claude session has no matching adapter adoption obligation.");
  }
  const install = readContextIntegrationInstallManifest(input.provider);
  if (
    input.adapterDigest !== install?.adapterDigest ||
    input.adoptionGeneration !== install?.adoptionGeneration ||
    !ADOPTION_GENERATION_RE.test(input.adoptionGeneration) ||
    !install.adapterVersion
  ) {
    throw new ContextReloadReceiptError("This Claude hook did not load the current First Tree Context adapter.");
  }
  if (obligation === "standalone_repair") {
    rmSync(join(providerStateRoot("claude-code"), "reload-required.json"), { force: true });
    return null;
  }
  const payload: SessionLoadedReceipt = {
    schemaVersion: 1,
    accountClientId: readActiveContextAccountClientId(),
    provider: "claude-code",
    adapterVersion: install.adapterVersion,
    adapterDigest: install.adapterDigest,
    adoptionGeneration: input.adoptionGeneration,
    sessionId: input.sessionId,
    nonce: randomBytes(24).toString("hex"),
    expiresAt: new Date(Date.now() + RECEIPT_TTL_MS).toISOString(),
  };
  return signReceipt(payload);
}

export function inspectContextAdapterLoadedObservationObligation(input: {
  provider: ContextIntegrationProvider;
  adapterDigest: string;
  adoptionGeneration: string;
}): ContextAdapterReloadObligationKind | null {
  if (
    input.provider !== "claude-code" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.adapterDigest) ||
    !ADOPTION_GENERATION_RE.test(input.adoptionGeneration)
  ) {
    return null;
  }
  const install = readContextIntegrationInstallManifest("claude-code");
  if (
    !install?.adapterVersion ||
    install.adapterDigest !== input.adapterDigest ||
    install.adoptionGeneration !== input.adoptionGeneration
  ) {
    return null;
  }
  const target = { adapterVersion: install.adapterVersion, adapterDigest: install.adapterDigest };
  const accountClientId = readActiveContextAccountClientId();
  const required = readContextAdapterReloadRequiredMarkerForTarget(target, accountClientId);
  if (required) {
    return required.adoptionGeneration === input.adoptionGeneration ? required.kind : null;
  }
  return hasAnyPendingContextAdapterReloadForTarget(target, input.adoptionGeneration, accountClientId) ? "setup" : null;
}

export function registerPendingContextAdapterReload(
  planChallenge: string,
  release: ContextIntegrationReleaseManifest,
): void {
  assertPlanChallenge(planChallenge);
  const target = release.providers["claude-code"];
  const install = readContextIntegrationInstallManifest("claude-code");
  const required = readContextAdapterReloadRequiredMarker(release);
  if (!required || required.kind !== "setup" || required.adoptionGeneration !== install?.adoptionGeneration) {
    throw new ContextReloadRecoveryStateError("The exact setup plan has no matching durable Claude reload obligation.");
  }
  const pending: PendingReloadPlan = {
    schemaVersion: 1,
    accountClientId: readActiveContextAccountClientId(),
    provider: "claude-code",
    adapterVersion: target.adapterVersion,
    adapterDigest: target.adapterDigest,
    adoptionGeneration: required.adoptionGeneration,
    planChallenge,
    boundSessionId: null,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  };
  writeJson(pendingPath(planChallenge), pending);
}

export type ContextAdapterReloadObligationKind = "setup" | "standalone_repair";

export function markContextAdapterReloadRequired(
  release: ContextIntegrationReleaseManifest,
  kind: ContextAdapterReloadObligationKind = "standalone_repair",
  adoptionGeneration = readContextIntegrationInstallManifest("claude-code")?.adoptionGeneration,
): void {
  if (!ADOPTION_GENERATION_RE.test(adoptionGeneration ?? "")) {
    throw new ContextReloadRecoveryStateError("The Claude reload obligation lacks an exact adoption generation.");
  }
  const target = release.providers["claude-code"];
  writeJson(join(providerStateRoot("claude-code"), "reload-required.json"), {
    schemaVersion: 1,
    accountClientId: readActiveContextAccountClientId(),
    provider: "claude-code",
    adapterVersion: target.adapterVersion,
    adapterDigest: target.adapterDigest,
    adoptionGeneration,
    kind,
    createdAt: new Date().toISOString(),
  });
}

export function beginContextAdapterReloadObligation(
  release: ContextIntegrationReleaseManifest,
  kind: ContextAdapterReloadObligationKind,
  adoptionGeneration: string,
): () => void {
  const path = join(providerStateRoot("claude-code"), "reload-required.json");
  let previous: string | null = null;
  try {
    previous = readFileSync(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  markContextAdapterReloadRequired(release, kind, adoptionGeneration);
  return () => {
    if (previous === null) {
      rmSync(path, { force: true });
      return;
    }
    writeRaw(path, previous);
  };
}

export function consumeContextAdapterReloadRequiredMarker(
  release: ContextIntegrationReleaseManifest,
  expectedKind?: ContextAdapterReloadObligationKind,
): boolean {
  const required = readContextAdapterReloadRequiredMarker(release);
  if (required && expectedKind && required.kind !== expectedKind) {
    throw new ContextReloadRecoveryStateError("The pending Claude reload obligation has the wrong recovery kind.");
  }
  if (required) rmSync(join(providerStateRoot("claude-code"), "reload-required.json"), { force: true });
  return required !== null;
}

export function hasContextAdapterReloadRequiredMarker(
  release: ContextIntegrationReleaseManifest,
  expectedKind?: ContextAdapterReloadObligationKind,
): boolean {
  const required = readContextAdapterReloadRequiredMarker(release);
  if (required && expectedKind && required.kind !== expectedKind) {
    throw new ContextReloadRecoveryStateError("The pending Claude reload obligation has the wrong recovery kind.");
  }
  return required !== null;
}

export function inspectContextAdapterReloadObligation(
  release: ContextIntegrationReleaseManifest,
): ContextAdapterReloadObligationKind | null {
  return readContextAdapterReloadRequiredMarker(release)?.kind ?? null;
}

function readContextAdapterReloadRequiredMarker(
  release: ContextIntegrationReleaseManifest,
): { kind: ContextAdapterReloadObligationKind; adoptionGeneration: string } | null {
  return readContextAdapterReloadRequiredMarkerForTarget(
    release.providers["claude-code"],
    readActiveContextAccountClientId(),
  );
}

function readContextAdapterReloadRequiredMarkerForTarget(
  target: { adapterVersion: string; adapterDigest: string },
  accountClientId: string,
): { kind: ContextAdapterReloadObligationKind; adoptionGeneration: string } | null {
  const path = join(providerStateRoot("claude-code"), "reload-required.json");
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      value.accountClientId !== accountClientId ||
      value.provider !== "claude-code" ||
      value.adapterVersion !== target.adapterVersion ||
      value.adapterDigest !== target.adapterDigest ||
      !ADOPTION_GENERATION_RE.test(String(value.adoptionGeneration ?? "")) ||
      (value.kind !== "setup" && value.kind !== "standalone_repair") ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      throw new ContextReloadReceiptError("The pending Claude reload state does not match this account or adapter.");
    }
    return { kind: value.kind, adoptionGeneration: value.adoptionGeneration as string };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export function hasPendingContextAdapterReload(
  planChallenge: string,
  release: ContextIntegrationReleaseManifest,
): boolean {
  const pending = readPending(planChallenge);
  if (pending && Date.parse(pending.expiresAt) <= Date.now()) {
    rmSync(pendingPath(planChallenge), { force: true });
    return false;
  }
  const target = release.providers["claude-code"];
  const install = readContextIntegrationInstallManifest("claude-code");
  if (!pending) return false;
  if (
    pending.accountClientId !== readActiveContextAccountClientId() ||
    pending.adapterVersion !== target.adapterVersion ||
    pending.adapterDigest !== target.adapterDigest ||
    pending.adoptionGeneration !== install?.adoptionGeneration
  ) {
    throw new ContextReloadRecoveryStateError(
      "The pending Claude reload state belongs to another account or adapter target.",
    );
  }
  return true;
}

export function consumeContextAdapterReloadReceipt(input: {
  planChallenge: string;
  receipt: string;
  release: ContextIntegrationReleaseManifest;
}): void {
  const pending = readPending(input.planChallenge);
  const loaded = verifyReceipt(input.receipt);
  const target = input.release.providers["claude-code"];
  const install = readContextIntegrationInstallManifest("claude-code");
  if (
    !pending ||
    pending.accountClientId !== readActiveContextAccountClientId() ||
    pending.adapterVersion !== target.adapterVersion ||
    pending.adapterDigest !== target.adapterDigest ||
    pending.adoptionGeneration !== install?.adoptionGeneration ||
    Date.parse(pending.expiresAt) <= Date.now() ||
    loaded.accountClientId !== pending.accountClientId ||
    loaded.provider !== pending.provider ||
    loaded.adapterVersion !== pending.adapterVersion ||
    loaded.adapterDigest !== pending.adapterDigest ||
    loaded.adoptionGeneration !== pending.adoptionGeneration ||
    Date.parse(loaded.expiresAt) <= Date.now() ||
    (pending.boundSessionId !== null && pending.boundSessionId !== loaded.sessionId)
  ) {
    throw new ContextReloadReceiptError("The Claude reload proof does not match this exact setup plan and session.");
  }
  const consumed = readConsumedNonce(loaded.nonce);
  if (consumed) {
    if (
      pending.boundSessionId === loaded.sessionId &&
      consumed.accountClientId === loaded.accountClientId &&
      consumed.planChallenge === input.planChallenge &&
      consumed.sessionId === loaded.sessionId
    ) {
      // Crash recovery: the nonce marker was durable before pending removal.
      rmSync(pendingPath(input.planChallenge), { force: true });
      return;
    }
    throw new ContextReloadReceiptError("The Claude reload proof was already consumed by another setup plan.");
  }
  const bound = { ...pending, boundSessionId: loaded.sessionId };
  writeJson(pendingPath(input.planChallenge), bound);
  writeJson(consumedPath(loaded.nonce), {
    schemaVersion: 1,
    nonce: loaded.nonce,
    accountClientId: loaded.accountClientId,
    planChallenge: input.planChallenge,
    sessionId: loaded.sessionId,
    expiresAt: loaded.expiresAt,
    consumedAt: new Date().toISOString(),
  });
  rmSync(pendingPath(input.planChallenge), { force: true });
}

export function clearContextAdapterObservation(
  provider: ContextIntegrationProvider,
  options: { includeReloadRequired?: boolean } = {},
): void {
  rmSync(join(providerStateRoot(provider), "adapter-sync"), { recursive: true, force: true });
  rmSync(join(providerStateRoot(provider), "reload-pending"), { recursive: true, force: true });
  rmSync(join(providerStateRoot(provider), "reload-consumed"), { recursive: true, force: true });
  if (options.includeReloadRequired) {
    rmSync(join(providerStateRoot(provider), "reload-required.json"), { force: true });
  }
}

export function assertContextAdapterReadyForRouting(
  provider: ContextIntegrationProvider,
  options: { releaseRoot?: string; coreRoot?: string; driver?: ContextIntegrationProviderDriver } = {},
): void {
  const release = resolveContextIntegrationRelease(options.releaseRoot, { coreRoot: options.coreRoot });
  const expected = release.manifest.providers[provider];
  const install = readContextIntegrationInstallManifest(provider);
  if (
    provider === "claude-code" &&
    (readContextAdapterReloadRequiredMarker(release.manifest) || hasAnyPendingContextAdapterReload(release.manifest))
  ) {
    throw new ContextPluginReloadRequiredError();
  }
  const exact = install?.adapterVersion === expected.adapterVersion && install.adapterDigest === expected.adapterDigest;
  const compatibleLoadedAdapter =
    install?.channel === channelConfig.channel &&
    install.loaderProtocolVersion === 1 &&
    Boolean(
      install.adapterVersion &&
        semver.valid(install.adapterVersion) &&
        semver.valid(expected.adapterVersion) &&
        semver.lt(install.adapterVersion, expected.adapterVersion),
    );
  if (!exact && !compatibleLoadedAdapter) {
    throw new ContextPluginReloadRequiredError();
  }
  if (!install?.adapterVersion || !install.adapterDigest) throw new ContextPluginReloadRequiredError();
  try {
    assertContextAdapterPayloadHealthy(options.driver ?? createContextIntegrationProviderDriver(provider), {
      adapterVersion: install.adapterVersion,
      adapterDigest: install.adapterDigest,
    });
  } catch (error) {
    throw new ContextPluginReloadRequiredError("The installed First Tree Context Plugin payload has drifted.", {
      cause: error,
    });
  }
}

function hasAnyPendingContextAdapterReload(release: ContextIntegrationReleaseManifest): boolean {
  const target = release.providers["claude-code"];
  const accountClientId = readActiveContextAccountClientId();
  const install = readContextIntegrationInstallManifest("claude-code");
  return install?.adoptionGeneration
    ? hasAnyPendingContextAdapterReloadForTarget(target, install.adoptionGeneration, accountClientId)
    : false;
}

function hasAnyPendingContextAdapterReloadForTarget(
  target: { adapterVersion: string; adapterDigest: string },
  adoptionGeneration: string,
  accountClientId: string,
): boolean {
  const root = join(providerStateRoot("claude-code"), "reload-pending");
  let entries: string[];
  try {
    entries = readdirSync(root).filter((entry) => entry.endsWith(".json"));
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  return entries.some((entry) => {
    if (!/^[0-9a-f]{64}\.json$/u.test(entry)) {
      throw new ContextReloadRecoveryStateError("The pending Claude reload state contains an invalid entry.");
    }
    const pending = readPending(entry.slice(0, -5));
    if (!pending) return false;
    if (
      pending.accountClientId !== accountClientId ||
      pending.adapterVersion !== target.adapterVersion ||
      pending.adapterDigest !== target.adapterDigest ||
      pending.adoptionGeneration !== adoptionGeneration
    ) {
      throw new ContextReloadRecoveryStateError(
        "The pending Claude reload state belongs to another account or adapter target.",
      );
    }
    return Date.parse(pending.expiresAt) > Date.now();
  });
}

export class ContextPluginReloadRequiredError extends Error {
  readonly code = "CONTEXT_PLUGIN_RELOAD_REQUIRED";

  constructor(
    message = "This session is still using an older First Tree Context Plugin. Reload the provider Plugin, then retry.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContextPluginReloadRequiredError";
  }
}

export class ContextReloadRecoveryStateError extends Error {
  readonly code = "CONTEXT_RELOAD_RECOVERY_STATE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ContextReloadRecoveryStateError";
  }
}

export class ContextReloadReceiptError extends Error {
  readonly code = "CONTEXT_RELOAD_RECEIPT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ContextReloadReceiptError";
  }
}

function signReceipt(payload: SessionLoadedReceipt): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(encoded).digest("base64url");
  return `v1.${encoded}.${signature}`;
}

function verifyReceipt(token: string): SessionLoadedReceipt {
  const [version, encoded, signature] = token.split(".");
  if (version !== "v1" || !encoded || !signature) throw new ContextReloadReceiptError("Invalid reload proof.");
  const expected = createHmac("sha256", signingKey()).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new ContextReloadReceiptError("Invalid reload proof.");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ContextReloadReceiptError("Invalid reload proof signature.");
  }
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionLoadedReceipt>;
    if (
      value.schemaVersion !== 1 ||
      value.provider !== "claude-code" ||
      typeof value.accountClientId !== "string" ||
      typeof value.adapterVersion !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.adapterDigest ?? "") ||
      !ADOPTION_GENERATION_RE.test(value.adoptionGeneration ?? "") ||
      typeof value.sessionId !== "string" ||
      typeof value.nonce !== "string" ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      throw new Error("invalid payload");
    }
    return value as SessionLoadedReceipt;
  } catch {
    throw new ContextReloadReceiptError("Invalid reload proof payload.");
  }
}

function readPending(planChallenge: string): PendingReloadPlan | null {
  assertPlanChallenge(planChallenge);
  try {
    const value = JSON.parse(readFileSync(pendingPath(planChallenge), "utf8")) as Partial<PendingReloadPlan>;
    if (
      value.schemaVersion !== 1 ||
      value.accountClientId === undefined ||
      !/^client_[a-f0-9]{8}$/u.test(value.accountClientId) ||
      value.provider !== "claude-code" ||
      typeof value.adapterVersion !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.adapterDigest ?? "") ||
      !ADOPTION_GENERATION_RE.test(value.adoptionGeneration ?? "") ||
      value.planChallenge !== planChallenge ||
      (value.boundSessionId !== null && typeof value.boundSessionId !== "string") ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      throw new Error("invalid pending reload state");
    }
    return value as PendingReloadPlan;
  } catch (error) {
    if (isMissing(error)) return null;
    throw new ContextReloadRecoveryStateError("The pending Claude reload state is unreadable or invalid.");
  }
}

function signingKey(): Buffer {
  const path = join(providerStateRoot("claude-code"), "reload-signing.key");
  try {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    if (key.length !== 32) throw new Error("invalid key");
    return key;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || Reflect.get(error, "code") !== "ENOENT") {
      throw new ContextReloadReceiptError("The Claude reload receipt signing state is invalid.");
    }
    const key = randomBytes(32);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
      return key;
    } catch (writeError) {
      if (
        typeof writeError === "object" &&
        writeError !== null &&
        "code" in writeError &&
        Reflect.get(writeError, "code") === "EEXIST"
      ) {
        const concurrentKey = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
        if (concurrentKey.length === 32) return concurrentKey;
      }
      throw writeError;
    }
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeRaw(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, value, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function providerStateRoot(provider: ContextIntegrationProvider): string {
  return join(defaultHome(), "state", "context", "providers", provider);
}

function pendingPath(challenge: string): string {
  return join(providerStateRoot("claude-code"), "reload-pending", `${challenge}.json`);
}

function consumedPath(nonce: string): string {
  return join(providerStateRoot("claude-code"), "reload-consumed", `${nonce}.json`);
}

function readConsumedNonce(nonce: string): ConsumedReloadReceipt | null {
  if (!/^[0-9a-f]{48}$/u.test(nonce)) throw new ContextReloadReceiptError("Invalid reload proof nonce.");
  try {
    const path = consumedPath(nonce);
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      value.nonce !== nonce ||
      typeof value.accountClientId !== "string" ||
      !/^client_[a-f0-9]{8}$/u.test(value.accountClientId) ||
      typeof value.planChallenge !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.planChallenge) ||
      typeof value.sessionId !== "string" ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      typeof value.consumedAt !== "string" ||
      !Number.isFinite(Date.parse(value.consumedAt))
    ) {
      throw new Error("invalid consumed reload state");
    }
    if (Date.parse(value.expiresAt) <= Date.now()) {
      rmSync(path, { force: true });
      return null;
    }
    return value as ConsumedReloadReceipt;
  } catch (error) {
    if (isMissing(error)) return null;
    throw new ContextReloadRecoveryStateError("The consumed Claude reload state is unreadable or invalid.");
  }
}

function assertSessionId(value: string): void {
  if (!value || value.length > 256 || !/^[0-9A-Za-z._:-]+$/u.test(value)) {
    throw new ContextReloadReceiptError("Claude did not provide a trustworthy session identity.");
  }
}

function assertPlanChallenge(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new ContextReloadReceiptError("Invalid setup plan challenge.");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
