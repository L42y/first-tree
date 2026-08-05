import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertContextAdapterReadyForRouting,
  consumeContextAdapterReloadReceipt,
  consumeContextAdapterReloadRequiredMarker,
  hasPendingContextAdapterReload,
  inspectContextAdapterLoadedObservationObligation,
  issueContextAdapterSessionLoadedReceipt,
  markContextAdapterReloadRequired,
  registerPendingContextAdapterReload as registerPendingContextAdapterReloadImpl,
} from "../core/context-integration/adapter-observation.js";
import {
  readContextIntegrationInstallManifest,
  writeContextIntegrationInstallManifest,
} from "../core/context-integration/manifest.js";
import { contextPluginTreeDigest } from "../core/context-integration/payload-integrity.js";
import type { ContextIntegrationProviderDriver } from "../core/context-integration/provider-driver.js";
import { resolveContextIntegrationRelease } from "../core/context-integration/release.js";
import { COMMAND_VERSION } from "../core/version.js";

const roots: string[] = [];
const ADOPTION_GENERATION = "a".repeat(48);
const originalHome = process.env.FIRST_TREE_HOME;
let home = "";
let coreRoot = "";
let releaseRoot = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "first-tree-observation-home-"));
  coreRoot = mkdtempSync(join(tmpdir(), "first-tree-observation-core-"));
  releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-observation-release-"));
  roots.push(home, coreRoot, releaseRoot);
  process.env.FIRST_TREE_HOME = home;
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
  prepareCoreRoot(coreRoot);
  buildRelease(releaseRoot, coreRoot);
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

describe("Claude adapter reload observation", () => {
  it("does not observe a healthy adapter when no reload obligation exists", () => {
    const release = installCurrentAdapter();
    expect(
      inspectContextAdapterLoadedObservationObligation({
        provider: "claude-code",
        adapterDigest: release.manifest.providers["claude-code"].adapterDigest,
        adoptionGeneration: ADOPTION_GENERATION,
      }),
    ).toBeNull();
  });

  it("blocks Context routing while a repair marker or exact setup reload is still pending", () => {
    const release = installCurrentAdapter();
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).not.toThrow();

    markContextAdapterReloadRequired(release.manifest);
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "Reload the provider Plugin",
    );
    expect(consumeContextAdapterReloadRequiredMarker(release.manifest)).toBe(true);

    const challenge = "0".repeat(64);
    registerPendingContextAdapterReload(challenge, release.manifest);
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "Reload the provider Plugin",
    );
    const receipt = loadedReceipt("session-ready", release.manifest.providers["claude-code"].adapterDigest);
    consumeContextAdapterReloadReceipt({ planChallenge: challenge, receipt, release: release.manifest });
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).not.toThrow();
  });

  it("consumes a standalone repair marker once and rejects it after an account switch", () => {
    const release = installCurrentAdapter();
    markContextAdapterReloadRequired(release.manifest);
    expect(consumeContextAdapterReloadRequiredMarker(release.manifest)).toBe(true);
    expect(consumeContextAdapterReloadRequiredMarker(release.manifest)).toBe(false);

    markContextAdapterReloadRequired(release.manifest);
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_ffffffff\n");
    expect(() => consumeContextAdapterReloadRequiredMarker(release.manifest)).toThrow("does not match");
  });

  it("lets the verified reloaded hook complete standalone repair adoption", () => {
    const release = installCurrentAdapter();
    markContextAdapterReloadRequired(release.manifest, "standalone_repair");

    expect(observeLoaded("session-after-repair", release.manifest.providers["claude-code"].adapterDigest)).toBeNull();

    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).not.toThrow();
    expect(consumeContextAdapterReloadRequiredMarker(release.manifest)).toBe(false);
  });

  it("rejects a pre-repair hook generation even when the adapter digest did not change", () => {
    const release = installCurrentAdapter();
    const repairedGeneration = "b".repeat(48);
    const install = readContextIntegrationInstallManifest("claude-code");
    if (!install) throw new Error("missing test install manifest");
    writeContextIntegrationInstallManifest({ ...install, adoptionGeneration: repairedGeneration });
    markContextAdapterReloadRequired(release.manifest, "standalone_repair", repairedGeneration);

    expect(() =>
      loadedReceipt(
        "session-still-running-old-hook",
        release.manifest.providers["claude-code"].adapterDigest,
        ADOPTION_GENERATION,
      ),
    ).toThrow();
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "Reload the provider Plugin",
    );

    expect(
      observeLoaded(
        "session-after-reload",
        release.manifest.providers["claude-code"].adapterDigest,
        repairedGeneration,
      ),
    ).toBeNull();
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).not.toThrow();
  });

  it("keeps the hook non-mutating while another process owns the account-state lock", async () => {
    const release = installCurrentAdapter();
    const lock = join(home, "state", "account-state.lock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');const p=process.argv[1];fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,process.pid+'\\n',{flag:'wx'});process.stdout.write('ready\\n');setInterval(()=>{},1000);",
        lock,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error("lock holder did not become ready")), 5_000);
        child.once("error", reject);
        child.stdout.once("data", () => {
          clearTimeout(timeout);
          resolveReady();
        });
      });
      expect(() => loadedReceipt("session-locked", release.manifest.providers["claude-code"].adapterDigest)).toThrow(
        "Another First Tree account or Context state change",
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      rmSync(lock, { force: true });
    }
  });

  it("accepts one signed current-session receipt for one exact pending plan", () => {
    const release = installCurrentAdapter();
    const challenge = "a".repeat(64);
    registerPendingContextAdapterReload(challenge, release.manifest);
    const receipt = loadedReceipt("session-a", release.manifest.providers["claude-code"].adapterDigest);

    consumeContextAdapterReloadReceipt({ planChallenge: challenge, receipt, release: release.manifest });

    expect(hasPendingContextAdapterReload(challenge, release.manifest)).toBe(false);
    registerPendingContextAdapterReload(challenge, release.manifest);
    expect(() =>
      consumeContextAdapterReloadReceipt({ planChallenge: challenge, receipt, release: release.manifest }),
    ).toThrow("already consumed");
  });

  it("binds receipts to the active account without treating the user-level Plugin install as account-owned", () => {
    const release = installCurrentAdapter();
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_ffffffff\n");
    const challenge = "f".repeat(64);
    registerPendingContextAdapterReload(challenge, release.manifest);
    const receipt = loadedReceipt("session-new-account", release.manifest.providers["claude-code"].adapterDigest);

    consumeContextAdapterReloadReceipt({ planChallenge: challenge, receipt, release: release.manifest });

    expect(hasPendingContextAdapterReload(challenge, release.manifest)).toBe(false);
  });

  it("rejects old adapter hooks, forged tokens, missing session identity, account changes, and expiry", () => {
    const release = installCurrentAdapter();
    const targetDigest = release.manifest.providers["claude-code"].adapterDigest;
    const challenge = "b".repeat(64);
    registerPendingContextAdapterReload(challenge, release.manifest);
    expect(() => loadedReceipt("session-a", `sha256:${"0".repeat(64)}`)).toThrow("no matching");
    expect(() => loadedReceipt("", targetDigest)).toThrow("session identity");
    expect(() =>
      consumeContextAdapterReloadReceipt({
        planChallenge: challenge,
        receipt: "v1.fake.fake",
        release: release.manifest,
      }),
    ).toThrow("signature");

    const accountReceipt = loadedReceipt("session-a", targetDigest);
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_ffffffff\n");
    expect(() =>
      consumeContextAdapterReloadReceipt({
        planChallenge: challenge,
        receipt: accountReceipt,
        release: release.manifest,
      }),
    ).toThrow("does not match");

    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
    const expires = loadedReceipt("session-a", targetDigest);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    expect(() =>
      consumeContextAdapterReloadReceipt({ planChallenge: challenge, receipt: expires, release: release.manifest }),
    ).toThrow("does not match");
  });

  it("keeps concurrent pending plans independent instead of scanning or globally unlocking them", () => {
    const release = installCurrentAdapter();
    const first = "c".repeat(64);
    const second = "d".repeat(64);
    registerPendingContextAdapterReload(first, release.manifest);
    registerPendingContextAdapterReload(second, release.manifest);
    const receipt = loadedReceipt("session-a", release.manifest.providers["claude-code"].adapterDigest);

    consumeContextAdapterReloadReceipt({ planChallenge: first, receipt, release: release.manifest });

    expect(hasPendingContextAdapterReload(first, release.manifest)).toBe(false);
    expect(hasPendingContextAdapterReload(second, release.manifest)).toBe(true);
    expect(() =>
      consumeContextAdapterReloadReceipt({ planChallenge: second, receipt, release: release.manifest }),
    ).toThrow("already consumed");
  });

  it("does not let another session take over a plan that was already bound before a crash", () => {
    const release = installCurrentAdapter();
    const challenge = "e".repeat(64);
    registerPendingContextAdapterReload(challenge, release.manifest);
    const path = join(home, "state", "context", "providers", "claude-code", "reload-pending", `${challenge}.json`);
    const pending = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...pending, boundSessionId: "session-a" })}\n`);
    const otherSession = loadedReceipt("session-b", release.manifest.providers["claude-code"].adapterDigest);

    expect(() =>
      consumeContextAdapterReloadReceipt({
        planChallenge: challenge,
        receipt: otherSession,
        release: release.manifest,
      }),
    ).toThrow("does not match");
    expect(hasPendingContextAdapterReload(challenge, release.manifest)).toBe(true);
  });

  it("finishes pending removal idempotently after the consumed nonce became durable", () => {
    const release = installCurrentAdapter();
    const challenge = "2".repeat(64);
    registerPendingContextAdapterReload(challenge, release.manifest);
    const receipt = loadedReceipt("session-crash", release.manifest.providers["claude-code"].adapterDigest);
    consumeContextAdapterReloadReceipt({ planChallenge: challenge, receipt, release: release.manifest });

    registerPendingContextAdapterReload(challenge, release.manifest);
    const path = join(home, "state", "context", "providers", "claude-code", "reload-pending", `${challenge}.json`);
    const pending = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...pending, boundSessionId: "session-crash" })}\n`);

    expect(() =>
      consumeContextAdapterReloadReceipt({ planChallenge: challenge, receipt, release: release.manifest }),
    ).not.toThrow();
    expect(hasPendingContextAdapterReload(challenge, release.manifest)).toBe(false);
  });

  it("fails closed for malformed pending and consumed reload recovery state", () => {
    const release = installCurrentAdapter();
    const challenge = "1".repeat(64);
    registerPendingContextAdapterReload(challenge, release.manifest);
    const pendingPath = join(
      home,
      "state",
      "context",
      "providers",
      "claude-code",
      "reload-pending",
      `${challenge}.json`,
    );
    writeFileSync(pendingPath, "{broken\n");
    expect(() => hasPendingContextAdapterReload(challenge, release.manifest)).toThrow("unreadable or invalid");
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "unreadable or invalid",
    );

    registerPendingContextAdapterReload(challenge, release.manifest);
    const invalidExpiry = JSON.parse(readFileSync(pendingPath, "utf8")) as Record<string, unknown>;
    writeFileSync(pendingPath, `${JSON.stringify({ ...invalidExpiry, expiresAt: "not-a-date" })}\n`);
    expect(() => hasPendingContextAdapterReload(challenge, release.manifest)).toThrow("unreadable or invalid");

    registerPendingContextAdapterReload(challenge, release.manifest);
    const receipt = loadedReceipt("session-corrupt-consumed", release.manifest.providers["claude-code"].adapterDigest);
    const payload = JSON.parse(Buffer.from(receipt.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      nonce: string;
    };
    const consumedPath = join(
      home,
      "state",
      "context",
      "providers",
      "claude-code",
      "reload-consumed",
      `${payload.nonce}.json`,
    );
    mkdirSync(join(consumedPath, ".."), { recursive: true });
    writeFileSync(consumedPath, "{broken\n");
    expect(() =>
      consumeContextAdapterReloadReceipt({ planChallenge: challenge, receipt, release: release.manifest }),
    ).toThrow("consumed Claude reload state is unreadable or invalid");
  });

  it("leaves payload health enforcement at the task routing boundary", () => {
    const release = installCurrentAdapter();
    const target = release.manifest.providers["claude-code"];
    const stableStub = join(
      home,
      "state",
      "context",
      "providers",
      "claude-code",
      "marketplace",
      "plugins",
      "first-tree-context",
      "skills",
      "first-tree-read",
      "SKILL.md",
    );
    writeFileSync(stableStub, "tampered stable stub\n");
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "payload has drifted",
    );

    installCurrentAdapter();
    const providerStub = join(home, "provider-cache", "first-tree-context", "skills", "first-tree-read", "SKILL.md");
    writeFileSync(providerStub, "tampered provider stub\n");
    const providerChallenge = "6".repeat(64);
    registerPendingContextAdapterReload(providerChallenge, release.manifest);
    const providerReceipt = loadedReceipt("session-provider-drift", target.adapterDigest);
    consumeContextAdapterReloadReceipt({
      planChallenge: providerChallenge,
      receipt: providerReceipt,
      release: release.manifest,
    });
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "payload has drifted",
    );

    installCurrentAdapter();
    rmSync(join(home, "provider-cache", "first-tree-context", "bin", "context-observe-loaded"));
    const partialChallenge = "7".repeat(64);
    registerPendingContextAdapterReload(partialChallenge, release.manifest);
    const partialReceipt = loadedReceipt("session-partial-cache", target.adapterDigest);
    consumeContextAdapterReloadReceipt({
      planChallenge: partialChallenge,
      receipt: partialReceipt,
      release: release.manifest,
    });
    expect(() => assertContextAdapterReadyForRouting("claude-code", observationOptions())).toThrow(
      "payload has drifted",
    );
  });
});

function installCurrentAdapter() {
  const release = resolveContextIntegrationRelease(releaseRoot, { coreRoot });
  const adapter = release.manifest.providers["claude-code"];
  const stableMarketplace = join(home, "state", "context", "providers", "claude-code", "marketplace");
  const stablePlugin = join(stableMarketplace, "plugins", "first-tree-context");
  const providerPlugin = join(home, "provider-cache", "first-tree-context");
  mkdirSync(join(stablePlugin, "bin"), { recursive: true });
  mkdirSync(join(stablePlugin, "skills", "first-tree-read"), { recursive: true });
  writeFileSync(join(stableMarketplace, "marketplace.json"), "{}\n");
  for (const launcher of ["context-session-start", "context-observe-loaded"]) {
    const path = join(stablePlugin, "bin", launcher);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o700);
  }
  writeFileSync(join(stablePlugin, "skills", "first-tree-read", "SKILL.md"), "---\nname: first-tree-read\n---\n");
  cpSync(stablePlugin, providerPlugin, { recursive: true });
  writeContextIntegrationInstallManifest({
    schemaVersion: 1,
    accountClientId: "client_1234abcd",
    channel: "dev",
    provider: "claude-code",
    firstTreeVersion: COMMAND_VERSION,
    bundleVersion: release.manifest.version,
    adapterVersion: adapter.adapterVersion,
    loaderProtocolVersion: 1,
    bundleDigest: release.manifest.bundleDigest,
    policyDigest: release.manifest.policyDigest,
    adapterDigest: adapter.adapterDigest,
    marketplaceName: "first-tree-dev",
    pluginName: "first-tree-context",
    adoptionGeneration: ADOPTION_GENERATION,
    materializedPayloadDigest: contextPluginTreeDigest(stablePlugin),
    materializedMarketplaceDigest: contextPluginTreeDigest(stableMarketplace),
    installedAt: new Date().toISOString(),
  });
  return release;
}

function loadedReceipt(sessionId: string, adapterDigest: string, adoptionGeneration = ADOPTION_GENERATION): string {
  const receipt = observeLoaded(sessionId, adapterDigest, adoptionGeneration);
  if (receipt === null) throw new Error("expected a setup reload receipt");
  return receipt;
}

function observeLoaded(sessionId: string, adapterDigest: string, adoptionGeneration = ADOPTION_GENERATION) {
  return issueContextAdapterSessionLoadedReceipt({
    provider: "claude-code",
    adapterDigest,
    adoptionGeneration,
    sessionId,
  });
}

function registerPendingContextAdapterReload(
  planChallenge: string,
  release: ReturnType<typeof installCurrentAdapter>["manifest"],
): void {
  markContextAdapterReloadRequired(release, "setup", ADOPTION_GENERATION);
  registerPendingContextAdapterReloadImpl(planChallenge, release);
  consumeContextAdapterReloadRequiredMarker(release, "setup");
}

function observationOptions() {
  return { releaseRoot, coreRoot, driver: testDriver() };
}

function testDriver(): ContextIntegrationProviderDriver {
  return {
    provider: "claude-code",
    executable: "claude",
    minimumVersion: "1.0.0",
    probe: () => ({
      provider: "claude-code",
      binaryAvailable: true,
      version: "1.0.0",
      compatible: true,
      installed: true,
      enabled: true,
      installedPath: join(home, "provider-cache", "first-tree-context"),
      issues: [],
    }),
    inspectHook: async () => ({ trust: "provider_managed", enabled: true, source: "provider_managed", issues: [] }),
    validateMarketplace: () => undefined,
    install: () => {
      throw new Error("not used");
    },
    uninstall: () => undefined,
  };
}

function prepareCoreRoot(target: string): void {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  cpSync(join(repoRoot, "skills"), join(target, "skills"), { recursive: true });
  const policy = join(target, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md");
  mkdirSync(join(policy, ".."), { recursive: true });
  cpSync(join(repoRoot, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md"), policy);
}

function buildRelease(target: string, source: string): void {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  execFileSync(process.execPath, [
    join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
    "--out-dir",
    target,
    "--version",
    COMMAND_VERSION,
    "--channel",
    "dev",
    "--core-root",
    source,
  ]);
}
