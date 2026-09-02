import type { MeChatRow } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

import { markChatRowsRead, patchChatListActivity } from "../chat-list-cache";

const chatId = "chat-1";

type TestRow = Pick<MeChatRow, "chatId" | "unreadMentionCount" | "chatHasExplicitMentionToMe">;

function row(overrides: Partial<TestRow> = {}) {
  return {
    chatId: overrides.chatId ?? chatId,
    unreadMentionCount: overrides.unreadMentionCount ?? 3,
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? true,
  } as unknown as MeChatRow;
}

describe("chat list cache reducers", () => {
  it("preserves an existing pinned projection while marking reads", () => {
    const previous = {
      priorityRows: { pinned: [row()] },
      rows: [row({ chatId: "chat-2" })],
      nextCursor: null,
    };

    expect(markChatRowsRead(previous, chatId)).toEqual({
      priorityRows: { pinned: [{ ...row(), unreadMentionCount: 0, chatHasExplicitMentionToMe: false }] },
      rows: [row({ chatId: "chat-2" })],
      nextCursor: null,
    });
  });

  it("tolerates a legacy cache without priorityRows", () => {
    expect(markChatRowsRead({ rows: [row()], nextCursor: null }, chatId)).toEqual({
      priorityRows: { pinned: [] },
      rows: [{ ...row(), unreadMentionCount: 0, chatHasExplicitMentionToMe: false }],
      nextCursor: null,
    });
  });

  it("updates activity without requiring priorityRows", () => {
    const updated = patchChatListActivity({ rows: [row()], nextCursor: null }, chatId, "hello", "2026-09-02T00:00:00Z");

    expect(updated?.rows[0]).toMatchObject({
      unreadMentionCount: 0,
      chatHasExplicitMentionToMe: false,
      lastMessagePreview: "hello",
      activityAt: "2026-09-02T00:00:00Z",
    });
  });

  it("passes through an absent cache", () => {
    expect(markChatRowsRead(undefined, chatId)).toBeUndefined();
    expect(patchChatListActivity(undefined, chatId, "hello", "2026-09-02T00:00:00Z")).toBeUndefined();
  });
});
