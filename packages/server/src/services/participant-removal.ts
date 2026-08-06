/**
 * Canonical "remove a participant from a chat" authorization + writer.
 *
 * This is the mirror of `participant-invite.ts`. Admission has always had a
 * single shared consent boundary that every entrypoint routes through;
 * removal did not — the agent-JWT `DELETE /agent/chats/:id/participants/:id`
 * route checked only "is the caller a speaker of this chat", which let any
 * speaker remove any other speaker, including the chat owner and agents
 * belonging to someone else. Web had no removal surface at all.
 *
 * Both entrypoints now come through here, so the rules live in one place:
 *
 *   1. Chat exists and is not a managed landing-campaign trial chat.
 *   2. Caller MUST be a speaker (`CallerNotSpeakerError`).
 *   3. Removing yourself is not a removal — `POST /:chatId/leave` and
 *      `POST /:chatId/workspace-leave` own that transition.
 *   4. Target MUST currently be a speaker.
 *   5. **The chat owner can never be removed.** `chats` carries no creator
 *      column, so `chat_membership.role = 'owner'` is the only record that
 *      the chat has an owner at all. Deleting that row would erase the fact
 *      irrecoverably and, via `assertOwner`'s "no agent owner is present"
 *      fallback, hand topic/description writes to every agent speaker.
 *      Protecting the row is also what lets the writer below stay a plain
 *      DELETE: the row it deletes is never the owner row, so `role` cannot
 *      be lost.
 *   6. Otherwise the caller must be **owner-side** for this removal:
 *        - the caller holds the chat's `owner` membership row, or
 *        - the caller's owning member is the chat owner's owning member
 *          (a manager and the agents they own share roster rights — the
 *          same "worker agents count as the owner" rule `assertOwner`
 *          already applies to chat metadata), or
 *        - the target is a non-human agent owned by the caller's owning
 *          member (recall your own agent from someone else's chat).
 *
 * Removing a human is deliberately NOT a hard eviction: their
 * `chat_membership` speaker row goes away, but `recomputeChatWatchers` will
 * re-materialise a watcher row while they still manage a speaker in the
 * chat, so they keep read access to work their own agents are doing. What
 * removal takes away is the ability to speak and to be addressed. Making
 * that durable against a self-service re-join is a separate, explicit
 * product decision and is not implemented here.
 */

import { parseLandingCampaignTrialChatMetadata } from "@first-tree/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, CallerNotSpeakerError, ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { lockChatMembershipMutation, lockChatSpeakerAndAgentSnapshot } from "./chat-membership-lock.js";
import { openRequestPredicate } from "./need-you.js";
import { recomputeChatWatchers } from "./participant-mode.js";

export type RemoveParticipantArgs = {
  chatId: string;
  /** The agent acting — a human agent for the web route, the agent itself for the agent route. */
  callerAgentId: string;
  targetAgentId: string;
};

type MembershipRow = {
  role: string;
  /** `agents.manager_id` — the member who owns this agent. */
  ownerMemberId: string;
  type: string;
  inboxId: string;
};

async function loadSpeaker(db: Database, chatId: string, agentId: string): Promise<MembershipRow | null> {
  const [row] = await db
    .select({
      role: chatMembership.role,
      ownerMemberId: agents.managerId,
      type: agents.type,
      inboxId: agents.inboxId,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Would the target still hold a `chat_membership` row after their speaker row
 * goes away? Mirrors `recomputeChatWatchers`' anchoring condition: a human
 * keeps a watcher row while they still manage an active non-human speaker in
 * the chat. Non-human agents have no watcher representation, so removing one
 * always detaches it.
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

/** The owning member behind the chat's `role='owner'` row, if the chat still has one. */
async function loadChatOwnerAgentId(db: Database, chatId: string): Promise<string | null> {
  // Deliberately unfiltered on access_mode: `leaveAsParticipant` flips a
  // departing owner to `watcher` while preserving `role`, so the owner row
  // is not necessarily a speaker.
  const [row] = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.role, "owner")))
    .limit(1);
  return row?.agentId ?? null;
}

async function loadOwningMember(db: Database, agentId: string): Promise<string | null> {
  const [row] = await db.select({ managerId: agents.managerId }).from(agents).where(eq(agents.uuid, agentId)).limit(1);
  return row?.managerId ?? null;
}

/**
 * Remove one speaker from a chat. Returns the chat's remaining speaker rows,
 * matching the wire shape both entrypoints already return.
 */
export async function removeParticipantFromChat(
  db: Database,
  args: RemoveParticipantArgs,
): Promise<(typeof chatMembership.$inferSelect)[]> {
  const { chatId, callerAgentId, targetAgentId } = args;

  const speakers = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    // Authorization below is derived from `agents.manager_id` (who owns the
    // caller, the target, and the chat owner). Taking only the membership
    // fence would leave those rows free to move: a manager reassignment
    // committing between the reads and this commit would let the decision
    // stand on ownership that no longer holds. `lockChatSpeakerAndAgentSnapshot`
    // exists for exactly that — it locks the chat, its speaker rows, and the
    // named agent rows FOR UPDATE in one UUID-sorted set, so manager
    // transfers cannot invalidate owner authority mid-transaction.
    // Take the membership fence first so the owner row cannot move, read who
    // the owner is, then lock the full authority set — caller, target AND the
    // owner's agent row. The snapshot helper only locks `access_mode='speaker'`
    // memberships plus the ids handed to it, and a `role='owner'` row is not
    // necessarily a speaker (`workspace-leave` downgrades an owner to watcher
    // while preserving the role), so the owner id has to be passed explicitly
    // or its `manager_id` stays free to change under the decision below.
    await lockChatMembershipMutation(tx, [chatId]);
    const chatOwnerAgentId = await loadChatOwnerAgentId(tx, chatId);
    await lockChatSpeakerAndAgentSnapshot(
      tx,
      [chatId],
      chatOwnerAgentId ? [callerAgentId, targetAgentId, chatOwnerAgentId] : [callerAgentId, targetAgentId],
    );

    const [chat] = await tx
      .select({ id: chats.id, metadata: chats.metadata })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);
    if (!chat) {
      throw new NotFoundError(`Chat "${chatId}" not found`);
    }
    if (parseLandingCampaignTrialChatMetadata(chat.metadata)) {
      throw new ForbiddenError("Landing campaign trial chats are managed by First Tree.");
    }

    // Self-removal is `leave`, not `remove`. Checked before the membership
    // lookups so the caller gets the actionable error even when they are not
    // a speaker at all.
    if (callerAgentId === targetAgentId) {
      throw new BadRequestError("Cannot remove yourself from a chat — leave the chat instead");
    }

    const caller = await loadSpeaker(tx, chatId, callerAgentId);
    if (!caller) {
      throw new CallerNotSpeakerError(callerAgentId, chatId);
    }

    const target = await loadSpeaker(tx, chatId, targetAgentId);
    if (!target) {
      throw new NotFoundError(`Agent "${targetAgentId}" is not a participant of this chat`);
    }
    if (target.role === "owner") {
      throw new ForbiddenError("The chat owner cannot be removed from their own chat");
    }

    const chatOwnerMemberId = chatOwnerAgentId ? await loadOwningMember(tx, chatOwnerAgentId) : null;
    const callerIsOwnerSide =
      caller.role === "owner" || (chatOwnerMemberId !== null && chatOwnerMemberId === caller.ownerMemberId);
    const targetIsCallersOwnAgent = target.type !== "human" && target.ownerMemberId === caller.ownerMemberId;
    if (!callerIsOwnerSide && !targetIsCallersOwnAgent) {
      throw new ForbiddenError(
        "Only the chat owner's side can remove a participant, or the agent's own manager can recall it",
      );
    }

    // An unresolved request addressed to the target, when removal would
    // leave them no membership row at all, is a trap with no exit:
    // `listNeedYouRequests` joins `chat_membership` so the request drops out
    // of their queue, `requireChatAccess` then refuses the chat so "Join to
    // reply" is unreachable, and `chat_user_state.open_request_count` stays
    // positive — which `chat-archive` treats as never-archivable. Refuse
    // instead of manufacturing that state. Callers who still hold a watcher
    // row are unaffected: they can see the request and join to answer it.
    if (!(await keepsMembershipAfterRemoval(tx, chatId, { type: target.type, agentId: targetAgentId }))) {
      const [openRequest] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.chatId, chatId), openRequestPredicate(targetAgentId)))
        .limit(1);
      if (openRequest) {
        throw new ConflictError(
          `Agent "${targetAgentId}" has an unanswered request in this chat and would lose all access to it. ` +
            "Resolve the request first, then remove them.",
        );
      }
    }

    await tx
      .delete(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, chatId),
          eq(chatMembership.agentId, targetAgentId),
          eq(chatMembership.accessMode, "speaker"),
        ),
      );

    // Drop what is still queued or in flight for the removed agent in this
    // chat. Delivery is inbox-scoped and never re-checks membership, so
    // leaving rows behind keeps waking an agent that can no longer write —
    // it burns a turn and then takes a 403 on reply. `delivered` rows matter
    // as much as `pending` ones: `resetDeliveredForInboxes` flips them back
    // to `pending` on the next bind without consulting membership, which
    // would resurrect exactly what this clears. Deleting undeliverable rows
    // matches `pruneStaleSilentEntries`.
    //
    // This is a mitigation, not a fence: `sendMessage` snapshots the speaker
    // set without taking the membership lock, so a send that started before
    // this transaction can still insert a row afterwards. Closing that
    // properly means making the delivery path membership-aware rather than
    // cleaning up behind it — tracked separately, see the PR discussion.
    await tx
      .delete(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, target.inboxId),
          eq(inboxEntries.chatId, chatId),
          inArray(inboxEntries.status, ["pending", "delivered"]),
        ),
      );

    await recomputeChatWatchers(tx, chatId);

    return tx
      .select()
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));
  });

  invalidateChatAudience(chatId);
  return speakers;
}
