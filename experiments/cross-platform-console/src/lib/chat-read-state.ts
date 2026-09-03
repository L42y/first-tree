import { getItem, setItem } from "./storage";

const READ_STATE_KEY_PREFIX = "chat-read-state:";

export type ChatReadState = {
  chatId: string;
  /** The message aligned to the bottom edge when the viewer last left the chat. */
  bottomVisibleMessageId: string;
  /** The newest message present when that snapshot was written. */
  latestKnownMessageId: string;
  updatedAt: number;
};

export function chatReadStateKey(chatId: string): string {
  return `${READ_STATE_KEY_PREFIX}${chatId}`;
}

export async function getChatReadState(chatId: string): Promise<ChatReadState | null> {
  const value = await getItem<ChatReadState>(chatReadStateKey(chatId));
  if (!value) return null;
  const { chatId: valueChatId, bottomVisibleMessageId, latestKnownMessageId, updatedAt } = value;
  if (
    valueChatId !== chatId ||
    typeof bottomVisibleMessageId !== "string" ||
    typeof latestKnownMessageId !== "string" ||
    typeof updatedAt !== "number"
  ) {
    return null;
  }
  return { chatId, bottomVisibleMessageId, latestKnownMessageId, updatedAt };
}

export async function saveChatReadState(
  chatId: string,
  bottomVisibleMessageId: string,
  latestKnownMessageId: string,
): Promise<void> {
  await setItem<ChatReadState>(chatReadStateKey(chatId), {
    chatId,
    bottomVisibleMessageId,
    latestKnownMessageId,
    updatedAt: Date.now(),
  });
}

/** Server message pages are newest-first; the timeline is always oldest-first. */
export function flattenNewestFirstMessages<T>(pages: readonly (readonly T[])[]): T[] {
  return [...pages.flat()].reverse();
}

export function findMessageIndexById<T extends { id: string }>(
  messages: readonly T[],
  messageId: string | null | undefined,
): number {
  if (!messageId) return -1;
  return messages.findIndex((message) => message.id === messageId);
}

/**
 * Message IDs are random UUIDs, so "newer than" is an ordering on the merged
 * timeline, never a lexical comparison of IDs.
 */
export function countUnreadMessages<T extends { id: string; senderId: string }>(
  messages: readonly T[],
  baselineMessageId: string | null | undefined,
  selfSenderIds: readonly string[],
): number {
  const baselineIndex = findMessageIndexById(messages, baselineMessageId);
  if (baselineIndex < 0) return 0;
  const selfSenders = new Set(selfSenderIds);
  return messages.slice(baselineIndex + 1).filter((message) => !selfSenders.has(message.senderId)).length;
}

export function findFirstUnreadIndex<T extends { id: string; senderId: string }>(
  messages: readonly T[],
  baselineMessageId: string | null | undefined,
  selfSenderIds: readonly string[],
): number {
  const baselineIndex = findMessageIndexById(messages, baselineMessageId);
  if (baselineIndex < 0) return -1;
  const selfSenders = new Set(selfSenderIds);
  return messages.findIndex((message, index) => index > baselineIndex && !selfSenders.has(message.senderId));
}

export function formatNewMessages(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 new message" : `${count} new messages`;
}

/** Distance from the newest message that still counts as "the reader is there". */
export const LIST_END_SLACK = 24;

/**
 * Is the reader parked at the newest message? The timeline renders inverted,
 * so offset 0 is the newest edge and this is a coordinate check rather than a
 * per-message visibility guess — a bubble taller than the viewport, or one
 * tucked under the glass composer, used to leave the unread pill on screen
 * pointing at messages the reader was already looking at.
 */
export function isAtNewestEdge(offsetY: number, slack: number = LIST_END_SLACK): boolean {
  return offsetY <= slack;
}
