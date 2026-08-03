import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const output = vi.hoisted(() => ({
  result: vi.fn(),
  fail: vi.fn((code: string, message: string) => {
    throw Object.assign(new Error(message), { code });
  }),
  line: vi.fn(),
  status: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  buildActivationContext: vi.fn(() => "verified activation context"),
  buildHandoff: vi.fn(),
  createDriver: vi.fn(() => ({ provider: "codex" })),
  enableOperation: vi.fn(),
  findBinding: vi.fn(() => null),
  inspectPreflight: vi.fn(() => ({ provider: "codex", project: { kind: "path", root: "/work/repo" } })),
  inspectStatus: vi.fn(),
  planInstall: vi.fn(() => ({ operation: "install" })),
  readAccountClientId: vi.fn(() => "client-1"),
  readConfig: vi.fn(() => ({ schemaVersion: 2, bindings: [] })),
  validateActivation: vi.fn(),
}));

vi.mock("../core/output.js", () => ({ print: output }));
vi.mock("../core/context-integration/account-state-guard.js", () => ({
  readActiveContextAccountClientId: mocks.readAccountClientId,
}));
vi.mock("../core/context-integration/activation.js", () => ({
  buildConnectedContextAdditionalContext: mocks.buildActivationContext,
}));
vi.mock("../core/context-integration/client-preflight.js", () => ({
  inspectContextClientPreflight: mocks.inspectPreflight,
}));
vi.mock("../core/context-integration/context-binding-store.js", () => ({
  findContextBinding: mocks.findBinding,
  readContextIntegrationConfig: mocks.readConfig,
}));
vi.mock("../core/context-integration/current-session-handoff.js", () => ({
  buildCurrentSessionHandoff: mocks.buildHandoff,
}));
vi.mock("../core/context-integration/installer.js", () => ({
  planContextIntegrationInstall: mocks.planInstall,
}));
vi.mock("../core/context-integration/operation.js", () => ({
  enableContextIntegrationOperation: mocks.enableOperation,
}));
vi.mock("../core/context-integration/status.js", () => ({
  inspectContextIntegrationStatus: mocks.inspectStatus,
}));
vi.mock("../commands/_shared/member.js", () => ({
  createMemberSdk: () => ({ validateMemberContextActivation: mocks.validateActivation }),
}));
vi.mock("../commands/context/shared.js", () => ({
  createContextIntegrationDriver: mocks.createDriver,
  parseContextProvider: (value: string) => value,
}));

import { runContextEnable } from "../commands/context/enable.js";

const requestedTeam = {
  organizationId: "org-requested",
  displayName: "Requested Team",
  role: "member" as const,
};
const replacementTeam = {
  organizationId: "org-replacement",
  displayName: "Replacement Team",
  role: "member" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateActivation.mockResolvedValue({ schemaVersion: 2, outcome: "connected", team: requestedTeam });
});

describe("context enable final handoff identity gate", () => {
  it("fails closed when a concurrent rebind or ancestor fallback resolves another Team", async () => {
    mocks.inspectStatus.mockResolvedValue(greenStatus({ team: replacementTeam, organizationId: "org-replacement" }));

    await runContextEnable(context());

    const result = jsonResult();
    expect(result.setup.complete).toBe(false);
    expect(result.setup.missingLayers).toEqual([
      "Requested Team binding: changed during verification",
      "Requested Team activation: changed during verification",
    ]);
    expect(result.currentSessionHandoff).toBeNull();
    expect(result.activationContext).toBeNull();
    expect(result.team).toEqual(replacementTeam);
    expect(result.requestedTeam).toEqual(requestedTeam);
    expect(result.nextActions.join(" ")).toContain("no longer matches this server-authored project/Team handoff");
    expect(mocks.buildHandoff).not.toHaveBeenCalled();
  });

  it("fails closed when final verification resolves a different project", async () => {
    mocks.inspectStatus.mockResolvedValue(
      greenStatus({ team: requestedTeam, organizationId: "org-requested", projectRoot: "/work/other" }),
    );

    await runContextEnable(context());

    const result = jsonResult();
    expect(result.setup.complete).toBe(false);
    expect(result.setup.missingLayers).toEqual(["Requested project: changed during verification"]);
    expect(result.currentSessionHandoff).toBeNull();
    expect(result.activationContext).toBeNull();
    expect(mocks.buildHandoff).not.toHaveBeenCalled();
  });

  it("renders the complete usable handoff in human mode", async () => {
    const handoff = {
      schemaVersion: 1,
      provider: "codex",
      project: { kind: "path", root: "/work/repo" },
      activationContext: "verified activation context",
      skills: [
        { name: "first-tree", description: "Activate", skillPath: "/plugin/skills/first-tree/SKILL.md" },
        { name: "first-tree-read", description: "Read", skillPath: "/plugin/skills/first-tree-read/SKILL.md" },
        { name: "first-tree-write", description: "Write", skillPath: "/plugin/skills/first-tree-write/SKILL.md" },
      ],
    };
    mocks.inspectStatus.mockResolvedValue(greenStatus({ team: requestedTeam, organizationId: "org-requested" }));
    mocks.buildHandoff.mockReturnValue(handoff);

    await runContextEnable(context(false));

    const rendered = output.line.mock.calls.flat().join("\n");
    expect(rendered).toContain("complete verified current-session handoff JSON");
    expect(rendered).toContain('"provider": "codex"');
    expect(rendered).toContain('"root": "/work/repo"');
    expect(rendered).toContain('"skillPath": "/plugin/skills/first-tree-read/SKILL.md"');
    expect(rendered).toContain("verified activation context");
  });
});

function context(json = true): CommandContext {
  return {
    command: {
      opts: () => ({ provider: "codex", team: "org-requested", projectRoot: "/work/repo", yes: true }),
    } as unknown as Command,
    options: { json, debug: false, quiet: false },
  };
}

function greenStatus(input: { team: typeof requestedTeam; organizationId: string; projectRoot?: string }) {
  return {
    provider: {
      name: "codex",
      available: true,
      version: "0.146.0",
      minimumVersion: "0.144.0",
      compatible: true,
    },
    plugin: { installed: true, enabled: true, installedPath: "/provider/cache/first-tree-context" },
    hook: { trust: "trusted", enabled: true, source: "provider_api", issues: [] },
    runtime: { healthy: true, issues: [] },
    project: { state: "ready", project: { kind: "path", root: input.projectRoot ?? "/work/repo" } },
    binding: { state: "exact", organizationId: input.organizationId },
    activation: { state: "connected", team: input.team },
  };
}

function jsonResult() {
  return output.result.mock.calls[0]?.[0] as {
    setup: { complete: boolean; missingLayers: string[] };
    currentSessionHandoff: unknown;
    activationContext: string | null;
    team: typeof requestedTeam;
    requestedTeam: typeof requestedTeam;
    nextActions: string[];
  };
}
