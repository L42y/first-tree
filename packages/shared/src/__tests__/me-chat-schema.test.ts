import { describe, expect, it } from "vitest";
import type { MeChatRow } from "../schemas/me-chat.js";
import { listMeChatsQuerySchema, meChatPriorityRowsSchema } from "../schemas/me-chat.js";

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
    participants: overrides.participants ?? [],
    participantCount: overrides.participantCount ?? 1,
    lastMessageAt: overrides.lastMessageAt ?? "2026-07-09T10:00:00.000Z",
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

describe("listMeChatsQuerySchema", () => {
  it("coerces comma-separated origin and participant filters", () => {
    const parsed = listMeChatsQuerySchema.parse({
      origin: "manual, github, ,",
      with: "agent-a, agent-b,",
    });

    expect(parsed.origin).toEqual(["manual", "github"]);
    expect(parsed.with).toEqual(["agent-a", "agent-b"]);
  });

  it("treats empty CSV filters as omitted", () => {
    const parsed = listMeChatsQuerySchema.parse({
      origin: " ",
      with: "",
    });

    expect(parsed.origin).toBeUndefined();
    expect(parsed.with).toBeUndefined();
  });

  it("passes through repeated query param arrays", () => {
    const parsed = listMeChatsQuerySchema.parse({
      origin: ["manual", "github"],
      with: ["agent-a", "agent-b"],
    });

    expect(parsed.origin).toEqual(["manual", "github"]);
    expect(parsed.with).toEqual(["agent-a", "agent-b"]);
  });

  it("coerces watching string query values", () => {
    expect(listMeChatsQuerySchema.parse({ watching: "1" }).watching).toBe(true);
    expect(listMeChatsQuerySchema.parse({ watching: "true" }).watching).toBe(true);
    expect(listMeChatsQuerySchema.parse({ watching: "0" }).watching).toBe(false);
    expect(listMeChatsQuerySchema.parse({ watching: "false" }).watching).toBe(false);
    expect(listMeChatsQuerySchema.parse({ watching: "" }).watching).toBe(false);
    expect(listMeChatsQuerySchema.parse({ watching: true }).watching).toBe(true);
  });
});

describe("meChatPriorityRowsSchema", () => {
  it("defaults to a pin-only projection and drops the retired attention bucket", () => {
    expect(meChatPriorityRowsSchema.parse(undefined)).toEqual({ pinned: [] });
    expect(meChatPriorityRowsSchema.parse({ pinned: [], attention: [] })).toEqual({ pinned: [] });
  });

  it("recovers legacy Attention pins without restoring Attention ordering", () => {
    const canonicalPin = chatRow({
      chatId: "canonical-pin",
      title: "Canonical pin",
      pinnedAt: "2026-07-09T08:00:00.000Z",
      activityAt: "2026-07-09T10:00:00.000Z",
    });
    const staleLegacyCopy = { ...canonicalPin, title: "Stale legacy copy" };
    const recoveredPin = chatRow({
      chatId: "recovered-pin",
      title: "Recovered pin",
      pinnedAt: "2026-07-09T09:00:00.000Z",
      activityAt: "2026-07-09T11:00:00.000Z",
      openRequestCount: 1,
    });
    const ordinaryAttention = chatRow({
      chatId: "ordinary-attention",
      title: "Ordinary attention",
      openRequestCount: 1,
    });

    const parsed = meChatPriorityRowsSchema.parse({
      pinned: [canonicalPin],
      attention: [staleLegacyCopy, recoveredPin, ordinaryAttention],
    });

    expect(parsed).toEqual({ pinned: [recoveredPin, canonicalPin] });
    expect("attention" in parsed).toBe(false);
  });
});
