import type { Message } from "@first-tree/shared";
import { readAskAgentMessageMetadata } from "@first-tree/shared";

export type AskAgentExchange = {
  clarification: Message;
  reply: Message | null;
};

/**
 * Project trusted Ask agent turns from the durable request thread. A normal
 * threaded discussion is intentionally ignored: only the server-owned marker
 * creates a clarification exchange, and only a direct reply from the original
 * asker satisfies it.
 */
export function projectAskAgentExchanges({
  thread,
  requestId,
  humanAgentId,
  askerAgentId,
}: {
  thread: readonly Message[];
  requestId: string;
  humanAgentId: string;
  askerAgentId: string;
}): AskAgentExchange[] {
  const ordered = [...thread].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return ordered.flatMap((message) => {
    const marker = readAskAgentMessageMetadata(message.metadata);
    if (
      message.senderId !== humanAgentId ||
      message.inReplyTo !== requestId ||
      marker?.requestId !== requestId ||
      marker.agentId !== askerAgentId
    ) {
      return [];
    }
    const reply =
      ordered.find((candidate) => candidate.senderId === askerAgentId && candidate.inReplyTo === message.id) ?? null;
    return [{ clarification: message, reply }];
  });
}
