import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { agents } from "../../../db/schema/agents.js";
import { chatMembership } from "../../../db/schema/chat-membership.js";
import { chats } from "../../../db/schema/chats.js";

// biome-ignore lint/suspicious/noExplicitAny: accepts both the root database and transaction clients
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

export type LockedChatSpeaker = {
  chatId: string;
  agentId: string;
  organizationId: string;
  type: string;
  status: string;
  managerId: string;
  delegateMention: string | null;
};

export type LockedChatMembership = LockedChatSpeaker & {
  accessMode: string;
};

export type LockedChatSpeakerSnapshot = {
  chats: Array<{ id: string; organizationId: string }>;
  speakers: LockedChatSpeaker[];
};

export type LockedChatSpeakerAndAgentSnapshot = LockedChatSpeakerSnapshot & {
  agents: Omit<LockedChatSpeaker, "chatId">[];
};

export type LockedChatMembershipSnapshot = {
  chats: Array<{ id: string; organizationId: string }>;
  memberships: LockedChatMembership[];
};

type LockedChatMembershipRows = {
  chats: Array<{ id: string; organizationId: string }>;
  memberships: Array<{ chatId: string; agentId: string; accessMode: string }>;
  agents: Omit<LockedChatSpeaker, "chatId">[];
};

/**
 * Serialize every speaker insert, delete, downgrade, and routing snapshot for
 * one chat. The transaction advisory lock also covers a not-yet-existing
 * membership row, which a row-level lock alone cannot protect.
 */
export async function lockChatMembershipMutation(db: DbLike, chatIds: ReadonlyArray<string>): Promise<void> {
  const stableChatIds = [...new Set(chatIds)].sort();
  for (const chatId of stableChatIds) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('chat_speaker_membership'), hashtext(${chatId}))`);
  }
}

/**
 * Freeze manager/member authority changes that can expand or shrink the set
 * of agents whose watcher projections a lifecycle mutation must rebuild.
 * Global order: member projection ids → agent projection ids → chat fences.
 */
export async function lockWatcherProjectionMemberMutation(db: DbLike, memberIds: ReadonlyArray<string>): Promise<void> {
  for (const memberId of [...new Set(memberIds)].sort()) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('watcher_projection_member'), hashtext(${memberId}))`);
  }
}

/**
 * Freeze first-time speaker admission for an agent while its current chat set
 * is discovered and fenced for watcher authority changes.
 */
export async function lockWatcherProjectionAgentMutation(db: DbLike, agentIds: ReadonlyArray<string>): Promise<void> {
  for (const agentId of [...new Set(agentIds)].sort()) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('watcher_projection_agent'), hashtext(${agentId}))`);
  }
}

/**
 * Lock a stable speaker/owner snapshot after taking the shared membership
 * mutation fence. Agent rows are locked separately so manager transfers and
 * status/delegate changes cannot invalidate owner or wake authority before
 * the enclosing transaction commits.
 */
export async function lockChatSpeakerSnapshot(
  db: DbLike,
  chatIds: ReadonlyArray<string>,
): Promise<LockedChatSpeakerSnapshot> {
  const snapshot = await lockChatSpeakerAndAgentSnapshot(db, chatIds, []);
  return { chats: snapshot.chats, speakers: snapshot.speakers };
}

/**
 * Lock every membership row in the selected chats, including watchers.
 * Agent-issued SCM declarations use this broader snapshot because their
 * stable representative human may be a supervising watcher, while the wake
 * side is still validated as a speaker by the caller.
 */
export async function lockChatMembershipSnapshot(
  db: DbLike,
  chatIds: ReadonlyArray<string>,
): Promise<LockedChatMembershipSnapshot> {
  const snapshot = await lockChatMembershipAndAgentRows(db, chatIds, [], true);
  const agentById = new Map(snapshot.agents.map((row) => [row.agentId, row]));
  const memberships = snapshot.memberships.flatMap((membership) => {
    const agent = agentById.get(membership.agentId);
    return agent ? [{ ...membership, ...agent }] : [];
  });
  return { chats: snapshot.chats, memberships };
}

/**
 * Lock candidate speakers and additional authority agents as one UUID-sorted
 * set. Callers that already hold required member rows can use this to avoid
 * taking a pair lock first and expanding it later to overlapping chat
 * speakers, which would permit cross-chat deadlocks.
 */
export async function lockChatSpeakerAndAgentSnapshot(
  db: DbLike,
  chatIds: ReadonlyArray<string>,
  additionalAgentIds: ReadonlyArray<string>,
): Promise<LockedChatSpeakerAndAgentSnapshot> {
  const snapshot = await lockChatMembershipAndAgentRows(db, chatIds, additionalAgentIds, false);
  const agentById = new Map(snapshot.agents.map((row) => [row.agentId, row]));
  const speakers = snapshot.memberships.flatMap((membership) => {
    const agent = agentById.get(membership.agentId);
    return agent ? [{ chatId: membership.chatId, ...agent }] : [];
  });
  return { chats: snapshot.chats, speakers, agents: snapshot.agents };
}

async function lockChatMembershipAndAgentRows(
  db: DbLike,
  chatIds: ReadonlyArray<string>,
  additionalAgentIds: ReadonlyArray<string>,
  includeWatchers: boolean,
): Promise<LockedChatMembershipRows> {
  const stableChatIds = [...new Set(chatIds)].sort();
  if (stableChatIds.length > 0) await lockChatMembershipMutation(db, stableChatIds);

  const chatRows =
    stableChatIds.length === 0
      ? []
      : await db
          .select({ id: chats.id, organizationId: chats.organizationId })
          .from(chats)
          .where(inArray(chats.id, stableChatIds))
          .orderBy(asc(chats.id))
          .for("update");
  const membershipRows =
    stableChatIds.length === 0
      ? []
      : await db
          .select({
            chatId: chatMembership.chatId,
            agentId: chatMembership.agentId,
            accessMode: chatMembership.accessMode,
          })
          .from(chatMembership)
          .where(
            includeWatchers
              ? inArray(chatMembership.chatId, stableChatIds)
              : and(inArray(chatMembership.chatId, stableChatIds), eq(chatMembership.accessMode, "speaker")),
          )
          .orderBy(asc(chatMembership.chatId), asc(chatMembership.agentId))
          .for("update");
  const agentIds = [...new Set([...membershipRows.map((row) => row.agentId), ...additionalAgentIds])].sort();
  if (agentIds.length === 0) return { chats: chatRows, memberships: [], agents: [] };
  const agentRows = await db
    .select({
      agentId: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      managerId: agents.managerId,
      delegateMention: agents.delegateMention,
    })
    .from(agents)
    .where(inArray(agents.uuid, agentIds))
    .orderBy(asc(agents.uuid))
    .for("update");
  return { chats: chatRows, memberships: membershipRows, agents: agentRows };
}
