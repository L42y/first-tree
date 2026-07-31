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
  // The default test client supports the terminate apply-ack; visibility
  // tests override this to cover old clients.
  sessionResetSupported: true,
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
      delivered: true,
    });
    sessionApiMocks.terminateSession.mockResolvedValue({
      agentId: "agent-nova",
      chatId: "chat-1",
      state: "evicted",
      transitioned: true,
      delivered: true,
      applied: true,
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
    renderPanel({ engagement: "suspended" });
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

  it("hides Reset for active sessions — working or idle (pause the agent first)", async () => {
    renderPanel({ engagement: "active", working: true });
    let card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();

    h.cleanup();
    h = createDomHarness();
    queryClient = createQueryClient();
    renderPanel({ engagement: "active" });
    card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();
  });

  it("hides Reset for viewers without manage permission", async () => {
    renderPanel({ engagement: "suspended" }, false);
    const card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();
  });

  it("hides Reset when the agent is offline", async () => {
    renderPanel({ reachable: false, engagement: "suspended" });
    const card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();
  });

  it("hides Reset when the client lacks the apply-ack capability (old client)", async () => {
    renderPanel({ engagement: "suspended", sessionResetSupported: false });
    let card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();

    h.cleanup();
    h = createDomHarness();
    queryClient = createQueryClient();
    renderPanel({ engagement: "suspended", sessionResetSupported: undefined });
    card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();
  });

  it("hides Reset when there is no session to clear", async () => {
    renderPanel({ engagement: "none" });
    const card = await openCard(h);
    expect(card.querySelector('button[aria-label="Reset session"]')).toBeNull();
  });

  it("suspended session: confirm calls only terminate in apply-ack mode, toasts success, invalidates queries", async () => {
    renderPanel({ engagement: "suspended" });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const dialog = await openConfirmFromCard(h);
    expect(dialog.textContent).toContain("clears the agent's stopped session");
    expect(dialog.textContent).toContain("Chat history is kept");
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();
    expect(sessionApiMocks.terminateSession).not.toHaveBeenCalled();

    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () =>
      expect(sessionApiMocks.terminateSession).toHaveBeenCalledWith("agent-nova", "chat-1", { waitForApply: true }),
    );
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();

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

  it("failed session (errored, engagement none): confirm terminates directly in apply-ack mode", async () => {
    renderPanel({ engagement: "none", errored: true });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () =>
      expect(sessionApiMocks.terminateSession).toHaveBeenCalledWith("agent-nova", "chat-1", { waitForApply: true }),
    );
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();
    await waitForSettled(h, () => expect(document.body.textContent).toContain("Session reset"));
  });

  it("cancel closes the dialog without any session call", async () => {
    renderPanel({ engagement: "suspended" });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Cancel"));

    await waitForSettled(h, () => expect(confirmDialog()).toBeNull());
    expect(sessionApiMocks.suspendSession).not.toHaveBeenCalled();
    expect(sessionApiMocks.terminateSession).not.toHaveBeenCalled();
  });

  it("pending: confirm disables while the apply-ack wait is in flight", async () => {
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
      resolveTerminate({
        agentId: "agent-nova",
        chatId: "chat-1",
        state: "evicted",
        transitioned: true,
        delivered: true,
        applied: true,
      });
    });
    await waitForSettled(h, () => expect(document.body.textContent).toContain("Session reset"));
  });

  it("failure (disconnect/timeout/applied:false/conflict): error toast, dialog stays open, no fake success", async () => {
    sessionApiMocks.terminateSession.mockRejectedValue(new Error("client did not confirm the terminate"));
    renderPanel({ engagement: "suspended" });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () => expect(document.body.textContent).toContain("Reset failed"));
    expect(document.body.textContent).toContain("client did not confirm");
    expect(document.body.textContent).not.toContain("Session reset");
    expect(confirmDialog()).not.toBeNull();
  });

  it("a failed reset leaves the stopped session intact, so the entry and retry survive a status refetch", async () => {
    // In apply-ack mode a failure never touches the DB: the row stays
    // suspended, so after the refetch the card action is still there — the
    // recovery entry survives reloads, and the open dialog can retry inline.
    sessionApiMocks.terminateSession.mockRejectedValueOnce(new Error("Timed out waiting for the computer to reply"));
    renderPanel({ engagement: "suspended" });
    const dialog = await openConfirmFromCard(h);
    const statusCallsBefore = agentStatusApiMocks.fetchChatAgentStatuses.mock.calls.length;
    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () => expect(document.body.textContent).toContain("Reset failed"));
    await waitForSettled(h, () => {
      expect(agentStatusApiMocks.fetchChatAgentStatuses.mock.calls.length).toBeGreaterThan(statusCallsBefore);
      expect(h.container.textContent).toContain("Paused");
    });
    expect(confirmDialog()).not.toBeNull();

    // Retry from the still-open dialog: client reconnected, ack lands, success.
    await click(h, dialogButton(confirmDialog() as HTMLElement, "Reset"));
    await waitForSettled(h, () => expect(document.body.textContent).toContain("Session reset"));
    expect(sessionApiMocks.terminateSession).toHaveBeenCalledTimes(2);
    expect(confirmDialog()).toBeNull();

    // And the card action itself remains available for a stopped session.
    const card = await openCard(h);
    await waitForSettled(h, () => {
      expect(card.querySelector('button[aria-label="Reset session"]')).not.toBeNull();
    });
  });

  it("a 200 with a non-evicted state is treated as a failure, never a success", async () => {
    // Defensive: the apply-ack route only 200s for evicted rows, but the UI
    // must not toast success on any other state.
    sessionApiMocks.terminateSession.mockResolvedValue({
      agentId: "agent-nova",
      chatId: "chat-1",
      state: "suspended",
      transitioned: false,
      delivered: true,
    });
    renderPanel({ engagement: "suspended" });
    const dialog = await openConfirmFromCard(h);
    await click(h, dialogButton(dialog, "Reset"));

    await waitForSettled(h, () => expect(document.body.textContent).toContain("Reset failed"));
    expect(document.body.textContent).not.toContain("Session reset");
    expect(confirmDialog()).not.toBeNull();
  });
});
