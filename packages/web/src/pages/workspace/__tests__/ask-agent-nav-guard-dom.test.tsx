// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAskAgentNavLock, clearAskAgentNavLocks } from "../../../components/chat/ask-agent-nav-lock.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    meLoaded: true,
    onboardingStep: "completed" as "connect" | "create_agent" | "completed" | null,
    onboardingDismissedAt: null as string | null,
    onboardingCompletedAt: "2026-05-28T00:00:00.000Z" as string | null,
    currentOrgHasUsableAgent: true,
    currentOrgHasPersonalAgent: true,
  },
}));

const viewportMock = vi.hoisted(() => ({
  value: "xl" as "xl" | "md" | "narrow",
}));

const wsMock = vi.hoisted(() => ({
  useAdminWs: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("../../../hooks/use-admin-ws.js", () => wsMock);

vi.mock("../../../hooks/use-viewport.js", () => ({
  useWorkspaceViewport: () => viewportMock.value,
}));

vi.mock("../conversations/index.js", () => ({
  DRAFT_CHAT_ID: "draft",
  ConversationList: ({
    onSelectChat,
    onNewChat,
    onEngagementChange,
  }: {
    selectedChatId: string | null;
    onSelectChat: (chatId: string) => void;
    onNewChat: () => void;
    onEngagementChange: (view: "active" | "archived" | "all") => void;
  }) => (
    <aside data-testid="conversation-list">
      <button type="button" onClick={() => onSelectChat("chat-picked")}>
        Select chat
      </button>
      <button type="button" onClick={onNewChat}>
        New chat
      </button>
      <button type="button" onClick={() => onEngagementChange("archived")}>
        Archived
      </button>
    </aside>
  ),
}));

vi.mock("../center/index.js", () => ({
  CenterPanel: ({ selectedChatId }: { selectedChatId: string | null }) => (
    <section data-testid="center-panel">center:{selectedChatId ?? "none"}</section>
  ),
}));

vi.mock("../need-you/need-you-page.js", () => ({
  NeedYouPage: () => <section data-testid="need-you-page">Need you review</section>,
}));

vi.mock("../../../components/doc-preview-drawer.js", () => ({
  DocPreviewDrawer: () => <div data-testid="doc-preview">Doc preview</div>,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(initialEntry: string, element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <LocationProbe />
                {element}
              </>
            }
          />
        </Routes>
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

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === text) ?? null;
}

function locationText(container: ParentNode): string {
  return container.querySelector('[data-testid="location"]')?.textContent ?? "";
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  viewportMock.value = "xl";
  authMock.value = {
    meLoaded: true,
    onboardingStep: "completed",
    onboardingDismissedAt: null,
    onboardingCompletedAt: "2026-05-28T00:00:00.000Z",
    currentOrgHasUsableAgent: true,
    currentOrgHasPersonalAgent: true,
  };
  wsMock.useAdminWs.mockReset();
  clearAskAgentNavLocks();
});

afterEach(() => {
  clearAskAgentNavLocks();
  document.body.innerHTML = "";
});

describe("Workspace Ask agent navigation lock", () => {
  it("blocks rail rows, new chat, and chat-dropping filters while an attempt is pending", async () => {
    const { WorkspaceBody } = await import("../index.js");
    const { container, root } = await renderDom("/?review=need-you", <WorkspaceBody />);

    // Sanity: unlocked, a rail row switches chats and clears the review.
    expect(container.querySelector('[data-testid="need-you-page"]')).not.toBeNull();
    await click(buttonByText(container, "Select chat"));
    expect(locationText(container)).toContain("c=chat-picked");
    expect(locationText(container)).not.toContain("review=need-you");
    expect(container.querySelector('[data-testid="need-you-page"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps the review surface mounted for every in-app exit while locked", async () => {
    const { WorkspaceBody } = await import("../index.js");
    const { container, root } = await renderDom("/?review=need-you", <WorkspaceBody />);
    expect(container.querySelector('[data-testid="need-you-page"]')).not.toBeNull();

    // A pending Ask agent attempt engages the shared lock.
    await act(async () => {
      addAskAgentNavLock({ chatId: "chat-1", requestId: "req-1" });
    });
    await flush();

    await click(buttonByText(container, "Select chat"));
    expect(locationText(container)).toBe("/?review=need-you");
    await click(buttonByText(container, "New chat"));
    expect(locationText(container)).toBe("/?review=need-you");
    await click(buttonByText(container, "Archived"));
    expect(locationText(container)).toBe("/?review=need-you");
    expect(container.querySelector('[data-testid="need-you-page"]')).not.toBeNull();

    // The attempt lifts: the same rail row navigates again.
    await act(async () => {
      clearAskAgentNavLocks();
    });
    await flush();
    await click(buttonByText(container, "Select chat"));
    expect(locationText(container)).toContain("c=chat-picked");
    expect(container.querySelector('[data-testid="need-you-page"]')).toBeNull();

    await act(async () => root.unmount());
  });
});
