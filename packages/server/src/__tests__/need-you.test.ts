import { ASK_AGENT_METADATA_KEY, readAskAgentMessageMetadata } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agents/identity.js";
import { sendMessage } from "../services/chat/message.js";
import { createMeChat, setChatEngagement } from "../services/chat/workspace/me-chat.js";
import { listNeedYouRequests, listRequestThread } from "../services/chat/workspace/need-you.js";
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

  it("projects only the viewer's active chats into both queue rows and exact total", async () => {
    const input = await setup("engagement-filter");
    const request = await ask(input, "Which active rollout?");

    const queue = async () =>
      listNeedYouRequests(input.app.db, input.owner.humanAgentUuid, input.owner.organizationId, { limit: 50 });

    // A missing user-state row has the lazy default `active`.
    await expect(queue()).resolves.toMatchObject({
      total: 1,
      items: [{ request: { id: request.id } }],
    });

    await setChatEngagement(input.app.db, input.chatId, input.owner.humanAgentUuid, "archived");
    await expect(queue()).resolves.toMatchObject({ total: 0, items: [] });

    await setChatEngagement(input.app.db, input.chatId, input.owner.humanAgentUuid, "deleted");
    await expect(queue()).resolves.toMatchObject({ total: 0, items: [] });

    await setChatEngagement(input.app.db, input.chatId, input.owner.humanAgentUuid, "active");
    await expect(queue()).resolves.toMatchObject({
      total: 1,
      items: [{ request: { id: request.id } }],
    });
  });

  it("closes a skipped request and notifies an active asker", async () => {
    const input = await setup("skip-active");
    const request = await ask(input, "Which rollout?");

    const result = await sendMessage(input.app.db, input.chatId, input.owner.humanAgentUuid, {
      source: "web",
      format: "text",
      content: "(Skipped — no answer provided.)",
      metadata: {
        mentions: [input.asker.uuid],
        resolves: { request: request.id, kind: "closed" },
      },
      inReplyTo: request.id,
    });

    expect(result.message.metadata).toMatchObject({
      mentions: [input.asker.uuid],
      resolves: { request: request.id, kind: "closed" },
    });
    expect(result.recipients).toContain(input.asker.inboxId);
    await expect(
      listNeedYouRequests(input.app.db, input.owner.humanAgentUuid, input.owner.organizationId, { limit: 50 }),
    ).resolves.toMatchObject({ total: 0, items: [] });
  });

  it.each([
    "suspended",
    "deleted",
  ] as const)("lets the target human close a request after the asker becomes %s without weakening other sends", async (status) => {
    const input = await setup(`skip-${status}`);
    const request = await ask(input, "Which rollout?");
    await input.app.db
      .update(agents)
      .set({ status, ...(status === "deleted" ? { name: null } : {}) })
      .where(eq(agents.uuid, input.asker.uuid));

    const expectInactiveRouteFailure = async (send: () => ReturnType<typeof sendMessage>): Promise<void> => {
      await expect(send()).rejects.toThrow(/Cannot route .* because the agent is (suspended|deleted)/);
    };

    await expectInactiveRouteFailure(() =>
      sendMessage(input.app.db, input.chatId, input.owner.humanAgentUuid, {
        source: "web",
        format: "text",
        content: "Ordinary message",
        metadata: { mentions: [input.asker.uuid] },
      }),
    );
    await expectInactiveRouteFailure(() =>
      sendMessage(input.app.db, input.chatId, input.owner.humanAgentUuid, {
        source: "web",
        format: "text",
        content: "Ordinary answer",
        metadata: {
          mentions: [input.asker.uuid],
          resolves: { request: request.id, kind: "answered" },
        },
        inReplyTo: request.id,
      }),
    );
    await expectInactiveRouteFailure(() =>
      sendMessage(
        input.app.db,
        input.chatId,
        input.owner.humanAgentUuid,
        {
          source: "web",
          format: "text",
          content: "Can you clarify?",
          metadata: { mentions: [input.asker.uuid] },
          inReplyTo: request.id,
        },
        { askAgentRequestId: request.id },
      ),
    );

    await expect(
      listNeedYouRequests(input.app.db, input.owner.humanAgentUuid, input.owner.organizationId, { limit: 50 }),
    ).resolves.toMatchObject({ total: 1, items: [{ request: { id: request.id } }] });

    const result = await sendMessage(input.app.db, input.chatId, input.owner.humanAgentUuid, {
      source: "web",
      format: "text",
      content: "(Skipped — no answer provided.)",
      metadata: {
        mentions: [input.asker.uuid],
        resolves: { request: request.id, kind: "closed" },
      },
      inReplyTo: request.id,
    });

    expect(result.message.metadata).toMatchObject({
      mentions: [],
      resolves: { request: request.id, kind: "closed" },
    });
    expect(result.recipients).toEqual([]);
    await expect(
      listNeedYouRequests(input.app.db, input.owner.humanAgentUuid, input.owner.organizationId, { limit: 50 }),
    ).resolves.toMatchObject({ total: 0, items: [] });
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

  it("fails closed across the Class B org boundary and Class C chat boundary", async () => {
    const input = await setup("boundary-owner");
    const request = await ask(input, "Private decision");
    const outsider = await createTestAdmin(input.app);
    const ownerHeaders = { authorization: `Bearer ${input.owner.accessToken}` };
    const outsiderHeaders = { authorization: `Bearer ${outsider.accessToken}` };

    const foreignOrgId = `org-need-you-${crypto.randomUUID().slice(0, 8)}`;
    await input.app.db
      .insert(organizations)
      .values({ id: foreignOrgId, name: foreignOrgId.slice(0, 30), displayName: "Need You Foreign" });
    const foreignChatId = crypto.randomUUID();
    await input.app.db.insert(chats).values({
      id: foreignChatId,
      organizationId: foreignOrgId,
      type: "direct",
    });

    // Class B: an explicit org URL never falls back to the caller's default
    // Team or discloses another Team's queue.
    const foreignQueue = await input.app.inject({
      method: "GET",
      url: `/api/v1/orgs/${encodeURIComponent(foreignOrgId)}/chats/open-requests`,
      headers: ownerHeaders,
    });
    expect(foreignQueue.statusCode).toBe(403);

    // Class C: a same-Team member without chat access and a caller from a
    // different Team both receive the anti-enumerating 404 on read and write.
    for (const [headers, chatId] of [
      [outsiderHeaders, input.chatId],
      [ownerHeaders, foreignChatId],
    ] as const) {
      const thread = await input.app.inject({
        method: "GET",
        url: `/api/v1/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(request.id)}/thread`,
        headers,
      });
      expect(thread.statusCode).toBe(404);

      const clarification = await input.app.inject({
        method: "POST",
        url: `/api/v1/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(request.id)}/ask-agent`,
        headers,
        payload: { content: "Reveal the private context." },
      });
      expect(clarification.statusCode).toBe(404);
    }
  });

  it("binds Class C request ids to the addressed chat", async () => {
    const input = await setup("request-chat-binding");
    const firstRequest = await ask(input, "First chat decision");
    const secondAgent = await createAgent(input.app.db, {
      name: "request-chat-binding-second",
      type: "agent",
      displayName: "request-chat-binding-second",
      managerId: input.owner.memberId,
      organizationId: input.owner.organizationId,
    });
    if (!secondAgent) throw new Error("second agent setup failed");
    const secondChat = await createMeChat(input.app.db, input.owner.humanAgentUuid, input.owner.organizationId, {
      participantIds: [secondAgent.uuid],
      topic: "request binding second chat",
    });
    const secondRequest = (
      await sendMessage(input.app.db, secondChat.chatId, secondAgent.uuid, {
        source: "api",
        format: "request",
        content: "Second chat decision",
        metadata: { mentions: [input.owner.humanAgentUuid] },
      })
    ).message;
    const headers = { authorization: `Bearer ${input.owner.accessToken}` };

    const thread = await input.app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(input.chatId)}/requests/${encodeURIComponent(secondRequest.id)}/thread`,
      headers,
    });
    expect(thread.statusCode).toBe(404);

    const clarification = await input.app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(input.chatId)}/requests/${encodeURIComponent(secondRequest.id)}/ask-agent`,
      headers,
      payload: { content: "This request belongs to another chat." },
    });
    expect(clarification.statusCode).toBe(404);

    const validThread = await input.app.inject({
      method: "GET",
      url: `/api/v1/chats/${encodeURIComponent(input.chatId)}/requests/${encodeURIComponent(firstRequest.id)}/thread`,
      headers,
    });
    expect(validThread.statusCode).toBe(200);
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
