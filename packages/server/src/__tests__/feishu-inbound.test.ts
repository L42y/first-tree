import { Readable } from "node:stream";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { attachments } from "../db/schema/attachments.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { ingestFeishuMessage } from "../services/integrations/feishu/inbound.js";
import { createFeishuSenderNameResolver } from "../services/integrations/feishu/sender-name.js";
import { createTestAgent, useTestApp } from "./helpers.js";

function normalizedMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  const messageId = overrides.messageId ?? `om_${crypto.randomUUID()}`;
  const chatId = overrides.chatId ?? `oc_${crypto.randomUUID()}`;
  return {
    messageId,
    chatId,
    chatType: "p2p",
    senderId: "ou_human",
    senderName: "张三",
    content: "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    raw: {
      header: { event_id: `event_${messageId}` },
      event: {
        sender: {
          tenant_key: "tenant-a",
          sender_id: { open_id: "ou_human", union_id: "on_human", user_id: "u_human" },
        },
        message: { message_type: "text", content: JSON.stringify({ text: "hello" }) },
      },
    },
    ...overrides,
  };
}

describe("Feishu inbound pipeline", () => {
  const getApp = useTestApp();

  async function seedBinding() {
    const app = getApp();
    const testAgent = await createTestAgent(app, { displayName: "Feishu Agent" });
    const bindingId = `binding-${crypto.randomUUID()}`;
    const foreignInstanceId = `foreign-${crypto.randomUUID()}`;
    await app.db.insert(serverInstances).values({ instanceId: foreignInstanceId, lastHeartbeat: new Date() });
    const [binding] = await app.db
      .insert(imBotBindings)
      .values({
        id: bindingId,
        organizationId: testAgent.organizationId,
        agentId: testAgent.agent.uuid,
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
    return { binding, testAgent };
  }

  function dependencies(bytes = Buffer.from("image")) {
    return {
      senderNames: createFeishuSenderNameResolver(),
      readMembers: vi.fn().mockResolvedValue({ data: { items: [] } }),
      downloadResource: vi.fn().mockResolvedValue({
        stream: Readable.from([bytes]),
        headers: { "content-type": "image/png", "content-length": String(bytes.length) },
      }),
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
    };
  }

  it("automatically addresses p2p messages, hydrates resources, and emits one canonical Integration message", async () => {
    const app = getApp();
    const { binding, testAgent } = await seedBinding();
    const deps = dependencies();
    const input = normalizedMessage({
      resources: [{ type: "image", fileKey: "img_a", fileName: "photo.png" }],
      raw: {
        header: { event_id: "event-p2p" },
        event: {
          sender: {
            tenant_key: "tenant-a",
            sender_id: { open_id: "ou_human", union_id: "on_human", user_id: "u_human" },
          },
          message: { message_type: "image", content: JSON.stringify({ image_key: "img_a" }) },
        },
      },
    });

    const first = await ingestFeishuMessage(app.db, app.notifier, binding, input, deps);
    expect(first.state).toBe("created");
    const second = await ingestFeishuMessage(app.db, app.notifier, binding, input, deps);
    expect(second).toEqual({ state: "duplicate" });
    expect(deps.downloadResource).toHaveBeenCalledTimes(1);

    const stored = await app.db.select().from(messages);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      senderId: "integration:feishu",
      senderKind: "integration",
      senderProvider: "feishu",
      source: "feishu",
    });
    expect(stored[0]?.metadata).toMatchObject({
      mentions: [testAgent.agent.uuid],
      feishu: {
        direction: "inbound",
        botBindingId: binding.id,
        externalAuthor: { openId: "ou_human", displayName: "张三" },
        reference: { messageId: input.messageId, chatId: input.chatId, chatType: "p2p" },
      },
    });
    const inbox = await app.db.select().from(inboxEntries);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ messageId: stored[0]?.id, notify: true });
    const hydrated = await app.db.select().from(attachments);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]?.uploadedBy).toBe(`integration:feishu:${binding.id}`);
    const membership = await app.db.select().from(chatMembership);
    expect(membership).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: testAgent.agent.uuid, accessMode: "speaker" }),
        expect.objectContaining({ agentId: testAgent.humanAgentUuid, accessMode: "watcher" }),
      ]),
    );
    const workspace = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${testAgent.organizationId}/chats?engagement=active`,
      headers: { authorization: `Bearer ${testAgent.accessToken}` },
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json<{ rows: Array<{ chatId: string }> }>().rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ chatId: first.state === "created" ? first.chatId : "" })]),
    );
  });

  it("does nothing for an unmentioned group message and accepts the exact structured Bot mention", async () => {
    const app = getApp();
    const { binding } = await seedBinding();
    const deps = dependencies();
    const ignoredInput = normalizedMessage({ chatType: "group", chatId: "oc_group", mentionedBot: false });

    await expect(ingestFeishuMessage(app.db, app.notifier, binding, ignoredInput, deps)).resolves.toEqual({
      state: "ignored",
      reason: "group_without_mention",
    });
    expect(deps.downloadResource).not.toHaveBeenCalled();
    expect(await app.db.select().from(imChatBindings)).toEqual([]);
    expect(await app.db.select().from(messages)).toEqual([]);

    const otherBotMention = normalizedMessage({
      chatType: "group",
      chatId: "oc_group",
      mentionedBot: true,
      mentions: [{ key: "@_user_1", openId: "ou_other_bot", name: "Other Bot", isBot: true }],
    });
    await expect(ingestFeishuMessage(app.db, app.notifier, binding, otherBotMention, deps)).resolves.toEqual({
      state: "ignored",
      reason: "group_without_mention",
    });
    expect(await app.db.select().from(messages)).toEqual([]);

    const accepted = normalizedMessage({
      chatType: "group",
      chatId: "oc_group",
      mentionedBot: true,
      mentions: [{ key: "@_user_1", openId: "ou_bot", name: "Bot", isBot: true }],
      content: "@_user_1 work",
      raw: {
        header: { event_id: "event-group-mentioned" },
        event: { message: { message_type: "text", content: JSON.stringify({ text: "@_user_1 work" }) } },
      },
    });
    await expect(ingestFeishuMessage(app.db, app.notifier, binding, accepted, deps)).resolves.toMatchObject({
      state: "created",
    });
    const [stored] = await app.db.select().from(messages);
    expect(stored?.content).toBe("work");
  });

  it("drops Bot echoes before any binding or message side effect", async () => {
    const app = getApp();
    const { binding } = await seedBinding();
    const deps = dependencies();
    const input = normalizedMessage({ senderId: "ou_bot", senderName: "Bot" });
    await expect(ingestFeishuMessage(app.db, app.notifier, binding, input, deps)).resolves.toEqual({
      state: "ignored",
      reason: "bot_echo",
    });
    expect(await app.db.select().from(messages)).toEqual([]);
    expect(await app.db.select().from(imChatBindings)).toEqual([]);
  });
});
