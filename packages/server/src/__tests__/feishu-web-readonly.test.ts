import { describe, expect, it } from "vitest";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat/conversation.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Feishu Web read-only boundary", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
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
        tenantKey: "tenant-a",
        appSecretCipher: "encrypted-test-secret",
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
    });
    const headers = { authorization: `Bearer ${a.accessToken}` };
    return { app, a, chat, headers };
  }

  it("allows reads and private view state but rejects structural Web writes", async () => {
    const { app, a, chat, headers } = await setup();
    const detail = await app.inject({ method: "GET", url: `/api/v1/chats/${chat.id}`, headers });
    expect(detail.statusCode).toBe(200);

    const read = await app.inject({ method: "POST", url: `/api/v1/chats/${chat.id}/read`, headers });
    expect(read.statusCode).toBe(200);
    const pin = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/pin`,
      headers,
      payload: { pinned: true },
    });
    expect(pin.statusCode).toBe(200);

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/chats/${chat.id}`,
      headers,
      payload: { topic: "Web must not rename Feishu" },
    });
    expect(rename.statusCode).toBe(403);
    const send = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/messages`,
      headers,
      payload: { format: "text", content: "Web must not send", metadata: { mentions: [a.agent.uuid] } },
    });
    expect(send.statusCode).toBe(403);
    const addParticipant = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/participants`,
      headers,
      payload: { agentIds: [a.agent.uuid] },
    });
    expect(addParticipant.statusCode).toBe(403);
  });
});
