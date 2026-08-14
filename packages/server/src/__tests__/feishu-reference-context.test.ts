import { FEISHU_REQUIRED_SCOPES } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { createChat } from "../services/chat/conversation.js";
import { withFeishuAbortTimeout } from "../services/integrations/feishu/provider-reader.js";
import {
  loadFeishuReferenceContextTarget,
  readFeishuReferenceContext,
} from "../services/integrations/feishu/reference-context.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Feishu reference context", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const b = await createTestAgent(app, { displayName: "Agent B" });
    const chat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const foreignInstanceId = `foreign-${crypto.randomUUID()}`;
    await app.db.insert(serverInstances).values({ instanceId: foreignInstanceId, lastHeartbeat: new Date() });
    const [binding] = await app.db
      .insert(imBotBindings)
      .values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
        appId: `cli_${crypto.randomUUID()}`,
        botOpenId: "ou_bot",
        appSecretCipher: "encrypted-test-secret",
        grantedScopes: [...FEISHU_REQUIRED_SCOPES],
        status: "active",
        connectionStatus: "connected",
        connectionOwnerInstanceId: foreignInstanceId,
        connectionLeaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!binding) throw new Error("binding setup failed");
    await app.db.insert(imChatBindings).values({
      id: `chat-binding-${crypto.randomUUID()}`,
      botBindingId: binding.id,
      feishuChatId: "oc_context",
      chatId: chat.id,
      feishuChatType: "group",
      status: "active",
    });
    const messageId = crypto.randomUUID();
    await app.db.insert(messages).values({
      id: messageId,
      chatId: chat.id,
      senderId: "integration:feishu",
      senderKind: "integration",
      senderProvider: "feishu",
      source: "feishu",
      format: "markdown",
      content: "current",
      metadata: {
        feishu: {
          version: 1,
          direction: "inbound",
          botBindingId: binding.id,
          reference: {
            messageId: "om_current",
            chatId: "oc_context",
            chatType: "group",
            threadId: "omt_context",
            rootId: "om_root",
            parentId: null,
            sentAt: "2026-08-14T03:00:00.000Z",
          },
          externalAuthor: { openId: "ou_human", displayName: "Human" },
          messageType: "text",
          mentions: [],
          resources: [],
        },
      },
    });
    return { app, a, b, binding, chat, messageId };
  }

  it("authorizes only the owning Agent and active canonical Feishu binding", async () => {
    const { app, a, b, chat, messageId } = await setup();
    await expect(loadFeishuReferenceContextTarget(app.db, a.agent.uuid, messageId)).resolves.toMatchObject({
      externalMessageId: "om_current",
      feishuChatId: "oc_context",
      scope: "thread",
      containerId: "omt_context",
    });
    await expect(loadFeishuReferenceContextTarget(app.db, b.agent.uuid, messageId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await app.db.update(imChatBindings).set({ status: "detached" }).where(eq(imChatBindings.chatId, chat.id));
    await expect(loadFeishuReferenceContextTarget(app.db, a.agent.uuid, messageId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("returns the latest bounded thread window in chronological order without canonical writes", async () => {
    const { app, a, messageId } = await setup();
    const target = await loadFeishuReferenceContextTarget(app.db, a.agent.uuid, messageId);
    const triggerSeconds = Date.parse("2026-08-14T03:00:00.000Z") / 1_000;
    const prior = Array.from({ length: 21 }, (_, index) => ({
      message_id: `om_prior_${index + 1}`,
      thread_id: "omt_context",
      chat_id: "oc_context",
      msg_type: index === 0 ? "image" : "text",
      create_time: String(triggerSeconds - index - 1),
      sender: { id: `ou_human_${index}`, sender_type: "user", sender_name: `Human ${index}` },
      body: {
        content:
          index === 0 ? JSON.stringify({ image_key: "img_history" }) : JSON.stringify({ text: `prior ${index}` }),
      },
    }));
    const request = vi.fn().mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        has_more: false,
        items: [
          {
            message_id: "om_newer",
            thread_id: "omt_context",
            chat_id: "oc_context",
            msg_type: "text",
            create_time: String(triggerSeconds + 1),
            sender: { id: "ou_newer", sender_type: "user", sender_name: "Newer" },
            body: { content: JSON.stringify({ text: "newer" }) },
          },
          {
            message_id: "om_current",
            thread_id: "omt_context",
            chat_id: "oc_context",
            msg_type: "text",
            create_time: String(triggerSeconds),
            sender: { id: "ou_human", sender_type: "user", sender_name: "Human" },
            body: { content: JSON.stringify({ text: "current" }) },
          },
          ...prior,
        ],
      },
    });
    const before = await app.db.select({ id: messages.id }).from(messages);
    const result = await readFeishuReferenceContext({ request } as never, target, new AbortController().signal);

    expect(result).toMatchObject({ state: "available", scope: "thread", truncated: true });
    expect(result.messages).toHaveLength(20);
    expect(result.messages[0]?.externalMessageId).toBe("om_prior_20");
    expect(result.messages.at(-1)).toMatchObject({ externalMessageId: "om_prior_1", content: "[图片]" });
    expect(result.messages.map((item) => item.externalMessageId)).not.toContain("om_current");
    expect(result.messages.map((item) => item.externalMessageId)).not.toContain("om_newer");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/im/v1/messages",
        signal: expect.any(AbortSignal),
        params: expect.objectContaining({
          container_id_type: "thread",
          container_id: "omt_context",
          page_size: 50,
          sort_type: "ByCreateTimeDesc",
        }),
      }),
    );
    expect(await app.db.select({ id: messages.id }).from(messages)).toEqual(before);
  });

  it("returns a stable permission marker without calling Feishu for a stale binding", async () => {
    const { app, a, binding, messageId } = await setup();
    await app.db
      .update(imBotBindings)
      .set({ grantedScopes: ["im:message"] })
      .where(eq(imBotBindings.id, binding.id));
    const target = await loadFeishuReferenceContextTarget(app.db, a.agent.uuid, messageId);
    const request = vi.fn();
    await expect(
      readFeishuReferenceContext({ request } as never, target, new AbortController().signal),
    ).resolves.toEqual({
      state: "unavailable",
      scope: "thread",
      messages: [],
      truncated: false,
      reason: "permission_denied",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("surfaces nonzero provider codes and marks a three-page partial window truncated", async () => {
    const { app, a, messageId } = await setup();
    const target = await loadFeishuReferenceContextTarget(app.db, a.agent.uuid, messageId);
    const permission = vi.fn().mockResolvedValue({ code: 99991672, msg: "permission denied" });
    await expect(
      readFeishuReferenceContext({ request: permission } as never, target, new AbortController().signal),
    ).rejects.toMatchObject({ code: "99991672", message: "permission denied" });

    const triggerSeconds = Date.parse("2026-08-14T03:00:00.000Z") / 1_000;
    const request = vi.fn().mockImplementation(({ params }: { params: { page_token?: string } }) => {
      const page = Number(params.page_token ?? "0");
      return Promise.resolve({
        code: 0,
        data: {
          has_more: true,
          page_token: String(page + 1),
          items:
            page === 0
              ? [
                  {
                    message_id: "om_current",
                    thread_id: "omt_context",
                    chat_id: "oc_context",
                    msg_type: "text",
                    create_time: String(triggerSeconds),
                    sender: { id: "ou_human", sender_type: "user", sender_name: "Human" },
                    body: { content: JSON.stringify({ text: "current" }) },
                  },
                  {
                    message_id: "om_prior",
                    thread_id: "omt_context",
                    chat_id: "oc_context",
                    msg_type: "text",
                    create_time: String(triggerSeconds - 1),
                    sender: { id: "ou_human", sender_type: "user", sender_name: "Human" },
                    body: { content: JSON.stringify({ text: "prior" }) },
                  },
                ]
              : [],
        },
      });
    });
    await expect(
      readFeishuReferenceContext({ request } as never, target, new AbortController().signal),
    ).resolves.toMatchObject({ state: "available", messages: [{ externalMessageId: "om_prior" }], truncated: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("aborts a stalled history page and never starts the next page", async () => {
    const { app, a, messageId } = await setup();
    const target = await loadFeishuReferenceContextTarget(app.db, a.agent.uuid, messageId);
    let providerSignal: AbortSignal | undefined;
    const request = vi.fn().mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          providerSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
        }),
    );

    await expect(
      withFeishuAbortTimeout(
        (signal) => readFeishuReferenceContext({ request } as never, target, signal),
        20,
        "history timeout",
      ),
    ).rejects.toThrow();
    expect(providerSignal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("exposes the bounded reader only through the current Agent runtime identity", async () => {
    const { app, a, b, messageId } = await setup();
    const reader = vi.spyOn(app.feishuIntegration, "getReferenceContext").mockImplementation(async (agentId) => {
      if (agentId !== a.agent.uuid) throw new ForbiddenError("wrong Agent");
      return { state: "available", scope: "thread", messages: [], truncated: false };
    });

    const own = await a.request("GET", `/api/v1/agent/feishu/messages/${messageId}/reference-context`);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ state: "available", scope: "thread", messages: [], truncated: false });
    expect(reader).toHaveBeenCalledWith(a.agent.uuid, messageId);

    const foreign = await b.request("GET", `/api/v1/agent/feishu/messages/${messageId}/reference-context`);
    expect(foreign.statusCode).toBe(403);
  });
});
