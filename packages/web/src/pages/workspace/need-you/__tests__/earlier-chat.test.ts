import type { Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { selectEarlierChatPreview } from "../earlier-chat.js";

function message(overrides: Partial<Message> & Pick<Message, "id" | "senderId" | "createdAt">): Message {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    format: overrides.format ?? "markdown",
    content: overrides.content ?? overrides.id,
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt,
  };
}

const request = message({
  id: "request-1",
  senderId: "asker",
  createdAt: "2026-07-28T10:10:00.000Z",
  format: "request",
  metadata: { mentions: ["human"] },
});

describe("selectEarlierChatPreview", () => {
  it("returns unavailable when the request is outside the recent API window", () => {
    expect(
      selectEarlierChatPreview({
        messages: [],
        requestId: request.id,
        requestCreatedAt: request.createdAt,
        humanAgentId: "human",
        askerAgentId: "asker",
        directChat: false,
        limit: 8,
      }),
    ).toEqual({ unavailable: true, messages: [] });
  });

  it("filters group history to messages between the current human and asker", () => {
    const humanToAsker = message({
      id: "human-to-asker",
      senderId: "human",
      createdAt: "2026-07-28T10:01:00.000Z",
      metadata: { mentions: ["asker"] },
    });
    const askerReply = message({
      id: "asker-reply",
      senderId: "asker",
      createdAt: "2026-07-28T10:02:00.000Z",
      inReplyTo: humanToAsker.id,
    });
    const askerToSomeoneElse = message({
      id: "asker-to-other",
      senderId: "asker",
      createdAt: "2026-07-28T10:03:00.000Z",
      metadata: { mentions: ["other-agent"] },
    });
    const thirdParty = message({
      id: "third-party",
      senderId: "other-agent",
      createdAt: "2026-07-28T10:04:00.000Z",
      metadata: { mentions: ["human"] },
    });

    const result = selectEarlierChatPreview({
      messages: [request, askerToSomeoneElse, thirdParty, askerReply, humanToAsker],
      requestId: request.id,
      requestCreatedAt: request.createdAt,
      humanAgentId: "human",
      askerAgentId: "asker",
      directChat: false,
      limit: 8,
    });

    expect(result.unavailable).toBe(false);
    expect(result.messages.map((item) => item.id)).toEqual(["human-to-asker", "asker-reply"]);
  });

  it("keeps only the nearest bounded slice in chronological order", () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      message({
        id: `message-${index}`,
        senderId: index % 2 === 0 ? "human" : "asker",
        createdAt: `2026-07-28T10:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );

    const result = selectEarlierChatPreview({
      messages: [...history, request],
      requestId: request.id,
      requestCreatedAt: "2026-07-28T11:00:00.000Z",
      humanAgentId: "human",
      askerAgentId: "asker",
      directChat: true,
      limit: 3,
    });

    expect(result.messages.map((item) => item.id)).toEqual(["message-9", "message-10", "message-11"]);
  });
});
