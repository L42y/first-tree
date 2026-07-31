// @vitest-environment happy-dom

import {
  type AgentChatStatus,
  type AgentChatStatusInput,
  buildAgentChatStatus,
  type ChatParticipantDetail,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { ToastProvider } from "../../ui/toast.js";

const agentStatusApiMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

const sessionApiMocks = vi.hoisted(() => ({
  suspendSession: vi.fn(),
  resumeSession: vi.fn(),
  terminateSession: vi.fn(),
}));

const chatApiMocks = vi.hoisted(() => ({
  getChat: vi.fn(),
}));

const agentApiMocks = vi.hoisted(() => ({
  getAgent: vi.fn(),
}));

vi.mock("../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId] as const,
  fetchChatAgentStatuses: agentStatusApiMocks.fetchChatAgentStatuses,
}));

vi.mock("../../../api/sessions.js", () => ({
  chatSessionEventsQueryKey: (chatId: string) => ["chat-session-events", chatId] as const,
  sessionQueryKey: (agentId: string, chatId: string) => ["session", agentId, chatId] as const,
  suspendSession: sessionApiMocks.suspendSession,
  resumeSession: sessionApiMocks.resumeSession,
  terminateSession: sessionApiMocks.terminateSession,
}));

vi.mock("../../../api/chats.js", () => ({ getChat: chatApiMocks.getChat }));
vi.mock("../../../api/agents.js", () => ({ getAgent: agentApiMocks.getAgent }));
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => ({ agentId: "self-human" }) }));

import { AgentStatusPanel } from "../agent-status-panel.js";

const BASE_STATUS: Omit<AgentChatStatusInput, "agentId"> = {
  reachable: true,
  errored: false,
  working: false,
  engagement: "none",
};

function status(agentId: string, overrides: Partial<AgentChatStatusInput> = {}): AgentChatStatus {
  return buildAgentChatStatus({ ...BASE_STATUS, agentId, ...overrides });
}

const PARTICIPANT: ChatParticipantDetail = {
  agentId: "agent-nova",
  role: "speaker",
  mode: "participant",
  joinedAt: "2026-07-04T12:00:00.000Z",
  displayName: "Nova",
  name: "nova",
  type: "agent",
  avatarColorToken: null,
  avatarImageUrl: null,
};

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }, mutations: { retry: false } },
  });
}

function withProviders(ui: ReactElement, queryClient: QueryClient): ReactElement {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{ui}</ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

async function waitForSettled(h: DomHarness, assertion: () => void): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 50; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await h.flush();
  }
  throw lastErr;
}

async function click(h: DomHarness, element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await h.flush();
}

/** Open the agent's hovercard from the roster row and return the card element. */
async function openCard(h: DomHarness): Promise<HTMLElement> {
  const trigger = h.container.querySelector<HTMLButtonElement>("button");
  await click(h, trigger ?? null);
  let card: HTMLElement | null = null;
  await waitForSettled(h, () => {
    card = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(card).not.toBeNull();
  });
  return card as unknown as HTMLElement;
}

/** The row-owned confirm dialog (Radix portal), distinguished from the card by its title. */
function confirmDialog(): HTMLElement | null {
  return (
    [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((el) =>
      el.textContent?.includes('Reset session for "Nova"?'),
    ) ?? null
  );
}

function dialogButton(dialog: HTMLElement, text: string): HTMLButtonElement | null {
  return [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;
}

async function openConfirmFromCard(h: DomHarness): Promise<HTMLElement> {
  const card = await openCard(h);
  let reset: Element | null = null;
  await waitForSettled(h, () => {
    reset = card.querySelector('button[aria-label="Reset session"]');
    expect(reset).not.toBeNull();
  });
  await click(h, reset);
  await waitForSettled(h, () => expect(confirmDialog()).not.toBeNull());
  return confirmDialog() as HTMLElement;
}

describe("AgentStatusPanel — chat session Reset", () => {
  let h: DomHarness;
  let queryClient: QueryClient;

  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    queryClient = createQueryClient();
    chatApiMocks.getChat.mockResolvedValue({ participants: [PARTICIPANT] });
    agentApiMocks.getAgent.mockResolvedValue({
      uuid: "agent-nova",
      name: "nova",
      displayName: "Nova",
      type: "agent",
      managerId: "m1",
      clientId: "c1",
    });
    sessionApiMocks.suspendSession.mockResolvedValue({
      agentId: "agent-nova",
      chatId: "chat-1",
      state: "suspended",
      transitioned: true,
    });
    sessionApiMocks.terminateSession.mockResolvedValue({
      agentId: "agent-nova",
      chatId: "chat-1",
      state: "evicted",
      transitioned: true,
    });
  });

  afterEach(() => {
    queryClient.clear();
    h.cleanup();
  });

  function renderPanel(overrides: Partial<AgentChatStatusInput>, canManage = true): void {
    agentStatusApiMocks.fetchChatAgentStatuses.mockResolvedValue([status("agent-nova", overrides)]);
    h.render(
      withProviders(
        <AgentStatusPanel chatId="chat-1" agents={[PARTICIPANT]} canManage={() => canManage} compact />,
        queryClient,
      ),
    );
  }

  it("keeps Reset out of the participants row; the card offers exactly one Reset action", async () => {
    renderPanel({ engagement: "active" });
    await waitForSettled(h, () => expect(h.container.textContent).toContain("Nova"));

    // The row itself carries no Reset affordance — only Pause/Resume may appear.
    expect(h.container.textContent).not.toContain("Reset");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    const card = await openCard(h);
    const resetButtons = [...card.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => b.getAttribute("aria-label") === "Reset session",
    );
    expect(resetButtons).toHaveLength(1);
    expect(resetButtons[0]?.textContent).toContain("Reset");
  });

  it("hides Reset for viewers without manage permission", async () => {
    renderPanel({ engagement: "active" }, false);
    const card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();
  });

  it("hides Reset when the agent is offline", async () => {
    renderPanel({ reachable: false, engagement: "active" });
    const card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();
  });

  it("hides Reset when there is no session to clear", async () => {
    renderPanel({ engagement: "none" });
    const card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();
  });

  it("active session: confirm runs suspend → terminate in order, toasts success, invalidates queries", async () => {
    renderPanel({ engagement: "active" });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const dialog = await openConfirmFromCard(h);
    expect(dialog.textContent).toContain("Chat history is kept");
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();
    expect(sessionApiMocks.terminateSession).not.toHaveBeenCalled();

    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () =>
      expect(sessionApiMocks.terminateSession).toHaveBeenCalledWith("agent-nova", "chat-1"),
    );
    expect(sessionApiMocks.suspendSession).toHaveBeenCalledWith("agent-nova", "chat-1");
    expect(sessionApiMocks.suspendSession.mock.invocationCallOrder[0]).toBeLessThan(
      sessionApiMocks.terminateSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await waitForSettled(h, () => expect(document.body.textContent).toContain("Session reset"));
    expect(document.body.textContent).toContain("start fresh");
    // Dialog closed after success.
    expect(confirmDialog()).toBeNull();

    const invalidatedKeys = invalidateSpy.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
    expect(invalidatedKeys).toContain(JSON.stringify(["chat-agent-status", "chat-1"]));
    expect(invalidatedKeys).toContain(JSON.stringify(["session", "agent-nova", "chat-1"]));
    expect(invalidatedKeys).toContain(JSON.stringify(["chat-session-events", "chat-1"]));
    expect(invalidatedKeys).toContain(JSON.stringify(["sessions"]));
    expect(invalidatedKeys).toContain(JSON.stringify(["activity"]));
  });

  it("suspended session: confirm terminates directly without suspending", async () => {
    renderPanel({ engagement: "suspended" });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () =>
      expect(sessionApiMocks.terminateSession).toHaveBeenCalledWith("agent-nova", "chat-1"),
    );
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();
  });

  it("failed session (errored, engagement none): confirm terminates directly", async () => {
    renderPanel({ engagement: "none", errored: true });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () =>
      expect(sessionApiMocks.terminateSession).toHaveBeenCalledWith("agent-nova", "chat-1"),
    );
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();
  });

  it("cancel closes the dialog without any session call", async () => {
    renderPanel({ engagement: "active" });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Cancel"));

    await waitForSettled(h, () => expect(confirmDialog()).toBeNull());
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();
    expect(sessionApiMocks.terminateSession).not.toHaveBeenCalled();
  });

  it("pending: confirm disables while the mutation is in flight", async () => {
    let resolveTerminate: (value: unknown) => void = () => {};
    sessionApiMocks.terminateSession.mockReturnValue(
      new Promise((resolve) => {
        resolveTerminate = resolve;
      }),
    );
    renderPanel({ engagement: "suspended" });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () => {
      const pending = dialogButton(confirmDialog() as HTMLElement, "Resetting…");
      expect(pending).not.toBeNull();
      expect(pending?.disabled).toBe(true);
    });

    await act(async () => {
      resolveTerminate({ agentId: "agent-nova", chatId: "chat-1", state: "evicted", transitioned: true });
    });
    await waitForSettled(h, () => expect(document.body.textContent).toContain("Session reset"));
  });

  it("failure: shows a retryable error toast, keeps the dialog open, no fake success", async () => {
    sessionApiMocks.terminateSession.mockRejectedValue(new Error("client disconnected"));
    renderPanel({ engagement: "suspended" });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () => expect(document.body.textContent).toContain("Reset failed"));
    expect(document.body.textContent).toContain("client disconnected");
    expect(document.body.textContent).not.toContain("Session reset");
    // Dialog stays open so the user can retry.
    expect(confirmDialog()).not.toBeNull();
  });
});
