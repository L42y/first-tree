// @vitest-environment happy-dom

import type { FeishuBotBinding } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDetailContext } from "../layout-context.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  getAgentFeishuBinding: vi.fn(),
  startAgentFeishuRegistration: vi.fn(),
  revokeAgentFeishuBinding: vi.fn(),
  createAgentFeishuSetupChat: vi.fn(),
}));

const contextMock = vi.hoisted(() => ({
  value: null as AgentDetailContext | null,
}));

vi.mock("../../../api/agents.js", () => apiMocks);
vi.mock("../layout-context.js", () => ({
  useAgentDetailContext: () => {
    if (!contextMock.value) throw new Error("missing test context");
    return contextMock.value;
  },
}));

const roots: Root[] = [];

function context(overrides: Partial<AgentDetailContext> = {}): AgentDetailContext {
  return {
    uuid: "agent-a",
    agent: {
      uuid: "agent-a",
      displayName: "Agent A",
      type: "agent",
      visibility: "organization",
    } as AgentDetailContext["agent"],
    isHuman: false,
    canManageAgent: true,
    navigateAway: vi.fn(),
    ...overrides,
  } as AgentDetailContext;
}

function binding(overrides: Partial<FeishuBotBinding> = {}): FeishuBotBinding {
  return {
    id: "binding-a",
    agentId: "agent-a",
    appId: "cli_app",
    botOpenId: "ou_bot",
    botName: null,
    botAvatarUrl: null,
    tenantKey: "tenant-a",
    status: "active",
    connectionStatus: "connected",
    grantedScopes: ["im:message"],
    registrationUrl: null,
    registrationExpiresAt: null,
    lastConnectedAt: "2026-08-12T00:00:00.000Z",
    lastEventAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    cli: { state: "missing", version: null, clientId: "client-a" },
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderSection(props: { onOpenProfile?: () => void } = {}): Promise<HTMLElement> {
  const { FeishuSection } = await import("../feishu-section.js");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <FeishuSection {...props} />
      </QueryClientProvider>,
    ),
  );
  await flush();
  return container;
}

async function click(button: Element | null): Promise<void> {
  if (!button) throw new Error("expected button");
  await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.value = context();
  apiMocks.getAgentFeishuBinding.mockResolvedValue({ binding: null });
  apiMocks.startAgentFeishuRegistration.mockResolvedValue({
    binding: binding({ status: "provisioning", connectionStatus: "disconnected" }),
  });
  apiMocks.revokeAgentFeishuBinding.mockResolvedValue(undefined);
  apiMocks.createAgentFeishuSetupChat.mockResolvedValue({ chatId: "setup-chat" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Feishu Agent Detail section", () => {
  it("starts the QR registration from the Agent Detail surface", async () => {
    const container = await renderSection();
    expect(container.textContent).toContain("Not connected");
    expect(container.textContent).toContain("Teammates can't reach this Agent in Feishu yet");
    await click(buttonByText(container, "Connect Bot"));
    expect(apiMocks.startAgentFeishuRegistration).toHaveBeenCalledWith("agent-a", "Agent A · First Tree");
  });

  it("explains the visibility requirement before a private Agent can connect", async () => {
    const onOpenProfile = vi.fn();
    const privateContext = context();
    contextMock.value = context({
      agent: {
        ...privateContext.agent,
        visibility: "private",
      } as AgentDetailContext["agent"],
    });
    const container = await renderSection({ onOpenProfile });

    expect(container.textContent).toContain("Organization visibility is required");
    expect(container.textContent).not.toContain("One Bot and Feishu chat map");
    expect(buttonByText(container, "Connect Bot")?.disabled).toBe(true);
    await click(buttonByText(container, "Manage in Profile"));
    expect(onOpenProfile).toHaveBeenCalledOnce();
    expect(apiMocks.startAgentFeishuRegistration).not.toHaveBeenCalled();
  });

  it("shows the Feishu Bot identity with App ID as supporting detail", async () => {
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({
      binding: binding({
        botName: "Agent A · First Tree",
        botAvatarUrl: "https://example.com/bot.png",
      }),
    });
    const container = await renderSection();

    expect(container.textContent).toContain("Agent A · First Tree");
    expect(container.textContent).toContain("App ID: cli_app");
    expect(container.querySelector('img[src="https://example.com/bot.png"]')).not.toBeNull();
  });

  it("only reports Ready when both the Bot is reachable and the CLI is ready", async () => {
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({
      binding: binding({ cli: { state: "ready", version: "1.2.3", clientId: "client-a" }, grantedScopes: [] }),
    });
    const ready = await renderSection();
    expect(ready.querySelector('[data-channel-state="ready"]')).not.toBeNull();
    expect(ready.textContent).toContain("Ready for Feishu tasks");

    await act(async () => roots.pop()?.unmount());
    document.body.innerHTML = "";
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({
      binding: binding({ cli: { state: "missing", version: null, clientId: "client-a" } }),
    });
    const incomplete = await renderSection();
    expect(incomplete.querySelector('[data-channel-state="setup-incomplete"]')).not.toBeNull();
    expect(incomplete.textContent).toContain("The Bot is reachable. Finish the Agent setup");
  });

  it("separates an offline Computer from Bot reachability and marks the aggregate channel for attention", async () => {
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({
      binding: binding({ cli: { state: "offline", version: null, clientId: null } }),
    });
    const container = await renderSection();
    expect(container.querySelector('[data-channel-state="needs-attention"]')).not.toBeNull();
    expect(container.textContent).toContain("The Bot may still receive messages");
    expect(container.textContent).toContain("Computer offline");
  });

  it("blocks Retry and explains visibility for a private Agent with an errored binding", async () => {
    const onOpenProfile = vi.fn();
    const privateContext = context();
    contextMock.value = context({
      agent: { ...privateContext.agent, visibility: "private" } as AgentDetailContext["agent"],
    });
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({
      binding: binding({ status: "error", connectionStatus: "error", lastErrorMessage: "Registration failed" }),
    });
    const container = await renderSection({ onOpenProfile });

    expect(container.textContent).toContain("Organization visibility is required");
    expect(buttonByText(container, "Retry")?.disabled).toBe(true);
    await click(buttonByText(container, "Manage in Profile"));
    expect(onOpenProfile).toHaveBeenCalledOnce();
    expect(apiMocks.startAgentFeishuRegistration).not.toHaveBeenCalled();
  });

  it("renders registration QR state and sends missing-CLI setup to a visible chat", async () => {
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({
      binding: binding({
        status: "provisioning",
        connectionStatus: "disconnected",
        registrationUrl: "https://open.feishu.cn/register?code=test",
      }),
    });
    const qr = await renderSection();
    expect(qr.querySelector("svg")).not.toBeNull();
    expect(qr.querySelector("svg title")?.textContent).toBe("Feishu Bot registration QR code");
    expect(qr.querySelector('a[href="https://open.feishu.cn/register?code=test"]')).not.toBeNull();

    await act(async () => roots.pop()?.unmount());
    document.body.innerHTML = "";
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({ binding: binding() });
    const navigateAway = vi.fn();
    contextMock.value = context({ navigateAway });
    const active = await renderSection();
    expect(active.textContent).toContain("Not detected");
    await click(buttonByText(active, "Ask Agent to install"));
    expect(apiMocks.createAgentFeishuSetupChat).toHaveBeenCalledWith("agent-a", { retry: true });
    expect(navigateAway).toHaveBeenCalledWith("/?c=setup-chat");
  });

  it("revokes only after an explicit confirmation", async () => {
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({ binding: binding() });
    const container = await renderSection();
    await click(buttonByText(container, "Disconnect"));
    expect(window.confirm).toHaveBeenCalled();
    expect(apiMocks.revokeAgentFeishuBinding).toHaveBeenCalledWith("agent-a");
  });

  it("never renders registration material for a visible non-manager", async () => {
    contextMock.value = context({ canManageAgent: false });
    apiMocks.getAgentFeishuBinding.mockResolvedValueOnce({
      binding: binding({
        status: "provisioning",
        connectionStatus: "disconnected",
        registrationUrl: "https://open.feishu.cn/register?code=must-not-render",
      }),
    });
    const container = await renderSection();
    expect(container.querySelector("svg title")?.textContent).not.toBe("Feishu Bot registration QR code");
    expect(container.querySelector('a[href*="must-not-render"]')).toBeNull();
    expect(buttonByText(container, "Disconnect")).toBeNull();
    expect(buttonByText(container, "Retry")).toBeNull();
  });

  it("lets the viewer retry a failed binding read without claiming the channel is disconnected", async () => {
    apiMocks.getAgentFeishuBinding
      .mockRejectedValueOnce(new Error("status unavailable"))
      .mockResolvedValueOnce({ binding: null });
    const container = await renderSection();
    expect(container.textContent).toContain("Couldn't check this channel");
    expect(container.querySelector('[data-channel-state="not-connected"]')).toBeNull();

    await click(buttonByText(container, "Retry"));
    expect(apiMocks.getAgentFeishuBinding).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-channel-state="not-connected"]')).not.toBeNull();
  });
});
