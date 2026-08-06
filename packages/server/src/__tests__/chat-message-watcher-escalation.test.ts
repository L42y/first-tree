/**
 * HTTP-level regression coverage for the watcher → speaker self-promotion
 * hole on the two human write routes:
 *
 *   - `POST /api/v1/chats/:chatId/messages`
 *   - `POST /api/v1/chats/:chatId/requests/:requestId/ask-agent`
 *
 * Both routes used to call `ensureParticipant`, which is a membership
 * *write* (it upserts the caller to `access_mode='speaker'`), not a check.
 * A watcher therefore promoted themselves to speaker simply by sending —
 * bypassing `ensureCanJoin`, the guard the dedicated join route
 * (`POST /:chatId/workspace-join`) applies to exactly that transition.
 *
 * The web console already models the correct contract: a watcher gets a
 * read-only banner plus an explicit "Join to reply" button instead of a
 * composer. These tests pin the server side to that same contract.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMembership } from "../db/schema/chat-membership.js";
import { messages } from "../db/schema/messages.js";
import { createAgent } from "../services/agent.js";
import { createMeChat } from "../services/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("watcher self-promotion on human write routes", () => {
  const getApp = useTestApp();

  /**
   * Build a chat owned by `peer` containing a non-human agent managed by
   * `manager`. `recomputeChatWatchers` materialises a watcher row for the
   * manager's human agent — the exact shape the hole was reachable from.
   */
  async function seedWatcherChat(app: ReturnType<typeof getApp>) {
    const manager = await createTestAdmin(app);
    const peer = await createTestAdmin(app);
    const managed = await createAgent(app.db, {
      name: `esc-managed-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Escalation Managed",
      managerId: manager.memberId,
      organizationId: manager.organizationId,
    });
    const { chatId } = await createMeChat(app.db, peer.humanAgentUuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });
    return { manager, peer, managed, chatId };
  }

  /** Insert a `format='request'` message straight from the managed agent. */
  async function seedOpenRequest(
    app: ReturnType<typeof getApp>,
    chatId: string,
    senderId: string,
    targetHumanAgentId: string,
  ) {
    const messageId = crypto.randomUUID();
    await app.db.insert(messages).values({
      id: messageId,
      chatId,
      senderId,
      format: "request",
      content: "need a decision",
      metadata: { mentions: [targetHumanAgentId] },
      source: "agent",
    });
    return { messageId };
  }

  async function loadMembership(app: ReturnType<typeof getApp>, chatId: string, agentId: string) {
    const [row] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, agentId)))
      .limit(1);
    return row ?? null;
  }

  it("refuses a watcher's message with 403 and leaves them a watcher", async () => {
    const app = getApp();
    const { manager, managed, chatId } = await seedWatcherChat(app);

    // Precondition: the supervisor is a watcher, not a speaker.
    expect((await loadMembership(app, chatId, manager.humanAgentUuid))?.accessMode).toBe("watcher");

    // Carry an explicit recipient so the send would otherwise succeed —
    // membership is then the only thing standing between this request and a
    // persisted message, which is exactly what the guard must decide.
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      headers: { authorization: `Bearer ${manager.accessToken}` },
      payload: { content: "promoting myself by typing", metadata: { mentions: [managed.uuid] } },
    });

    expect(res.statusCode).toBe(403);

    // The membership row must be untouched — this is the actual regression.
    expect((await loadMembership(app, chatId, manager.humanAgentUuid))?.accessMode).toBe("watcher");

    // And no message may have been persisted.
    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
    expect(rows).toHaveLength(0);
  });

  it("still lets an actual speaker send (guard does not over-refuse)", async () => {
    const app = getApp();
    const owner = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `esc-speaker-peer-${crypto.randomUUID().slice(0, 6)}` });
    const { chatId } = await createMeChat(app.db, owner.humanAgentUuid, owner.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { content: "hello", metadata: { mentions: [peer.agent.uuid] } },
    });

    expect(res.statusCode).toBe(201);
    expect((await loadMembership(app, chatId, owner.humanAgentUuid))?.accessMode).toBe("speaker");
  });

  it("refuses a watcher's ask-agent clarification with 403 and leaves them a watcher", async () => {
    const app = getApp();
    const { manager, managed, chatId } = await seedWatcherChat(app);

    // The managed agent has an open request addressed at its owner-side
    // human, so there is something in the chat to clarify against.
    const { messageId } = await seedOpenRequest(app, chatId, managed.uuid, manager.humanAgentUuid);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(messageId)}/ask-agent`,
      headers: { authorization: `Bearer ${manager.accessToken}` },
      payload: { content: "clarify please" },
    });

    expect(res.statusCode).toBe(403);
    expect((await loadMembership(app, chatId, manager.humanAgentUuid))?.accessMode).toBe("watcher");

    // Only the seeded request survives — the clarification was not written.
    const rows = await app.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
    expect(rows.map((r) => r.id)).toEqual([messageId]);
  });
});
