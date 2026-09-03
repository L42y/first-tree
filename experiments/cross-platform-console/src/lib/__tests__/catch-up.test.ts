import type { MeChatRow } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

import { buildCatchUpQueue, remainingLabel, resolveDeckIndex } from "../catch-up";

const row = (chatId: string, overrides: Partial<MeChatRow> = {}): MeChatRow =>
  ({
    chatId,
    title: chatId,
    openRequestCount: 0,
    unreadMentionCount: 0,
    lastMessageAt: "2026-02-01T12:00:00.000Z",
    ...overrides,
  }) as MeChatRow;

describe("catch up queue", () => {
  it("puts blocking questions before unread mentions", () => {
    const cards = buildCatchUpQueue([
      row("mention", { unreadMentionCount: 3 }),
      row("question", { openRequestCount: 1 }),
    ]);
    expect(cards.map((card) => card.kind)).toEqual(["ask", "unread"]);
  });

  it("orders each kind oldest-first, so nothing grows a tail", () => {
    const cards = buildCatchUpQueue([
      row("newer", { openRequestCount: 1, lastMessageAt: "2026-02-01T12:00:00.000Z" }),
      row("older", { openRequestCount: 1, lastMessageAt: "2026-02-01T09:00:00.000Z" }),
    ]);
    expect(cards.map((card) => card.chatId)).toEqual(["older", "newer"]);
  });

  it("ignores chats that need nothing, and never counts one twice", () => {
    const cards = buildCatchUpQueue([
      row("quiet"),
      // A chat with a question AND mentions is one card: the question.
      row("both", { openRequestCount: 1, unreadMentionCount: 4 }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "ask", chatId: "both" });
  });

  it("keeps the reader on their card when the deck is rebuilt", () => {
    const cards = buildCatchUpQueue([
      row("a", { openRequestCount: 1, lastMessageAt: "2026-02-01T08:00:00.000Z" }),
      row("b", { openRequestCount: 1, lastMessageAt: "2026-02-01T09:00:00.000Z" }),
    ]);
    // The card is still there, at a different position — follow the card.
    expect(resolveDeckIndex(cards, "ask-b", 0)).toBe(1);
    // The card is gone (answered elsewhere) — hold the position instead.
    expect(resolveDeckIndex(cards, "ask-vanished", 1)).toBe(1);
    // ...clamped into the deck that is actually left.
    expect(resolveDeckIndex(cards, "ask-vanished", 9)).toBe(1);
    expect(resolveDeckIndex([], "ask-a", 3)).toBe(0);
  });

  it("counts down what is left", () => {
    const cards = buildCatchUpQueue([
      row("a", { openRequestCount: 1 }),
      row("b", { unreadMentionCount: 1 }),
      row("c", { unreadMentionCount: 1 }),
    ]);
    expect(remainingLabel(cards, 0)).toBe("3 left");
    expect(remainingLabel(cards, 2)).toBe("1 left");
    expect(remainingLabel(cards, 3)).toBe("0 left");
  });
});
