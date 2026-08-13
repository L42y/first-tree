// @vitest-environment happy-dom

import type { Agent, FeishuBotBinding } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const agentApi = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getAgentFeishuBinding: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  value: { organizationId: "org-1", teamDisplayName: "Acme", role: "member" },
}));

vi.mock("../../../api/agents.js", () => agentApi);
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));

const NOW = "2026-08-14T00:00:00.000Z";

function agent(index: number, overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? `agent-${index}`,
    name: overrides.name ?? `agent-${index}`,
    displayName: overrides.displayName ?? `Agent ${index}`,
    organizationId: "org-1",
    type: overrides.type ?? "agent",
    delegateMention: null,
    inboxId: `inbox-${index}`,
    status: overrides.status ?? "active",
    source: "portal",
    visibility: overrides.visibility ?? "organization",
    metadata: {},
    managerId: "member-admin",
    clientId: "client-1",
    runtimeProvider: "codex",
    avatarColorToken: null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    runtimeState: overrides.runtimeState === undefined ? "idle" : overrides.runtimeState,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function binding(index: number, overrides: Partial<FeishuBotBinding> = {}): FeishuBotBinding {
  return {
    id: `binding-${index}`,
    agentId: `agent-${index}`,
    appId: overrides.appId === undefined ? `cli_${index}` : overrides.appId,
    botOpenId: `ou_${index}`,
    botName: `Agent ${index}`,
    botAvatarUrl: null,
    tenantKey: "tenant-1",
    status: overrides.status ?? "active",
    connectionStatus: overrides.connectionStatus ?? "connected",
    grantedScopes: [],
    registrationUrl: null,
    registrationExpiresAt: null,
    lastConnectedAt: NOW,
    lastEventAt: NOW,
    lastErrorCode: null,
    lastErrorMessage: null,
    cli: overrides.cli ?? { state: "ready", version: "1.0.0", clientId: "client-1" },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPage(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  const { TeamPage } = await import("../index.js");
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TeamPage />
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { organizationId: "org-1", teamDisplayName: "Acme", role: "member" };
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("Member Team Agents page", () => {
  it("renders only ready cards in roster order with exact Bot AppLinks and the page-level group hint after the grid", async () => {
    const agents = [
      agent(1, { displayName: "Alpha" }),
      agent(2, { displayName: "Beta" }),
      agent(3, { displayName: "Gamma" }),
      agent(4, { displayName: "Delta" }),
      agent(5, { displayName: "Private", visibility: "private" }),
      agent(6, { displayName: "Offline", runtimeState: null }),
      agent(7, { displayName: "Bot not ready" }),
    ];
    agentApi.listAgents.mockResolvedValue({ items: agents, nextCursor: null });
    agentApi.getAgentFeishuBinding.mockImplementation(async (uuid: string) => {
      const index = Number(uuid.split("-")[1]);
      return { binding: binding(index, index === 7 ? { connectionStatus: "disconnected" } : {}) };
    });

    const { container, root } = await renderPage();
    const grid = container.querySelector<HTMLElement>(".member-team-agent-grid");
    const cards = [...container.querySelectorAll<HTMLElement>(".member-team-agent-card")];
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="https://applink.feishu.cn/"]')];
    const hint = container.querySelector<HTMLElement>(".member-team-agents-group-hint");

    expect(grid?.dataset.teamAgentCount).toBe("4");
    expect(cards.map((card) => card.querySelector("[class*='CardTitle']")?.textContent ?? card.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Alpha"), expect.stringContaining("Beta")]),
    );
    expect(cards.map((card) => card.textContent?.match(/Alpha|Beta|Gamma|Delta/)?.[0])).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://applink.feishu.cn/client/bot/open?appId=cli_1",
      "https://applink.feishu.cn/client/bot/open?appId=cli_2",
      "https://applink.feishu.cn/client/bot/open?appId=cli_3",
      "https://applink.feishu.cn/client/bot/open?appId=cli_4",
    ]);
    expect(links.every((link) => link.textContent?.includes("Message in Feishu"))).toBe(true);
    expect(links.every((link) => link.target === "_blank" && link.rel === "noreferrer")).toBe(true);
    expect(grid && hint ? Boolean(grid.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING) : false).toBe(
      true,
    );
    expect(hint?.textContent).toContain("search for the agent by name");
    expect(hint?.textContent).toContain("@mention");
    expect(container.textContent).not.toContain("First Tree");
    expect(agentApi.listAgents).toHaveBeenCalledWith({
      limit: 100,
      type: "agent",
      addressableOnly: true,
      cursor: undefined,
    });
    expect(agentApi.getAgentFeishuBinding).not.toHaveBeenCalledWith("agent-5");
    expect(agentApi.getAgentFeishuBinding).not.toHaveBeenCalledWith("agent-6");

    await act(async () => root.unmount());
  });

  it("shows the same-page Team empty state without personal Agent, Computer, or Runtime setup", async () => {
    agentApi.listAgents.mockResolvedValue({ items: [agent(1)], nextCursor: null });
    agentApi.getAgentFeishuBinding.mockResolvedValue({
      binding: binding(1, { cli: { state: "missing", version: null, clientId: "client-1" } }),
    });

    const { container, root } = await renderPage();

    expect(container.textContent).toContain("You’re in Acme");
    expect(container.textContent).toContain("Check with your team admins");
    expect(container.textContent).not.toContain("personal agent");
    expect(container.textContent).not.toContain("Computer");
    expect(container.textContent).not.toContain("Runtime");
    expect(container.querySelector(".member-team-agent-grid")).toBeNull();

    await act(async () => root.unmount());
  });

  it("reads each eligible binding once without starting a directory polling fan-out", async () => {
    agentApi.listAgents.mockResolvedValue({ items: [agent(1, { displayName: "Atlas" })], nextCursor: null });
    agentApi.getAgentFeishuBinding.mockResolvedValue({ binding: binding(1) });

    const { container, root } = await renderPage();
    expect(container.textContent).toContain("Atlas");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10_100));
    });
    await flush();

    expect(agentApi.listAgents).toHaveBeenCalledTimes(1);
    expect(agentApi.getAgentFeishuBinding).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  }, 15_000);
});
