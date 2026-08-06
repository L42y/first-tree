import { CRON_TRIGGER_METADATA_KEY, REMOVE_PARTICIPANT_OPEN_REQUEST_CODE } from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { connectDatabase, sslOptions } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { clients } from "../db/schema/clients.js";
import { cronJobs } from "../db/schema/cron-jobs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { ConflictError } from "../errors.js";
import { upsertSessionState } from "../services/activity.js";
import { createAgent } from "../services/agent.js";
import { createChat, ensureParticipant, removeParticipant } from "../services/chat.js";
import { lockChatMembershipMutation } from "../services/chat-membership-lock.js";
import * as connectionManager from "../services/connection-manager.js";
import {
  bindAgentToClient,
  removeClientConnection,
  sendToAgent,
  setClientConnection,
} from "../services/connection-manager.js";
import { createCronJob, loadOutstanding, lockOwnerChatCronBarrier, updateCronJob } from "../services/cron-job.js";
import { sweepCronJobs } from "../services/cron-scheduler.js";
import { ackThroughEntryIdForBoundAgents, pollInbox, pruneStaleSilentEntries } from "../services/inbox.js";
import { sendMessage } from "../services/message.js";
import {
  softTerminateRemovedAgentSession,
  withLiveInboxDeliveryFence,
  withLiveRemovedSessionFence,
} from "../services/remove-chat-participant.js";
import { lockAndValidateScmPersonnelPlacement } from "../services/scm-target-chat-policy.js";
import { resumeSuspendedSession } from "../services/session.js";
import { appendLiveEvent } from "../services/session-event.js";
import { createAdminContext, createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

function databaseUrlWithApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function waitForPostgresLockWait(observer: ReturnType<typeof postgres>, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer<{ wait_event_type: string | null }[]>`
      SELECT wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
    `;
    if (rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

async function seedDispatchRoute(
  app: ReturnType<ReturnType<typeof useTestApp>>,
  agentId: string,
  clientId: string,
): Promise<void> {
  const now = new Date();
  const instanceId = app.config.instanceId;
  await app.db
    .update(clients)
    .set({ status: "connected", instanceId, lastSeenAt: now, pausedReason: null })
    .where(eq(clients.id, clientId));
  await app.db
    .insert(agentPresence)
    .values({
      agentId,
      status: "online",
      clientId,
      instanceId,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [agentPresence.agentId],
      set: { status: "online", clientId, instanceId, lastSeenAt: now },
    });
  await app.db
    .insert(serverInstances)
    .values({ instanceId, lastHeartbeat: now })
    .onConflictDoUpdate({
      target: [serverInstances.instanceId],
      set: { lastHeartbeat: now },
    });
}

function cronTriggerMessages(rows: Array<{ metadata: unknown }>, jobId: string) {
  return rows.filter((row) => {
    const meta = row.metadata as Record<string, unknown>;
    const trigger = meta?.[CRON_TRIGGER_METADATA_KEY] as { jobId?: string } | undefined;
    return trigger?.jobId === jobId;
  });
}

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

  it("pauses active cron jobs when the owning Human speaker is removed", async () => {
    const { app, owner, agent, chatId, ownerHeaders } = await setupGroup();
    // Legal product shape: the managing human of the wake agent is a speaker and
    // owns the job; removing that human must pause with owner_not_speaker while
    // watcher recompute keeps them watching the still-present managed agent.
    await ensureParticipant(app.db, chatId, agent.humanAgentUuid);
    const jobId = crypto.randomUUID();
    await app.db.insert(cronJobs).values({
      id: jobId,
      ownerMemberId: agent.memberId,
      controlChatId: chatId,
      agentId: agent.agent.uuid,
      name: `rm-own-${jobId.slice(0, 6)}`,
      chatMode: "reuse_control_chat",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
      prompt: "owner human removed",
      state: "active",
      stateReason: null,
      nextRunAt: new Date(Date.now() + 60_000),
      revision: 1,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.humanAgentUuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      chatId,
      targetAgentId: agent.humanAgentUuid,
      membershipKind: "watching",
    });

    const [job] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1);
    expect(job?.state).toBe("paused");
    expect(job?.stateReason).toBe("owner_not_speaker");
    expect(job?.nextRunAt).toBeNull();
    void owner;
  });

  it("remove with outstanding trigger → cancel clears pointer → GC → re-add/resume/sweep continues", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `rm-out-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    const chatId = chat.id;
    await seedDispatchRoute(app, runtime.agent.uuid, runtime.clientId);

    const sent = await sendMessage(app.db, chatId, runtime.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "cron outstanding before remove",
      metadata: { mentions: [runtime.agent.uuid] },
    });
    const outstandingBefore = await app.db
      .select({ status: inboxEntries.status, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, runtime.agent.inboxId),
          eq(inboxEntries.messageId, sent.message.id),
          eq(inboxEntries.notify, true),
        ),
      );
    expect(outstandingBefore.some((r) => r.status === "pending" || r.status === "delivered")).toBe(true);

    const jobId = crypto.randomUUID();
    const pausedJobId = crypto.randomUUID();
    await app.db.insert(cronJobs).values([
      {
        id: jobId,
        ownerMemberId: runtime.memberId,
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        name: `rm-out-${jobId.slice(0, 6)}`,
        chatMode: "reuse_control_chat",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        prompt: "wake after re-add",
        state: "active",
        stateReason: null,
        nextRunAt: new Date(Date.now() + 60_000),
        lastTriggerMessageId: sent.message.id,
        revision: 1,
      },
      {
        // Already-paused job must also lose the outstanding pointer on cancel.
        id: pausedJobId,
        ownerMemberId: runtime.memberId,
        controlChatId: chatId,
        agentId: runtime.agent.uuid,
        name: `rm-paused-${pausedJobId.slice(0, 6)}`,
        chatMode: "reuse_control_chat",
        cronExpression: "0 2 * * *",
        timezone: "UTC",
        prompt: "already paused",
        state: "paused",
        stateReason: "user_paused",
        nextRunAt: null,
        lastTriggerMessageId: sent.message.id,
        revision: 1,
      },
    ]);

    await removeParticipant(app.db, chatId, runtime.humanAgentUuid, runtime.agent.uuid);

    const cancelledRows = await app.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, runtime.agent.inboxId),
          eq(inboxEntries.messageId, sent.message.id),
          eq(inboxEntries.notify, true),
        ),
      );
    expect(cancelledRows.every((r) => r.status === "cancelled")).toBe(true);

    const [paused] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1);
    expect(paused?.state).toBe("paused");
    expect(paused?.stateReason).toBe("agent_not_speaker");
    expect(paused?.lastTriggerMessageId).toBeNull();

    const [alreadyPaused] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, pausedJobId)).limit(1);
    expect(alreadyPaused?.state).toBe("paused");
    expect(alreadyPaused?.lastTriggerMessageId).toBeNull();

    expect(await loadOutstanding(app.db, paused!)).toBeNull();

    const pruned = await pruneStaleSilentEntries(app.db);
    expect(pruned.cancelledDeleted).toBeGreaterThan(0);
    const afterGc = await app.db
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, runtime.agent.inboxId),
          eq(inboxEntries.messageId, sent.message.id),
          eq(inboxEntries.status, "cancelled"),
        ),
      );
    expect(afterGc).toHaveLength(0);

    // Pointer cleared: GC'd cancelled row must not surface as inbox_state_missing.
    expect(await loadOutstanding(app.db, { ...paused!, lastTriggerMessageId: null })).toBeNull();

    await ensureParticipant(app.db, chatId, runtime.agent.uuid);
    await seedDispatchRoute(app, runtime.agent.uuid, runtime.clientId);

    const resumed = await updateCronJob(app.db, {
      jobId,
      expectedRevision: paused!.revision,
      ownerMemberId: runtime.memberId,
      body: { state: "active" },
    });
    expect(resumed.state).toBe("active");
    expect(resumed.stateReason).toBeNull();
    expect(resumed.outstanding).toBeNull();

    await app.db
      .update(cronJobs)
      .set({ nextRunAt: new Date(Date.now() - 5_000) })
      .where(eq(cronJobs.id, jobId));

    const beforeTriggers = cronTriggerMessages(
      await app.db.select().from(messages).where(eq(messages.chatId, chatId)),
      jobId,
    ).length;

    await sweepCronJobs(app.db, app.notifier, {
      staleSeconds: app.config.runtime.presenceCleanupSeconds,
    });

    const [afterSweep] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1);
    expect(afterSweep?.state).toBe("active");
    expect(afterSweep?.stateReason).not.toBe("inbox_state_missing");
    expect(afterSweep?.stateReason).toBeNull();

    const afterTriggers = cronTriggerMessages(
      await app.db.select().from(messages).where(eq(messages.chatId, chatId)),
      jobId,
    );
    expect(afterTriggers.length).toBeGreaterThan(beforeTriggers);
    expect(afterSweep?.lastTriggerMessageId).toBeTruthy();
    expect(afterSweep?.lastTriggerMessageId).not.toBe(sent.message.id);
  });

  it("loadOutstanding treats cancelled as settled and a missing delivery row as missing", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `rm-lo-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    const chatId = chat.id;

    const sent = await sendMessage(app.db, chatId, runtime.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "outstanding projection",
      metadata: { mentions: [runtime.agent.uuid] },
    });

    const jobBase = {
      agentId: runtime.agent.uuid,
      controlChatId: chatId,
      lastTriggerMessageId: sent.message.id,
    };

    await app.db
      .update(inboxEntries)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(inboxEntries.inboxId, runtime.agent.inboxId),
          eq(inboxEntries.messageId, sent.message.id),
          eq(inboxEntries.notify, true),
        ),
      );
    expect(await loadOutstanding(app.db, jobBase)).toBeNull();

    await app.db
      .delete(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, runtime.agent.inboxId),
          eq(inboxEntries.messageId, sent.message.id),
          eq(inboxEntries.chatId, chatId),
        ),
      );
    expect(await loadOutstanding(app.db, jobBase)).toBe("missing");
  });

  it("resume after remove returns 409 and never sends session:resume", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `rm-res-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    await app.db
      .insert(agentChatSessions)
      .values({ agentId: runtime.agent.uuid, chatId: chat.id, state: "suspended" })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state: "suspended", updatedAt: new Date() },
      });

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(runtime.clientId, ws as unknown as WebSocket);
    bindAgentToClient(runtime.clientId, runtime.agent.uuid);
    try {
      await removeParticipant(app.db, chat.id, runtime.humanAgentUuid, runtime.agent.uuid);

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${runtime.agent.uuid}/sessions/${chat.id}/resume`,
        headers: { authorization: `Bearer ${runtime.accessToken}` },
      });
      expect(res.statusCode).toBe(409);
      expect(ws.send).not.toHaveBeenCalledWith(
        JSON.stringify({ type: "session:resume", chatId: chat.id, agentId: runtime.agent.uuid }),
      );
    } finally {
      removeClientConnection(runtime.clientId, ws as unknown as WebSocket);
    }
  });

  it("resume shared fence blocks remove until resume finishes; terminate is the last wake", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `rm-rsf-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    const chatId = chat.id;
    await app.db
      .insert(agentChatSessions)
      .values({ agentId: runtime.agent.uuid, chatId, state: "suspended" })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state: "suspended", updatedAt: new Date() },
      });
    await seedDispatchRoute(app, runtime.agent.uuid, runtime.clientId);

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(runtime.clientId, ws as unknown as WebSocket);
    bindAgentToClient(runtime.clientId, runtime.agent.uuid);

    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for resume/remove concurrency test");

    const resumeAppName = `rm_res_sh_${crypto.randomUUID().slice(0, 8)}`;
    const removeAppName = `rm_res_rm_${crypto.randomUUID().slice(0, 8)}`;
    const resumePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, resumeAppName));
    const removePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, removeAppName));
    const observer = postgres(databaseUrl, { max: 1, idle_timeout: 5, ...(sslOptions(databaseUrl) ?? {}) });

    try {
      let releaseResume!: () => void;
      const resumeHeld = new Promise<void>((resolve) => {
        releaseResume = resolve;
      });
      let resumeReady!: () => void;
      const resumeReadyP = new Promise<void>((resolve) => {
        resumeReady = resolve;
      });

      const resumePromise = resumeSuspendedSession(resumePool, runtime.agent.uuid, chatId, {
        afterMembershipFenceForTest: async () => {
          resumeReady();
          await resumeHeld;
        },
      });

      await Promise.race([
        resumeReadyP,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("resume fence barrier timeout")), 10_000);
        }),
      ]);

      const removePromise = removeParticipant(removePool, chatId, runtime.humanAgentUuid, runtime.agent.uuid);
      await waitForPostgresLockWait(observer, removeAppName);

      releaseResume();
      const [resumeResult] = await Promise.race([
        Promise.all([resumePromise, removePromise]),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("resume-vs-remove deadlock timeout")), 15_000);
        }),
      ]);
      expect(resumeResult.delivered).toBe(true);
      expect(resumeResult.state).toBe("suspended");

      // remove's soft terminate is post-commit `void`; drive it explicitly so the
      // wake ordering assertion is deterministic.
      await softTerminateRemovedAgentSession({
        db: app.db,
        agentId: runtime.agent.uuid,
        chatId,
      });

      const frames = ws.send.mock.calls.map((call) => JSON.parse(String(call[0])) as { type: string });
      const resumeIdx = frames.findIndex((f) => f.type === "session:resume");
      const terminateIdx = frames.findIndex((f) => f.type === "session:terminate");
      expect(resumeIdx).toBeGreaterThanOrEqual(0);
      expect(terminateIdx).toBeGreaterThanOrEqual(0);
      // Resume delivered while it still held shared; terminate must be last wake.
      expect(resumeIdx).toBeLessThan(terminateIdx);
      expect(frames.filter((f) => f.type === "session:resume").length).toBe(1);
    } finally {
      removeClientConnection(runtime.clientId, ws as unknown as WebSocket);
      await resumePool.end();
      await removePool.end();
      await observer.end();
    }
  });

  it("exclusive remove ahead of resume: blocked resume sees non-speaker and skips resume send", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `rm-rex-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    const chatId = chat.id;
    await app.db
      .insert(agentChatSessions)
      .values({ agentId: runtime.agent.uuid, chatId, state: "suspended" })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state: "suspended", updatedAt: new Date() },
      });

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(runtime.clientId, ws as unknown as WebSocket);
    bindAgentToClient(runtime.clientId, runtime.agent.uuid);

    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for exclusive-remove resume test");

    const exclusiveAppName = `rm_ex_hold_${crypto.randomUUID().slice(0, 8)}`;
    const resumeAppName = `rm_ex_res_${crypto.randomUUID().slice(0, 8)}`;
    const exclusivePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, exclusiveAppName));
    const resumePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, resumeAppName));
    const observer = postgres(databaseUrl, { max: 1, idle_timeout: 5, ...(sslOptions(databaseUrl) ?? {}) });

    try {
      let resumePromise!: ReturnType<typeof resumeSuspendedSession>;
      await exclusivePool.transaction(async (tx) => {
        await lockChatMembershipMutation(tx as never, [chatId]);

        resumePromise = resumeSuspendedSession(resumePool, runtime.agent.uuid, chatId);
        await waitForPostgresLockWait(observer, resumeAppName);

        // Commit speaker detach under the exclusive fence while resume waits.
        // Same durable membership outcome remove uses before soft terminate.
        await tx
          .delete(chatMembership)
          .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, runtime.agent.uuid)));
      });

      await expect(resumePromise).rejects.toBeInstanceOf(ConflictError);
      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      removeClientConnection(runtime.clientId, ws as unknown as WebSocket);
      await exclusivePool.end();
      await resumePool.end();
      await observer.end();
    }
  });

  it("outstanding-pointer remove and owner engagement delete complete without deadlock", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `rm-eng-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    const chatId = chat.id;
    const sent = await sendMessage(app.db, chatId, runtime.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "outstanding for lock-order",
      metadata: { mentions: [runtime.agent.uuid] },
    });
    const jobId = crypto.randomUUID();
    await app.db.insert(cronJobs).values({
      id: jobId,
      ownerMemberId: runtime.memberId,
      controlChatId: chatId,
      agentId: runtime.agent.uuid,
      name: `rm-eng-${jobId.slice(0, 6)}`,
      chatMode: "reuse_control_chat",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      prompt: "ping",
      state: "paused",
      stateReason: "user_paused",
      nextRunAt: null,
      lastTriggerMessageId: sent.message.id,
      revision: 1,
    });

    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for engagement/remove lock test");
    const removeAppName = `rm_eng_rm_${crypto.randomUUID().slice(0, 8)}`;
    const engAppName = `rm_eng_de_${crypto.randomUUID().slice(0, 8)}`;
    const removePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, removeAppName));
    const engPool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, engAppName));
    const observer = postgres(databaseUrl, { max: 1, idle_timeout: 5, ...(sslOptions(databaseUrl) ?? {}) });

    try {
      // Deterministic: engagement holds owner-chat barrier first. New remove waits on
      // that barrier before touching cron rows, so this txn can FOR UPDATE the job.
      // Old remove (cron row → barrier) would already hold the cron row and deadlock.
      let removePromise!: Promise<unknown>;
      await engPool.transaction(async (tx) => {
        await lockOwnerChatCronBarrier(tx as never, chatId, runtime.memberId);

        removePromise = removeParticipant(removePool, chatId, runtime.humanAgentUuid, runtime.agent.uuid);
        await waitForPostgresLockWait(observer, removeAppName);

        const locked = await tx
          .select({ id: cronJobs.id })
          .from(cronJobs)
          .where(eq(cronJobs.id, jobId))
          .for("update")
          .limit(1);
        expect(locked).toHaveLength(1);
      });

      await Promise.race([
        removePromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("remove vs engagement-delete deadlock timeout")), 15_000);
        }),
      ]);

      const [job] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1);
      expect(job?.lastTriggerMessageId).toBeNull();
    } finally {
      await removePool.end();
      await engPool.end();
      await observer.end();
    }
  });

  it("cron create membership-first (Class D and no-caller) does not deadlock against SCM exclusive placement", async () => {
    const app = getApp();
    const runtime = await createTestAgent(app, { name: `rm-scm-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    const chatId = chat.id;

    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for cron/SCM lock test");

    async function contendCreatePath(label: string, withCaller: boolean): Promise<void> {
      const cronAppName = `rm_scm_${label}_${crypto.randomUUID().slice(0, 6)}`;
      const scmAppName = `rm_scm_${label}_s_${crypto.randomUUID().slice(0, 6)}`;
      const cronPool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, cronAppName));
      const scmPool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, scmAppName));
      const observer = postgres(databaseUrl, { max: 1, idle_timeout: 5, ...(sslOptions(databaseUrl) ?? {}) });

      try {
        // Reverse of the weak order: SCM holds membership exclusive first. Create waits
        // on shared. New create has not taken member/agent yet, so SCM can finish
        // lockAndValidateScmPersonnelPlacement; old member/agent→membership would deadlock.
        let createPromise!: Promise<unknown>;
        await scmPool.transaction(async (tx) => {
          await lockChatMembershipMutation(tx as never, [chatId]);

          createPromise = createCronJob(cronPool, {
            controlChatId: chatId,
            agentId: runtime.agent.uuid,
            body: {
              name: `rm-scm-${label}-${crypto.randomUUID().slice(0, 6)}`,
              schedule: "0 3 * * *",
              timezone: "UTC",
              prompt: "lock order",
            },
            ...(withCaller
              ? {
                  callerMemberId: runtime.memberId,
                  callerHumanAgentId: runtime.humanAgentUuid,
                }
              : {}),
          });
          await waitForPostgresLockWait(observer, cronAppName);

          const placement = await lockAndValidateScmPersonnelPlacement(tx as never, {
            humanAgentId: runtime.humanAgentUuid,
            wakeAgentId: runtime.agent.uuid,
            candidateChatIds: [chatId],
          });
          // Placement may be null for ordinary group chats; completing member/agent
          // locks under exclusive without deadlock is the gate.
          void placement;
        });

        await Promise.race([
          createPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`${label}: cron vs SCM deadlock timeout`)), 15_000);
          }),
        ]);
      } finally {
        await cronPool.end();
        await scmPool.end();
        await observer.end();
      }
    }

    await contendCreatePath("d", true);
    await contendCreatePath("n", false);
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

  it("remove vs due cron sweep: membership-before-cron lock order — no deadlock, no post-remove trigger", async () => {
    const app = getApp();
    // Same managing human owns the cron job and the chat speakers (matches
    // revalidateOwnerChatAgent); avoids incidental agent_manager_changed pauses.
    const runtime = await createTestAgent(app, { name: `rm-lock-${crypto.randomUUID().slice(0, 6)}` });
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    const chatId = chat.id;
    await seedDispatchRoute(app, runtime.agent.uuid, runtime.clientId);

    const jobId = crypto.randomUUID();
    await app.db.insert(cronJobs).values({
      id: jobId,
      ownerMemberId: runtime.memberId,
      controlChatId: chatId,
      agentId: runtime.agent.uuid,
      name: `rm-lock-${jobId.slice(0, 6)}`,
      chatMode: "reuse_control_chat",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      prompt: "wake after remove race",
      state: "active",
      stateReason: null,
      nextRunAt: new Date(Date.now() - 5_000),
      revision: 1,
    });

    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the lock-order concurrency test");

    const sweepAppName = `rm_cron_sw_${crypto.randomUUID().slice(0, 8)}`;
    const removeAppName = `rm_cron_rm_${crypto.randomUUID().slice(0, 8)}`;
    const sweepPool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, sweepAppName));
    const removePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, removeAppName));
    const observer = postgres(databaseUrl, { max: 1, idle_timeout: 5, ...(sslOptions(databaseUrl) ?? {}) });

    try {
      let releaseClaim!: () => void;
      const claimHeld = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      let claimReady!: () => void;
      const claimReadyP = new Promise<void>((resolve) => {
        claimReady = resolve;
      });

      const staleSeconds = app.config.runtime.presenceCleanupSeconds;
      const sweepPromise = sweepCronJobs(sweepPool, app.notifier, {
        staleSeconds,
        afterClaimForTest: async () => {
          claimReady();
          await claimHeld;
        },
      });

      await Promise.race([
        claimReadyP,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("cron claim barrier timeout")), 10_000);
        }),
      ]);

      // Sweep holds membership shared + cron row. Start removal on another
      // connection — it must block on exclusive membership (not deadlock by
      // taking cron first).
      const removePromise = removeParticipant(removePool, chatId, runtime.humanAgentUuid, runtime.agent.uuid);
      await waitForPostgresLockWait(observer, removeAppName);

      releaseClaim();

      await Promise.race([
        Promise.all([sweepPromise, removePromise]),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("remove-vs-cron-sweep deadlock timeout")), 15_000);
        }),
      ]);

      const [job] = await app.db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).limit(1);
      expect(job?.state).toBe("paused");
      expect(job?.stateReason).toBe("agent_not_speaker");
      expect(job?.nextRunAt).toBeNull();

      const triggersAfterRace = cronTriggerMessages(
        await app.db.select().from(messages).where(eq(messages.chatId, chatId)),
        jobId,
      );
      // At most one accept from the in-flight sweep; never a live pending wake.
      expect(triggersAfterRace.length).toBeLessThanOrEqual(1);
      const wakeRows = await app.db
        .select({ status: inboxEntries.status })
        .from(inboxEntries)
        .where(and(eq(inboxEntries.inboxId, runtime.agent.inboxId), eq(inboxEntries.chatId, chatId)));
      expect(wakeRows.some((r) => r.status === "pending" || r.status === "delivered")).toBe(false);

      // Post-remove sweep must not rematerialize while the agent is detached.
      await sweepCronJobs(app.db, app.notifier, { staleSeconds });
      const triggersAfterSweep = cronTriggerMessages(
        await app.db.select().from(messages).where(eq(messages.chatId, chatId)),
        jobId,
      );
      expect(triggersAfterSweep.length).toBe(triggersAfterRace.length);
    } finally {
      await sweepPool.end();
      await removePool.end();
      await observer.end();
    }
  });

  it("holds shared removal fence across soft-terminate action so concurrent re-add blocks", async () => {
    const { app, agent, chatId, ownerHeaders } = await setupGroup();
    await upsertSessionState(app.db, agent.agent.uuid, chatId, "active", agent.organizationId);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);

    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the fence concurrency test");

    const fenceAppName = `rm_fence_${crypto.randomUUID().slice(0, 8)}`;
    const readdAppName = `rm_readd_${crypto.randomUUID().slice(0, 8)}`;
    const fencePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, fenceAppName));
    const readdPool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, readdAppName));
    const observer = postgres(databaseUrl, { max: 1, idle_timeout: 5, ...(sslOptions(databaseUrl) ?? {}) });

    const sendSpy = vi.spyOn(connectionManager, "sendToAgent").mockReturnValue(true);
    try {
      let releaseAction!: () => void;
      const actionHeld = new Promise<void>((resolve) => {
        releaseAction = resolve;
      });
      let fenceReady!: () => void;
      const fenceReadyP = new Promise<void>((resolve) => {
        fenceReady = resolve;
      });
      let actionRan = false;

      const terminatePromise = withLiveRemovedSessionFence(fencePool, agent.agent.uuid, chatId, async () => {
        fenceReady();
        await actionHeld;
        actionRan = true;
        return sendToAgent(agent.agent.uuid, { type: "session:terminate", chatId });
      });

      await Promise.race([
        fenceReadyP,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("fence barrier timeout")), 10_000);
        }),
      ]);

      const readdPromise = ensureParticipant(readdPool, chatId, agent.agent.uuid);
      await waitForPostgresLockWait(observer, readdAppName);

      releaseAction();
      await Promise.race([
        Promise.all([terminatePromise, readdPromise]),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("fence-vs-readd deadlock timeout")), 15_000);
        }),
      ]);

      expect(actionRan).toBe(true);
      expect(sendSpy).toHaveBeenCalled();

      // Reverse order: after re-add committed, a delayed fence must skip action.
      sendSpy.mockClear();
      await upsertSessionState(app.db, agent.agent.uuid, chatId, "active", agent.organizationId);
      let skippedAction = false;
      const skipped = await withLiveRemovedSessionFence(app.db, agent.agent.uuid, chatId, async () => {
        skippedAction = true;
        return sendToAgent(agent.agent.uuid, { type: "session:terminate", chatId });
      });
      expect(skipped).toBeUndefined();
      expect(skippedAction).toBe(false);
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      sendSpy.mockRestore();
      await fencePool.end();
      await readdPool.end();
      await observer.end();
    }
  });

  it("inbox delivery fence skips stale claims after remove and holds shared until send completes", async () => {
    const { app, owner, agent, chatId, ownerHeaders } = await setupGroup();
    const sent = await sendMessage(app.db, chatId, owner.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "deliver fence wake",
      metadata: { mentions: [agent.agent.uuid] },
    });
    const [claimed] = await app.db
      .update(inboxEntries)
      .set({ status: "delivered" })
      .where(
        and(
          eq(inboxEntries.inboxId, agent.agent.inboxId),
          eq(inboxEntries.messageId, sent.message.id),
          eq(inboxEntries.chatId, chatId),
        ),
      )
      .returning({ id: inboxEntries.id, inboxId: inboxEntries.inboxId, chatId: inboxEntries.chatId });
    expect(claimed?.chatId).toBe(chatId);

    // Direction 1: claim already delivered → remove commits first → fence skips action.
    {
      const remove = await app.inject({
        method: "DELETE",
        url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
        headers: ownerHeaders,
      });
      expect(remove.statusCode).toBe(200);
      let actionRan = false;
      const skipped = await withLiveInboxDeliveryFence(
        app.db,
        {
          agentId: agent.agent.uuid,
          chatId,
          entryId: claimed!.id,
          inboxId: agent.agent.inboxId,
        },
        async () => {
          actionRan = true;
          return true;
        },
      );
      expect(skipped).toBeUndefined();
      expect(actionRan).toBe(false);
      const [row] = await app.db
        .select({ status: inboxEntries.status })
        .from(inboxEntries)
        .where(eq(inboxEntries.id, claimed!.id));
      expect(row?.status).toBe("cancelled");
    }

    // Re-add and seed a fresh delivered claim for the reverse barrier.
    await ensureParticipant(app.db, chatId, agent.agent.uuid);
    const sent2 = await sendMessage(app.db, chatId, owner.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "deliver fence hold",
      metadata: { mentions: [agent.agent.uuid] },
    });
    const [claimed2] = await app.db
      .update(inboxEntries)
      .set({ status: "delivered" })
      .where(
        and(
          eq(inboxEntries.inboxId, agent.agent.inboxId),
          eq(inboxEntries.messageId, sent2.message.id),
          eq(inboxEntries.chatId, chatId),
        ),
      )
      .returning({ id: inboxEntries.id });

    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for inbox delivery fence test");
    const fenceAppName = `rm_inbox_f_${crypto.randomUUID().slice(0, 8)}`;
    const removeAppName = `rm_inbox_r_${crypto.randomUUID().slice(0, 8)}`;
    const fencePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, fenceAppName));
    const removePool = connectDatabase(databaseUrlWithApplicationName(databaseUrl, removeAppName));
    const observer = postgres(databaseUrl, { max: 1, idle_timeout: 5, ...(sslOptions(databaseUrl) ?? {}) });

    try {
      let releaseAction!: () => void;
      const actionHeld = new Promise<void>((resolve) => {
        releaseAction = resolve;
      });
      let fenceReady!: () => void;
      const fenceReadyP = new Promise<void>((resolve) => {
        fenceReady = resolve;
      });
      let actionRan = false;

      // Direction 2: fence holds shared → remove waits → action runs → remove cancels.
      const fencePromise = withLiveInboxDeliveryFence(
        fencePool,
        {
          agentId: agent.agent.uuid,
          chatId,
          entryId: claimed2!.id,
          inboxId: agent.agent.inboxId,
        },
        async () => {
          fenceReady();
          await actionHeld;
          actionRan = true;
          return true;
        },
      );

      await Promise.race([
        fenceReadyP,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("inbox delivery fence barrier timeout")), 10_000);
        }),
      ]);

      const removePromise = removeParticipant(removePool, chatId, owner.humanAgentUuid, agent.agent.uuid);
      await waitForPostgresLockWait(observer, removeAppName);

      releaseAction();
      await Promise.race([
        Promise.all([fencePromise, removePromise]),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("inbox fence vs remove deadlock timeout")), 15_000);
        }),
      ]);

      expect(actionRan).toBe(true);
      const [row] = await app.db
        .select({ status: inboxEntries.status })
        .from(inboxEntries)
        .where(eq(inboxEntries.id, claimed2!.id));
      expect(row?.status).toBe("cancelled");
    } finally {
      await fencePool.end();
      await removePool.end();
      await observer.end();
    }

    // Direction 3: FOR SHARE on the delivery row blocks concurrent status writers
    // (ACK / recovery reset) until action completes — membership shared alone cannot.
    await ensureParticipant(app.db, chatId, agent.agent.uuid);
    const sent3 = await sendMessage(app.db, chatId, owner.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "deliver fence row lock",
      metadata: { mentions: [agent.agent.uuid] },
    });
    const [claimed3] = await app.db
      .update(inboxEntries)
      .set({ status: "delivered" })
      .where(
        and(
          eq(inboxEntries.inboxId, agent.agent.inboxId),
          eq(inboxEntries.messageId, sent3.message.id),
          eq(inboxEntries.chatId, chatId),
        ),
      )
      .returning({ id: inboxEntries.id });

    const databaseUrl3 = process.env.DATABASE_URL ?? "";
    if (!databaseUrl3) throw new Error("DATABASE_URL is required for inbox row-lock fence test");
    const fenceAppName3 = `rm_inbox_fs_${crypto.randomUUID().slice(0, 8)}`;
    const ackAppName = `rm_inbox_ack_${crypto.randomUUID().slice(0, 8)}`;
    const fencePool3 = connectDatabase(databaseUrlWithApplicationName(databaseUrl3, fenceAppName3));
    const ackPool = connectDatabase(databaseUrlWithApplicationName(databaseUrl3, ackAppName));
    const observer3 = postgres(databaseUrl3, { max: 1, idle_timeout: 5, ...(sslOptions(databaseUrl3) ?? {}) });
    try {
      let releaseAction!: () => void;
      const actionHeld = new Promise<void>((resolve) => {
        releaseAction = resolve;
      });
      let fenceReady!: () => void;
      const fenceReadyP = new Promise<void>((resolve) => {
        fenceReady = resolve;
      });
      let sawDeliveredUnderFence = false;

      const fencePromise = withLiveInboxDeliveryFence(
        fencePool3,
        {
          agentId: agent.agent.uuid,
          chatId,
          entryId: claimed3!.id,
          inboxId: agent.agent.inboxId,
        },
        async (tx) => {
          const [under] = await tx
            .select({ status: inboxEntries.status })
            .from(inboxEntries)
            .where(eq(inboxEntries.id, claimed3!.id))
            .limit(1);
          sawDeliveredUnderFence = under?.status === "delivered";
          fenceReady();
          await actionHeld;
          return true;
        },
      );

      await Promise.race([
        fenceReadyP,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("inbox row-lock fence barrier timeout")), 10_000);
        }),
      ]);

      const ackPromise = ackPool.transaction(async (tx) => {
        await tx.update(inboxEntries).set({ status: "acked" }).where(eq(inboxEntries.id, claimed3!.id));
      });
      await waitForPostgresLockWait(observer3, ackAppName);

      releaseAction();
      await Promise.race([
        Promise.all([fencePromise, ackPromise]),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("inbox fence vs ack deadlock timeout")), 15_000);
        }),
      ]);

      expect(sawDeliveredUnderFence).toBe(true);
      const [after] = await app.db
        .select({ status: inboxEntries.status })
        .from(inboxEntries)
        .where(eq(inboxEntries.id, claimed3!.id));
      expect(after?.status).toBe("acked");
    } finally {
      await fencePool3.end();
      await ackPool.end();
      await observer3.end();
    }
  });

  it("still-evicted soft terminate delivers; softTerminate helper uses the held fence", async () => {
    const { app, agent, chatId, ownerHeaders } = await setupGroup();
    await upsertSessionState(app.db, agent.agent.uuid, chatId, "active", agent.organizationId);
    await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });

    const sendSpy = vi.spyOn(connectionManager, "sendToAgent").mockReturnValue(true);
    try {
      await softTerminateRemovedAgentSession({
        db: app.db,
        agentId: agent.agent.uuid,
        chatId,
      });
      expect(sendSpy).toHaveBeenCalledWith(agent.agent.uuid, {
        type: "session:terminate",
        chatId,
      });
    } finally {
      sendSpy.mockRestore();
    }
  });

  it("remove → re-add clears cancelled envelopes, reseeds silent context, and allows ACK-through", async () => {
    const { app, owner, agent, chatId, ownerHeaders } = await setupGroup();
    for (let i = 0; i < 3; i++) {
      await sendMessage(
        app.db,
        chatId,
        owner.humanAgentUuid,
        { source: "api", format: "markdown", content: `ctx-${i}` },
        { allowRecipientlessSend: true },
      );
    }
    await sendMessage(app.db, chatId, owner.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "wake before remove",
      metadata: { mentions: [agent.agent.uuid] },
    });

    const beforeRemove = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, agent.agent.inboxId), eq(inboxEntries.chatId, chatId)));
    expect(beforeRemove.length).toBeGreaterThan(0);
    const oldIds = new Set(beforeRemove.map((r) => r.id));

    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(del.statusCode).toBe(200);

    const cancelled = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, agent.agent.inboxId),
          eq(inboxEntries.chatId, chatId),
          eq(inboxEntries.status, "cancelled"),
        ),
      );
    expect(cancelled.length).toBeGreaterThan(0);

    await ensureParticipant(app.db, chatId, agent.agent.uuid);

    const afterReadd = await app.db
      .select({ id: inboxEntries.id, status: inboxEntries.status, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.inboxId, agent.agent.inboxId), eq(inboxEntries.chatId, chatId)));
    expect(afterReadd.every((r) => r.status !== "cancelled")).toBe(true);
    const silent = afterReadd.filter((r) => r.notify === false && r.status === "pending");
    expect(silent.length).toBeGreaterThan(0);
    expect(silent.every((r) => !oldIds.has(r.id))).toBe(true);

    await sendMessage(app.db, chatId, owner.humanAgentUuid, {
      source: "api",
      format: "markdown",
      content: "wake after re-add",
      metadata: { mentions: [agent.agent.uuid] },
    });
    const delivered = await pollInbox(app.db, agent.agent.inboxId, 10);
    const wake = delivered.find((e) => e.message.content === "wake after re-add");
    expect(wake).toBeTruthy();
    const ack = await ackThroughEntryIdForBoundAgents(app.db, wake!.id, [agent.agent.inboxId]);
    expect(ack).toMatchObject({ ok: true });
  });

  it("detaches Human with me-chats:changed(chatId) and notifies audience only once", async () => {
    const { app, peer, chatId, ownerHeaders } = await setupGroup();
    const audienceSpy = vi.spyOn(app.notifier, "notifyChatAudience");
    const meChatsSpy = vi.spyOn(app.notifier, "notifyMeChatsChanged");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${peer.humanAgentUuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ membershipKind: null });

    await vi.waitFor(() => {
      expect(meChatsSpy).toHaveBeenCalledWith(peer.humanAgentUuid, peer.organizationId, chatId);
    });
    // invalidateChatAudience → dispatcher → notifyChatAudience exactly once
    // (no second explicit call from removeChatParticipant).
    expect(audienceSpy).toHaveBeenCalledTimes(1);
    expect(audienceSpy).toHaveBeenCalledWith(chatId);

    audienceSpy.mockRestore();
    meChatsSpy.mockRestore();
  });

  it("kicks me-chats for a manager who loses their last watcher anchor when an agent is removed", async () => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `rm-own-${crypto.randomUUID().slice(0, 6)}` });
    const manager = await createAdminContext(app, { username: `rm-mgr-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `rm-only-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: manager.memberId,
      clientId: manager.clientId,
      organizationId: manager.organizationId,
    });
    const chat = await createChat(app.db, owner.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    // createChat recomputes watchers → manager is watcher-only (not a speaker).
    const [watcherBefore] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, manager.humanAgentUuid)))
      .limit(1);
    expect(watcherBefore?.accessMode).toBe("watcher");

    const meChatsSpy = vi.spyOn(app.notifier, "notifyMeChatsChanged");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chat.id}/participants/${agent.uuid}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const [watcherAfter] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, manager.humanAgentUuid)))
      .limit(1);
    expect(watcherAfter).toBeUndefined();

    await vi.waitFor(() => {
      expect(meChatsSpy).toHaveBeenCalledWith(manager.humanAgentUuid, manager.organizationId, chat.id);
    });
    meChatsSpy.mockRestore();
  });

  it("keeps a manager watcher (and does not kick me-chats) when another managed agent remains", async () => {
    const app = getApp();
    const owner = await createAdminContext(app, { username: `rm-own2-${crypto.randomUUID().slice(0, 6)}` });
    const manager = await createAdminContext(app, { username: `rm-mgr2-${crypto.randomUUID().slice(0, 6)}` });
    const agentA = await createAgent(app.db, {
      name: `rm-a-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: manager.memberId,
      clientId: manager.clientId,
      organizationId: manager.organizationId,
    });
    const agentB = await createAgent(app.db, {
      name: `rm-b-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: manager.memberId,
      clientId: manager.clientId,
      organizationId: manager.organizationId,
    });
    const chat = await createChat(app.db, owner.humanAgentUuid, {
      type: "group",
      participantIds: [agentA.uuid, agentB.uuid],
    });

    const meChatsSpy = vi.spyOn(app.notifier, "notifyMeChatsChanged");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chat.id}/participants/${agentA.uuid}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const [watcher] = await app.db
      .select({ accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, manager.humanAgentUuid)))
      .limit(1);
    expect(watcher?.accessMode).toBe("watcher");
    expect(meChatsSpy).not.toHaveBeenCalledWith(manager.humanAgentUuid, manager.organizationId, chat.id);
    meChatsSpy.mockRestore();
  });
});
