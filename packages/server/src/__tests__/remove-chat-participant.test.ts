import { CRON_TRIGGER_METADATA_KEY, REMOVE_PARTICIPANT_OPEN_REQUEST_CODE } from "@first-tree/shared";
import { and, eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
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
import { upsertSessionState } from "../services/activity.js";
import { createAgent } from "../services/agent.js";
import { createChat, ensureParticipant, removeParticipant } from "../services/chat.js";
import * as connectionManager from "../services/connection-manager.js";
import { sweepCronJobs } from "../services/cron-scheduler.js";
import { sendMessage } from "../services/message.js";
import {
  isRemovedSessionSoftTerminateLive,
  softTerminateRemovedAgentSession,
} from "../services/remove-chat-participant.js";
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

  it("delayed soft terminate after re-add does not kill the new session; still-evicted does", async () => {
    const { app, agent, chatId, ownerHeaders } = await setupGroup();
    await upsertSessionState(app.db, agent.agent.uuid, chatId, "active", agent.organizationId);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/chats/${chatId}/participants/${agent.agent.uuid}`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(await isRemovedSessionSoftTerminateLive(app.db, agent.agent.uuid, chatId)).toBe(true);

    const sendSpy = vi.spyOn(connectionManager, "sendToAgent").mockReturnValue(true);
    try {
      // Still removed + evicted → terminate delivers.
      await softTerminateRemovedAgentSession({
        db: app.db,
        agentId: agent.agent.uuid,
        chatId,
      });
      expect(sendSpy).toHaveBeenCalledWith(agent.agent.uuid, {
        type: "session:terminate",
        chatId,
      });
      sendSpy.mockClear();

      // Re-add as speaker and revive session — delayed terminate must no-op.
      await ensureParticipant(app.db, chatId, agent.agent.uuid);
      await upsertSessionState(app.db, agent.agent.uuid, chatId, "active", agent.organizationId);
      expect(await isRemovedSessionSoftTerminateLive(app.db, agent.agent.uuid, chatId)).toBe(false);

      await softTerminateRemovedAgentSession({
        db: app.db,
        agentId: agent.agent.uuid,
        chatId,
        notifier: app.notifier,
        instanceId: "other-replica",
      });
      expect(sendSpy).not.toHaveBeenCalled();

      const [session] = await app.db
        .select({ state: agentChatSessions.state })
        .from(agentChatSessions)
        .where(and(eq(agentChatSessions.agentId, agent.agent.uuid), eq(agentChatSessions.chatId, chatId)))
        .limit(1);
      expect(session?.state).toBe("active");
    } finally {
      sendSpy.mockRestore();
    }
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
