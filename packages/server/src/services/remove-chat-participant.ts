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
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { clients } from "../db/schema/clients.js";
import { cronJobs } from "../db/schema/cron-jobs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import {
  isChatSpeaker,
  lockChatMembershipMutation,
  lockChatMembershipShared,
  lockChatSpeakerAndAgentSnapshot,
} from "./chat-membership-lock.js";
import { sendToAgent } from "./connection-manager.js";
import { lockOwnerChatCronBarrier } from "./cron-job.js";
import { openRequestPredicate } from "./need-you.js";
import type { Notifier } from "./notifier.js";
import { recomputeChatWatchers } from "./participant-mode.js";

export type RemoveChatParticipantOptions = {
  /** Live notifier for post-commit roster / me-chats / soft terminate fan-out. */
  notifier?: Notifier;
  /** This server replica's instance id — used for soft terminate routing. */
  instanceId?: string;
  /**
   * Test-only barrier after the authority snapshot is locked and before
   * authorization / mutation, so concurrent manager_id updates can be proven
   * to wait on the same FOR UPDATE set.
   */
  afterAuthoritySnapshotForTest?: () => Promise<void>;
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
  /**
   * Generation being invalidated by this remove (pre-bump). Soft terminate
   * carries it so a Client that already adopted the post-bump generation
   * ignores the late cleanup frame.
   */
  terminateInvalidatedGeneration: number | null;
};

/**
 * Remove `targetAgentId` as a speaker of `chatId`. Caller must already be a
 * direct speaker. Authorization follows the owner-side / own-agent matrix
 * (chat owner row is never removable). Returns the target's final membership
 * kind for Web toasting.
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
    // Take the membership fence first so the owner row cannot move, read who
    // the owner is (including a watcher owner), then lock caller / target /
    // owner agent rows with the speakers in one UUID-sorted FOR UPDATE set.
    // Authorization reads `agents.manager_id`; without that lock a concurrent
    // manager reassignment can invalidate the decision mid-transaction.
    await lockChatMembershipMutation(tx, [chatId]);
    const chatOwnerAgentId = await loadChatOwnerAgentId(tx, chatId);
    const authorityAgentIds = chatOwnerAgentId
      ? [requesterId, targetAgentId, chatOwnerAgentId]
      : [requesterId, targetAgentId];
    const authority = await lockChatSpeakerAndAgentSnapshot(tx, [chatId], authorityAgentIds);
    if (options.afterAuthoritySnapshotForTest) {
      await options.afterAuthoritySnapshotForTest();
    }

    const chat = authority.chats.find((row) => row.id === chatId);
    if (!chat) throw new NotFoundError(`Chat "${chatId}" not found`);
    const [chatMeta] = await tx.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId)).limit(1);
    if (parseLandingCampaignTrialChatMetadata(chatMeta?.metadata)) {
      throw new ForbiddenError("Landing campaign trial chats are managed by First Tree.");
    }

    if (requesterId === targetAgentId) {
      throw new BadRequestError("Cannot remove yourself from a chat");
    }

    const callerLocked = authority.agents.find((row) => row.agentId === requesterId);
    const targetLocked = authority.agents.find((row) => row.agentId === targetAgentId);
    if (!callerLocked) throw new NotFoundError(`Agent "${requesterId}" not found`);
    if (!targetLocked) throw new NotFoundError(`Agent "${targetAgentId}" not found`);

    const [callerSpeaker] = await tx
      .select({ role: chatMembership.role })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, chatId),
          eq(chatMembership.agentId, requesterId),
          eq(chatMembership.accessMode, "speaker"),
        ),
      )
      .limit(1);
    if (!callerSpeaker) throw new ForbiddenError("Not a participant of this chat");

    const [targetSpeaker] = await tx
      .select({ role: chatMembership.role, accessMode: chatMembership.accessMode })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, targetAgentId)))
      .limit(1);
    if (!targetSpeaker || targetSpeaker.accessMode !== "speaker") {
      throw new NotFoundError(`Agent "${targetAgentId}" is not a participant of this chat`);
    }
    if (targetSpeaker.role === "owner") {
      throw new ForbiddenError("The chat owner cannot be removed from their own chat");
    }

    const ownerLocked = chatOwnerAgentId ? authority.agents.find((row) => row.agentId === chatOwnerAgentId) : undefined;
    const callerIsOwnerSide =
      callerSpeaker.role === "owner" || (ownerLocked != null && ownerLocked.managerId === callerLocked.managerId);
    const targetIsCallersOwnAgent = targetLocked.type !== "human" && targetLocked.managerId === callerLocked.managerId;
    if (!callerIsOwnerSide && !targetIsCallersOwnAgent) {
      throw new ForbiddenError(
        "Only the chat owner's side can remove a participant, or the agent's own manager can recall it",
      );
    }

    // Open-request guard uses durable request/resolution rows (Need You), not
    // `chat_user_state.open_request_count`. 409 only when removal would fully
    // detach the Human — a retained watcher can still see and answer.
    if (targetLocked.type === "human") {
      const keepsMembership = await keepsMembershipAfterRemoval(tx, chatId, {
        type: targetLocked.type,
        agentId: targetAgentId,
      });
      if (!keepsMembership) {
        const [openRequest] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.chatId, chatId), openRequestPredicate(targetAgentId)))
          .limit(1);
        if (openRequest) {
          throw new ConflictError(
            "Cannot remove a participant who still has an unanswered request in this chat. Answer or skip the request first.",
            { code: REMOVE_PARTICIPANT_OPEN_REQUEST_CODE },
          );
        }
      }
    }

    const targetAgent = {
      uuid: targetLocked.agentId,
      type: targetLocked.type,
      inboxId: null as string | null,
    };
    // Inbox id is not part of the authority snapshot; read it under the same
    // txn after the agent row is locked.
    const [inboxRow] = await tx
      .select({ inboxId: agents.inboxId })
      .from(agents)
      .where(eq(agents.uuid, targetAgentId))
      .limit(1);
    targetAgent.inboxId = inboxRow?.inboxId ?? null;

    let membershipKind: "watching" | null = null;
    let detachedHumanAgentId: string | null = null;

    const watcherHumansBefore = await listWatcherHumanAgentIds(tx, chatId);

    if (targetAgent.type === "human") {
      // Same visibility rule as leaveAsParticipant: still manage a non-human
      // speaker → downgrade to watcher; otherwise fully detach. chat_user_state
      // is never touched.
      const stillVisible = await keepsMembershipAfterRemoval(tx, chatId, {
        type: targetAgent.type,
        agentId: targetAgentId,
      });

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
    // Cancelled message ids feed the canonical cron pause/pointer phase below
    // (barriers before any cron UPDATE) so outstanding pointers clear safely.
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

    // Non-human: force an evicted fence even when no prior session row exists,
    // bump resume generation atomically, clear live events, and refresh
    // presence session counts. Generation must never be reset by later re-add.
    let terminateInvalidatedGeneration: number | null = null;
    if (targetAgent.type !== "human") {
      const now = new Date();
      const [prior] = await tx
        .select({ resumeGeneration: agentChatSessions.resumeGeneration })
        .from(agentChatSessions)
        .where(and(eq(agentChatSessions.agentId, targetAgentId), eq(agentChatSessions.chatId, chatId)))
        .limit(1);
      const invalidatedGeneration = prior?.resumeGeneration ?? 0;
      terminateInvalidatedGeneration = invalidatedGeneration;
      await tx
        .insert(agentChatSessions)
        .values({
          agentId: targetAgentId,
          chatId,
          state: "evicted",
          runtimeState: "idle",
          runtimeStateAt: now,
          resumeGeneration: invalidatedGeneration + 1,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [agentChatSessions.agentId, agentChatSessions.chatId],
          set: {
            state: "evicted",
            runtimeState: "idle",
            runtimeStateAt: now,
            resumeGeneration: sql`${agentChatSessions.resumeGeneration} + 1`,
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
      cancelledMessageIds,
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
      terminateInvalidatedGeneration,
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

  if (outcome.terminateAgentId != null && outcome.terminateInvalidatedGeneration != null) {
    void softTerminateRemovedAgentSession({
      db,
      agentId: outcome.terminateAgentId,
      chatId,
      invalidatedGeneration: outcome.terminateInvalidatedGeneration,
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

async function loadChatOwnerAgentId(db: Database, chatId: string): Promise<string | null> {
  // Unfiltered on access_mode: leave/workspace-leave may flip a departing
  // owner to watcher while preserving role='owner'.
  const [row] = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.role, "owner")))
    .limit(1);
  return row?.agentId ?? null;
}

/**
 * Would the target still hold a membership row after their speaker row goes
 * away? Mirrors recomputeChatWatchers: a human keeps a watcher while they
 * manage an active non-human speaker in the chat.
 */
async function keepsMembershipAfterRemoval(
  db: Database,
  chatId: string,
  target: { type: string; agentId: string },
): Promise<boolean> {
  if (target.type !== "human") return false;
  const rows = (await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
        FROM chat_membership cm
        JOIN agents  a ON a.uuid = cm.agent_id
        JOIN members m ON m.id   = a.manager_id
       WHERE cm.chat_id = ${chatId}
         AND cm.access_mode = 'speaker'
         AND cm.agent_id <> ${target.agentId}
         AND m.agent_id = ${target.agentId}
         AND m.status   = 'active'
         AND a.type    <> 'human'
    ) AS anchored
  `)) as unknown as Array<{ anchored: boolean }>;
  return Boolean(rows[0]?.anchored);
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
  input: {
    chatId: string;
    targetAgentId: string;
    targetType: string;
    cancelledMessageIds: string[];
  },
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

  // Agent removed: one canonical cron phase under membership exclusive.
  // Lock order must match engagement delete (`pauseActiveJobsForOwnerChatDelete`):
  //   owner-chat barriers (stable owner order) → cron FOR UPDATE → pause/clear.
  // Include owners of already-paused jobs whose outstanding pointer matches a
  // cancelled delivery — clearing those rows still needs the barrier first.
  const cancelledIds = input.cancelledMessageIds;
  const activeMatch = and(
    eq(cronJobs.controlChatId, input.chatId),
    eq(cronJobs.agentId, input.targetAgentId),
    eq(cronJobs.state, "active"),
  );
  const pointerMatch =
    cancelledIds.length > 0
      ? and(
          eq(cronJobs.controlChatId, input.chatId),
          eq(cronJobs.agentId, input.targetAgentId),
          inArray(cronJobs.lastTriggerMessageId, cancelledIds),
        )
      : undefined;
  const affectedWhere = pointerMatch ? or(activeMatch, pointerMatch) : activeMatch;

  const ownerRows = await db
    .selectDistinct({ ownerMemberId: cronJobs.ownerMemberId })
    .from(cronJobs)
    .where(affectedWhere)
    .orderBy(asc(cronJobs.ownerMemberId));

  for (const row of ownerRows) {
    await lockOwnerChatCronBarrier(db, input.chatId, row.ownerMemberId);
  }

  const locked = await db
    .select({
      id: cronJobs.id,
      state: cronJobs.state,
      lastTriggerMessageId: cronJobs.lastTriggerMessageId,
    })
    .from(cronJobs)
    .where(affectedWhere)
    .orderBy(asc(cronJobs.id))
    .for("update");
  if (locked.length === 0) return;

  const activeIds = locked.filter((row) => row.state === "active").map((row) => row.id);
  const pointerClearIds = locked
    .filter((row) => row.lastTriggerMessageId != null && cancelledIds.includes(row.lastTriggerMessageId))
    .map((row) => row.id);

  if (activeIds.length > 0) {
    await db
      .update(cronJobs)
      .set({
        state: "paused",
        stateReason: "agent_not_speaker",
        nextRunAt: null,
        revision: sql`${cronJobs.revision} + 1`,
      })
      .where(inArray(cronJobs.id, activeIds));
  }

  if (pointerClearIds.length > 0) {
    await db.update(cronJobs).set({ lastTriggerMessageId: null }).where(inArray(cronJobs.id, pointerClearIds));
  }
}

/**
 * Hold shared membership across a live `inbox:deliver` socket send so removal
 * cannot cancel the row (and soft-terminate) between claim-commit and
 * `socket.send`. Re-check speaker + status with `FOR SHARE` on the entry row
 * and hold both locks through `action`, so recovery reset/ACK cannot flip
 * status after the SELECT and before send. Returns `undefined` when the frame
 * must be skipped (removed speaker, cancelled/acked/reset row). `chatId`-less
 * entries must not use this helper — they stay on the unfenced drain path.
 */
export async function withLiveInboxDeliveryFence<T>(
  db: Database,
  input: {
    agentId: string;
    chatId: string;
    entryId: number;
    inboxId: string;
  },
  action: (tx: Database) => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await lockChatMembershipShared(tx, [input.chatId]);
    if (!(await isChatSpeaker(tx, input.chatId, input.agentId))) return undefined;
    const [entry] = await tx
      .select({ id: inboxEntries.id })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.id, input.entryId),
          eq(inboxEntries.inboxId, input.inboxId),
          eq(inboxEntries.chatId, input.chatId),
          eq(inboxEntries.status, "delivered"),
        ),
      )
      .for("share")
      .limit(1);
    if (!entry) return undefined;
    return action(tx);
  });
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
  /** Pre-bump generation being cleaned up; Client ignores if already past it. */
  invalidatedGeneration: number;
  notifier?: Notifier;
  instanceId?: string;
}): Promise<void> {
  try {
    const localSent = await withLiveRemovedSessionFence(input.db, input.agentId, input.chatId, async () =>
      sendToAgent(input.agentId, {
        type: "session:terminate",
        chatId: input.chatId,
        resumeGeneration: input.invalidatedGeneration,
      }),
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
        resumeGeneration: input.invalidatedGeneration,
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
