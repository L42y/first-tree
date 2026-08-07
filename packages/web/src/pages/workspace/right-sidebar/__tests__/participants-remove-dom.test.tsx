// @vitest-environment happy-dom

import type { ChatParticipantDetail } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../api/client.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function removeLabel(displayName: string): string {
  return `Remove ${displayName} from this chat`;
}

const meChatMocks = vi.hoisted(() => ({
  removeMeChatParticipant: vi.fn(),
  addMeChatParticipants: vi.fn(),
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
  addMeChatParticipants: meChatMocks.addMeChatParticipants,
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

vi.mock("../../../../components/avatar.js", () => ({
  Avatar: ({ name }: { name: string }) => <span>{name.slice(0, 1)}</span>,
}));

/** Lightweight stand-in: open details, then optional Remove — mirrors card flow. */
vi.mock("../../../../components/chat/agent-hovercard.js", async () => {
  const React = await import("react");
  return {
    removeFromChatAriaLabel: (displayName: string) => removeLabel(displayName),
    AgentHovercard: ({
      name,
      removeFromChat,
      children,
    }: {
      name: string;
      removeFromChat?: { onRequest: () => void };
      children: React.ReactNode;
    }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <div data-testid="agent-hovercard">
          <button type="button" aria-label={`Show details for ${name}`} onClick={() => setOpen(true)}>
            {children}
          </button>
          {open ? (
            <div role="dialog">
              {removeFromChat ? (
                <button
                  type="button"
                  aria-label={removeLabel(name)}
                  onClick={() => {
                    setOpen(false);
                    removeFromChat.onRequest();
                  }}
                >
                  Remove from chat
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    },
  };
});

vi.mock("../../../../components/chat/agent-status-panel.js", async () => {
  const { AgentHovercard } = await import("../../../../components/chat/agent-hovercard.js");
  return {
    AgentStatusPanel: ({
      chatId,
      agents,
      canRemove,
      onRemove,
    }: {
      chatId: string;
      agents: ChatParticipantDetail[];
      canRemove?: (agentId: string) => boolean;
      onRemove?: (agent: ChatParticipantDetail) => void;
    }) => (
      <div data-testid="agent-status-panel">
        {agents.map((agent) => (
          <div key={agent.agentId}>
            <AgentHovercard
              agentId={agent.agentId}
              chatId={chatId}
              name={agent.displayName}
              participantType="agent"
              removeFromChat={
                canRemove?.(agent.agentId) && onRemove ? { onRequest: () => onRemove(agent) } : undefined
              }
            >
              <span>{agent.displayName}</span>
            </AgentHovercard>
          </div>
        ))}
      </div>
    ),
  };
});

/** Presence-like Dialog: once opened, keep children mounted after close so
 *  post-success exit races (second Confirm) are deterministic in happy-dom. */
vi.mock("../../../../components/ui/dialog.js", async () => {
  const React = await import("react");
  function Dialog({ open, children }: { open: boolean; children: React.ReactNode }) {
    const wasOpen = React.useRef(false);
    if (open) wasOpen.current = true;
    if (!open && !wasOpen.current) return null;
    return (
      <div data-testid="dialog-root" data-open={String(open)}>
        {children}
      </div>
    );
  }
  return {
    Dialog,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  };
});

function participant(id: string, type: "human" | "agent", displayName = id): ChatParticipantDetail {
  return {
    agentId: id,
    role: "member",
    mode: "default",
    joinedAt: "2026-06-16T00:00:00.000Z",
    name: id,
    displayName,
    type,
    avatarColorToken: null,
    avatarImageUrl: null,
  };
}

let queryClient: QueryClient;
let root: Root | null = null;
let container: HTMLElement | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  await flush();
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return document.querySelector(`button[aria-label="${label}"]`);
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

async function openCardRemove(displayName: string): Promise<void> {
  await click(buttonByLabel(`Show details for ${displayName}`));
  await click(buttonByLabel(removeLabel(displayName)));
}

async function renderSection(opts: {
  participants: ChatParticipantDetail[];
  readOnly?: boolean;
  onAdded?: () => void;
}) {
  const { ParticipantsSection } = await import("../participants-section.js");
  await renderDom(
    <ParticipantsSection
      chatId="chat-1"
      participants={opts.participants}
      participantsLoading={false}
      managedByMe={new Map()}
      onAdded={opts.onAdded ?? (() => undefined)}
      readOnly={opts.readOnly ?? false}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.role = "member";
  authMock.agentId = "human-self";
  meChatMocks.removeMeChatParticipant.mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("ParticipantsSection remove affordance", () => {
  it("offers Remove only inside the identity card for other agents/humans, never self or roster rows", async () => {
    await renderSection({
      participants: [
        participant("agent-1", "agent", "Byte"),
        participant("human-self", "human", "Me"),
        participant("human-2", "human", "Teammate"),
      ],
    });
    await flush();

    // Roster itself never surfaces a Remove control.
    expect(buttonByLabel(removeLabel("Byte"))).toBeNull();
    expect(buttonByLabel(removeLabel("Teammate"))).toBeNull();
    expect(buttonByLabel(removeLabel("Me"))).toBeNull();

    await click(buttonByLabel("Show details for Byte"));
    expect(buttonByLabel(removeLabel("Byte"))).not.toBeNull();

    await click(buttonByLabel("Show details for Teammate"));
    expect(buttonByLabel(removeLabel("Teammate"))).not.toBeNull();

    await click(buttonByLabel("Show details for Me"));
    expect(buttonByLabel(removeLabel("Me"))).toBeNull();
  });

  it("hides Remove when readOnly", async () => {
    await renderSection({
      participants: [
        participant("agent-1", "agent", "Byte"),
        participant("human-self", "human", "Me"),
        participant("human-2", "human", "Teammate"),
      ],
      readOnly: true,
    });
    await flush();
    await click(buttonByLabel("Show details for Byte"));
    expect(buttonByLabel(removeLabel("Byte"))).toBeNull();
    await click(buttonByLabel("Show details for Teammate"));
    expect(buttonByLabel(removeLabel("Teammate"))).toBeNull();
  });

  it("hides Remove for supervisor views where self is absent from speaker roster", async () => {
    authMock.agentId = "human-supervisor";
    await renderSection({
      participants: [participant("agent-1", "agent", "Byte"), participant("human-2", "human", "Teammate")],
      readOnly: false,
    });
    await flush();

    await click(buttonByLabel("Show details for Byte"));
    expect(buttonByLabel(removeLabel("Byte"))).toBeNull();
    await click(buttonByLabel("Show details for Teammate"));
    expect(buttonByLabel(removeLabel("Teammate"))).toBeNull();
  });

  it("opens confirm, Cancel does not mutate, Confirm submits once", async () => {
    const onAdded = vi.fn();
    await renderSection({
      participants: [participant("agent-1", "agent", "Byte"), participant("human-self", "human", "Me")],
      onAdded,
    });
    await flush();

    await openCardRemove("Byte");
    expect(document.body.textContent).toContain('Remove "Byte"?');

    await click(buttonByText("Cancel"));
    expect(meChatMocks.removeMeChatParticipant).not.toHaveBeenCalled();

    await openCardRemove("Byte");
    await click(buttonByLabel("Confirm remove participant"));
    await flush();

    expect(meChatMocks.removeMeChatParticipant).toHaveBeenCalledTimes(1);
    expect(meChatMocks.removeMeChatParticipant).toHaveBeenCalledWith("chat-1", "agent-1");
    expect(onAdded).toHaveBeenCalled();
    expect(toastMock.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Participant removed" }));
  });

  it("pending confirm only submits once under deferred mutation", async () => {
    let release!: () => void;
    meChatMocks.removeMeChatParticipant.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await renderSection({
      participants: [participant("agent-1", "agent", "Byte"), participant("human-self", "human", "Me")],
    });
    await flush();

    await openCardRemove("Byte");
    const confirm = buttonByLabel("Confirm remove participant");
    expect(confirm).not.toBeNull();

    await click(confirm);
    // Mutation is in-flight: confirm is disabled / guarded — a second press must not enqueue another call.
    expect(meChatMocks.removeMeChatParticipant).toHaveBeenCalledTimes(1);
    const pendingConfirm = buttonByLabel("Removing participant");
    expect(pendingConfirm?.disabled).toBe(true);
    await click(pendingConfirm);
    expect(meChatMocks.removeMeChatParticipant).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await flush();
    expect(toastMock.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Participant removed" }));
  });

  it("keeps the confirm display name through a successful close transition", async () => {
    let release!: () => void;
    meChatMocks.removeMeChatParticipant.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await renderSection({
      participants: [participant("agent-1", "agent", "Byte"), participant("human-self", "human", "Me")],
    });
    await flush();

    await openCardRemove("Byte");
    expect(document.body.textContent).toContain('Remove "Byte"?');
    expect(document.body.textContent).not.toContain('Remove ""?');

    await click(buttonByLabel("Confirm remove participant"));
    expect(document.body.textContent).toContain('Remove "Byte"?');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    // Success closes the dialog but must not clear the title to `Remove ""?` while
    // Radix still mounts the exit animation (~200ms). Any remaining Remove title
    // must still name the participant.
    const titles = Array.from(document.body.textContent?.matchAll(/Remove "[^"]*"\?/g) ?? []).map((m) => m[0]);
    expect(titles).not.toContain('Remove ""?');
    for (const title of titles) {
      expect(title).toBe('Remove "Byte"?');
    }

    await flush();
    expect(toastMock.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Participant removed" }));
    expect(document.body.textContent).not.toContain('Remove ""?');
  });

  it("does not re-fire DELETE when Confirm is activated again after success during exit", async () => {
    let release!: () => void;
    meChatMocks.removeMeChatParticipant.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await renderSection({
      participants: [participant("agent-1", "agent", "Byte"), participant("human-self", "human", "Me")],
    });
    await flush();

    await openCardRemove("Byte");
    await click(buttonByLabel("Confirm remove participant"));
    expect(meChatMocks.removeMeChatParticipant).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await flush();

    // Dialog mock keeps content mounted (exit presence). Label may remain, but
    // the actionable target is cleared — Confirm stays locked; second activation
    // must not enqueue another DELETE.
    expect(toastMock.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Participant removed" }));
    expect(document.body.textContent).toContain('Remove "Byte"?');
    expect(document.body.textContent).not.toContain('Remove ""?');

    const confirmAfter = buttonByLabel("Confirm remove participant");
    expect(confirmAfter).not.toBeNull();
    expect(confirmAfter?.disabled).toBe(true);
    await click(confirmAfter);
    confirmAfter?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    confirmAfter?.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    await flush();
    expect(meChatMocks.removeMeChatParticipant).toHaveBeenCalledTimes(1);
  });

  it("surfaces a visible error toast when remove fails", async () => {
    meChatMocks.removeMeChatParticipant.mockRejectedValueOnce(new ApiError(403, "Not a participant of this chat"));
    await renderSection({
      participants: [participant("human-2", "human", "Teammate"), participant("human-self", "human", "Me")],
    });
    await flush();

    await openCardRemove("Teammate");
    await click(buttonByLabel("Confirm remove participant"));
    await flush();

    expect(toastMock.addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't remove participant",
        description: "Not a participant of this chat",
      }),
    );
  });

  it("exports a display-name aria-label helper shared with human rows", async () => {
    const { removeParticipantAriaLabel } = await import("../participants-section.js");
    expect(removeParticipantAriaLabel("Byte")).toBe(removeLabel("Byte"));
  });
});
