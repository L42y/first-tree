import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../cli/output.js", () => outputMocks);

function makeWorkspaceItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chat-1",
    chatId: "chat-1",
    type: "task",
    membershipKind: "participant",
    createdByMe: true,
    source: "github",
    entityType: "pull_request",
    title: "PR repo#42: Ship it",
    topic: "review batch",
    description: "Reviewing reviewer batch.",
    participants: [],
    participantCount: 2,
    lastMessageAt: "2026-08-01T10:00:00.000Z",
    lastMessagePreview: "looks good",
    unreadMentionCount: 3,
    openRequestCount: 1,
    canReply: true,
    engagementStatus: "active",
    liveActivity: {
      agentId: "agent-self",
      kind: "tool_call",
      label: "Read",
      startedAt: "2026-08-01T10:01:00.000Z",
    },
    failedAgentIds: ["agent-2"],
    busyAgentIds: ["agent-self"],
    chatHasExplicitMentionToMe: true,
    pinnedAt: null,
    activityAt: "2026-08-01T10:01:00.000Z",
    ...overrides,
  };
}

function makeChatDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chat-1",
    organizationId: "org-1",
    type: "task",
    topic: "review batch",
    description: "Reviewing reviewer batch.",
    metadata: { entityKey: "github:repo:pr:42", entityUrl: "https://github.com/repo/pull/42" },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    participants: [
      {
        agentId: "agent-self",
        role: "member",
        mode: "speaker",
        joinedAt: "2026-07-01T00:00:00.000Z",
        name: "nova",
        displayName: "Nova",
        type: "agent",
        avatarColorToken: null,
        avatarImageUrl: null,
      },
    ],
    title: "PR repo#42: Ship it",
    firstMessagePreview: "please review",
    engagementStatus: "active",
    viewerMembershipKind: "participant",
    descriptionUpdatedAt: "2026-07-15T00:00:00.000Z",
    lastReadAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  };
}

type MockSdk = {
  agentId: string | undefined;
  listChats: ReturnType<typeof vi.fn>;
  getAgentOrganizationId: ReturnType<typeof vi.fn>;
  listWorkspaceChats: ReturnType<typeof vi.fn>;
  getMemberChatDetail: ReturnType<typeof vi.fn>;
};

function makeMockSdk(overrides: Partial<MockSdk> = {}): MockSdk {
  return {
    agentId: "agent-self",
    listChats: vi.fn(async () => ({ items: [{ id: "chat-struct" }], nextCursor: null })),
    getAgentOrganizationId: vi.fn(async () => "org-1"),
    listWorkspaceChats: vi.fn(async () => ({ items: [makeWorkspaceItem()], nextCursor: "cursor-2" })),
    getMemberChatDetail: vi.fn(async () => makeChatDetail()),
    ...overrides,
  };
}

async function runChatList(args: string[]): Promise<void> {
  const { registerChatListCommand } = await import("../commands/chat/list.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  const chat = program.command("chat");
  registerChatListCommand(chat);
  await program.parseAsync(["node", "test", "chat", "list", ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  localAgentMocks.createSdk.mockReturnValue(makeMockSdk());
});

describe("chat list --engagement", () => {
  it("keeps the default structural path untouched when --engagement is absent", async () => {
    const sdk = localAgentMocks.createSdk() as MockSdk;

    await runChatList([]);

    expect(sdk.listChats).toHaveBeenCalledWith({ limit: 20, cursor: undefined });
    expect(outputMocks.success).toHaveBeenCalledWith({ items: [{ id: "chat-struct" }], nextCursor: null });
    expect(sdk.getAgentOrganizationId).not.toHaveBeenCalled();
    expect(sdk.listWorkspaceChats).not.toHaveBeenCalled();

    await runChatList(["--limit", "5", "--cursor", "cur-1"]);
    expect(sdk.listChats).toHaveBeenLastCalledWith({ limit: 5, cursor: "cur-1" });
  });

  it.each([
    "active",
    "archived",
    "all",
  ] as const)("routes --engagement %s to the Workspace projection with the agent as speaker filter", async (view) => {
    const sdk = localAgentMocks.createSdk() as MockSdk;

    await runChatList(["--engagement", view]);

    expect(sdk.getAgentOrganizationId).toHaveBeenCalledTimes(1);
    expect(sdk.listWorkspaceChats).toHaveBeenCalledWith("org-1", {
      engagement: view,
      withAgentId: "agent-self",
      limit: 20,
      cursor: undefined,
    });
    expect(sdk.listChats).not.toHaveBeenCalled();
    expect(outputMocks.success).toHaveBeenCalledWith({
      items: [makeWorkspaceItem()],
      nextCursor: "cursor-2",
    });
  });

  it("passes limit and cursor through in engagement mode", async () => {
    const sdk = localAgentMocks.createSdk() as MockSdk;

    await runChatList(["--engagement", "archived", "--limit", "7", "--cursor", "cur-9"]);

    expect(sdk.listWorkspaceChats).toHaveBeenCalledWith("org-1", {
      engagement: "archived",
      withAgentId: "agent-self",
      limit: 7,
      cursor: "cur-9",
    });
  });

  it("exposes the id alias and Workspace attention fields on the success payload", async () => {
    await runChatList(["--engagement", "active"]);

    const payload = outputMocks.success.mock.calls.at(-1)?.[0] as { items: Record<string, unknown>[] };
    const item = payload.items[0] as Record<string, unknown>;
    expect(item.id).toBe("chat-1");
    expect(item.chatId).toBe("chat-1");
    expect(item).toMatchObject({
      unreadMentionCount: 3,
      openRequestCount: 1,
      busyAgentIds: ["agent-self"],
      failedAgentIds: ["agent-2"],
      createdByMe: true,
      source: "github",
      entityType: "pull_request",
    });
    expect(item.liveActivity).toMatchObject({ agentId: "agent-self", kind: "tool_call" });
  });

  it("fails closed in list mode when no agent is selected", async () => {
    const sdk = makeMockSdk({ agentId: undefined });
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await expect(runChatList(["--engagement", "active"])).rejects.toThrow(
      "Workspace engagement listing requires a selected agent (sdk.agentId is unset)",
    );

    expect(sdk.getAgentOrganizationId).not.toHaveBeenCalled();
    expect(sdk.listWorkspaceChats).not.toHaveBeenCalled();
    expect(outputMocks.success).not.toHaveBeenCalled();
  });

  it("exact chat merges the Workspace row with the raw detail; the detail engagement wins", async () => {
    const sdk = makeMockSdk({
      listWorkspaceChats: vi.fn(async () => ({ items: [makeWorkspaceItem()], nextCursor: null })),
      getMemberChatDetail: vi.fn(async () =>
        makeChatDetail({
          engagementStatus: "archived",
          description: "detail-side description",
        }),
      ),
    });
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await runChatList(["--engagement", "all", "--chat", "chat-1"]);

    expect(sdk.getAgentOrganizationId).toHaveBeenCalledTimes(1);
    expect(sdk.listWorkspaceChats).toHaveBeenCalledWith("org-1", {
      engagement: "all",
      withAgentId: "agent-self",
      limit: 100,
      cursor: undefined,
    });
    expect(sdk.getMemberChatDetail).toHaveBeenCalledWith("chat-1");

    const payload = outputMocks.success.mock.calls.at(-1)?.[0] as {
      items: Record<string, unknown>[];
      nextCursor: null;
    };
    expect(payload.nextCursor).toBeNull();
    expect(payload.items).toHaveLength(1);
    const item = payload.items[0] as Record<string, unknown>;
    expect(item.id).toBe("chat-1");
    expect(item.chatId).toBe("chat-1");
    // Every Workspace attention field comes from the conversation row…
    expect(item).toMatchObject(makeWorkspaceItem({ engagementStatus: "archived" }));
    // …including row-owned shared fields (row wins over the detail)…
    expect(item.description).toBe("Reviewing reviewer batch.");
    // …overlaid with the detail-only raw fields.
    expect(item.metadata).toEqual({
      entityKey: "github:repo:pr:42",
      entityUrl: "https://github.com/repo/pull/42",
    });
    expect(item.lastReadAt).toBe("2026-08-01T09:00:00.000Z");
    expect(item.descriptionUpdatedAt).toBe("2026-07-15T00:00:00.000Z");
    expect(item.firstMessagePreview).toBe("please review");
    expect(item.viewerMembershipKind).toBe("participant");
    expect(item.organizationId).toBe("org-1");
    expect(item.createdAt).toBe("2026-07-01T00:00:00.000Z");
    expect(item.updatedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("exact chat pages the Workspace list until the target row appears", async () => {
    const listWorkspaceChats = vi
      .fn()
      .mockResolvedValueOnce({
        items: [makeWorkspaceItem({ id: "chat-other", chatId: "chat-other" })],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({ items: [makeWorkspaceItem()], nextCursor: null });
    const sdk = makeMockSdk({ listWorkspaceChats });
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await runChatList(["--engagement", "active", "--chat", "chat-1"]);

    expect(listWorkspaceChats).toHaveBeenCalledTimes(2);
    expect(listWorkspaceChats).toHaveBeenNthCalledWith(1, "org-1", {
      engagement: "active",
      withAgentId: "agent-self",
      limit: 100,
      cursor: undefined,
    });
    expect(listWorkspaceChats).toHaveBeenNthCalledWith(2, "org-1", {
      engagement: "active",
      withAgentId: "agent-self",
      limit: 100,
      cursor: "cursor-2",
    });
    expect(sdk.getMemberChatDetail).toHaveBeenCalledWith("chat-1");
    const payload = outputMocks.success.mock.calls.at(-1)?.[0] as { items: Record<string, unknown>[] };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.chatId).toBe("chat-1");
  });

  it("exact chat returns empty items when the target never appears before nextCursor is null", async () => {
    const sdk = makeMockSdk({
      listWorkspaceChats: vi.fn(async () => ({
        items: [makeWorkspaceItem({ id: "chat-other", chatId: "chat-other" })],
        nextCursor: null,
      })),
    });
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await runChatList(["--engagement", "archived", "--chat", "chat-1"]);

    expect(outputMocks.success).toHaveBeenCalledWith({ items: [], nextCursor: null });
    expect(sdk.getMemberChatDetail).not.toHaveBeenCalled();
  });

  it("fails closed in exact mode when no agent is selected", async () => {
    const sdk = makeMockSdk({ agentId: undefined });
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await expect(runChatList(["--engagement", "active", "--chat", "chat-1"])).rejects.toThrow(
      "Workspace engagement listing requires a selected agent (sdk.agentId is unset)",
    );

    expect(sdk.getAgentOrganizationId).not.toHaveBeenCalled();
    expect(sdk.listWorkspaceChats).not.toHaveBeenCalled();
    expect(sdk.getMemberChatDetail).not.toHaveBeenCalled();
    expect(outputMocks.success).not.toHaveBeenCalled();
  });

  it("exact chat returns empty items when the detail engagement drifted from the requested view", async () => {
    // Row still matches the view filter (active), but the fresher detail read
    // says archived — the race the detail re-check exists to cover.
    const sdk = makeMockSdk({
      listWorkspaceChats: vi.fn(async () => ({ items: [makeWorkspaceItem()], nextCursor: null })),
      getMemberChatDetail: vi.fn(async () => makeChatDetail({ engagementStatus: "archived" })),
    });
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await runChatList(["--engagement", "active", "--chat", "chat-1"]);

    expect(outputMocks.success).toHaveBeenCalledWith({ items: [], nextCursor: null });
  });

  it("exact chat returns empty items when the agent is not a speaker", async () => {
    const sdk = makeMockSdk({
      listWorkspaceChats: vi.fn(async () => ({ items: [makeWorkspaceItem()], nextCursor: null })),
      getMemberChatDetail: vi.fn(async () =>
        makeChatDetail({
          participants: [
            {
              agentId: "agent-other",
              role: "member",
              mode: "speaker",
              joinedAt: "2026-07-01T00:00:00.000Z",
              name: "other",
              displayName: "Other",
              type: "agent",
              avatarColorToken: null,
              avatarImageUrl: null,
            },
          ],
        }),
      ),
    });
    localAgentMocks.createSdk.mockReturnValue(sdk);

    await runChatList(["--engagement", "active", "--chat", "chat-1"]);

    expect(outputMocks.success).toHaveBeenCalledWith({ items: [], nextCursor: null });
  });

  it("exact chat with --engagement all matches archived but never deleted", async () => {
    localAgentMocks.createSdk.mockReturnValue(
      makeMockSdk({
        listWorkspaceChats: vi.fn(async () => ({ items: [makeWorkspaceItem()], nextCursor: null })),
        getMemberChatDetail: vi.fn(async () => makeChatDetail({ engagementStatus: "archived" })),
      }),
    );
    await runChatList(["--engagement", "all", "--chat", "chat-1"]);
    const archivedPayload = outputMocks.success.mock.calls.at(-1)?.[0] as { items: Record<string, unknown>[] };
    expect(archivedPayload.items).toHaveLength(1);
    expect(archivedPayload.items[0]).toMatchObject({
      id: "chat-1",
      chatId: "chat-1",
      engagementStatus: "archived",
    });

    localAgentMocks.createSdk.mockReturnValue(
      makeMockSdk({
        listWorkspaceChats: vi.fn(async () => ({ items: [makeWorkspaceItem()], nextCursor: null })),
        getMemberChatDetail: vi.fn(async () => makeChatDetail({ engagementStatus: "deleted" })),
      }),
    );
    await runChatList(["--engagement", "all", "--chat", "chat-1"]);
    expect(outputMocks.success).toHaveBeenLastCalledWith({ items: [], nextCursor: null });
  });

  it("rejects --chat without --engagement", async () => {
    await expect(runChatList(["--chat", "chat-1"])).rejects.toMatchObject({
      code: "CHAT_REQUIRES_ENGAGEMENT",
      exitCode: 2,
    });
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
  });

  it("rejects --chat together with --cursor", async () => {
    await expect(
      runChatList(["--engagement", "active", "--chat", "chat-1", "--cursor", "cur-1"]),
    ).rejects.toMatchObject({ code: "CONFLICTING_ARGS", exitCode: 2 });
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
  });

  it("rejects an unknown --engagement value", async () => {
    await expect(runChatList(["--engagement", "bogus"])).rejects.toMatchObject({
      code: "INVALID_ENGAGEMENT",
      exitCode: 2,
    });
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
  });
});
