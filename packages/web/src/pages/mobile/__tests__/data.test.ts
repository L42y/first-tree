import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  countUnreadRows,
  mobileCardContent,
  mobileChatListSignal,
  mobileChatPreview,
  mobileChatSignal,
  mobileRowsFromList,
  sortMobileChats,
} from "../data.js";

const NOW = "2026-07-09T10:00:00.000Z";

function chatRow(overrides: Partial<MeChatRow> = {}): MeChatRow {
  return {
    chatId: overrides.chatId ?? "chat-1",
    type: overrides.type ?? "group",
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Launch planning",
    topic: overrides.topic ?? "Launch planning",
    description: overrides.description ?? null,
    participants: overrides.participants ?? [
      {
        agentId: "human-agent-self",
        displayName: "Gandy",
        type: "human",
        avatarColorToken: null,
        avatarImageUrl: null,
      },
    ],
    participantCount: overrides.participantCount ?? 1,
    lastMessageAt: overrides.lastMessageAt ?? NOW,
    lastMessagePreview: overrides.lastMessagePreview ?? "Please review the launch checklist.",
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
    pinnedAt: overrides.pinnedAt ?? null,
    activityAt: overrides.activityAt ?? null,
  };
}

describe("mobile chat projection", () => {
  it("keeps request, recovery, unread, and working statuses in time order", () => {
    const recent = chatRow({ chatId: "recent", lastMessageAt: "2026-07-09T10:05:00.000Z" });
    const working = chatRow({
      chatId: "working",
      busyAgentIds: ["agent-1"],
      lastMessageAt: "2026-07-09T10:04:00.000Z",
    });
    const unread = chatRow({ chatId: "unread", unreadMentionCount: 2, lastMessageAt: "2026-07-09T10:03:00.000Z" });
    const failed = chatRow({
      chatId: "failed",
      failedAgentIds: ["agent-2"],
      lastMessageAt: "2026-07-09T10:02:00.000Z",
    });
    const question = chatRow({ chatId: "question", openRequestCount: 1, lastMessageAt: "2026-07-09T10:01:00.000Z" });

    expect(sortMobileChats([recent, working, unread, failed, question]).map((row) => row.chatId)).toEqual([
      "recent",
      "working",
      "unread",
      "failed",
      "question",
    ]);
  });

  it("includes complete pins, then de-duplicates additive rows without promoting failures", () => {
    const failed = chatRow({ chatId: "failed", failedAgentIds: ["agent-1"] });
    const pinnedOnly = chatRow({
      chatId: "pinned-only",
      pinnedAt: "2026-07-09T09:00:00.000Z",
      lastMessageAt: "2026-06-01T09:00:00.000Z",
    });
    const olderPin = chatRow({
      chatId: "older-pin",
      pinnedAt: "2026-07-08T09:00:00.000Z",
      lastMessageAt: "2026-07-09T12:00:00.000Z",
    });
    const newer = chatRow({ chatId: "newer", lastMessageAt: "2026-07-09T11:00:00.000Z" });
    const duplicatePinned = { ...pinnedOnly, title: "Wrong additive copy" };
    const response: ListMeChatsResponse = {
      priorityRows: { pinned: [pinnedOnly, olderPin] },
      rows: [newer, duplicatePinned, failed],
      nextCursor: null,
    };

    const rows = sortMobileChats(mobileRowsFromList(response));
    expect(rows.map((row) => row.chatId)).toEqual(["older-pin", "pinned-only", "newer", "failed"]);
    expect(rows.find((row) => row.chatId === "pinned-only")?.title).toBe("Launch planning");
  });

  it("keeps Chat's quiet labels while real-work activity advances recency", () => {
    const messageUpdate = chatRow({ chatId: "message-update", lastMessageAt: "2026-07-09T11:00:00.000Z" });
    const descriptionUpdate = chatRow({
      chatId: "description-update",
      lastMessageAt: "2026-07-09T08:00:00.000Z",
      activityAt: "2026-07-09T12:00:00.000Z",
    });
    const olderWorking = chatRow({
      chatId: "working",
      busyAgentIds: ["agent-1"],
      lastMessageAt: "2026-07-09T09:00:00.000Z",
    });
    const question = chatRow({
      chatId: "question",
      openRequestCount: 1,
      lastMessageAt: "2026-07-09T08:00:00.000Z",
    });

    expect(
      sortMobileChats([messageUpdate, descriptionUpdate, olderWorking, question]).map((row) => row.chatId),
    ).toEqual(["description-update", "message-update", "working", "question"]);
    expect(mobileChatListSignal(question).label).toBe("Needs answer");
    expect(mobileChatListSignal(olderWorking).label).toBe("Working");
  });

  it("keeps row status labels separate from the unread tab badge", () => {
    const explicitMention = chatRow({ chatId: "explicit", chatHasExplicitMentionToMe: true });
    const rows = [
      chatRow({ chatId: "question", openRequestCount: 1 }),
      chatRow({ chatId: "failed", failedAgentIds: ["agent-1"] }),
      explicitMention,
      chatRow({ chatId: "unread", unreadMentionCount: 1 }),
      chatRow({ chatId: "working", busyAgentIds: ["agent-2"] }),
    ];

    expect(countUnreadRows(rows)).toBe(1);
    expect(mobileChatSignal(explicitMention).label).toBe("Unread");
    expect(mobileChatSignal(explicitMention).attention).toBe(false);
  });

  it("allocates Work content by state", () => {
    const summary = "**Current:** staging is green";
    expect(
      mobileCardContent(
        chatRow({
          description: summary,
          lastMessagePreview: "Latest message",
        }),
      ),
    ).toEqual({ kind: "summary", primary: "Current: staging is green", secondary: null });

    expect(
      mobileCardContent(
        chatRow({
          description: summary,
          lastMessagePreview: "Unrelated newer status message",
          openRequestCount: 1,
        }),
      ),
    ).toEqual({
      kind: "summary",
      primary: "Current: staging is green",
      secondary: null,
    });

    expect(
      mobileCardContent(
        chatRow({
          description: summary,
          lastMessagePreview: "Unrelated message before the failure",
          failedAgentIds: ["agent-1", "agent-2"],
        }),
      ),
    ).toEqual({
      kind: "summary",
      primary: "Current: staging is green",
      secondary: null,
    });

    expect(
      mobileCardContent(
        chatRow({
          description: summary,
          lastMessagePreview: "A new review arrived",
          unreadMentionCount: 1,
        }),
      ),
    ).toEqual({
      kind: "dynamic",
      primary: "Current: staging is green",
      secondary: "New · A new review arrived",
    });

    expect(
      mobileCardContent(
        chatRow({
          description: summary,
          busyAgentIds: ["agent-1"],
          liveActivity: {
            agentId: "agent-1",
            kind: "tool_call",
            label: "Running tests",
            detail: "Web smoke suite",
            startedAt: NOW,
          },
        }),
      ),
    ).toEqual({
      kind: "dynamic",
      primary: "Current: staging is green",
      secondary: "Working · Web smoke suite",
    });
  });
});

describe("mobileChatPreview", () => {
  it("peels inline markdown so the card preview shows plain text", () => {
    const preview = mobileChatPreview(
      chatRow({ description: "**Task:** Build the tree from scratch (`first-tree-seed`)." }),
    );
    expect(preview).toBe("Task: Build the tree from scratch (first-tree-seed).");
    expect(preview).not.toContain("**");
    expect(preview).not.toContain("`");
  });

  it("prefers description, falls back to lastMessagePreview, then a placeholder", () => {
    expect(mobileChatPreview(chatRow({ description: "  hello  ", lastMessagePreview: "later" }))).toBe("hello");
    expect(mobileChatPreview(chatRow({ description: null, lastMessagePreview: "`only` this" }))).toBe("only this");
    expect(mobileChatPreview(chatRow({ description: null, lastMessagePreview: "" }))).toBe("No messages yet.");
  });

  it("shows the placeholder when a markup-only preview strips to empty", () => {
    // lastMessagePreview is stored verbatim server-side, so an image-only
    // message arrives as `![](url)`, which strips to "" — must not render blank.
    expect(mobileChatPreview(chatRow({ description: null, lastMessagePreview: "![](https://x/y.png)" }))).toBe(
      "No messages yet.",
    );
  });
});
