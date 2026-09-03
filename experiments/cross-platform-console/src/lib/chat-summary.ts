/**
 * The chat's Summary — the agent-authored current-state brief on
 * `chat.description`. It answers "what is happening in here" without replaying
 * the thread, so the chat surfaces it above the timeline rather than leaving it
 * to the conversation-list preview.
 */
export type ChatSummaryState = {
  text: string;
  /** ISO time of the last real description write, or null when never written. */
  updatedAt: string | null;
  /** The summary changed since the reader last opened the chat. */
  isUnread: boolean;
};

export function buildChatSummary(chat: {
  description?: string | null;
  descriptionUpdatedAt?: string | null;
  lastReadAt?: string | null;
}): ChatSummaryState | null {
  const text = chat.description?.trim();
  if (!text) return null;
  const updatedAt = chat.descriptionUpdatedAt ?? null;
  return { text, updatedAt, isUnread: isUpdatedSinceRead(updatedAt, chat.lastReadAt ?? null) };
}

/**
 * A summary written after the reader's last visit is news; one written before
 * it is background they have already had a chance to see. An unknown write
 * time cannot be news, and a reader who has never opened the chat has not seen
 * any of it.
 */
export function isUpdatedSinceRead(updatedAt: string | null, lastReadAt: string | null): boolean {
  if (!updatedAt) return false;
  const written = Date.parse(updatedAt);
  if (Number.isNaN(written)) return false;
  if (!lastReadAt) return true;
  const read = Date.parse(lastReadAt);
  return Number.isNaN(read) ? true : written > read;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact freshness for the summary line ("Updated 5m ago"). */
export function formatSummaryAge(updatedAt: string | null, now: number = Date.now()): string | null {
  if (!updatedAt) return null;
  const written = Date.parse(updatedAt);
  if (Number.isNaN(written)) return null;
  const elapsed = Math.max(0, now - written);
  if (elapsed < MINUTE) return "Updated just now";
  if (elapsed < HOUR) return `Updated ${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `Updated ${Math.floor(elapsed / HOUR)}h ago`;
  return `Updated ${Math.floor(elapsed / DAY)}d ago`;
}
