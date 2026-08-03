import { describe, expect, it, vi } from "vitest";
import type { ContextIntegrationProviderDriver } from "../core/context-integration/provider-driver.js";
import { inspectContextIntegrationStatus } from "../core/context-integration/status.js";

const driver: ContextIntegrationProviderDriver = {
  provider: "codex",
  executable: "codex",
  minimumVersion: "0.144.0",
  probe: vi.fn(),
  inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
  validateMarketplace: () => undefined,
  install: vi.fn(),
  uninstall: vi.fn(),
};

describe("multi-Team context status", () => {
  it("reports every applicable grant with its independent live activation", async () => {
    const grants = ["org-a", "org-b"].map((organizationId) => ({
      grant: { provider: "codex" as const, organizationId, activationScope: { kind: "global" as const } },
      priority: "global" as const,
    }));
    const validator = {
      validateMemberContextActivation: vi.fn(async (organizationId: string) => ({
        schemaVersion: 2 as const,
        outcome: "connected" as const,
        team: { organizationId, displayName: organizationId, role: "member" as const },
      })),
    };
    const status = await inspectContextIntegrationStatus(
      driver,
      validator,
      {},
      {
        inspectRuntime: () => ({
          provider: "codex",
          healthy: true,
          issues: [],
          release: null,
          install: null,
          probe: {
            provider: "codex",
            binaryAvailable: true,
            version: "0.145.0",
            compatible: true,
            installed: true,
            enabled: true,
            installedPath: "/plugin",
            issues: [],
          },
        }),
        inspectPreflight: () => ({ kind: "path", project: { kind: "path", root: "/work" }, source: "explicit_path" }),
        resolveCandidates: () => grants,
        readConfig: () => ({
          schemaVersion: 3,
          grants: [
            ...grants.map((item) => item.grant),
            {
              provider: "codex",
              organizationId: "org-other-directory",
              activationScope: { kind: "directory", root: "/other" },
            },
            {
              provider: "claude-code",
              organizationId: "org-other-provider",
              activationScope: { kind: "global" },
            },
          ],
        }),
      },
    );
    expect(status.effectiveCandidates).toHaveLength(2);
    expect(status.effectiveCandidates.every((candidate) => candidate.activation.state === "connected")).toBe(true);
    expect(status.persistentGrants.map((grant) => grant.organizationId)).toEqual([
      "org-a",
      "org-b",
      "org-other-directory",
    ]);
  });

  it("keeps all provider grants visible when the current project cannot be inspected", async () => {
    const status = await inspectContextIntegrationStatus(
      driver,
      { validateMemberContextActivation: vi.fn() },
      { pathless: true },
      {
        inspectRuntime: () => ({
          provider: "codex",
          healthy: true,
          issues: [],
          release: null,
          install: null,
          probe: {
            provider: "codex",
            binaryAvailable: true,
            version: "0.145.0",
            compatible: true,
            installed: true,
            enabled: true,
            installedPath: "/plugin",
            issues: [],
          },
        }),
        inspectPreflight: () => {
          throw new Error("project unavailable");
        },
        readConfig: () => ({
          schemaVersion: 3,
          grants: [
            { provider: "codex", organizationId: "org-global", activationScope: { kind: "global" } },
            {
              provider: "codex",
              organizationId: "org-directory",
              activationScope: { kind: "directory", root: "/work" },
            },
          ],
        }),
      },
    );
    expect(status.project.state).toBe("unavailable");
    expect(status.persistentGrants).toHaveLength(2);
    expect(status.effectiveCandidates).toEqual([]);
  });

  it("keeps a pathless global grant visible when its live authority is unavailable", async () => {
    const global = {
      provider: "codex" as const,
      organizationId: "org-global",
      activationScope: { kind: "global" as const },
    };
    const status = await inspectContextIntegrationStatus(
      driver,
      {
        validateMemberContextActivation: vi.fn(async () => {
          throw new Error("authority offline");
        }),
      },
      { pathless: true },
      {
        inspectRuntime: () => ({
          provider: "codex",
          healthy: true,
          issues: [],
          release: null,
          install: null,
          probe: {
            provider: "codex",
            binaryAvailable: true,
            version: "0.145.0",
            compatible: true,
            installed: true,
            enabled: true,
            installedPath: "/plugin",
            issues: [],
          },
        }),
        inspectPreflight: () => ({ kind: "pathless", project: { kind: "pathless" }, source: "explicit_pathless" }),
        resolveCandidates: () => [{ grant: global, priority: "global" }],
        readConfig: () => ({ schemaVersion: 3, grants: [global] }),
      },
    );
    expect(status.persistentGrants).toEqual([global]);
    expect(status.effectiveCandidates).toEqual([
      expect.objectContaining({ grant: global, activation: expect.objectContaining({ state: "unavailable" }) }),
    ]);
  });
});
