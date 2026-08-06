import { REMOVE_PARTICIPANT_OPEN_REQUEST_CODE } from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { cronJobs } from "../db/schema/cron-jobs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { upsertSessionState } from "../services/activity.js";
import { createChat, removeParticipant } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { appendLiveEvent } from "../services/session-event.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

describe("remove chat participant — canonical mutation + Web Class C", () => {
  const getApp = useTestApp();

  async function setupGroup() {
    const app = getApp();
    const uid = crypto.randomUUID().slice(0, 6);
    const owner = await createTestAdmin(app, { username: `rm-owner-${uid}` });
    const peer = await createTestAdmin(app, { username: `rm-peer-${uid}` });
    const agent = await createTestAgent(app, { name: `rm-agent-${uid}` });
    // Put owner's human + peer human + agent in one chat. createChat as owner human.
    const chat = await createChat(app.db, owner.humanAgentUuid, {
      type: "group",
      participantIds: [peer.humanAgentUuid, agent.agent.uuid],
    });
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}` };
    return { app, owner, peer, agent, chatId: chat.id, ownerHeaders };
  }

  it("Web DELETE removes an agent speaker and returns membershipKind null", async () => {
    const { app, agent, chatId, ownerHeaders } = await setupGroup();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      chatId,
      targetAgentId: agent.agent.uuid,
      membershipKind: null,
    });

    const speakers = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
    expect(speakers.map((s) => s.agentId)).not.toContain(agent.agent.uuid);
  });

  it("rejects self-remove with 400", async () => {
    const { app, owner, chatId, ownerHeaders } = await setupGroup();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${owner.humanAgentUuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when target is not a speaker", async () => {
    const { app, chatId, ownerHeaders } = await setupGroup();
    const stranger = await createTestAgent(app, { name: `rm-stranger-${crypto.randomUUID().slice(0, 6)}` });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${stranger.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when a same-org watcher (non-speaker) tries to remove", async () => {
    const { app, owner, peer, agent, chatId, ownerHeaders } = await setupGroup();
    // Demote peer to watcher by leaving as participant while still managing…
    // peer has no managed agent here. Instead: remove peer as speaker via owner,
    // then re-add as watcher only via recompute is hard. Simpler: use requireChatAccess
    // path — invite peer's managed...
    // Use a human who can see the chat as watcher: leave peer as speaker, then
    // have stranger admin who is NOT in the chat — requireChatAccess 404s.
    // Contract: non-speaker with chat access → 403 from mutation.
    // Promote peer to watcher-only: delete speaker and insert watcher row.
    await app.db
      .delete(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, peer.humanAgentUuid)));
    await app.db.insert(chatMembership).values({
      chatId,
      agentId: peer.humanAgentUuid,
      role: "member",
      accessMode: "watcher",
      mode: "full",
      source: "auto_manager",
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: { authorization: `Bearer ${peer.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
    void owner;
    void ownerHeaders;
  });

  it("downgrades a managing Human to watching when their agent remains", async () => {
    const { app, owner, peer, agent, chatId, ownerHeaders } = await setupGroup();
    // peer manages agent? peer is a separate admin — agent is managed by its own createTestAgent member.
    // Transfer: make peer the manager of agent so removing peer leaves watching.
    // Simpler path: remove owner while owner's managed agent stays — but owner created the chat via human.
    // Re-seed: agent's manager is agent.memberId. Invite that human (agent's manager human) as speaker,
    // then remove that human while agent stays → watching.
    const managerHuman = agent.humanAgentUuid;
    await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/participants`,
      headers: ownerHeaders,
      payload: { participantIds: [managerHuman] },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${managerHuman}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      chatId,
      targetAgentId: managerHuman,
      membershipKind: "watching",
    });

    const [row] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, managerHuman)))
      .limit(1);
    expect(row?.accessMode).toBe("watcher");
    // peer/owner still present — silence unused lint via void
    void peer;
    void owner;
  });

  it("preserves messages and chat_user_state after remove", async () => {
    const { app, owner, agent, chatId, ownerHeaders } = await setupGroup();
    await sendMessage(app.db, chatId, agent.agent.uuid, {
      source: "api",
      format: "markdown",
      content: "hello before remove",
      metadata: { mentions: [owner.humanAgentUuid] },
    });
    await app.db.insert(chatUserState).values({
      chatId,
      agentId: agent.agent.uuid,
      unreadMentionCount: 3,
      openRequestCount: 0,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);

    const [msg] = await app.db
      .select({ content: messages.content, senderId: messages.senderId })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.senderId, agent.agent.uuid)))
      .limit(1);
    expect(msg?.content).toBe("hello before remove");

    const [state] = await app.db
      .select({ unreadMentionCount: chatUserState.unreadMentionCount })
      .from(chatUserState)
      .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, agent.agent.uuid)))
      .limit(1);
    expect(state?.unreadMentionCount).toBe(3);
  });

  it("returns 409 OPEN_REQUEST_PENDING when target Human has open requests", async () => {
    const { app, owner, peer, chatId, ownerHeaders } = await setupGroup();
    await sendMessage(app.db, chatId, owner.humanAgentUuid, {
      source: "api",
      format: "request",
      content: "Need a decision",
      metadata: { mentions: [peer.humanAgentUuid], request: { question: "Ship today?" } },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${peer.humanAgentUuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: REMOVE_PARTICIPANT_OPEN_REQUEST_CODE });
  });

  it("cancels pending/delivered inbox rows for the removed target", async () => {
    const { app, owner, agent, chatId, ownerHeaders } = await setupGroup();
    await sendMessage(app.db, chatId, owner.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "wake agent",
      metadata: { mentions: [agent.agent.uuid] },
    });

    const before = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, agent.agent.inboxId), eq(inboxEntries.chatId, chatId)));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.status === "pending" || r.status === "delivered")).toBe(true);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);

    const after = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, agent.agent.inboxId), eq(inboxEntries.chatId, chatId)));
    expect(after.every((r) => r.status === "cancelled" || r.status === "acked")).toBe(true);
    expect(after.some((r) => r.status === "cancelled")).toBe(true);
  });

  it("evicts session, clears events, and fences late session writes", async () => {
    const { app, agent, chatId, ownerHeaders } = await setupGroup();
    await upsertSessionState(app.db, agent.agent.uuid, chatId, "active", agent.organizationId);
    await appendLiveEvent(app.db, agent.agent.uuid, chatId, {
      kind: "assistant_text",
      payload: { text: "live" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);

    const [session] = await app.db
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.agent.uuid), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    expect(session?.state).toBe("evicted");

    const events = await app.db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(and(eq(sessionEvents.agentId, agent.agent.uuid), eq(sessionEvents.chatId, chatId)));
    expect(events).toHaveLength(0);

    // Late frames must not revive.
    await upsertSessionState(app.db, agent.agent.uuid, chatId, "active", agent.organizationId);
    const [after] = await app.db
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.agent.uuid), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    expect(after?.state).toBe("evicted");

    const late = await appendLiveEvent(app.db, agent.agent.uuid, chatId, {
      kind: "assistant_text",
      payload: { text: "late" },
    });
    expect(late).toBeNull();
  });

  it("pauses active cron jobs when the job agent is removed", async () => {
    const { app, owner, agent, chatId, ownerHeaders } = await setupGroup();
    const jobId = crypto.randomUUID();
    await app.db.insert(cronJobs).values({
      id: jobId,
      ownerMemberId: owner.memberId,
      controlChatId: chatId,
      agentId: agent.agent.uuid,
      name: `rm-job-${jobId.slice(0, 6)}`,
      chatMode: "reuse_control_chat",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      prompt: "ping",
      state: "active",
      stateReason: null,
      nextRunAt: new Date(Date.now() + 60_000),
      revision: 1,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);

    const [job] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1);
    expect(job?.state).toBe("paused");
    expect(job?.stateReason).toBe("agent_not_speaker");
    expect(job?.nextRunAt).toBeNull();
  });

  it("keeps agent DELETE 204 contract while sharing the mutation", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: `rm-a1-${crypto.randomUUID().slice(0, 6)}` });
    const a2 = await createTestAgent(app, { name: `rm-a2-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, a1.agent.uuid, {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const del = await a1.request("DELETE", `/api/v1/agent/chats/${chat.id}/participants/${a2.agent.uuid}`);
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");
  });

  it("send/remove concurrency: send after remove is rejected; send before remove gets cancelled delivery", async () => {
    const { app, owner, agent, chatId, ownerHeaders } = await setupGroup();

    // Remove first, then send as removed agent → forbidden.
    await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    await expect(
      sendMessage(app.db, chatId, agent.agent.uuid, {
        source: "api",
        format: "markdown",
        content: "after remove",
        metadata: { mentions: [owner.humanAgentUuid] },
      }),
    ).rejects.toThrow();

    // Fresh chat: send then remove → inbox cancelled.
    const agent2 = await createTestAgent(app, { name: `rm-c2-${crypto.randomUUID().slice(0, 6)}` });
    const chatB = await createChat(app.db, owner.humanAgentUuid, {
      type: "group",
      participantIds: [agent2.agent.uuid],
    });
    await sendMessage(app.db, chatB.id, owner.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "pending wake",
      metadata: { mentions: [agent2.agent.uuid] },
    });
    await removeParticipant(app.db, chatB.id, owner.humanAgentUuid, agent2.agent.uuid);
    const rows = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, agent2.agent.inboxId),
          eq(inboxEntries.chatId, chatB.id),
          inArray(inboxEntries.status, ["pending", "delivered", "cancelled"]),
        ),
      );
    expect(rows.some((r) => r.status === "cancelled")).toBe(true);
  });
});
