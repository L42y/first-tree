import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accountMocks = vi.hoisted(() => ({ readActiveContextAccountClientId: vi.fn(() => "client-1") }));
const preflightMocks = vi.hoisted(() => ({
  inspectContextClientPreflight: vi.fn(() => ({
    checkoutRoot: "/repo",
    repositoryKey: "github.com/acme/app",
  })),
}));
const bindingMocks = vi.hoisted(() => ({
  findContextBinding: vi.fn(),
  readContextIntegrationConfig: vi.fn(() => ({ schemaVersion: 1, bindings: [] })),
}));
const installerMocks = vi.hoisted(() => ({
  planContextIntegrationInstall: vi.fn(() => ({ operation: "unchanged" })),
}));
const operationMocks = vi.hoisted(() => ({ enableContextIntegrationOperation: vi.fn() }));
const statusMocks = vi.hoisted(() => ({
  inspectContextIntegrationStatus: vi.fn(),
}));
const serviceMocks = vi.hoisted(() => ({
  getClientServiceStatus: vi.fn(() => ({ state: "active" })),
  isServiceSupported: vi.fn(() => true),
}));
const memberMocks = vi.hoisted(() => ({ createMemberSdk: vi.fn() }));
const contextSharedMocks = vi.hoisted(() => ({
  createContextIntegrationDriver: vi.fn(() => ({ provider: "claude-code" })),
  parseContextProvider: vi.fn((provider: string) => provider),
}));
const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string) => {
    throw Object.assign(new Error(message), { code });
  }),
  result: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../core/context-integration/account-state-guard.js", () => accountMocks);
vi.mock("../core/context-integration/client-preflight.js", () => preflightMocks);
vi.mock("../core/context-integration/context-binding-store.js", () => bindingMocks);
vi.mock("../core/context-integration/installer.js", () => installerMocks);
vi.mock("../core/context-integration/operation.js", () => operationMocks);
vi.mock("../core/context-integration/status.js", () => statusMocks);
vi.mock("../core/service-install.js", () => serviceMocks);
vi.mock("../commands/_shared/member.js", () => memberMocks);
vi.mock("../commands/context/shared.js", () => contextSharedMocks);
vi.mock("../core/output.js", () => ({ print: outputMocks }));

describe("context enable onboarding completion", () => {
  const activation = {
    schemaVersion: 1 as const,
    outcome: "connected" as const,
    team: { organizationId: "org-1", displayName: "Acme", role: "member" as const },
  };
  const verification = {
    provider: {
      name: "claude-code" as const,
      available: true,
      version: "2.0.0",
      minimumVersion: "1.0.0",
      compatible: true,
    },
    plugin: { installed: true, enabled: true, installedPath: "/plugin" },
    hook: { trust: "provider_managed" as const, enabled: true, source: "provider_managed" as const, issues: [] },
    runtime: { healthy: true, issues: [] },
    checkout: { state: "ready" as const, root: "/repo", repositoryKey: "github.com/acme/app" },
    binding: {
      state: "exact" as const,
      organizationId: "org-1",
      repositoryKey: "github.com/acme/app",
    },
    activation: { state: "connected" as const, team: activation.team },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    bindingMocks.findContextBinding.mockReturnValue({
      provider: "claude-code",
      checkoutRoot: "/repo",
      repositoryKey: "github.com/acme/app",
      organizationId: "org-1",
    });
    statusMocks.inspectContextIntegrationStatus.mockResolvedValue(verification);
    memberMocks.createMemberSdk.mockReturnValue({
      validateMemberContextActivation: vi.fn().mockResolvedValue(activation),
      completeMemberOnboarding: vi.fn().mockResolvedValue(undefined),
      getOwnedClientStatus: vi.fn().mockResolvedValue({ status: "connected" }),
    });
  });

  async function run(options: { completeOnboarding?: boolean }) {
    const { runContextEnable } = await import("../commands/context/enable.js");
    return runContextEnable({
      command: {
        opts: () => ({
          provider: "claude-code",
          team: "org-1",
          yes: true,
          ...options,
        }),
      } as unknown as Command,
      options: { debug: false, json: true, quiet: false },
    });
  }

  it("stamps completion only after local binding and live Team verification", async () => {
    await run({ completeOnboarding: true });

    const sdk = memberMocks.createMemberSdk.mock.results[0]?.value;
    expect(statusMocks.inspectContextIntegrationStatus).toHaveBeenCalledTimes(1);
    expect(sdk.validateMemberContextActivation).toHaveBeenCalledTimes(1);
    expect(sdk.getOwnedClientStatus).toHaveBeenCalledWith("client-1");
    expect(sdk.completeMemberOnboarding).toHaveBeenCalledWith("org-1");
    expect(outputMocks.result).toHaveBeenCalledWith(expect.objectContaining({ onboardingCompleted: true }));
  });

  it("keeps the ordinary Settings command independent from onboarding", async () => {
    await run({});

    const sdk = memberMocks.createMemberSdk.mock.results[0]?.value;
    expect(statusMocks.inspectContextIntegrationStatus).toHaveBeenCalledTimes(1);
    expect(sdk.validateMemberContextActivation).toHaveBeenCalledTimes(1);
    expect(sdk.getOwnedClientStatus).not.toHaveBeenCalled();
    expect(sdk.completeMemberOnboarding).not.toHaveBeenCalled();
    expect(outputMocks.result).toHaveBeenCalledWith(expect.objectContaining({ onboardingCompleted: false }));
  });

  it.each([
    ["review_required", true],
    ["modified", true],
    ["unknown", null],
    ["trusted", false],
  ] as const)("does not stamp Codex completion while Hook trust/enabled is %s/%s", async (trust, enabled) => {
    statusMocks.inspectContextIntegrationStatus.mockResolvedValue({
      ...verification,
      provider: { ...verification.provider, name: "codex" },
      hook: { trust, enabled, source: "provider_api", issues: [] },
    });
    contextSharedMocks.parseContextProvider.mockReturnValueOnce("codex");

    await expect(run({ completeOnboarding: true })).rejects.toMatchObject({
      code: "CONTEXT_ONBOARDING_VERIFICATION_PENDING",
    });
    const sdk = memberMocks.createMemberSdk.mock.results[0]?.value;
    expect(sdk.completeMemberOnboarding).not.toHaveBeenCalled();
  });

  it("does not stamp completion while the local service or server connection is offline", async () => {
    serviceMocks.getClientServiceStatus.mockReturnValueOnce({ state: "inactive" });
    const sdk = memberMocks.createMemberSdk();
    sdk.getOwnedClientStatus.mockResolvedValueOnce({ status: "disconnected" });
    memberMocks.createMemberSdk.mockReturnValueOnce(sdk);

    await expect(run({ completeOnboarding: true })).rejects.toThrow("background service");
    expect(sdk.completeMemberOnboarding).not.toHaveBeenCalled();
  });
});
