import type { Message } from "@first-tree/shared";
import { describe, expect, it } from "vitest";

import { collectRequestIds, threadDescendantIds } from "../ask";

const message = (id: string, overrides: Partial<Message> = {}): Message =>
  ({
    id,
    chatId: "chat",
    senderId: "agent",
    senderKind: "member",
    senderProvider: null,
    format: "text",
    content: id,
    metadata: {},
    inReplyTo: null,
    source: "web",
    createdAt: "2026-02-01T12:00:00.000Z",
    ...overrides,
  }) as Message;

describe("ask threads", () => {
  const window = [
    message("chatter-1"),
    message("ask", { format: "request" }),
    message("clarification", { inReplyTo: "ask" }),
    message("agent-reply", { inReplyTo: "clarification" }),
    message("chatter-2"),
    message("answer", { inReplyTo: "ask", metadata: { resolves: { request: "ask", kind: "answered" } } }),
  ];

  it("finds the asks in a window", () => {
    expect(collectRequestIds(window)).toEqual(["ask"]);
  });

  it("claims the whole subtree, not just direct replies", () => {
    const hidden = threadDescendantIds(window, ["ask"]);
    // The agent answers the clarification, not the ask — it is still thread.
    expect([...hidden].sort()).toEqual(["agent-reply", "answer", "clarification"]);
    // Ordinary conversation stays in the conversation, and so does the ask.
    expect(hidden.has("chatter-1")).toBe(false);
    expect(hidden.has("chatter-2")).toBe(false);
    expect(hidden.has("ask")).toBe(false);
  });

  it("claims nothing when there is no ask", () => {
    expect(threadDescendantIds(window, []).size).toBe(0);
  });
});
