// @vitest-environment happy-dom

import type { MeChatRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAskAgentNavLock, clearAskAgentNavLocks } from "../chat/ask-agent-nav-lock.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: { organizationId: "org-1" as string | null, agentId: "human-1" as string | null },
}));

const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
}));

const orgAgentsMock = vi.hoisted(() => ({
  value: { items: [] as unknown[], nextCursor: null },
  isLoading: false,
}));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => "xl",
}));

vi.mock("../../hooks/use-version-check.js", () => ({
  useNewVersionAvailable: () => false,
}));

vi.mock("../../api/me-chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/me-chats.js")>()),
  listMeChats: meChatMocks.listMeChats,
}));

vi.mock("../../lib/use-org-agents.js", () => ({
  useOrgAgents: () => ({ data: orgAgentsMock.value, isLoading: orgAgentsMock.isLoading }),
}));

// Unrelated top-bar chrome is stubbed so the test exercises the REAL Layout —
// its nav tabs, Jump-to trigger, and CommandPalette — without dragging every
// status chip's own data dependencies along. Layout itself is never mocked.
vi.mock("../disconnect-chip.js", () => ({ DisconnectChip: () => null }));
vi.mock("../new-version-chip.js", () => ({ NewVersionChip: () => null }));
vi.mock("../support-menu.js", () => ({ SupportMenu: () => null }));
vi.mock("../team-switch-overlay.js", () => ({ TeamSwitchOverlay: () => null }));
vi.mock("../team-switcher.js", () => ({ TeamSwitcher: () => null }));
vi.mock("../user-menu.js", () => ({ UserMenu: () => null }));
vi.mock("../ui/theme-toggle.js", () => ({ ThemeToggle: () => null }));

const NOW = "2026-05-28T12:00:00.000Z";

function chatRow(): MeChatRow {
  const participants = [
    {
      agentId: "agent-1",
      name: "nova",
      displayName: "Nova",
      type: "agent" as const,
      avatarColorToken: null,
      avatarImageUrl: null,
    },
  ];
  return {
    chatId: "chat-1",
    type: "group",
    membershipKind: "participant",
    createdByMe: false,
    source: "manual",
    entityType: null,
    title: "Launch planning",
    topic: "Release train",
    description: null,
    participants,
    participantCount: participants.length,
    lastMessageAt: NOW,
    lastMessagePreview: "Ship it.",
    unreadMentionCount: 0,
    openRequestCount: 0,
    canReply: true,
    engagementStatus: "active",
    liveActivity: null,
    failedAgentIds: [],
    busyAgentIds: [],
    chatHasExplicitMentionToMe: false,
    pinnedAt: null,
    activityAt: null,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
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

async function renderLayout(initialEntry: string): Promise<{ container: HTMLElement; root: Root }> {
  const { Layout } = await import("../layout.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <QueryClientProvider client={createClient()}>
          <LocationProbe />
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<div data-testid="workspace-surface">workspace surface</div>} />
              <Route path="/context" element={<div>context surface</div>} />
              <Route path="/team" element={<div>team surface</div>} />
              <Route path="/settings" element={<div>settings surface</div>} />
            </Route>
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForText(text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

function locationText(container: ParentNode): string {
  return container.querySelector('[data-testid="location"]')?.textContent ?? "";
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll("button")].find((button) => button.textContent === text) ?? null;
}

function linkByText(scope: ParentNode, text: string): HTMLAnchorElement | null {
  return [...scope.querySelectorAll("a")].find((anchor) => anchor.textContent === text) ?? null;
}

function commandItemByText(text: string): HTMLElement | null {
  return (
    [...document.body.querySelectorAll<HTMLElement>("[cmdk-item]")].find((item) => item.textContent?.includes(text)) ??
    null
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  clearAskAgentNavLocks();
  authMock.value = { organizationId: "org-1", agentId: "human-1" };
  meChatMocks.listMeChats.mockResolvedValue({ rows: [chatRow()], nextCursor: null });
});

afterEach(() => {
  clearAskAgentNavLocks();
  document.body.innerHTML = "";
});

describe("Layout Ask agent navigation lock", () => {
  it("locks top tabs and the Jump-to palette while an attempt is pending, then restores them", async () => {
    const { container, root } = await renderLayout("/?review=need-you");
    expect(container.querySelector('[data-testid="workspace-surface"]')).not.toBeNull();
    // The external brand link is a read-only new-tab exit and must stay a
    // real anchor regardless of the lock.
    const brandLink = container.querySelector('a[target="_blank"]');
    expect(brandLink).not.toBeNull();

    await act(async () => {
      addAskAgentNavLock({ chatId: "chat-1", requestId: "req-1" });
    });
    await flush();

    // Every top tab is now an inert disabled button — no navigable anchors.
    expect(container.querySelector('a[href="/team"]')).toBeNull();
    expect(container.querySelector('a[href="/context"]')).toBeNull();
    const lockedTabs = [...container.querySelectorAll("button")].filter((button) =>
      button.getAttribute("aria-label")?.includes("unavailable while waiting for the agent reply"),
    );
    expect(lockedTabs).toHaveLength(4);
    for (const tab of lockedTabs) expect(tab.disabled).toBe(true);
    // The brand link is NOT one of them.
    expect(container.querySelector('a[target="_blank"]')).not.toBeNull();

    await click(buttonByText(container, "Team"));
    expect(locationText(container)).toBe("/?review=need-you");
    expect(container.querySelector('[data-testid="workspace-surface"]')).not.toBeNull();

    // The palette cannot be opened via the Jump button or ⌘K while locked.
    await click(container.querySelector('button[aria-label^="Jump to"]'));
    expect(document.body.textContent).not.toContain("Jump to chat or teammate…");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
    expect(document.body.textContent).not.toContain("Jump to chat or teammate…");

    // Unlock: tabs navigate again (back to real anchors) and the palette opens.
    await act(async () => {
      clearAskAgentNavLocks();
    });
    await flush();
    expect(container.querySelector('a[href="/team"]')).not.toBeNull();
    await click(linkByText(container, "Team"));
    expect(locationText(container)).toBe("/team");

    await click(container.querySelector('button[aria-label^="Jump to"]'));
    await waitForText("Launch planning");
    await click(commandItemByText("Launch planning"));
    expect(locationText(container)).toBe("/?c=chat-1");

    await act(async () => root.unmount());
  });

  it("dismisses an already-open palette jump without navigating when the attempt is pending", async () => {
    const { container, root } = await renderLayout("/?review=need-you");

    // Palette opens BEFORE the attempt starts…
    await click(container.querySelector('button[aria-label^="Jump to"]'));
    await waitForText("Launch planning");

    // …then the Ask agent attempt engages the lock.
    await act(async () => {
      addAskAgentNavLock({ chatId: "chat-1", requestId: "req-1" });
    });
    await flush();

    // The destination is dismissed without leaving the review surface.
    await click(commandItemByText("Launch planning"));
    expect(locationText(container)).toBe("/?review=need-you");
    expect(document.body.textContent).not.toContain("Jump to chat or teammate…");
    expect(container.querySelector('[data-testid="workspace-surface"]')).not.toBeNull();

    await act(async () => root.unmount());
  });
});
