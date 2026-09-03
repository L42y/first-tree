import type { ChatParticipantDetail, Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

import {
  buildParticipantRoster,
  formatLastActive,
  participantRoleLabel,
  summarizeParticipants,
} from "../participants";

const participant = (
  agentId: string,
  displayName: string,
  overrides: Partial<ChatParticipantDetail> = {},
): ChatParticipantDetail => ({
  agentId,
  role: "member",
  mode: "full",
  joinedAt: "2026-01-01T00:00:00.000Z",
  name: agentId,
  displayName,
  type: "agent",
  avatarColorToken: null,
  avatarImageUrl: null,
  ...overrides,
});

const message = (senderId: string, createdAt: string): Message =>
  ({
    id: `${senderId}-${createdAt}`,
    chatId: "chat",
    senderId,
    senderKind: "member",
    senderProvider: null,
    format: "text",
    content: "hi",
    metadata: {},
    inReplyTo: null,
    source: "web",
    createdAt,
  }) as Message;

const roster = [
  participant("self", "Me", { type: "human", joinedAt: "2026-01-01T00:00:00.000Z" }),
  participant("quiet", "Quiet", { joinedAt: "2026-01-03T00:00:00.000Z" }),
  participant("stale", "Stale", { joinedAt: "2026-01-02T00:00:00.000Z" }),
  participant("busy", "Busy"),
];

describe("participant roster", () => {
  it("orders by most recent activity, then by how long the silent ones have been here", () => {
    const rows = buildParticipantRoster(
      roster,
      [
        message("stale", "2026-02-01T10:00:00.000Z"),
        message("busy", "2026-02-01T12:00:00.000Z"),
        message("member-id-of-self", "2026-02-01T11:00:00.000Z"),
      ],
      { agentId: "self", senderIds: ["member-id-of-self"] },
    );
    expect(rows.map((row) => row.participant.agentId)).toEqual(["busy", "self", "stale", "quiet"]);
    expect(rows[1]?.isSelf).toBe(true);
    expect(rows[1]?.lastActiveAt).toBe("2026-02-01T11:00:00.000Z");
    expect(rows[3]?.lastActiveAt).toBeNull();
  });

  it("keeps only the newest message per participant", () => {
    const rows = buildParticipantRoster(
      [participant("busy", "Busy")],
      [message("busy", "2026-02-01T09:00:00.000Z"), message("busy", "2026-02-01T08:00:00.000Z")],
    );
    expect(rows[0]?.lastActiveAt).toBe("2026-02-01T09:00:00.000Z");
  });

  it("falls back to a stable name order when joins tie", () => {
    const rows = buildParticipantRoster([participant("b", "Bravo"), participant("a", "Alpha")], []);
    expect(rows.map((row) => row.participant.displayName)).toEqual(["Alpha", "Bravo"]);
  });

  it("labels activity in the coarsest unit that still reads", () => {
    const now = Date.parse("2026-02-01T12:00:00.000Z");
    expect(formatLastActive(null, now)).toBe("No messages yet");
    expect(formatLastActive("2026-02-01T11:59:30.000Z", now)).toBe("Active now");
    expect(formatLastActive("2026-02-01T11:45:00.000Z", now)).toBe("Active 15m ago");
    expect(formatLastActive("2026-02-01T09:00:00.000Z", now)).toBe("Active 3h ago");
    expect(formatLastActive("2026-01-30T12:00:00.000Z", now)).toBe("Active 2d ago");
    expect(formatLastActive("2026-01-10T12:00:00.000Z", now)).toBe("Active 3w ago");
  });

  it("summarizes the header line in the same order, truncating the tail", () => {
    const rows = buildParticipantRoster(roster, [message("busy", "2026-02-01T12:00:00.000Z")]);
    expect(summarizeParticipants(rows)).toBe("Busy, Me, Stale +1");
    expect(summarizeParticipants(rows, 4)).toBe("Busy, Me, Stale, Quiet");
    expect(summarizeParticipants([])).toBe("");
  });

  it("labels the membership kind and mention-only mode", () => {
    const [human] = buildParticipantRoster([participant("h", "Human", { type: "human" })], []);
    const [watcher] = buildParticipantRoster([participant("w", "Watcher", { mode: "mention_only" })], []);
    expect(participantRoleLabel(human)).toBe("Human");
    expect(participantRoleLabel(watcher)).toBe("Agent · Mention only");
  });
});
