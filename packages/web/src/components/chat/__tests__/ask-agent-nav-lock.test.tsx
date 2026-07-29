// @vitest-environment happy-dom

import type { Message } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast.js";
import {
  addAskAgentNavLock,
  clearAskAgentNavLocks,
  isAskAgentNavLocked,
  removeAskAgentNavLock,
  subscribeAskAgentNavLock,
  useAskAgentNavGuard,
} from "../ask-agent-nav-lock.js";
import { useAskAgent } from "../use-ask-agent.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const chatMocks = vi.hoisted(() => ({
  listRequestThread: vi.fn(),
  sendAskAgentQuestion: vi.fn(),
}));

const agentStatusMocks = vi.hoisted(() => ({
  fetchChatAgentStatuses: vi.fn(),
}));

vi.mock("../../../api/chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/chats.js")>()),
  listRequestThread: chatMocks.listRequestThread,
  sendAskAgentQuestion: chatMocks.sendAskAgentQuestion,
}));

vi.mock("../../../api/agent-status.js", () => ({
  chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId] as const,
  fetchChatAgentStatuses: agentStatusMocks.fetchChatAgentStatuses,
}));

function message(overrides: Partial<Message> & Pick<Message, "id" | "senderId">): Message {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    format: overrides.format ?? "markdown",
    content: overrides.content ?? "Can you clarify?",
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt ?? "2026-07-28T10:00:00.000Z",
  };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForCondition(predicate: () => boolean, messageText: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(messageText);
}

async function renderDom(element: ReactElement, route: string): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>);
  });
  await flush();
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  clearAskAgentNavLocks();
});

afterEach(() => {
  clearAskAgentNavLocks();
  document.body.innerHTML = "";
});

describe("ask-agent nav lock store", () => {
  it("tracks locks, notifies subscribers, and dedupes repeat writes", () => {
    const notifications: boolean[] = [];
    const off = subscribeAskAgentNavLock(() => {
      notifications.push(isAskAgentNavLocked());
    });

    const lock = { chatId: "chat-1", requestId: "req-1" };
    expect(isAskAgentNavLocked()).toBe(false);
    addAskAgentNavLock(lock);
    expect(isAskAgentNavLocked()).toBe(true);
    // Duplicate add / unknown remove are no-ops (no extra notifications).
    addAskAgentNavLock(lock);
    removeAskAgentNavLock({ chatId: "chat-1", requestId: "req-other" });
    expect(isAskAgentNavLocked()).toBe(true);
    removeAskAgentNavLock(lock);
    expect(isAskAgentNavLocked()).toBe(false);

    off();
    expect(notifications).toEqual([true, false]);

    addAskAgentNavLock(lock);
    clearAskAgentNavLocks();
    expect(isAskAgentNavLocked()).toBe(false);
  });
});

function GuardProbe() {
  const locked = useAskAgentNavGuard();
  const location = useLocation();
  return (
    <div>
      <div data-testid="guard-location">{`${location.pathname}${location.search}`}</div>
      <div data-testid="guard-locked">{String(locked)}</div>
    </div>
  );
}

describe("useAskAgentNavGuard", () => {
  it("reverts a popstate exit to the locked surface and resumes after unlock", async () => {
    let navigateAway: ReturnType<typeof useNavigate> | null = null;
    function CaptureNavigate() {
      navigateAway = useNavigate();
      return null;
    }
    const { container, root } = await renderDom(
      <>
        <GuardProbe />
        <CaptureNavigate />
      </>,
      "/?review=need-you",
    );
    const locationText = () => container.querySelector('[data-testid="guard-location"]')?.textContent;
    expect(locationText()).toBe("/?review=need-you");
    expect(container.querySelector('[data-testid="guard-locked"]')?.textContent).toBe("false");

    // The attempt starts on this surface: the guard captures the URL.
    await act(async () => {
      addAskAgentNavLock({ chatId: "chat-1", requestId: "req-1" });
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-locked"]')?.textContent).toBe("true");

    // Simulate a browser back: the location moves first (as the router
    // processes the pop), then the popstate listener reverts it while the
    // lock is still held.
    await act(async () => {
      navigateAway?.("/?c=other");
    });
    await flush();
    expect(locationText()).toBe("/?c=other");
    await act(async () => {
      window.dispatchEvent(new Event("popstate"));
    });
    await flush();
    expect(locationText()).toBe("/?review=need-you");

    // After the attempt lifts, the same pop navigation is not reverted.
    await act(async () => {
      removeAskAgentNavLock({ chatId: "chat-1", requestId: "req-1" });
    });
    await flush();
    await act(async () => {
      navigateAway?.("/?c=other");
    });
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event("popstate"));
    });
    await flush();
    expect(locationText()).toBe("/?c=other");

    await act(async () => root.unmount());
  });
});

function AskAgentProbe() {
  const controller = useAskAgent({
    chatId: "chat-1",
    requestId: "req-1",
    humanAgentId: "human-1",
    askerAgentId: "agent-1",
  });
  return <div data-testid="ask-waiting">{String(controller.waiting)}</div>;
}

describe("useAskAgent navigation lock publishing", () => {
  it("locks while a clarification awaits a reply and unlocks when the reply lands", async () => {
    const clarification = message({
      id: "clarification-1",
      senderId: "human-1",
      inReplyTo: "req-1",
      metadata: { askAgent: { requestId: "req-1", agentId: "agent-1" } },
      createdAt: "2026-07-28T10:01:00.000Z",
    });
    const reply = message({
      id: "reply-1",
      senderId: "agent-1",
      inReplyTo: clarification.id,
      content: "The migration keeps the old API compatible.",
      createdAt: "2026-07-28T10:02:00.000Z",
    });
    chatMocks.listRequestThread.mockResolvedValue({ items: [clarification] });
    agentStatusMocks.fetchChatAgentStatuses.mockResolvedValue([]);

    const queryClient = createClient();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <AskAgentProbe />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flush();

    // Waiting for the durable reply: the shared lock is held.
    await waitForCondition(
      () => container.querySelector('[data-testid="ask-waiting"]')?.textContent === "true",
      "waiting state",
    );
    expect(isAskAgentNavLocked()).toBe(true);

    // The reply lands: waiting ends and the lock lifts.
    await act(async () => {
      queryClient.setQueryData(["request-thread", "chat-1", "req-1"], { items: [clarification, reply] });
    });
    await flush();
    await waitForCondition(
      () => container.querySelector('[data-testid="ask-waiting"]')?.textContent === "false",
      "reply applied",
    );
    expect(isAskAgentNavLocked()).toBe(false);

    await act(async () => root.unmount());
    expect(isAskAgentNavLocked()).toBe(false);
  });
});
