import type { MeChatRow } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

import { asChatRows, clearChatUnreadRows, patchChatRowActivity } from "../chat-list-cache";

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
  it("clears unread state only for the target chat in row arrays", () => {
    const rows = [row(), row({ chatId: "chat-2" })];

    expect(clearChatUnreadRows(rows, chatId)).toEqual([
      { ...row(), unreadMentionCount: 0, chatHasExplicitMentionToMe: false },
      row({ chatId: "chat-2" }),
    ]);
  });

  it("updates activity without changing other rows", () => {
    const updated = patchChatRowActivity([row(), row({ chatId: "chat-2" })], chatId, "hello", "2026-09-02T00:00:00Z");

    expect(updated?.[0]).toMatchObject({
      unreadMentionCount: 0,
      chatHasExplicitMentionToMe: false,
      lastMessagePreview: "hello",
      activityAt: "2026-09-02T00:00:00Z",
    });
    expect(updated?.[1]).toEqual(row({ chatId: "chat-2" }));
  });

  it("normalizes a corrupted legacy projection without crashing consumers", () => {
    expect(asChatRows({ priorityRows: { pinned: [] }, rows: [] })).toEqual([]);
    expect(asChatRows([row()])).toHaveLength(1);
    expect(asChatRows(undefined)).toEqual([]);
  });

  it("passes through an absent cache", () => {
    expect(clearChatUnreadRows(undefined, chatId)).toBeUndefined();
    expect(patchChatRowActivity(undefined, chatId, "hello", "2026-09-02T00:00:00Z")).toBeUndefined();
  });

  it("leaves an unexpected legacy object for the array guard instead of crashing", () => {
    const legacy = { rows: [] } as unknown as MeChatRow[];
    expect(clearChatUnreadRows(legacy, chatId)).toBe(legacy);
    expect(patchChatRowActivity(legacy, chatId, "hello", "2026-09-02T00:00:00Z")).toBe(legacy);
  });
});
