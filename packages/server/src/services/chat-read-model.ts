import { MENTION_REGEX, stripCode } from "@first-tree/shared";

export const CHAT_SUMMARY_MAX_LENGTH = 50;

/**
 * Extract a plain-text summary from a message's JSONB content field.
 *
 * Mention tokens are routing metadata rather than part of the user's intent,
 * so they are removed before whitespace normalization and code-point-aware
 * truncation. Code regions are removed first so identifier-shaped tokens such
 * as `@param` are never partially interpreted as mentions.
 */
export function extractChatSummary(content: unknown, maxLen = CHAT_SUMMARY_MAX_LENGTH): string | null {
  let text = "";
  if (typeof content === "object" && content !== null && "text" in content) {
    text = String((content as { text: unknown }).text ?? "");
  } else if (typeof content === "string") {
    text = content;
  }
  if (!text) return null;

  const cleaned = stripCode(text).replace(MENTION_REGEX, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, maxLen).join("");
}

/**
 * Resolve the canonical display title for a Chat read model: explicit topic,
 * then first-message summary, then the other participants' display names.
 */
export function resolveChatTitle<P extends { agentId: string; displayName: string }>(
  topic: string | null,
  firstMessageSummary: string | null,
  participants: ReadonlyArray<P>,
  selfAgentId: string,
): string {
  if (topic && topic.length > 0) return topic;
  if (firstMessageSummary && firstMessageSummary.length > 0) return firstMessageSummary;
  const others = participants.filter((participant) => participant.agentId !== selfAgentId);
  if (others.length === 0) return "Empty chat";
  if (others.length <= 3) return others.map((participant) => participant.displayName).join(", ");
  return `${others[0]?.displayName}, ${others[1]?.displayName} +${others.length - 2}`;
}
