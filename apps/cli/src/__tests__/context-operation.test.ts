import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contextGrantStoreFingerprintAfterGrant,
  inspectContextGrantStore,
  readContextIntegrationConfig,
} from "../core/context-integration/context-binding-store.js";
import { contextIntegrationMarketplaceSourcePath } from "../core/context-integration/installer.js";
import { writeContextIntegrationInstallManifest } from "../core/context-integration/manifest.js";
import {
  disableContextIntegrationOperation,
  enableContextIntegrationOperation,
  recoverContextIntegrationOperation,
} from "../core/context-integration/operation.js";
import type { ContextIntegrationProviderDriver } from "../core/context-integration/provider-driver.js";

const original = process.env.FIRST_TREE_HOME;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (original === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = original;
});

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "context-operation-v3-"));
  roots.push(root);
  process.env.FIRST_TREE_HOME = root;
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
  return root;
}

function grant() {
  return { provider: "codex" as const, organizationId: "org-a", activationScope: { kind: "global" as const } };
}

function storeFence(target = grant()) {
  const store = inspectContextGrantStore();
  return {
    beforeFingerprint: store.fingerprint,
    afterFingerprint: contextGrantStoreFingerprintAfterGrant(store, target),
  };
}

function installManifest() {
  return {
    schemaVersion: 1 as const,
    channel: "dev" as const,
    provider: "codex" as const,
    firstTreeVersion: "0.5.18",
    bundleVersion: "0.5.18",
    bundleDigest: `sha256:${"1".repeat(64)}`,
    policyDigest: `sha256:${"2".repeat(64)}`,
    adapterDigest: `sha256:${"3".repeat(64)}`,
    marketplaceName: "first-tree-dev",
    pluginName: "first-tree-context",
    installedAt: "2026-08-03T00:00:00.000Z",
  };
}

function seedRollbackPlugin(): void {
  const root = join(contextIntegrationMarketplaceSourcePath("codex"), "plugins", "first-tree-context");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "context-session-start"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}

const driver: ContextIntegrationProviderDriver = {
  provider: "codex",
  executable: "codex",
  minimumVersion: "0.144.0",
  probe: () => ({
    provider: "codex",
    binaryAvailable: true,
    version: "0.145.0",
    compatible: true,
    installed: false,
    enabled: false,
    installedPath: null,
    issues: [],
  }),
  inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
  validateMarketplace: () => undefined,
  install: () => {
    throw new Error("not expected");
  },
  uninstall: () => undefined,
};

const unchangedPlan = {
  provider: "codex" as const,
  operation: "unchanged" as const,
  previous: null,
  release: {
    root: "/unused",
    manifest: {
      schemaVersion: 1 as const,
      version: "0.5.18",
      channel: "dev" as const,
      bundleDigest: `sha256:${"1".repeat(64)}`,
      policyDigest: `sha256:${"2".repeat(64)}`,
      providers: {
        codex: { adapterDigest: `sha256:${"3".repeat(64)}`, minimumVersion: "0.144.0" },
        "claude-code": { adapterDigest: `sha256:${"4".repeat(64)}`, minimumVersion: "2.1.121" },
      },
    },
  },
  probe: driver.probe("first-tree", "first-tree-context"),
  marketplaceName: "first-tree-dev",
};

describe("v3 grant operation", () => {
  it("atomically adds and removes one exact grant", () => {
    setup();
    const grant = { provider: "codex" as const, organizationId: "org-a", activationScope: { kind: "global" as const } };
    const store = inspectContextGrantStore();
    enableContextIntegrationOperation(
      driver,
      unchangedPlan,
      grant,
      {
        beforeFingerprint: store.fingerprint,
        afterFingerprint: contextGrantStoreFingerprintAfterGrant(store, grant),
      },
      "client_1234abcd",
    );
    expect(readContextIntegrationConfig().grants).toEqual([grant]);
    disableContextIntegrationOperation("codex", {
      organizationId: "org-a",
      activationScope: { kind: "global" },
      expectedConfig: readContextIntegrationConfig(),
      expectedAccountClientId: "client_1234abcd",
    });
    expect(readContextIntegrationConfig()).toEqual({ schemaVersion: 3, grants: [] });
  });

  it("removes only the exact Team and scope while preserving peer grants", () => {
    setup();
    const first = grant();
    const second = {
      provider: "codex" as const,
      organizationId: "org-b",
      activationScope: { kind: "directory" as const, root: "/work/other" },
    };
    for (const target of [first, second]) {
      const store = inspectContextGrantStore();
      enableContextIntegrationOperation(
        driver,
        unchangedPlan,
        target,
        {
          beforeFingerprint: store.fingerprint,
          afterFingerprint: contextGrantStoreFingerprintAfterGrant(store, target),
        },
        "client_1234abcd",
      );
    }
    const before = readContextIntegrationConfig();
    const result = disableContextIntegrationOperation("codex", {
      organizationId: first.organizationId,
      activationScope: first.activationScope,
      expectedConfig: before,
      expectedAccountClientId: "client_1234abcd",
    });
    expect(result.removed).toEqual([first]);
    expect(result.remaining).toEqual([second]);
    expect(readContextIntegrationConfig().grants).toEqual([second]);
  });

  it("fails before mutation when the installed provider Plugin is disabled", () => {
    setup();
    writeContextIntegrationInstallManifest(installManifest());
    seedRollbackPlugin();
    const install = vi.fn();
    const uninstall = vi.fn();
    const disabled: ContextIntegrationProviderDriver = {
      ...driver,
      probe: () => ({
        ...driver.probe("first-tree-dev", "first-tree-context"),
        installed: true,
        enabled: false,
        installedPath: "/provider/plugin",
      }),
      install,
      uninstall,
    };
    expect(() =>
      enableContextIntegrationOperation(disabled, unchangedPlan, grant(), storeFence(), "client_1234abcd"),
    ).toThrow("installed but disabled");
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig().grants).toEqual([]);
  });

  it("rejects a stale grant plan before provider mutation", () => {
    setup();
    const target = grant();
    const fence = storeFence(target);
    const concurrent = {
      provider: "codex" as const,
      organizationId: "org-b",
      activationScope: { kind: "global" as const },
    };
    const current = inspectContextGrantStore();
    enableContextIntegrationOperation(
      driver,
      unchangedPlan,
      concurrent,
      {
        beforeFingerprint: current.fingerprint,
        afterFingerprint: contextGrantStoreFingerprintAfterGrant(current, concurrent),
      },
      "client_1234abcd",
    );
    const install = vi.fn();
    expect(() =>
      enableContextIntegrationOperation({ ...driver, install }, unchangedPlan, target, fence, "client_1234abcd"),
    ).toThrow("changed after the displayed plan");
    expect(install).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig().grants).toEqual([concurrent]);
  });

  it("rolls back Plugin, manifest, and grants when grant persistence fails", () => {
    const home = setup();
    const target = grant();
    const uninstall = vi.fn();
    const installing = { ...driver, uninstall };
    const plan = { ...unchangedPlan, operation: "install" as const };
    expect(() =>
      enableContextIntegrationOperation(installing, plan, target, storeFence(target), "client_1234abcd", {
        install: () => {
          writeContextIntegrationInstallManifest(installManifest());
          return { manifest: installManifest(), probe: driver.probe("first-tree-dev", "first-tree-context") };
        },
        writeGrant: () => {
          throw new Error("grant rename failed");
        },
      }),
    ).toThrow("grant rename failed");
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(readContextIntegrationConfig().grants).toEqual([]);
    expect(existsSync(join(home, "state", "context", "operation-journal.json"))).toBe(false);
  });

  it("keeps a rollback_failed durable journal when restoration also fails", () => {
    const home = setup();
    const target = grant();
    const failing = {
      ...driver,
      uninstall: vi.fn(() => {
        throw new Error("provider rollback failed");
      }),
    };
    expect(() =>
      enableContextIntegrationOperation(
        failing,
        { ...unchangedPlan, operation: "install" as const },
        target,
        storeFence(target),
        "client_1234abcd",
        {
          install: () => ({ manifest: installManifest(), probe: driver.probe("first-tree-dev", "first-tree-context") }),
          writeGrant: () => {
            throw new Error("grant failed");
          },
        },
      ),
    ).toThrow(AggregateError);
    expect(JSON.parse(readFileSync(join(home, "state", "context", "operation-journal.json"), "utf8"))).toMatchObject({
      phase: "rollback_failed",
      previousConfig: { schemaVersion: 3, grants: [] },
    });
  });

  it("recovers the exact previous v3 grant set from a durable journal", () => {
    const home = setup();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    mkdirSync(recoveryRoot, { recursive: true });
    mkdirSync(join(home, "state", "context"), { recursive: true });
    writeFileSync(
      join(home, "state", "context", "operation-journal.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "enable",
        phase: "grant_changed",
        previousConfig: { schemaVersion: 3, grants: [grant()] },
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
        startedAt: "2026-08-03T00:00:00.000Z",
      })}\n`,
    );
    expect(recoverContextIntegrationOperation(driver)).toBe(true);
    expect(readContextIntegrationConfig().grants).toEqual([grant()]);
    expect(existsSync(recoveryRoot)).toBe(false);
  });

  it("rejects account changes before any operation mutation", () => {
    setup();
    const target = grant();
    const install = vi.fn();
    expect(() =>
      enableContextIntegrationOperation(
        { ...driver, install },
        unchangedPlan,
        target,
        storeFence(target),
        "client_other",
      ),
    ).toThrow("account changed");
    expect(install).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig().grants).toEqual([]);
  });
});
