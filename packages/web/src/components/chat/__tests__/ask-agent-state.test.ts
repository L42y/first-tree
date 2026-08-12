import type { Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { projectAskAgentExchanges } from "../ask-agent-state.js";

function message(overrides: Partial<Message> & Pick<Message, "id" | "senderId">): Message {
  return {
    id: overrides.id,
    chatId: overrides.chatId ?? "chat-1",
    senderId: overrides.senderId,
    senderKind: overrides.senderKind ?? "member",
    senderProvider: overrides.senderProvider ?? null,
    format: overrides.format ?? "markdown",
    content: overrides.content ?? "Can you clarify?",
    metadata: overrides.metadata ?? {},
    inReplyTo: overrides.inReplyTo ?? null,
    source: overrides.source ?? "web",
    createdAt: overrides.createdAt ?? "2026-07-28T10:00:00.000Z",
  };
}

describe("projectAskAgentExchanges", () => {
  it("projects only trusted clarifications and the asker's direct reply", () => {
    const clarification = message({
      id: "clarification-1",
      senderId: "human-1",
      inReplyTo: "request-1",
      metadata: { askAgent: { requestId: "request-1", agentId: "agent-1" } },
      createdAt: "2026-07-28T10:01:00.000Z",
    });
    const reply = message({
      id: "reply-1",
      senderId: "agent-1",
      inReplyTo: clarification.id,
      content: "The migration keeps the old API compatible.",
      createdAt: "2026-07-28T10:02:00.000Z",
    });
    const unrelated = message({
      id: "reply-from-someone-else",
      senderId: "agent-2",
      inReplyTo: clarification.id,
      createdAt: "2026-07-28T10:01:30.000Z",
    });

    expect(
      projectAskAgentExchanges({
        thread: [reply, unrelated, clarification],
        requestId: "request-1",
        humanAgentId: "human-1",
        askerAgentId: "agent-1",
      }),
    ).toEqual([{ clarification, reply }]);
  });

  it("ignores ordinary threaded messages and malformed or mismatched markers", () => {
    const messages = [
      message({
        id: "ordinary",
        senderId: "human-1",
        inReplyTo: "request-1",
      }),
      message({
        id: "malformed",
        senderId: "human-1",
        inReplyTo: "request-1",
        metadata: { askAgent: { requestId: 42, agentId: "agent-1" } },
      }),
      message({
        id: "wrong-agent",
        senderId: "human-1",
        inReplyTo: "request-1",
        metadata: { askAgent: { requestId: "request-1", agentId: "agent-2" } },
      }),
      message({
        id: "wrong-request",
        senderId: "human-1",
        inReplyTo: "request-2",
        metadata: { askAgent: { requestId: "request-2", agentId: "agent-1" } },
      }),
    ];

    expect(
      projectAskAgentExchanges({
        thread: messages,
        requestId: "request-1",
        humanAgentId: "human-1",
        askerAgentId: "agent-1",
      }),
    ).toEqual([]);
  });
});
