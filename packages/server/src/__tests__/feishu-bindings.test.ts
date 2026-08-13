import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat/conversation.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

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

describe("Feishu CLI setup Task", () => {
  const getApp = useTestApp();

  async function requestSetupChat(app: FastifyInstance, accessToken: string, agentUuid: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentUuid}/feishu-binding/setup-chat`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { requestInstall: true },
    });
  }

  it("returns one Task however many times the same member asks for it", async () => {
    // The automatic OpenTag preparation, a reload, a retry, and a second tab
    // all hit this endpoint for the same Agent on the same Computer. Each one
    // opening its own Task would bury the member's workspace in identical
    // conversations about a machine check they never asked for.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });

    const first = await requestSetupChat(app, a.accessToken, a.agent.uuid);
    const second = await requestSetupChat(app, a.accessToken, a.agent.uuid);
    const third = await requestSetupChat(app, a.accessToken, a.agent.uuid);

    expect(first.statusCode).toBe(201);
    const chatId = first.json<{ chatId: string }>().chatId;
    expect(second.json<{ chatId: string }>().chatId).toBe(chatId);
    expect(third.json<{ chatId: string }>().chatId).toBe(chatId);

    // The reuse is a real reuse, not three chats sharing a response shape.
    const opening = await app.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(opening).toHaveLength(1);
  });

  it("opens a new Task when the Agent moves to another Computer", async () => {
    // The capability the Task establishes is a fact about one machine, so a
    // move genuinely needs a new check there. Reusing the old Computer's Task
    // would answer a question about a machine the Agent no longer runs on.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const firstChatId = (await requestSetupChat(app, a.accessToken, a.agent.uuid)).json<{ chatId: string }>().chatId;

    const movedClientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: movedClientId,
      userId: a.userId,
      organizationId: a.organizationId,
      status: "connected",
    });
    await app.db.update(agents).set({ clientId: movedClientId }).where(eq(agents.uuid, a.agent.uuid));

    const moved = await requestSetupChat(app, a.accessToken, a.agent.uuid);
    expect(moved.json<{ chatId: string }>().chatId).not.toBe(firstChatId);

    // Moving back converges on the original Task rather than a third one: the
    // key describes the machine, not the order the member visited them in.
    await app.db.update(agents).set({ clientId: a.clientId }).where(eq(agents.uuid, a.agent.uuid));
    const back = await requestSetupChat(app, a.accessToken, a.agent.uuid);
    expect(back.json<{ chatId: string }>().chatId).toBe(firstChatId);
  });

  it("keeps one administrator out of another's private setup Task", async () => {
    // The Task is a private conversation between one human and one Agent. Two
    // admins may both manage the same Agent, and joining the second one to the
    // first one's chat would hand them a private history they were never in.
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const other = await createTestAdmin(app, { username: `admin-${crypto.randomUUID().slice(0, 8)}` });

    const mine = (await requestSetupChat(app, a.accessToken, a.agent.uuid)).json<{ chatId: string }>().chatId;
    const theirs = await requestSetupChat(app, other.accessToken, a.agent.uuid);

    expect(theirs.statusCode).toBe(201);
    expect(theirs.json<{ chatId: string }>().chatId).not.toBe(mine);
  });
});
