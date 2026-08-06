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
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { BadRequestError, CallerNotSpeakerError, ForbiddenError, NotFoundError } from "../errors.js";
import { invalidateChatAudience } from "./chat-audience-cache.js";
import { lockChatMembershipMutation } from "./chat-membership-lock.js";
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

/** The owning member behind the chat's `role='owner'` row, if the chat still has one. */
async function loadChatOwnerMemberId(db: Database, chatId: string): Promise<string | null> {
  const [row] = await db
    .select({ ownerMemberId: agents.managerId })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.role, "owner")))
    .limit(1);
  return row?.ownerMemberId ?? null;
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
    await lockChatMembershipMutation(tx, [chatId]);

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

    const chatOwnerMemberId = await loadChatOwnerMemberId(tx, chatId);
    const callerIsOwnerSide =
      caller.role === "owner" || (chatOwnerMemberId !== null && chatOwnerMemberId === caller.ownerMemberId);
    const targetIsCallersOwnAgent = target.type !== "human" && target.ownerMemberId === caller.ownerMemberId;
    if (!callerIsOwnerSide && !targetIsCallersOwnAgent) {
      throw new ForbiddenError(
        "Only the chat owner's side can remove a participant, or the agent's own manager can recall it",
      );
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

    // Drop anything still queued for the removed agent in this chat.
    // Inbox delivery is inbox-scoped and never re-checks membership, so
    // without this the agent keeps being woken for a chat it can no longer
    // write to — it would burn a turn and then take a 403 on reply.
    // Deleting undeliverable rows matches `pruneStaleSilentEntries`.
    await tx
      .delete(inboxEntries)
      .where(
        and(
          eq(inboxEntries.inboxId, target.inboxId),
          eq(inboxEntries.chatId, chatId),
          eq(inboxEntries.status, "pending"),
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
