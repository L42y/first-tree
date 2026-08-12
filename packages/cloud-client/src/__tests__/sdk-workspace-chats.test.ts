import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK } from "../sdk.js";

const SERVER_URL = "https://first-tree.example/";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetchMock(responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeSdk(): FirstTreeHubSDK {
  return new FirstTreeHubSDK({
    serverUrl: SERVER_URL,
    agentId: "agent-1",
    userAgent: "first-tree-test",
    getAccessToken: () => "access-token",
  });
}

function makeWorkspaceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: "chat-1",
    type: "task",
    membershipKind: "participant",
    createdByMe: true,
    source: "github",
    entityType: "pull_request",
    title: "PR repo#42: Ship it",
    topic: "review batch",
    description: "Reviewing reviewer batch.",
    participants: [
      {
        agentId: "agent-1",
        displayName: "Nova",
        type: "agent",
        avatarColorToken: null,
        avatarImageUrl: null,
      },
    ],
    participantCount: 2,
    lastMessageAt: "2026-08-01T10:00:00.000Z",
    lastMessagePreview: "looks good",
    unreadMentionCount: 3,
    openRequestCount: 1,
    canReply: true,
    engagementStatus: "active",
    liveActivity: {
      agentId: "agent-1",
      kind: "tool_call",
      label: "Read",
      startedAt: "2026-08-01T10:01:00.000Z",
    },
    failedAgentIds: ["agent-2"],
    busyAgentIds: ["agent-1"],
    chatHasExplicitMentionToMe: true,
    pinnedAt: "2026-07-31T09:00:00.000Z",
    activityAt: "2026-08-01T10:01:00.000Z",
    ...overrides,
  };
}

function makeChatDetailPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        agentId: "agent-1",
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
    ...overrides,
  };
}

describe("FirstTreeHubSDK workspace chat APIs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("listWorkspaceChats composes the URL with engagement/with/limit/cursor", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ priorityRows: { pinned: [] }, rows: [], nextCursor: null })]);

    await makeSdk().listWorkspaceChats("org-1", {
      engagement: "archived",
      withAgentId: "agent-1",
      limit: 10,
      cursor: "cur-1",
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://first-tree.example/api/v1/orgs/org-1/chats?engagement=archived&with=agent-1&limit=10&cursor=cur-1",
    );
  });

  it("listWorkspaceChats omits `with` when no agent is given and always sends engagement", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ priorityRows: { pinned: [] }, rows: [], nextCursor: null })]);

    await makeSdk().listWorkspaceChats("org-1", { engagement: "all" });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://first-tree.example/api/v1/orgs/org-1/chats?engagement=all");
  });

  it("listWorkspaceChats maps rows to items with the id alias and passes attention fields through", async () => {
    const row = makeWorkspaceRow();
    makeFetchMock([jsonResponse({ priorityRows: { pinned: [] }, rows: [row], nextCursor: "cursor-2" })]);

    const result = await makeSdk().listWorkspaceChats("org-1", { engagement: "active", withAgentId: "agent-1" });

    expect(result.nextCursor).toBe("cursor-2");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({ id: "chat-1", ...row });
  });

  it("listWorkspaceChats passes a null nextCursor through", async () => {
    makeFetchMock([jsonResponse({ priorityRows: { pinned: [] }, rows: [makeWorkspaceRow()], nextCursor: null })]);

    const result = await makeSdk().listWorkspaceChats("org-1", { engagement: "active" });

    expect(result.nextCursor).toBeNull();
  });

  it("listWorkspaceChats tolerates rows missing defaulted fields (version skew)", async () => {
    const minimalRow = {
      chatId: "chat-2",
      type: "manual",
      membershipKind: "participant",
      title: "Plain chat",
      topic: null,
      participants: [],
      participantCount: 1,
      lastMessageAt: null,
      lastMessagePreview: null,
      unreadMentionCount: 0,
      canReply: true,
      engagementStatus: "archived",
      liveActivity: null,
    };
    makeFetchMock([jsonResponse({ priorityRows: { pinned: [] }, rows: [minimalRow], nextCursor: null })]);

    const result = await makeSdk().listWorkspaceChats("org-1", { engagement: "archived" });

    expect(result.items[0]).toMatchObject({
      id: "chat-2",
      chatId: "chat-2",
      createdByMe: false,
      source: "manual",
      entityType: null,
      description: null,
      openRequestCount: 0,
      failedAgentIds: [],
      busyAgentIds: [],
      chatHasExplicitMentionToMe: false,
      pinnedAt: null,
      activityAt: null,
    });
  });

  it("getAgentOrganizationId resolves the organization from GET /agent/me", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ uuid: "agent-1", organizationId: "org-1" })]);

    await expect(makeSdk().getAgentOrganizationId()).resolves.toBe("org-1");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://first-tree.example/api/v1/agent/me");
  });

  it("getAgentOrganizationId rejects payloads without a usable organizationId", async () => {
    makeFetchMock([jsonResponse({ uuid: "agent-1" })]);
    await expect(makeSdk().getAgentOrganizationId()).rejects.toBeInstanceOf(SyntaxError);

    makeFetchMock([jsonResponse({ organizationId: " padded " })]);
    await expect(makeSdk().getAgentOrganizationId()).rejects.toBeInstanceOf(SyntaxError);

    makeFetchMock([jsonResponse({ organizationId: 42 })]);
    await expect(makeSdk().getAgentOrganizationId()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("getMemberChatDetail fetches and parses the member chat detail", async () => {
    const payload = makeChatDetailPayload();
    const fetchMock = makeFetchMock([jsonResponse(payload)]);

    const detail = await makeSdk().getMemberChatDetail("chat-1");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://first-tree.example/api/v1/chats/chat-1");
    expect(detail.id).toBe("chat-1");
    expect(detail.engagementStatus).toBe("active");
    expect(detail.metadata).toEqual({
      entityKey: "github:repo:pr:42",
      entityUrl: "https://github.com/repo/pull/42",
    });
    expect(detail.participants[0]?.agentId).toBe("agent-1");
  });
});
