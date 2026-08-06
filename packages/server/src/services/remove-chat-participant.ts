/**
 * Canonical chat speaker removal used by both the agent Class D DELETE route
 * and the Web Class C DELETE route. Membership mutation, inbox cancellation,
 * session eviction fence, and cron pause all commit in one transaction; WS
 * kicks and ordinary session:terminate are best-effort after commit.
 */

import {
  parseLandingCampaignTrialChatMetadata,
  REMOVE_PARTICIPANT_OPEN_REQUEST_CODE,
  type RemoveChatParticipantResponse,
} from "@first-tree/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { cronJobs } from "../db/schema/cron-jobs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { isChatSpeaker, lockChatMembershipMutation, lockChatMembershipShared } from "./chat-membership-lock.js";
import { sendToAgent } from "./connection-manager.js";
import { lockOwnerChatCronBarrier } from "./cron-job.js";
import type { Notifier } from "./notifier.js";
import { recomputeChatWatchers } from "./participant-mode.js";

export type RemoveChatParticipantOptions = {
  /** Live notifier for post-commit roster / me-chats / soft terminate fan-out. */
  notifier?: Notifier;
  /** This server replica's instance id — used for soft terminate routing. */
  instanceId?: string;
};

type TxOutcome = RemoveChatParticipantResponse & {
  organizationId: string;
  targetType: string;
  targetInboxId: string | null;
  /**
   * Humans who lost every membership row this remove (target detach and/or
   * watcher rows dropped by recompute). Each gets a targeted me-chats kick.
   */
  detachedHumanAgentIds: string[];
  /** Non-human targets always get a soft terminate attempt after commit. */
  terminateAgentId: string | null;
};

/**
 * Remove `targetAgentId` as a speaker of `chatId`. Caller must already be a
 * direct speaker. Returns the target's final membership kind for Web toasting.
 */
export async function removeChatParticipant(
  db: Database,
  chatId: string,
  requesterId: string,
  targetAgentId: string,
  options: RemoveChatParticipantOptions = {},
): Promise<RemoveChatParticipantResponse> {
  const outcome = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockChatMembershipMutation(tx, [chatId]);

    const [chat] = await tx
      .select({ id: chats.id, organizationId: chats.organizationId, metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);
    if (!chat) throw new NotFoundError(`Chat "${chatId}" not found`);
    if (parseLandingCampaignTrialChatMetadata(chat.metadata)) {
      throw new ForbiddenError("Landing campaign trial chats are managed by First Tree.");
    }

    const [caller] = await tx
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, chatId),
          eq(chatMembership.agentId, requesterId),
          eq(chatMembership.accessMode, "speaker"),
        ),
      )
      .limit(1);
    if (!caller) throw new ForbiddenError("Not a participant of this chat");

    if (requesterId === targetAgentId) {
      throw new BadRequestError("Cannot remove yourself from a chat");
    }

    const [targetAgent] = await tx
      .select({
        uuid: agents.uuid,
        type: agents.type,
        inboxId: agents.inboxId,
        managerId: agents.managerId,
      })
      .from(agents)
      .where(eq(agents.uuid, targetAgentId))
      .limit(1);
    if (!targetAgent) throw new NotFoundError(`Agent "${targetAgentId}" not found`);

    const [targetSpeaker] = await tx
      .select({ agentId: chatMembership.agentId, accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, targetAgentId)))
      .limit(1);
    if (!targetSpeaker || targetSpeaker.accessMode !== "speaker") {
      throw new NotFoundError(`Agent "${targetAgentId}" is not a participant of this chat`);
    }

    if (targetAgent.type === "human") {
      const [openReq] = await tx
        .select({ openRequestCount: chatUserState.openRequestCount })
        .from(chatUserState)
        .where(and(eq(chatUserState.chatId, chatId), eq(chatUserState.agentId, targetAgentId)))
        .limit(1);
      if ((openReq?.openRequestCount ?? 0) > 0) {
        throw new ConflictError(
          "Cannot remove a participant who still has an unanswered request in this chat. Answer or skip the request first.",
          { code: REMOVE_PARTICIPANT_OPEN_REQUEST_CODE },
        );
      }
    }

    let membershipKind: "watching" | null = null;
    let detachedHumanAgentId: string | null = null;

    const watcherHumansBefore = await listWatcherHumanAgentIds(tx, chatId);

    if (targetAgent.type === "human") {
      // Same visibility rule as leaveAsParticipant: still manage a non-human
      // speaker → downgrade to watcher; otherwise fully detach. chat_user_state
      // is never touched.
      const visible = (await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1
            FROM chat_membership cm
            JOIN agents  a ON a.uuid = cm.agent_id
            JOIN members m ON m.id   = a.manager_id
           WHERE cm.chat_id = ${chatId}
             AND cm.access_mode = 'speaker'
             AND m.agent_id = ${targetAgentId}
             AND m.status   = 'active'
             AND a.type    <> 'human'
        ) AS visible
      `)) as unknown as Array<{ visible: boolean }>;
      const stillVisible = Boolean(visible[0]?.visible);

      if (stillVisible) {
        await tx
          .update(chatMembership)
          .set({ accessMode: "watcher" })
          .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, targetAgentId)));
        membershipKind = "watching";
      } else {
        await tx
          .delete(chatMembership)
          .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, targetAgentId)));
        membershipKind = null;
        detachedHumanAgentId = targetAgentId;
      }
    } else {
      await tx
        .delete(chatMembership)
        .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, targetAgentId)));
      membershipKind = null;
    }

    // Cancel undelivered / unacked inbox rows for this target in this chat.
    // Collect cancelled message ids so cron outstanding pointers that pointed
    // at those deliveries can be cleared in the same txn (any job state).
    let cancelledMessageIds: string[] = [];
    if (targetAgent.inboxId) {
      const cancelled = await tx
        .update(inboxEntries)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(inboxEntries.inboxId, targetAgent.inboxId),
            eq(inboxEntries.chatId, chatId),
            inArray(inboxEntries.status, ["pending", "delivered"]),
          ),
        )
        .returning({ messageId: inboxEntries.messageId });
      cancelledMessageIds = [...new Set(cancelled.map((row) => row.messageId))];
    }

    if (cancelledMessageIds.length > 0) {
      await tx
        .update(cronJobs)
        .set({ lastTriggerMessageId: null })
        .where(
          and(
            eq(cronJobs.controlChatId, chatId),
            eq(cronJobs.agentId, targetAgentId),
            inArray(cronJobs.lastTriggerMessageId, cancelledMessageIds),
          ),
        );
    }

    // Non-human: force an evicted fence even when no prior session row exists,
    // clear live events, and refresh presence session counts.
    if (targetAgent.type !== "human") {
      const now = new Date();
      await tx
        .insert(agentChatSessions)
        .values({
          agentId: targetAgentId,
          chatId,
          state: "evicted",
          runtimeState: "idle",
          runtimeStateAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agentChatSessions.agentId, agentChatSessions.chatId],
          set: {
            state: "evicted",
            runtimeState: "idle",
            runtimeStateAt: now,
            updatedAt: now,
          },
        });

      await tx
        .delete(sessionEvents)
        .where(and(eq(sessionEvents.agentId, targetAgentId), eq(sessionEvents.chatId, chatId)));

      const [counts] = await tx
        .select({
          active: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} = 'active')::int`,
          total: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} != 'evicted')::int`,
        })
        .from(agentChatSessions)
        .where(eq(agentChatSessions.agentId, targetAgentId));

      await tx
        .insert(agentPresence)
        .values({
          agentId: targetAgentId,
          activeSessions: counts?.active ?? 0,
          totalSessions: counts?.total ?? 0,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: [agentPresence.agentId],
          set: {
            activeSessions: counts?.active ?? 0,
            totalSessions: counts?.total ?? 0,
            lastSeenAt: now,
          },
        });
    }

    await pauseCronJobsForRemovedSpeaker(tx, {
      chatId,
      targetAgentId,
      targetType: targetAgent.type,
    });

    await recomputeChatWatchers(tx, chatId);

    const watcherHumansAfter = new Set(await listWatcherHumanAgentIds(tx, chatId));
    const detachedByRecompute = watcherHumansBefore.filter((id) => !watcherHumansAfter.has(id));

    // After recompute, confirm Human watcher outcome from durable rows so the
    // response matches the post-recompute truth (recompute may re-attach).
    if (targetAgent.type === "human") {
      const [finalRow] = await tx
        .select({ accessMode: chatMembership.accessMode })
        .from(chatMembership)
        .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, targetAgentId)))
        .limit(1);
      if (finalRow?.accessMode === "watcher") {
        membershipKind = "watching";
        detachedHumanAgentId = null;
      } else if (!finalRow) {
        membershipKind = null;
        detachedHumanAgentId = targetAgentId;
      }
    }

    const detachedHumanAgentIds = [
      ...new Set([...detachedByRecompute, ...(detachedHumanAgentId ? [detachedHumanAgentId] : [])]),
    ];

    const result: TxOutcome = {
      chatId,
      targetAgentId,
      membershipKind,
      organizationId: chat.organizationId,
      targetType: targetAgent.type,
      targetInboxId: targetAgent.inboxId,
      detachedHumanAgentIds,
      terminateAgentId: targetAgent.type !== "human" ? targetAgentId : null,
    };
    return result;
  });

  invalidateChatAudience(chatId);

  const notifier = options.notifier;
  if (notifier) {
    // `invalidateChatAudience` already fans `notifyChatAudience` via the
    // boot-registered dispatcher — do not call it again here.
    void notifier.notifyChatUpdated(chatId);
    for (const humanAgentId of outcome.detachedHumanAgentIds) {
      void notifier.notifyMeChatsChanged(humanAgentId, outcome.organizationId, chatId);
    }
  }

  if (outcome.terminateAgentId) {
    void softTerminateRemovedAgentSession({
      db,
      agentId: outcome.terminateAgentId,
      chatId,
      notifier,
      instanceId: options.instanceId,
    });
  }

  return {
    chatId: outcome.chatId,
    targetAgentId: outcome.targetAgentId,
    membershipKind: outcome.membershipKind,
  };
}

async function listWatcherHumanAgentIds(db: Database, chatId: string): Promise<string[]> {
  const rows = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "watcher"), eq(agents.type, "human")));
  return rows.map((row) => row.agentId);
}

async function pauseCronJobsForRemovedSpeaker(
  db: Database,
  input: { chatId: string; targetAgentId: string; targetType: string },
): Promise<void> {
  if (input.targetType === "human") {
    const [ownerMember] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.agentId, input.targetAgentId), eq(members.status, "active")))
      .limit(1);
    if (!ownerMember) return;

    await lockOwnerChatCronBarrier(db, input.chatId, ownerMember.id);
    const locked = await db
      .select({ id: cronJobs.id })
      .from(cronJobs)
      .where(
        and(
          eq(cronJobs.controlChatId, input.chatId),
          eq(cronJobs.ownerMemberId, ownerMember.id),
          eq(cronJobs.state, "active"),
        ),
      )
      .orderBy(asc(cronJobs.id))
      .for("update");
    if (locked.length === 0) return;
    await db
      .update(cronJobs)
      .set({
        state: "paused",
        stateReason: "owner_not_speaker",
        nextRunAt: null,
        revision: sql`${cronJobs.revision} + 1`,
      })
      .where(
        and(
          eq(cronJobs.controlChatId, input.chatId),
          eq(cronJobs.ownerMemberId, ownerMember.id),
          eq(cronJobs.state, "active"),
        ),
      );
    return;
  }

  // Agent removed: pause every active job that wakes this agent in the chat.
  // Caller already holds exclusive chat membership; keep lock order
  // membership → owner-chat barrier → cron FOR UPDATE (scheduler/create/resume
  // take membership shared before cron so this cannot deadlock).
  const ownerRows = await db
    .selectDistinct({ ownerMemberId: cronJobs.ownerMemberId })
    .from(cronJobs)
    .where(
      and(
        eq(cronJobs.controlChatId, input.chatId),
        eq(cronJobs.agentId, input.targetAgentId),
        eq(cronJobs.state, "active"),
      ),
    )
    .orderBy(asc(cronJobs.ownerMemberId));

  for (const row of ownerRows) {
    await lockOwnerChatCronBarrier(db, input.chatId, row.ownerMemberId);
  }

  const locked = await db
    .select({ id: cronJobs.id })
    .from(cronJobs)
    .where(
      and(
        eq(cronJobs.controlChatId, input.chatId),
        eq(cronJobs.agentId, input.targetAgentId),
        eq(cronJobs.state, "active"),
      ),
    )
    .orderBy(asc(cronJobs.id))
    .for("update");
  if (locked.length === 0) return;

  await db
    .update(cronJobs)
    .set({
      state: "paused",
      stateReason: "agent_not_speaker",
      nextRunAt: null,
      revision: sql`${cronJobs.revision} + 1`,
    })
    .where(
      and(
        eq(cronJobs.controlChatId, input.chatId),
        eq(cronJobs.agentId, input.targetAgentId),
        eq(cronJobs.state, "active"),
      ),
    );
}

/**
 * Soft terminate is only live while the removal fence still holds: the agent
 * is not a speaker and the durable `(agent, chat)` session row is still
 * `evicted`. Hold the shared membership advisory for the entire `action` so
 * re-add (exclusive membership) cannot commit between the check and delivery
 * — local `sendToAgent` / remote `sendToClient` / publish must run inside
 * `action` while the lock is still held.
 */
export async function withLiveRemovedSessionFence<T>(
  db: Database,
  agentId: string,
  chatId: string,
  action: (tx: Database) => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockChatMembershipShared(tx, [chatId]);
    if (await isChatSpeaker(tx, chatId, agentId)) return undefined;
    const [session] = await tx
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    if (session?.state !== "evicted") return undefined;
    return action(tx);
  });
}

/**
 * Best-effort ordinary `session:terminate` (no Reset apply-ack). Local first;
 * when the agent's socket lives on another replica, fan a soft evict command.
 * Failures never surface to the DELETE caller — DB eviction is authoritative.
 * Delivery and remote publish run inside the shared removal fence.
 */
export async function softTerminateRemovedAgentSession(input: {
  db: Database;
  agentId: string;
  chatId: string;
  notifier?: Notifier;
  instanceId?: string;
}): Promise<void> {
  try {
    const localSent = await withLiveRemovedSessionFence(input.db, input.agentId, input.chatId, async () =>
      sendToAgent(input.agentId, { type: "session:terminate", chatId: input.chatId }),
    );
    if (localSent) return;
    const notifier = input.notifier;
    if (!notifier || !input.instanceId) return;

    await withLiveRemovedSessionFence(input.db, input.agentId, input.chatId, async (tx) => {
      const [route] = await tx
        .select({
          clientId: agents.clientId,
          instanceId: clients.instanceId,
        })
        .from(agents)
        .leftJoin(clients, eq(clients.id, agents.clientId))
        .where(eq(agents.uuid, input.agentId))
        .limit(1);

      if (!route?.clientId || !route.instanceId) return;
      if (route.instanceId === input.instanceId) return;

      await notifier.notifyDaemonClientCommand({
        type: "session:evict",
        clientId: route.clientId,
        agentId: input.agentId,
        chatId: input.chatId,
        targetInstanceId: route.instanceId,
      });
    });
  } catch {
    // best-effort
  }
}

/**
 * Test helper: non-evicted session rows for an agent/chat.
 */
export async function countNonEvictedSessions(db: Database, agentId: string, chatId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentChatSessions)
    .where(
      and(
        eq(agentChatSessions.agentId, agentId),
        eq(agentChatSessions.chatId, chatId),
        ne(agentChatSessions.state, "evicted"),
      ),
    );
  return row?.n ?? 0;
}
