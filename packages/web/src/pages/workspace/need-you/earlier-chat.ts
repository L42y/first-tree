import type { Message } from "@first-tree/shared";

export type EarlierChatPreview = {
  unavailable: boolean;
  messages: Message[];
};

/**
 * Select a bounded preview before one request. Direct chats include every
 * message authored by the pair; group chats additionally require the message
 * to address or reply to the other member of the pair, so the asker's side
 * conversations with other participants never leak into this review context.
 */
export function selectEarlierChatPreview({
  messages,
  requestId,
  requestCreatedAt,
  humanAgentId,
  askerAgentId,
  directChat,
  limit,
}: {
  messages: readonly Message[];
  requestId: string;
  requestCreatedAt: string;
  humanAgentId: string;
  askerAgentId: string;
  directChat: boolean;
  limit: number;
}): EarlierChatPreview {
  if (!messages.some((message) => message.id === requestId)) {
    return { unavailable: true, messages: [] };
  }

  const senderById = new Map(messages.map((message) => [message.id, message.senderId]));
  const pair = new Set([humanAgentId, askerAgentId]);
  const selected = messages
    .filter((message) => {
      if (message.id === requestId || message.createdAt >= requestCreatedAt || !pair.has(message.senderId)) {
        return false;
      }
      if (directChat) return true;

      const otherAgentId = message.senderId === humanAgentId ? askerAgentId : humanAgentId;
      const mentions = Array.isArray(message.metadata.mentions) ? message.metadata.mentions : [];
      return mentions.includes(otherAgentId) || senderById.get(message.inReplyTo ?? "") === otherAgentId;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-limit);

  return { unavailable: false, messages: selected };
}
