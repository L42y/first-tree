import type { ChatParticipantDetail } from "@first-tree/shared";

export type MentionCandidate = {
  agentId: string;
  /** Immutable routing name; this is the only value sent as `@name`. */
  name: string;
  displayName: string;
};

export type ActiveMentionTrigger = {
  /** Offset of the `@` that starts the token being edited. */
  triggerIndex: number;
  query: string;
};

export type MentionInsert = {
  text: string;
  cursor: number;
};

const MENTION_QUERY_REGEX = /(?:^|[^A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})?$/;

/**
 * The chat roster is already speaker-scoped. The viewer's own speaker row is
 * not an addressable recipient.
 */
export function buildMentionCandidates(
  participants: readonly ChatParticipantDetail[],
  selfAgentId: string | null | undefined,
): MentionCandidate[] {
  return participants
    .filter((participant) => participant.name && participant.agentId !== selfAgentId)
    .map((participant) => ({
      agentId: participant.agentId,
      name: participant.name as string,
      displayName: participant.displayName,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name));
}

export function computeRequiresMention(
  participantAgentIds: readonly string[],
  myAgentId: string | null | undefined,
): boolean {
  const meInRoster = myAgentId != null && participantAgentIds.includes(myAgentId);
  const speakersAfterSend = participantAgentIds.length + (meInRoster ? 0 : 1);
  return speakersAfterSend >= 3;
}

export function isSelfOnlySpeakerRoster(
  participantAgentIds: readonly string[],
  myAgentId: string | null | undefined,
): boolean {
  if (myAgentId == null) return false;
  return participantAgentIds.length === 1 && participantAgentIds[0] === myAgentId;
}

export function findSolePeerAgentId(
  participants: readonly ChatParticipantDetail[],
  myAgentId: string | null | undefined,
): string | null {
  if (!myAgentId) return null;
  const others = participants.filter((participant) => participant.agentId !== myAgentId);
  return others.length === 1 ? (others[0]?.agentId ?? null) : null;
}

/**
 * Web parity (`chat-by-id.tsx` `pickPrimaryAgent`): the agent the composer
 * names in its placeholder — the first non-self, non-human speaker, else the
 * first non-self speaker, else the viewer.
 */
export function pickPrimaryAgent(
  participants: readonly Pick<ChatParticipantDetail, "agentId" | "type">[],
  myAgentId: string | null | undefined,
): string | null {
  const nonSelf = participants.filter((participant) => participant.agentId !== myAgentId);
  const nonHuman = nonSelf.find((participant) => participant.type !== "human");
  if (nonHuman) return nonHuman.agentId;
  if (nonSelf[0]) return nonSelf[0].agentId;
  return myAgentId ?? null;
}

/**
 * Web parity (`chat-view.tsx` composer placeholder chain, mobile variant):
 * a self-only roster points at adding someone, a group carries the @mention
 * rule, and anything else names the primary agent. The desktop
 * `/ for commands · @ to mention` suffix is keyboard teaching that does not
 * apply to a touch surface.
 */
export function composerPlaceholder(args: {
  selfOnlyRoster: boolean;
  requiresMention: boolean;
  primaryDisplayName: string | null;
}): string {
  if (args.selfOnlyRoster) return "Add a participant to send a message";
  if (args.requiresMention) return "In a group, @mention who this is for";
  return `Message @${args.primaryDisplayName ?? "—"}`;
}

/**
 * Put an unfinished `@` in an empty group composer once, so the recipient
 * picker leads instead of letting the author type an unaddressed message.
 * Clearing it must not bring it back until the next chat visit.
 */
export function shouldPrimeMentionOnFocus(args: {
  requiresMention: boolean;
  dockActive: boolean;
  alreadyPrimed: boolean;
  draftLength: number;
  mentionCandidateCount: number;
}): boolean {
  return (
    args.requiresMention &&
    !args.dockActive &&
    !args.alreadyPrimed &&
    args.draftLength === 0 &&
    args.mentionCandidateCount > 0
  );
}

/**
 * Find an unfinished `@query` ending at the caret. The leading-boundary rule
 * intentionally matches the shared send-path parser, so what the picker
 * completes is the same class of token the server will resolve.
 */
export function findActiveMentionTrigger(text: string, caret: number): ActiveMentionTrigger | null {
  if (caret < 0 || caret > text.length) return null;
  const match = MENTION_QUERY_REGEX.exec(text.slice(0, caret));
  if (!match) return null;
  const atPosition = match.index + match[0].length - (match[1]?.length ?? 0) - 1;
  return { triggerIndex: atPosition, query: match[1] ?? "" };
}

/**
 * Web parity: name prefix wins, then display prefix, then display substring,
 * then name substring. Picker order stays stable instead of following roster
 * database order.
 */
export function rankMentionCandidates(candidates: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return [...candidates];

  const scored: Array<{ candidate: MentionCandidate; score: number }> = [];
  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase();
    const displayName = candidate.displayName.toLowerCase();
    let score: number | null = null;
    if (name.startsWith(lowerQuery)) score = 0;
    else if (displayName.startsWith(lowerQuery)) score = 1;
    else if (displayName.includes(lowerQuery)) score = 2;
    else if (name.includes(lowerQuery)) score = 3;
    if (score != null) scored.push({ candidate, score });
  }

  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.candidate.displayName.localeCompare(b.candidate.displayName) ||
        a.candidate.name.localeCompare(b.candidate.name),
    )
    .map(({ candidate }) => candidate);
}

export function buildMentionInsert(
  text: string,
  trigger: ActiveMentionTrigger,
  candidate: MentionCandidate,
): MentionInsert {
  const before = text.slice(0, trigger.triggerIndex);
  const after = text.slice(trigger.triggerIndex + 1 + trigger.query.length);
  const literal = `@${candidate.name}`;
  const needsSpace = after.length === 0 || !/\s/.test(after[0] ?? "");
  const suffix = needsSpace ? ` ${after}` : after;
  return {
    text: `${before}${literal}${suffix}`,
    cursor: before.length + literal.length + (needsSpace ? 1 : 0),
  };
}
