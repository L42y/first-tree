import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { NotFoundError } from "../errors.js";
import { createChat } from "../services/chat/conversation.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("controlled Feishu CLI preflight", () => {
  const getApp = useTestApp();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup() {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const b = await createTestAgent(app, { displayName: "Agent B" });
    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.agent.uuid],
    });
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
        tenantKey: "tenant-a",
        appSecretCipher: "encrypted-test-secret",
        grantedScopes: ["im:message"],
        status: "active",
        connectionStatus: "connected",
        connectionOwnerInstanceId: foreignInstanceId,
        connectionLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      })
      .returning();
    if (!binding) throw new Error("binding setup failed");
    await app.db.insert(imChatBindings).values({
      id: `chat-binding-${crypto.randomUUID()}`,
      botBindingId: binding.id,
      feishuChatId: "oc_feishu",
      chatId: chat.id,
      feishuChatType: "group",
      status: "active",
    });
    vi.spyOn(app.feishuIntegration, "getCliGrant").mockImplementation(async (agentId) => {
      if (agentId !== a.agent.uuid) throw new NotFoundError("Active Feishu Bot binding not found");
      return {
        binding,
        appId: binding.appId ?? "cli_test",
        appSecret: "agent-owned-secret",
      };
    });
    return { app, a, b, binding, chat };
  }

  it("reuses sendMessage for an immutable recipientless intent and silently fans out to B", async () => {
    const { app, a, b, chat } = await setup();
    const request = {
      chatId: chat.id,
      operation: "send",
      targetChatId: "oc_feishu",
      replyInThread: false,
      format: "markdown",
      content: "**hello**",
    };

    const response = await a.request("POST", "/api/v1/agent/feishu/intents", request);
    expect(response.statusCode).toBe(200);
    const grant = response.json<{
      canonicalMessageId: string;
      idempotencyKey: string;
      targetChatId: string;
    }>();
    expect(grant).toMatchObject({
      canonicalMessageId: expect.any(String),
      idempotencyKey: expect.any(String),
      targetChatId: "oc_feishu",
    });
    expect(grant.idempotencyKey).toBe(grant.canonicalMessageId);

    const [stored] = await app.db.select().from(messages).where(eq(messages.id, grant.canonicalMessageId));
    expect(stored).toMatchObject({
      chatId: chat.id,
      senderId: a.agent.uuid,
      senderKind: "member",
      senderProvider: null,
      format: "markdown",
      content: "**hello**",
    });
    expect(stored?.metadata).toMatchObject({
      feishu: {
        direction: "outbound",
        botBindingId: expect.any(String),
        intent: {
          operation: "send",
          chatId: "oc_feishu",
          targetMessageId: null,
          idempotencyKey: grant.canonicalMessageId,
        },
      },
    });
    expect((stored?.metadata as { mentions?: unknown } | undefined)?.mentions).toEqual([]);

    const edit = await a.request("PATCH", `/api/v1/agent/chats/${chat.id}/messages/${grant.canonicalMessageId}`, {
      content: "edited after provider delivery",
    });
    expect(edit.statusCode).toBe(403);

    const inbox = await app.db.select().from(inboxEntries).where(eq(inboxEntries.messageId, grant.canonicalMessageId));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ inboxId: b.agent.inboxId, notify: false });

    const retry = await a.request("POST", "/api/v1/agent/feishu/intents", {
      ...request,
      canonicalMessageId: grant.canonicalMessageId,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ canonicalMessageId: string }>().canonicalMessageId).toBe(grant.canonicalMessageId);
    expect(await app.db.select().from(messages)).toHaveLength(1);
    expect(await app.db.select().from(inboxEntries)).toHaveLength(1);

    const changedRetry = await a.request("POST", "/api/v1/agent/feishu/intents", {
      ...request,
      content: "different",
      canonicalMessageId: grant.canonicalMessageId,
    });
    expect(changedRetry.statusCode).toBe(403);
  });

  it("allows only A to reply to an inbound reference from the same Bot and chat", async () => {
    const { app, a, b, binding, chat } = await setup();
    await app.db.insert(messages).values({
      id: crypto.randomUUID(),
      chatId: chat.id,
      senderId: "integration:feishu",
      senderKind: "integration",
      senderProvider: "feishu",
      source: "feishu",
      format: "text",
      content: "inbound",
      metadata: {
        feishu: {
          version: 1,
          direction: "inbound",
          botBindingId: binding.id,
          externalAuthor: { openId: "ou_human", displayName: "Human" },
          reference: {
            messageId: "om_target",
            chatId: "oc_feishu",
            chatType: "group",
            threadId: "omt_thread",
            rootId: "om_root",
            parentId: null,
            sentAt: null,
          },
          mentions: [],
          resources: [],
        },
      },
    });
    const request = {
      chatId: chat.id,
      operation: "reply",
      targetMessageId: "om_target",
      replyInThread: true,
      format: "text",
      content: "reply",
    };

    const response = await a.request("POST", "/api/v1/agent/feishu/intents", request);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ targetMessageId: string }>().targetMessageId).toBe("om_target");

    const bResponse = await b.request("POST", "/api/v1/agent/feishu/intents", request);
    expect(bResponse.statusCode).toBe(404);

    const unknown = await a.request("POST", "/api/v1/agent/feishu/intents", {
      ...request,
      targetMessageId: "om_unknown",
    });
    expect(unknown.statusCode).toBe(403);
  });

  it("allows media retry only when its immutable byte identity still matches", async () => {
    const { a, chat } = await setup();
    const first = await a.request("POST", "/api/v1/agent/feishu/intents", {
      chatId: chat.id,
      operation: "send",
      targetChatId: "oc_feishu",
      replyInThread: false,
      format: "file",
      media: { kind: "file", filename: "report.pdf", size: 12, sha256: "a".repeat(64) },
    });
    expect(first.statusCode).toBe(200);
    const canonicalMessageId = first.json<{ canonicalMessageId: string }>().canonicalMessageId;

    const retry = await a.request("POST", "/api/v1/agent/feishu/intents", {
      chatId: chat.id,
      operation: "send",
      targetChatId: "oc_feishu",
      replyInThread: false,
      format: "file",
      media: { kind: "file", filename: "report.pdf", size: 12, sha256: "a".repeat(64) },
      canonicalMessageId,
    });
    expect(retry.statusCode).toBe(200);

    const changed = await a.request("POST", "/api/v1/agent/feishu/intents", {
      chatId: chat.id,
      operation: "send",
      targetChatId: "oc_feishu",
      replyInThread: false,
      format: "file",
      media: { kind: "file", filename: "report.pdf", size: 13, sha256: "b".repeat(64) },
      canonicalMessageId,
    });
    expect(changed.statusCode).toBe(403);
  });

  it("returns Bot credentials only to the bound primary Agent", async () => {
    const { a, b } = await setup();
    const allowed = await a.request("POST", "/api/v1/agent/feishu/credentials");
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ appId: expect.any(String), appSecret: "agent-owned-secret" });

    const denied = await b.request("POST", "/api/v1/agent/feishu/credentials");
    expect(denied.statusCode).toBe(404);
  });
});
