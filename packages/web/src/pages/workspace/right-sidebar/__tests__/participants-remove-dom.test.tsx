// @vitest-environment happy-dom

import { type ChatParticipantDetail, REMOVE_PARTICIPANT_OPEN_REQUEST_CODE } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../api/client.js";
import { ParticipantsSection } from "../participants-section.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const meChatMocks = vi.hoisted(() => ({
  removeMeChatParticipant: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  role: "member" as string | null,
  agentId: "human-self" as string | null,
}));

const toastMock = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("../../../../api/me-chats.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../api/me-chats.js")>()),
  removeMeChatParticipant: meChatMocks.removeMeChatParticipant,
}));

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => ({ role: authMock.role, agentId: authMock.agentId }),
}));

vi.mock("../../../../components/ui/toast.js", () => ({
  useToast: () => ({ addToast: toastMock.addToast }),
}));

vi.mock("../../../../components/add-participant-dropdown.js", () => ({
  AddParticipantDropdown: () => <div data-testid="add-participant" />,
}));

vi.mock("../../../../components/chat/agent-status-panel.js", () => ({
  AgentStatusPanel: ({
    agents,
    onRequestRemove,
    selfAgentId,
    canRemoveAgent,
  }: {
    agents: ChatParticipantDetail[];
    onRequestRemove?: (agent: ChatParticipantDetail) => void;
    selfAgentId?: string | null;
    canRemoveAgent?: (agent: ChatParticipantDetail) => boolean;
  }) => (
    <div data-testid="agent-status-panel">
      {agents.map((agent) =>
        onRequestRemove && agent.agentId !== selfAgentId && (canRemoveAgent ? canRemoveAgent(agent) : true) ? (
          <button
            key={agent.agentId}
            type="button"
            aria-label={`Actions for ${agent.displayName}`}
            onClick={() => onRequestRemove(agent)}
          >
            Remove from chat
          </button>
        ) : (
          <div key={agent.agentId}>{agent.displayName}</div>
        ),
      )}
    </div>
  ),
}));

function participant(
  id: string,
  type: "human" | "agent",
  displayName = id,
  opts: { role?: string; canRemove?: boolean } = {},
): ChatParticipantDetail {
  return {
    agentId: id,
    role: opts.role ?? "member",
    mode: "default",
    joinedAt: "2026-06-16T00:00:00.000Z",
    name: id,
    displayName,
    type,
    avatarColorToken: null,
    avatarImageUrl: null,
    canRemove: opts.canRemove ?? false,
  };
}

function render(ui: ReactElement): { container: HTMLDivElement; root: Root; qc: QueryClient } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root.render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  });
  return { container, root, qc };
}

async function openRemoveConfirm(container: HTMLElement, label: string): Promise<void> {
  const menu = container.querySelector(`[aria-label="Actions for ${label}"]`) as HTMLButtonElement;
  expect(menu).toBeTruthy();
  await act(async () => {
    menu.click();
  });
  const removeItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) =>
    b.textContent?.includes("Remove from chat"),
  ) as HTMLButtonElement | undefined;
  expect(removeItem).toBeTruthy();
  await act(async () => {
    removeItem?.click();
  });
}

describe("ParticipantsSection remove affordance", () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    meChatMocks.removeMeChatParticipant.mockReset();
    toastMock.addToast.mockReset();
    authMock.role = "member";
    authMock.agentId = "human-self";
  });

  afterEach(() => {
    if (mounted) {
      act(() => mounted?.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
  });

  it("hides Remove for self, owner, read-only, and watcher/non-speaker", () => {
    const roster = [
      participant("human-self", "human", "Me", { role: "owner", canRemove: false }),
      participant("human-other", "human", "Other", { canRemove: true }),
      participant("agent-1", "agent", "Nova", { canRemove: true }),
    ];
    const readOnly = render(
      <ParticipantsSection
        chatId="chat-1"
        participants={roster}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly
      />,
    );
    mounted = readOnly;
    expect(readOnly.container.querySelector('[aria-label="Actions for Other"]')).toBeNull();
    expect(readOnly.container.querySelector('[aria-label="Actions for Nova"]')).toBeNull();
    act(() => readOnly.root.unmount());
    readOnly.container.remove();

    const writable = render(
      <ParticipantsSection
        chatId="chat-1"
        participants={roster}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    mounted = writable;
    expect(writable.container.querySelector('[aria-label="Actions for Me"]')).toBeNull();
    expect(writable.container.querySelector('[aria-label="Actions for Other"]')).not.toBeNull();
    expect(writable.container.querySelector('[aria-label="Actions for Nova"]')).not.toBeNull();
    act(() => writable.root.unmount());
    writable.container.remove();

    // Watcher / supervisor: server sets every canRemove false.
    authMock.agentId = "human-supervisor";
    const outsider = render(
      <ParticipantsSection
        chatId="chat-1"
        participants={[
          participant("human-owner", "human", "Owner", { role: "owner", canRemove: false }),
          participant("human-other", "human", "Other", { canRemove: false }),
          participant("agent-1", "agent", "Nova", { canRemove: false }),
        ]}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    mounted = outsider;
    expect(outsider.container.querySelector('[aria-label="Actions for Other"]')).toBeNull();
    expect(outsider.container.querySelector('[aria-label="Actions for Nova"]')).toBeNull();
  });

  it("follows server canRemove for owner-side, own-agent, and unrelated speaker", () => {
    authMock.agentId = "human-owner";
    const ownerSide = render(
      <ParticipantsSection
        chatId="chat-1"
        participants={[
          participant("human-owner", "human", "Owner", { role: "owner", canRemove: false }),
          participant("human-peer", "human", "Peer", { canRemove: true }),
          participant("agent-any", "agent", "Any", { canRemove: true }),
        ]}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    mounted = ownerSide;
    expect(ownerSide.container.querySelector('[aria-label="Actions for Owner"]')).toBeNull();
    expect(ownerSide.container.querySelector('[aria-label="Actions for Peer"]')).not.toBeNull();
    expect(ownerSide.container.querySelector('[aria-label="Actions for Any"]')).not.toBeNull();
    act(() => ownerSide.root.unmount());
    ownerSide.container.remove();

    authMock.agentId = "human-bystander";
    const bystander = render(
      <ParticipantsSection
        chatId="chat-1"
        participants={[
          participant("human-owner", "human", "Owner", { role: "owner", canRemove: false }),
          participant("human-bystander", "human", "Bystander", { canRemove: false }),
          participant("human-peer", "human", "Peer", { canRemove: false }),
          participant("agent-mine", "agent", "Mine", { canRemove: true }),
          participant("agent-theirs", "agent", "Theirs", { canRemove: false }),
        ]}
        participantsLoading={false}
        managedByMe={new Map([["agent-mine", true]])}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    mounted = bystander;
    expect(bystander.container.querySelector('[aria-label="Actions for Owner"]')).toBeNull();
    expect(bystander.container.querySelector('[aria-label="Actions for Peer"]')).toBeNull();
    expect(bystander.container.querySelector('[aria-label="Actions for Theirs"]')).toBeNull();
    expect(bystander.container.querySelector('[aria-label="Actions for Mine"]')).not.toBeNull();
  });

  it("shows confirm copy, submits once, and toasts watching vs detached", async () => {
    meChatMocks.removeMeChatParticipant.mockResolvedValueOnce({
      chatId: "chat-1",
      targetAgentId: "human-other",
      membershipKind: "watching",
    });
    const { container, root } = render(
      <ParticipantsSection
        chatId="chat-1"
        participants={[
          participant("human-self", "human", "Me", { role: "owner", canRemove: false }),
          participant("human-other", "human", "Other", { canRemove: true }),
        ]}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    mounted = { container, root };

    await openRemoveConfirm(container, "Other");

    expect(document.body.textContent).toContain("Remove Other?");
    expect(document.body.textContent).toContain("Message history is kept");
    expect(document.body.textContent).toContain("no longer be able to send messages or be");
    expect(document.body.textContent).toContain("may continue to observe as a watcher");
    expect(document.body.textContent).not.toContain("no longer be able to send, receive, or be @mentioned");

    const confirm = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Remove");
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(meChatMocks.removeMeChatParticipant).toHaveBeenCalledTimes(1);
    expect(meChatMocks.removeMeChatParticipant).toHaveBeenCalledWith("chat-1", "human-other");
    expect(toastMock.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Moved to watching",
      }),
    );
  });

  it("surfaces open-request 409 and generic forbidden 403 distinctly", async () => {
    meChatMocks.removeMeChatParticipant.mockRejectedValueOnce(
      new ApiError(409, "Answer or skip first", undefined, REMOVE_PARTICIPANT_OPEN_REQUEST_CODE),
    );

    const section = render(
      <ParticipantsSection
        chatId="chat-1"
        participants={[
          participant("human-self", "human", "Me", { role: "owner", canRemove: false }),
          participant("human-other", "human", "Other", { canRemove: true }),
        ]}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    mounted = section;
    await openRemoveConfirm(section.container, "Other");
    const confirm = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Remove");
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastMock.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Unanswered request",
      }),
    );

    act(() => section.root.unmount());
    section.container.remove();
    toastMock.addToast.mockReset();
    meChatMocks.removeMeChatParticipant.mockRejectedValueOnce(new ApiError(403, "Only the chat owner's side"));

    const forbidden = render(
      <ParticipantsSection
        chatId="chat-1"
        participants={[
          participant("human-self", "human", "Me", { role: "owner", canRemove: false }),
          participant("human-other", "human", "Other", { canRemove: true }),
        ]}
        participantsLoading={false}
        managedByMe={new Map()}
        onAdded={() => undefined}
        readOnly={false}
      />,
    );
    mounted = forbidden;
    await openRemoveConfirm(forbidden.container, "Other");
    const confirm2 = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Remove");
    await act(async () => {
      confirm2?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastMock.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Not allowed",
      }),
    );
  });
});
