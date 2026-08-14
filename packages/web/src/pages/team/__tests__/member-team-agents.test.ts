import type { Agent, FeishuBotBinding } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { feishuBotChatUrl, selectReadyTeamAgents, teamAgentResponsibility } from "../member-team-agents.js";

const NOW = "2026-08-14T00:00:00.000Z";

function agent(index: number, overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? `agent-${index}`,
    name: overrides.name ?? `agent-${index}`,
    displayName: overrides.displayName ?? `Agent ${index}`,
    organizationId: overrides.organizationId ?? "org-1",
    type: overrides.type ?? "agent",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? `inbox-${index}`,
    status: overrides.status ?? "active",
    source: overrides.source ?? "portal",
    visibility: overrides.visibility ?? "organization",
    metadata: overrides.metadata ?? {},
    managerId: overrides.managerId ?? "member-admin",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "codex",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    runtimeState: overrides.runtimeState === undefined ? "idle" : overrides.runtimeState,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function binding(index: number, overrides: Partial<FeishuBotBinding> = {}): FeishuBotBinding {
  return {
    id: overrides.id ?? `binding-${index}`,
    agentId: overrides.agentId ?? `agent-${index}`,
    appId: overrides.appId === undefined ? `cli_${index}` : overrides.appId,
    botOpenId: overrides.botOpenId ?? `ou_${index}`,
    botName: overrides.botName ?? `Agent ${index}`,
    botAvatarUrl: overrides.botAvatarUrl ?? null,
    tenantKey: overrides.tenantKey ?? "tenant-1",
    status: overrides.status ?? "active",
    connectionStatus: overrides.connectionStatus ?? "connected",
    grantedScopes: overrides.grantedScopes ?? [],
    registrationUrl: overrides.registrationUrl ?? null,
    registrationExpiresAt: overrides.registrationExpiresAt ?? null,
    lastConnectedAt: overrides.lastConnectedAt ?? NOW,
    lastEventAt: overrides.lastEventAt ?? NOW,
    lastErrorCode: overrides.lastErrorCode ?? null,
    lastErrorMessage: overrides.lastErrorMessage ?? null,
    cli: overrides.cli ?? { state: "ready", version: "1.0.0", clientId: "client-1" },
  };
}

function readyBindings(count: number): Map<string, FeishuBotBinding | null> {
  return new Map(Array.from({ length: count }, (_, index) => [`agent-${index + 1}`, binding(index + 1)]));
}

describe("member Team Agent selection", () => {
  for (const count of [0, 1, 2, 3, 4]) {
    it(`keeps the roster order for the ${count}-ready-Agent state`, () => {
      const agents = Array.from({ length: count }, (_, index) => agent(index + 1));

      expect(selectReadyTeamAgents(agents, readyBindings(count)).map(({ agent: item }) => item.uuid)).toEqual(
        agents.map((item) => item.uuid),
      );
    });
  }

  it("keeps a usable Bot pending reauthorization while filtering every non-ready or ineligible row", () => {
    const agents = [
      agent(1),
      agent(2, { visibility: "private" }),
      agent(3, { status: "suspended" }),
      agent(4, { type: "human" }),
      agent(5, { runtimeState: null }),
      agent(6),
      agent(7),
      agent(8),
      agent(9),
    ];
    const bindings = new Map<string, FeishuBotBinding | null>([
      ["agent-1", binding(1)],
      ["agent-2", binding(2)],
      ["agent-3", binding(3)],
      ["agent-4", binding(4)],
      ["agent-5", binding(5)],
      ["agent-6", binding(6, { status: "provisioning" })],
      ["agent-7", binding(7, { connectionStatus: "disconnected" })],
      ["agent-8", binding(8, { cli: { state: "missing", version: null, clientId: "client-1" } })],
      ["agent-9", binding(9, { appId: null })],
    ]);

    expect(selectReadyTeamAgents(agents, bindings).map(({ agent: item }) => item.uuid)).toEqual([
      "agent-1",
      "agent-6",
    ]);
  });
});

describe("member Team Agent copy and destination", () => {
  it("builds the official Bot AppLink and percent-encodes the exact App ID", () => {
    expect(feishuBotChatUrl("cli_1&next=wrong")).toBe(
      "https://applink.feishu.cn/client/bot/open?appId=cli_1%26next%3Dwrong",
    );
  });

  it("uses a short Team-scoped responsibility without fetching the full resource catalog", () => {
    expect(teamAgentResponsibility("Acme")).toBe("Ready to help Acme in Feishu.");
  });
});
