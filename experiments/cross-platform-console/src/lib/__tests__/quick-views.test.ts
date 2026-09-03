import type { MeChatRow } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

import type { ChatCronJob } from "../chats-api";
import { applyDraft, draftPreview, sortDrafts } from "../drafts";
import { buildQuickViews, catchUpCount, forgeChats, orderSchedules } from "../quick-views";

const row = (chatId: string, overrides: Partial<MeChatRow> = {}): MeChatRow =>
  ({
    chatId,
    title: chatId,
    source: "manual",
    openRequestCount: 0,
    unreadMentionCount: 0,
    ...overrides,
  }) as MeChatRow;

const job = (name: string, overrides: Partial<ChatCronJob> = {}): ChatCronJob => ({
  id: name,
  name,
  schedule: "0 9 * * *",
  timezone: "UTC",
  state: "active",
  nextRunAt: null,
  ...overrides,
});

describe("quick views", () => {
  it("counts a chat once, whether it owes an answer or a read", () => {
    expect(
      catchUpCount([
        row("both", { openRequestCount: 1, unreadMentionCount: 3 }),
        row("mention", { unreadMentionCount: 1 }),
        row("quiet"),
      ]),
    ).toBe(2);
  });

  it("reads followed code work off the chat rows themselves", () => {
    const rows = [row("pr", { source: "github" }), row("mr", { source: "gitlab" }), row("chat")];
    expect(forgeChats(rows).map((r) => r.chatId)).toEqual(["pr", "mr"]);
  });

  it("orders schedules by what runs next, paused last", () => {
    const ordered = orderSchedules([
      job("paused-soon", { state: "paused", nextRunAt: "2026-02-01T09:00:00.000Z" }),
      job("later", { nextRunAt: "2026-02-01T18:00:00.000Z" }),
      job("soon", { nextRunAt: "2026-02-01T10:00:00.000Z" }),
      // An active job with no next run sorts after ones that have a time.
      job("unscheduled"),
    ]);
    expect(ordered.map((j) => j.name)).toEqual(["soon", "later", "unscheduled", "paused-soon"]);
  });

  it("says it has not counted schedules rather than claiming zero", () => {
    const [, , schedules] = buildQuickViews({ rows: [], draftCount: 0, scheduleCount: null });
    expect(schedules.subtitle).toBe("—");
    const [, , counted] = buildQuickViews({ rows: [], draftCount: 0, scheduleCount: 2 });
    expect(counted.subtitle).toBe("2 active");
  });

  it("keeps every tile even when empty, the way a standing pile stays named", () => {
    const views = buildQuickViews({ rows: [], draftCount: 0, scheduleCount: 0 });
    expect(views.map((view) => view.key)).toEqual(["catch-up", "drafts", "schedules", "github"]);
    expect(views[0].subtitle).toBe("0 new");
  });
});

describe("local drafts", () => {
  it("stores a draft per chat and deletes it when emptied", () => {
    const withDraft = applyDraft({}, "chat-1", "Chat one", "half a thought");
    expect(withDraft["chat-1"]).toMatchObject({ chatId: "chat-1", text: "half a thought" });
    // Clearing the box is deleting the draft, not storing an empty one.
    expect(applyDraft(withDraft, "chat-1", "Chat one", "   ")).toEqual({});
  });

  it("shows the most recently touched draft first", () => {
    const drafts = sortDrafts([
      { chatId: "old", title: "", text: "a", updatedAt: 1 },
      { chatId: "new", title: "", text: "b", updatedAt: 2 },
    ]);
    expect(drafts.map((d) => d.chatId)).toEqual(["new", "old"]);
  });

  it("flattens a draft into one readable line", () => {
    expect(draftPreview({ chatId: "c", title: "", text: "line one\n\nline two", updatedAt: 0 })).toBe(
      "line one line two",
    );
    expect(draftPreview({ chatId: "c", title: "", text: "x".repeat(90), updatedAt: 0 }, 10)).toBe(`${"x".repeat(9)}…`);
  });
});
