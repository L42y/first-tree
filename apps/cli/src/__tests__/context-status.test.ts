import type { ContextActivationResponse } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildContextEnableNextActions,
  buildSetupNextActions,
  collectMissingSetupLayers,
  renderSetupVerdictLine,
} from "../commands/context/enable.js";
import { renderHookEnabled, renderHookTrust } from "../commands/context/status.js";
import type { ContextActivationValidator } from "../core/context-integration/activation.js";
import {
  ContextClientPreflightError,
  contextClientPreflightErrorCode,
} from "../core/context-integration/client-preflight.js";
import type {
  ContextIntegrationProviderDriver,
  ProviderPluginProbe,
} from "../core/context-integration/provider-driver.js";
import { contextRepairAdditionalContext } from "../core/context-integration/repair-guidance.js";
import { inspectContextIntegrationStatus } from "../core/context-integration/status.js";

function pluginProbe(overrides: Partial<ProviderPluginProbe> = {}): ProviderPluginProbe {
  return {
    provider: "codex",
    binaryAvailable: true,
    version: "0.146.0",
    compatible: true,
    installed: true,
    enabled: true,
    installedPath: "/provider/cache/first-tree-context",
    issues: [],
    ...overrides,
  };
}

function driver(probe = pluginProbe()): ContextIntegrationProviderDriver {
  return {
    provider: "codex",
    executable: "codex",
    minimumVersion: "0.144.0",
    probe: () => probe,
    inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
    validateMarketplace: () => undefined,
    install: () => probe,
    uninstall: () => undefined,
  };
}

function validator(response: ContextActivationResponse): ContextActivationValidator {
  return { validateMemberContextActivation: vi.fn(async () => response) };
}

const connected = {
  schemaVersion: 2 as const,
  outcome: "connected" as const,
  team: { organizationId: "org_acme", displayName: "Acme", role: "admin" as const },
};

const runtime = (runtimeDriver: ContextIntegrationProviderDriver) => ({
  provider: runtimeDriver.provider,
  healthy: true,
  issues: [],
  install: null,
  release: null,
  probe: runtimeDriver.probe("first-tree-dev", "first-tree-context"),
});

describe("Context integration project status", () => {
  it("reports provider, Plugin, Hook, project binding, and live activation independently", async () => {
    const value = await inspectContextIntegrationStatus(
      driver(),
      validator(connected),
      { projectRoot: "/work/repo" },
      {
        inspectRuntime: runtime,
        inspectPreflight: () => ({
          kind: "path",
          project: { kind: "path", root: "/work/repo" },
          source: "explicit_path",
        }),
        findBinding: () => ({
          provider: "codex",
          project: { kind: "path", root: "/work/repo" },
          organizationId: "org_acme",
        }),
      },
    );

    expect(value).toMatchObject({
      provider: { available: true, compatible: true },
      plugin: { installed: true, enabled: true },
      hook: { trust: "trusted", enabled: true },
      project: { state: "ready", project: { kind: "path", root: "/work/repo" } },
      binding: { state: "exact", organizationId: "org_acme" },
      activation: { state: "connected", team: { displayName: "Acme" } },
    });
  });

  it("preserves project resolution failures and does not inspect a binding", async () => {
    const findBinding = vi.fn();
    const value = await inspectContextIntegrationStatus(
      driver(),
      validator(connected),
      {},
      {
        inspectRuntime: runtime,
        inspectPreflight: () => {
          throw new ContextClientPreflightError(
            contextClientPreflightErrorCode.projectUnknown,
            "No provider project is attached.",
            "Pass --pathless or --project-root.",
          );
        },
        findBinding,
      },
    );
    expect(value.project).toMatchObject({ state: "unavailable", reason: "project_unknown" });
    expect(value.binding.state).toBe("not_checked");
    expect(findBinding).not.toHaveBeenCalled();
  });

  it("sends the v2 repo-independent authority contract", async () => {
    const validate = vi.fn(async () => connected);
    await inspectContextIntegrationStatus(
      driver(),
      { validateMemberContextActivation: validate },
      { pathless: true },
      {
        inspectRuntime: runtime,
        inspectPreflight: () => ({
          kind: "pathless",
          project: { kind: "pathless" },
          source: "explicit_pathless",
        }),
        findBinding: () => ({
          provider: "codex",
          project: { kind: "pathless" },
          organizationId: "org_acme",
        }),
      },
    );
    expect(validate).toHaveBeenCalledWith("org_acme", { schemaVersion: 2 }, { retry: false, timeoutMs: 5_000 });
  });
});

describe("Context enable setup verdict", () => {
  const greenVerification = {
    provider: {
      name: "codex" as const,
      available: true,
      version: "1.0.0",
      minimumVersion: "0.5.0",
      compatible: true,
    },
    plugin: { installed: true, enabled: true, installedPath: "/tmp/plugin" },
    hook: { trust: "trusted" as const, enabled: true, source: "provider_api" as const, issues: [] },
    runtime: { healthy: true, issues: [] },
    project: { state: "ready" as const, project: { kind: "path" as const, root: "/work/project" } },
    binding: { state: "exact" as const, organizationId: "org-1" },
    activation: {
      state: "connected" as const,
      team: { organizationId: "org-1", displayName: "Acme", role: "member" as const },
    },
  };

  it("preserves the literal complete/incomplete verdict contract", () => {
    expect(collectMissingSetupLayers("codex", greenVerification)).toEqual([]);
    expect(renderSetupVerdictLine({ complete: true, missingLayers: [] })).toBe(
      "Setup: Complete — every layer verified",
    );
    expect(renderSetupVerdictLine({ complete: false, missingLayers: ["Plugin enabled: No"] })).toContain(
      "Setup: Incomplete",
    );
  });

  it("requires Codex Hook readiness for path projects but not pathless projects", () => {
    const hookPending = {
      ...greenVerification,
      hook: { trust: "review_required" as const, enabled: false, source: "provider_api" as const, issues: [] },
    };
    expect(collectMissingSetupLayers("codex", hookPending)).toEqual(["Hook trusted: No", "Hook enabled: No"]);
    expect(
      collectMissingSetupLayers("codex", {
        ...hookPending,
        project: { state: "ready", project: { kind: "pathless" } },
      }),
    ).toEqual([]);
    expect(
      buildContextEnableNextActions("codex", hookPending.hook, "first-tree-staging", { kind: "pathless" }),
    ).toEqual([]);
  });

  it("keeps every incomplete setup actionable and channel-specific", () => {
    const verification = {
      ...greenVerification,
      runtime: { healthy: false, issues: ["Plugin payload differs."] },
    };
    const missingLayers = collectMissingSetupLayers("codex", verification);
    const actions = buildSetupNextActions(
      "codex",
      verification,
      { complete: false, missingLayers },
      "first-tree-staging",
    );
    expect(actions.join(" ")).toContain("first-tree-staging context repair --provider codex");
    expect(actions.length).toBeGreaterThan(0);
  });

  it("renders provider Hook states", () => {
    expect(renderHookTrust({ trust: "trusted", enabled: true, source: "provider_api", issues: [] })).toBe("Yes");
    expect(renderHookEnabled({ trust: "trusted", enabled: true, source: "provider_api", issues: [] })).toBe("Yes");
  });

  it("keeps stale-Plugin repair explicit-user-only and channel-specific", () => {
    const guidance = contextRepairAdditionalContext("codex");
    expect(guidance).toContain("Do not repair, upgrade, or synchronize the Plugin automatically.");
    expect(guidance).toContain("Only if the user explicitly asks");
    expect(guidance).toContain("first-tree-dev context repair --provider codex");
    expect(guidance).toContain("first-tree-dev context status --provider codex");
  });
});
