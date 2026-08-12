import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat/conversation.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Feishu binding lifecycle", () => {
  const getApp = useTestApp();

  it("soft-revokes credentials and mappings, then permits a replacement binding", async () => {
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
        appSecretCipher: "encrypted-secret",
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

    await expect(
      app.db.insert(imBotBindings).values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
      }),
    ).rejects.toThrow();

    await app.feishuIntegration.revoke(a.agent.uuid);
    const [revoked] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, binding.id));
    expect(revoked).toMatchObject({
      status: "revoked",
      appSecretCipher: null,
      registrationStateCipher: null,
      connectionStatus: "disconnected",
      connectionOwnerInstanceId: null,
      connectionLeaseExpiresAt: null,
    });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    const [detached] = await app.db.select().from(imChatBindings).where(eq(imChatBindings.botBindingId, binding.id));
    expect(detached?.status).toBe("detached");

    await expect(
      app.db.insert(imBotBindings).values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
      }),
    ).resolves.toBeDefined();
  });

  it("keeps one Bot plus Feishu chat mapped to one canonical chat", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const firstChat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const secondChat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const [binding] = await app.db
      .insert(imBotBindings)
      .values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
      })
      .returning();
    if (!binding) throw new Error("binding setup failed");
    await app.db.insert(imChatBindings).values({
      id: `chat-binding-${crypto.randomUUID()}`,
      botBindingId: binding.id,
      feishuChatId: "oc_feishu",
      chatId: firstChat.id,
      feishuChatType: "group",
    });
    await expect(
      app.db.insert(imChatBindings).values({
        id: `chat-binding-${crypto.randomUUID()}`,
        botBindingId: binding.id,
        feishuChatId: "oc_feishu",
        chatId: secondChat.id,
        feishuChatType: "group",
      }),
    ).rejects.toThrow();
  });

  it("keeps an expiring connection-owner snapshot when a server instance is removed", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const ownerInstanceId = `owner-${crypto.randomUUID()}`;
    const leaseExpiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    await app.db.insert(serverInstances).values({ instanceId: ownerInstanceId, lastHeartbeat: new Date() });
    const [binding] = await app.db
      .insert(imBotBindings)
      .values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
        connectionOwnerInstanceId: ownerInstanceId,
        connectionLeaseExpiresAt: leaseExpiresAt,
      })
      .returning();
    if (!binding) throw new Error("binding setup failed");

    await app.db.delete(serverInstances).where(eq(serverInstances.instanceId, ownerInstanceId));

    const [persisted] = await app.db.select().from(imBotBindings).where(eq(imBotBindings.id, binding.id));
    expect(persisted?.connectionOwnerInstanceId).toBe(ownerInstanceId);
    expect(persisted?.connectionLeaseExpiresAt?.getTime()).toBe(leaseExpiresAt.getTime());
  });
});
