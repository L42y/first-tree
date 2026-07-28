import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentPresence } from "../db/schema/agent-presence.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { createAgent } from "../services/agent.js";
import { createMeChat, listMeChats, pinMeChat } from "../services/me-chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * The chat list has exactly two ordering tiers: the caller's complete private
 * pin projection, then the additive activity-ordered stream. Open requests,
 * unread state, and recovery are row status only and never promote a chat.
 */
describe("listMeChats — pins plus ordinary recency", () => {
  const getApp = useTestApp();

  type Admin = Awaited<ReturnType<typeof createTestAdmin>>;
  type ListResult = Awaited<ReturnType<typeof listMeChats>>;

  async function ownerUserId(app: FastifyInstance, owner: Admin): Promise<string> {
    const [row] = await app.db.select().from(members).where(eq(members.id, owner.memberId)).limit(1);
    if (!row) throw new Error("owner member missing");
    return row.userId;
  }

  async function managedAgent(
    app: FastifyInstance,
    owner: Admin,
    name: string,
  ): Promise<{ uuid: string; clientId: string }> {
    const clientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: clientId,
      userId: await ownerUserId(app, owner),
      organizationId: owner.organizationId,
      status: "connected",
    });
    const agent = await createAgent(app.db, {
      name,
      type: "agent",
      displayName: name,
      managerId: owner.memberId,
      organizationId: owner.organizationId,
      clientId,
    });
    if (!agent) throw new Error("managed agent setup failed");
    return { uuid: agent.uuid, clientId };
  }

  async function chatWith(app: FastifyInstance, owner: Admin, agentUuid: string, topic: string): Promise<string> {
    const result = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [agentUuid],
      topic,
    });
    return result.chatId;
  }

  async function setActivity(app: FastifyInstance, chatId: string, iso: string): Promise<void> {
    await app.db
      .update(chats)
      .set({ activityAt: new Date(iso) })
      .where(eq(chats.id, chatId));
  }

  async function raiseRequest(app: FastifyInstance, chatId: string, fromAgent: string, toHuman: string): Promise<void> {
    await sendMessage(app.db, chatId, fromAgent, {
      source: "api",
      format: "request",
      content: "Please decide",
      metadata: { mentions: [toHuman] },
    });
  }

  async function markFailed(app: FastifyInstance, agentUuid: string, clientId: string, chatId: string): Promise<void> {
    await app.db
      .insert(agentPresence)
      .values({ agentId: agentUuid, clientId, lastSeenAt: new Date(), activeSessions: 0, totalSessions: 0 })
      .onConflictDoUpdate({ target: [agentPresence.agentId], set: { clientId, lastSeenAt: new Date() } });
    await app.db.execute(sql`
      INSERT INTO agent_chat_sessions (agent_id, chat_id, state, runtime_state, updated_at)
      VALUES (${agentUuid}, ${chatId}, 'errored', 'idle', NOW())
      ON CONFLICT (agent_id, chat_id) DO UPDATE SET state = 'errored', updated_at = NOW()
    `);
  }

  function list(
    app: FastifyInstance,
    owner: Admin,
    query: Partial<Parameters<typeof listMeChats>[4]> = {},
  ): Promise<ListResult> {
    return listMeChats(app.db, owner.humanAgentUuid, owner.memberId, owner.organizationId, {
      limit: 50,
      filter: "all",
      engagement: "all",
      ...query,
    });
  }

  it("returns every pin in activity order while keeping rows additive", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "pin-peer");
    const first = await chatWith(app, owner, peer.uuid, "first");
    const second = await chatWith(app, owner, peer.uuid, "second");

    await pinMeChat(app.db, first, owner.humanAgentUuid, true);
    await pinMeChat(app.db, second, owner.humanAgentUuid, true);
    await setActivity(app, first, "2026-07-02T00:00:00.000Z");
    await setActivity(app, second, "2026-07-01T00:00:00.000Z");

    const result = await list(app, owner);
    expect(result.priorityRows.pinned.map((row) => row.chatId)).toEqual([first, second]);
    expect(result.rows.map((row) => row.chatId)).toEqual(expect.arrayContaining([first, second]));
  });

  it("surfaces a low-activity pin on page one without removing it from recency pagination", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "old-pin-peer");
    const newest = await chatWith(app, owner, peer.uuid, "newest");
    const middle = await chatWith(app, owner, peer.uuid, "middle");
    const oldPin = await chatWith(app, owner, peer.uuid, "old pin");
    await setActivity(app, newest, "2026-06-03T00:00:00.000Z");
    await setActivity(app, middle, "2026-06-02T00:00:00.000Z");
    await setActivity(app, oldPin, "2020-01-01T00:00:00.000Z");
    await pinMeChat(app.db, oldPin, owner.humanAgentUuid, true);

    const firstPage = await list(app, owner, { limit: 2 });
    expect(firstPage.priorityRows.pinned.map((row) => row.chatId)).toEqual([oldPin]);
    expect(firstPage.rows.map((row) => row.chatId)).toEqual([newest, middle]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await list(app, owner, { limit: 2, cursor: firstPage.nextCursor ?? undefined });
    expect(secondPage.priorityRows).toEqual({ pinned: [] });
    expect(secondPage.rows.map((row) => row.chatId)).toContain(oldPin);
  });

  it("keeps ask and recovery states in ordinary activity order", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const askPeer = await managedAgent(app, owner, "ask-peer");
    const failedPeer = await managedAgent(app, owner, "failed-peer");
    const quietPeer = await managedAgent(app, owner, "quiet-peer");
    const askChat = await chatWith(app, owner, askPeer.uuid, "ask");
    const failedChat = await chatWith(app, owner, failedPeer.uuid, "failed");
    const quietChat = await chatWith(app, owner, quietPeer.uuid, "quiet");
    await raiseRequest(app, askChat, askPeer.uuid, owner.humanAgentUuid);
    await markFailed(app, failedPeer.uuid, failedPeer.clientId, failedChat);
    await setActivity(app, quietChat, "2026-07-03T00:00:00.000Z");
    await setActivity(app, askChat, "2026-07-02T00:00:00.000Z");
    await setActivity(app, failedChat, "2026-07-01T00:00:00.000Z");

    const result = await list(app, owner);
    expect(result.priorityRows.pinned).toEqual([]);
    expect(result.rows.slice(0, 3).map((row) => row.chatId)).toEqual([quietChat, askChat, failedChat]);
    expect(result.rows.find((row) => row.chatId === askChat)?.openRequestCount).toBe(1);
    expect(result.rows.find((row) => row.chatId === failedChat)?.failedAgentIds).toContain(failedPeer.uuid);
  });

  it("keeps a pinned ask in the pin projection with its ask status intact", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "pinned-ask-peer");
    const chatId = await chatWith(app, owner, peer.uuid, "pinned ask");
    await pinMeChat(app.db, chatId, owner.humanAgentUuid, true);
    await raiseRequest(app, chatId, peer.uuid, owner.humanAgentUuid);

    const result = await list(app, owner);
    expect(result.priorityRows.pinned.find((row) => row.chatId === chatId)?.openRequestCount).toBe(1);
    expect(result.rows.find((row) => row.chatId === chatId)?.openRequestCount).toBe(1);
  });

  it("applies active origin filters to pins and rows alike", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "origin-peer");
    const manualChat = await chatWith(app, owner, peer.uuid, "manual");
    const githubChat = await chatWith(app, owner, peer.uuid, "github");
    await app.db
      .update(chats)
      .set({ metadata: { source: "github", entityType: "github_pull_request" } })
      .where(eq(chats.id, githubChat));
    await pinMeChat(app.db, manualChat, owner.humanAgentUuid, true);
    await pinMeChat(app.db, githubChat, owner.humanAgentUuid, true);

    const manualOnly = await list(app, owner, { origin: ["manual"] });
    expect(manualOnly.priorityRows.pinned.map((row) => row.chatId)).toEqual([manualChat]);
    expect(manualOnly.rows.map((row) => row.chatId)).not.toContain(githubChat);

    const githubOnly = await list(app, owner, { origin: ["github"] });
    expect(githubOnly.priorityRows.pinned.map((row) => row.chatId)).toEqual([githubChat]);
    expect(githubOnly.rows.map((row) => row.chatId)).not.toContain(manualChat);
  });

  it("walks the complete activity-ordered stream without gaps or duplicates", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await managedAgent(app, owner, "page-peer");
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const chatId = await chatWith(app, owner, peer.uuid, `c-${index}`);
      await setActivity(app, chatId, `2026-05-0${index + 1}T00:00:00.000Z`);
      ids.push(chatId);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await list(app, owner, { limit: 2, cursor });
      seen.push(...page.rows.map((row) => row.chatId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...ids].reverse());
  });
});
