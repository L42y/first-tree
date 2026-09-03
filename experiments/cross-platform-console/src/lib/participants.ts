import type { ChatParticipantDetail, Message } from "@first-tree/shared";

/**
 * A chat participant plus the recency signal the roster orders by. The server
 * hands back `participants` in membership order, which tells a reader nothing
 * about who is carrying the conversation — the roster re-orders it by who
 * spoke last, so the people currently active in the chat sit on top.
 */
export type ParticipantRosterRow = {
  participant: ChatParticipantDetail;
  /** ISO time of this participant's newest message in the loaded window, or null when silent. */
  lastActiveAt: string | null;
  isSelf: boolean;
};

export type SelfIdentity = {
  /** The viewer's own agent row in the roster. */
  agentId?: string | null;
  /** Sender ids the viewer's own messages carry (member id / user id). */
  senderIds?: readonly string[];
};

function timeValue(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Newest message per participant. The viewer sends under their member id
 * rather than their agent id (see the optimistic row in `chat-detail`), so
 * those aliases collapse onto the self agent row before the fold.
 */
function lastActiveByAgentId(messages: readonly Message[], self: SelfIdentity): Map<string, string> {
  const selfAgentId = self.agentId ?? null;
  const selfSenderIds = new Set(self.senderIds ?? []);
  const newest = new Map<string, string>();
  for (const message of messages) {
    const agentId = selfAgentId && selfSenderIds.has(message.senderId) ? selfAgentId : message.senderId;
    const seen = newest.get(agentId);
    if (seen === undefined || timeValue(message.createdAt) > timeValue(seen)) {
      newest.set(agentId, message.createdAt);
    }
  }
  return newest;
}

/**
 * Roster ordered by recent activity: whoever spoke most recently first, then
 * everyone still silent in the loaded window ordered by how long they have
 * been in the chat. Ties break on display name so the order is stable across
 * renders rather than following database order.
 */
export function buildParticipantRoster(
  participants: readonly ChatParticipantDetail[],
  messages: readonly Message[],
  self: SelfIdentity = {},
): ParticipantRosterRow[] {
  const newest = lastActiveByAgentId(messages, self);
  const selfAgentId = self.agentId ?? null;
  const selfSenderIds = new Set(self.senderIds ?? []);
  return participants
    .map((participant) => ({
      participant,
      lastActiveAt: newest.get(participant.agentId) ?? null,
      // Some deployments seat the viewer under their member id rather than a
      // separate agent row, so both identities count as "you".
      isSelf: participant.agentId === selfAgentId || selfSenderIds.has(participant.agentId),
    }))
    .sort((a, b) => {
      const byActivity = timeValue(b.lastActiveAt) - timeValue(a.lastActiveAt);
      if (Number.isFinite(byActivity) && byActivity !== 0) return byActivity;
      if (a.lastActiveAt === null && b.lastActiveAt !== null) return 1;
      if (a.lastActiveAt !== null && b.lastActiveAt === null) return -1;
      const byJoin = timeValue(a.participant.joinedAt) - timeValue(b.participant.joinedAt);
      if (Number.isFinite(byJoin) && byJoin !== 0) return byJoin;
      return (
        a.participant.displayName.localeCompare(b.participant.displayName) ||
        a.participant.agentId.localeCompare(b.participant.agentId)
      );
    });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Short activity label for a roster row ("Active 5m ago"). */
export function formatLastActive(lastActiveAt: string | null, now: number = Date.now()): string {
  const at = timeValue(lastActiveAt);
  if (!Number.isFinite(at)) return "No messages yet";
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "Active now";
  if (elapsed < HOUR) return `Active ${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `Active ${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < WEEK) return `Active ${Math.floor(elapsed / DAY)}d ago`;
  return `Active ${Math.floor(elapsed / WEEK)}w ago`;
}

/**
 * Header subtitle: the same activity order, truncated so the most recently
 * active names are the ones that survive the single line.
 */
export function summarizeParticipants(rows: readonly ParticipantRosterRow[], max = 3): string {
  if (rows.length === 0) return "";
  const shown = rows.slice(0, max).map((row) => row.participant.displayName);
  const hidden = rows.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} +${hidden}` : shown.join(", ");
}

/** Human-readable membership role for a roster row. */
export function participantRoleLabel(row: ParticipantRosterRow): string {
  const kind = row.participant.type === "human" ? "Human" : "Agent";
  const watching = row.participant.mode === "mention_only" ? " · Mention only" : "";
  return `${kind}${watching}`;
}
