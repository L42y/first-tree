import type { MeChatRow } from "@first-tree/shared";

/**
 * Catch Up turns "everything that needs you" into a finite queue you can
 * empty, one card at a time — Slack's insight is that a list invites
 * skimming, while a deck asks for a decision and then hands you the next one.
 *
 * Two kinds of card, because the two kinds of debt want different verbs:
 *
 *   ask     — a question blocking on your answer. Answering it IS clearing it,
 *             so the card carries the answer surface rather than a "read" button.
 *   unread  — messages that mentioned you. Slack's pair applies verbatim:
 *             mark it read, or keep it unread and move on.
 */
export type CatchUpCard =
  | { kind: "ask"; key: string; chatId: string; title: string; count: number }
  | { kind: "unread"; key: string; chatId: string; title: string; count: number };

/**
 * Questions before mentions: an open ask blocks an agent that is waiting on
 * you, while an unread mention is only information. Within a kind, oldest
 * activity first — the thing that has been waiting longest deserves the top
 * of the deck, which is also the order that stops the queue growing a tail.
 */
export function buildCatchUpQueue(rows: readonly MeChatRow[]): CatchUpCard[] {
  const byOldestActivity = (a: MeChatRow, b: MeChatRow) =>
    Date.parse(a.lastMessageAt ?? "") - Date.parse(b.lastMessageAt ?? "") || a.chatId.localeCompare(b.chatId);

  const asks = rows
    .filter((row) => row.openRequestCount > 0)
    .sort(byOldestActivity)
    .map(
      (row): CatchUpCard => ({
        kind: "ask",
        key: `ask-${row.chatId}`,
        chatId: row.chatId,
        title: row.title,
        count: row.openRequestCount,
      }),
    );

  const unread = rows
    .filter((row) => row.openRequestCount === 0 && row.unreadMentionCount > 0)
    .sort(byOldestActivity)
    .map(
      (row): CatchUpCard => ({
        kind: "unread",
        key: `unread-${row.chatId}`,
        chatId: row.chatId,
        title: row.title,
        count: row.unreadMentionCount,
      }),
    );

  return [...asks, ...unread];
}

/**
 * The deck is rebuilt from the server on every refresh, so the position has to
 * survive cards disappearing underneath it — answering a question elsewhere,
 * or a chat going quiet. Anchoring on the card's key keeps the reader where
 * they were; when that card is gone, the index is clamped into the new deck.
 */
export function resolveDeckIndex(
  cards: readonly CatchUpCard[],
  activeKey: string | null,
  previousIndex: number,
): number {
  if (cards.length === 0) return 0;
  const byKey = cards.findIndex((card) => card.key === activeKey);
  if (byKey >= 0) return byKey;
  return Math.min(Math.max(previousIndex, 0), cards.length - 1);
}

/** "3 left" — the progress Slack puts in the header, so the queue feels finite. */
export function remainingLabel(cards: readonly CatchUpCard[], index: number): string {
  const left = Math.max(0, cards.length - index);
  return left === 1 ? "1 left" : `${left} left`;
}
