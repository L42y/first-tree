import { ASK_AGENT_METADATA_KEY, readAskAgentMessageMetadata } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { listNeedYouRequests, listRequestThread } from "../services/need-you.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Need you request queue and Ask agent protocol", () => {
  const getApp = useTestApp();

  async function setup(name: string) {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const asker = await createAgent(app.db, {
      name,
      type: "agent",
      displayName: name,
      managerId: owner.memberId,
      organizationId: owner.organizationId,
    });
    if (!asker) throw new Error("agent setup failed");
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [asker.uuid],
      topic: `${name} chat`,
    });
    return { app, owner, asker, chatId };
  }

  async function ask(
    input: Awaited<ReturnType<typeof setup>>,
    content: string,
  ): Promise<Awaited<ReturnType<typeof sendMessage>>["message"]> {
    const result = await sendMessage(input.app.db, input.chatId, input.asker.uuid, {
      source: "api",
      format: "request",
      content,
      metadata: { mentions: [input.owner.humanAgentUuid] },
    });
    return result.message;
  }

  it("lists open requests request-by-request in FIFO order with an exact total", async () => {
    const first = await setup("queue-first");
    const secondAgent = await createAgent(first.app.db, {
      name: "queue-second",
      type: "agent",
      displayName: "queue-second",
      managerId: first.owner.memberId,
      organizationId: first.owner.organizationId,
    });
    if (!secondAgent) throw new Error("second agent setup failed");
    const secondChat = await createMeChat(first.app.db, first.owner.humanAgentUuid, first.owner.organizationId, {
      participantIds: [secondAgent.uuid],
      topic: "second chat",
    });

    const firstRequest = await ask(first, "First decision");
    const secondRequest = (
      await sendMessage(first.app.db, secondChat.chatId, secondAgent.uuid, {
        source: "api",
        format: "request",
        content: "Second decision",
        metadata: { mentions: [first.owner.humanAgentUuid] },
      })
    ).message;

    const page = await listNeedYouRequests(first.app.db, first.owner.humanAgentUuid, first.owner.organizationId, {
      limit: 1,
    });
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.request.id)).toEqual([firstRequest.id]);
    expect(page.items[0]?.chat.title).toBe("queue-first chat");
    expect(page.nextCursor).not.toBeNull();

    const next = await listNeedYouRequests(first.app.db, first.owner.humanAgentUuid, first.owner.organizationId, {
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    });
    expect(next.total).toBe(2);
    expect(next.items.map((item) => item.request.id)).toEqual([secondRequest.id]);
  });

  it("keeps Ask agent clarification and reply in a durable thread without resolving the request", async () => {
    const input = await setup("clarifier");
    const request = await ask(input, "Which rollout?");

    const clarification = (
      await sendMessage(
        input.app.db,
        input.chatId,
        input.owner.humanAgentUuid,
        {
          source: "web",
          format: "markdown",
          content: "What is the risk of option B?",
          metadata: { mentions: [input.asker.uuid] },
          inReplyTo: request.id,
        },
        { askAgentRequestId: request.id },
      )
    ).message;
    expect(readAskAgentMessageMetadata(clarification.metadata)).toEqual({
      requestId: request.id,
      agentId: input.asker.uuid,
    });

    const queueWhileWaiting = await listNeedYouRequests(
      input.app.db,
      input.owner.humanAgentUuid,
      input.owner.organizationId,
      { limit: 50 },
    );
    expect(queueWhileWaiting.total).toBe(1);
    expect(queueWhileWaiting.items[0]?.request.id).toBe(request.id);

    const reply = (
      await sendMessage(input.app.db, input.chatId, input.asker.uuid, {
        source: "cli",
        format: "markdown",
        content: "Option B delays the rollout but reduces migration risk.",
        metadata: { mentions: [input.owner.humanAgentUuid] },
        inReplyTo: clarification.id,
      })
    ).message;

    const thread = await listRequestThread(input.app.db, input.chatId, request.id);
    expect(thread.items.map((message) => message.id)).toEqual([request.id, clarification.id, reply.id]);
  });

  it("exposes the queue and trusted Ask agent send through the authenticated HTTP routes", async () => {
    const input = await setup("http-clarifier");
    const request = await ask(input, "Which path?");
    const headers = { authorization: `Bearer ${input.owner.accessToken}` };

    const queueResponse = await input.app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(input.owner.organizationId)}/chats/open-requests`,
      headers,
    });
    expect(queueResponse.statusCode).toBe(200);
    expect(queueResponse.json<{ total: number; items: Array<{ request: { id: string } }> }>()).toMatchObject({
      total: 1,
      items: [{ request: { id: request.id } }],
    });

    const askResponse = await input.app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(input.chatId)}/requests/${encodeURIComponent(request.id)}/ask-agent`,
      headers,
      payload: { content: "Explain the trade-off." },
    });
    expect(askResponse.statusCode).toBe(201);
    expect(readAskAgentMessageMetadata(askResponse.json<{ metadata: Record<string, unknown> }>().metadata)).toEqual({
      requestId: request.id,
      agentId: input.asker.uuid,
    });
  });

  it("strips a forged Ask agent marker from ordinary messages", async () => {
    const input = await setup("marker-guard");
    const sent = (
      await sendMessage(input.app.db, input.chatId, input.owner.humanAgentUuid, {
        source: "web",
        format: "text",
        content: "ordinary message",
        metadata: {
          mentions: [input.asker.uuid],
          [ASK_AGENT_METADATA_KEY]: { requestId: "forged", agentId: input.asker.uuid },
        },
      })
    ).message;
    expect(sent.metadata[ASK_AGENT_METADATA_KEY]).toBeUndefined();
  });

  it("rejects Ask agent after the original request is resolved", async () => {
    const input = await setup("resolved-guard");
    const request = await ask(input, "Ship it?");
    await sendMessage(input.app.db, input.chatId, input.owner.humanAgentUuid, {
      source: "web",
      format: "text",
      content: "Yes",
      metadata: {
        mentions: [input.asker.uuid],
        resolves: { request: request.id, kind: "answered" },
      },
      inReplyTo: request.id,
    });

    await expect(
      sendMessage(
        input.app.db,
        input.chatId,
        input.owner.humanAgentUuid,
        {
          source: "web",
          format: "text",
          content: "One more question",
          metadata: { mentions: [input.asker.uuid] },
          inReplyTo: request.id,
        },
        { askAgentRequestId: request.id },
      ),
    ).rejects.toThrow("already been handled");

    const queue = await listNeedYouRequests(input.app.db, input.owner.humanAgentUuid, input.owner.organizationId, {
      limit: 50,
    });
    expect(queue.total).toBe(0);
  });
});
