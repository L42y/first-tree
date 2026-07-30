import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import type { InfiniteData } from "@tanstack/react-query";

type MeChatsData = InfiniteData<ListMeChatsResponse>;

/**
 * Optimistically reflect a pin / unpin in a cached me-chats infinite list, so the
 * row jumps to (or out of) the Pinned group instantly instead of waiting for the
 * server round-trip + refetch. Pure: returns a new `InfiniteData` and never
 * mutates its input, so it doubles as the rollback source (keep the pre-call
 * value and re-set it on error).
 *
 * Mirrors the server projection contract (`shared/schemas/me-chat.ts`):
 *   - `priorityRows.pinned` lives on page 0 only; later pages carry it empty and
 *     the client reads page 0.
 *   - `pinned` is ordered by real-work activity DESC, matching the server.
 *   - the ordinary `rows` are ADDITIVE; the row-list dedup in `index.tsx` drops
 *     any chat present in a priority group, so inserting into `pinned` removes
 *     the chat from the recency stream on the next render with no extra work.
 *
 * `pinnedAt` is flipped on EVERY occurrence of the chat (pinned / rows, across
 * all pages) so the row-actions menu reads Pin vs Unpin
 * consistently wherever the chat is rendered. A chat absent from this list
 * (e.g. filtered out of another cached view) is left untouched; the trailing
 * invalidate reconciles it.
 */
export function applyOptimisticPin(data: MeChatsData, chatId: string, pinned: boolean, nowIso: string): MeChatsData {
  const nextPinnedAt = pinned ? nowIso : null;
  const setPin = (row: MeChatRow): MeChatRow =>
    row.chatId === chatId && row.pinnedAt !== nextPinnedAt ? { ...row, pinnedAt: nextPinnedAt } : row;

  // Seed row for a promotion (recency → Pinned): prefer a pinned copy, then any
  // page's ordinary rows. Returned with a corrected `pinnedAt`.
  const findRow = (): MeChatRow | undefined => {
    for (const page of data.pages) {
      const hit =
        page.priorityRows.pinned.find((r) => r.chatId === chatId) ?? page.rows.find((r) => r.chatId === chatId);
      if (hit) return hit;
    }
    return undefined;
  };

  const pages = data.pages.map((page, index) => {
    let pinnedList = page.priorityRows.pinned.map(setPin);
    if (index === 0) {
      const inPinned = pinnedList.some((r) => r.chatId === chatId);
      if (pinned && !inPinned) {
        const row = findRow();
        if (row) pinnedList = sortByActivity([...pinnedList, { ...row, pinnedAt: nextPinnedAt }]);
      } else if (!pinned && inPinned) {
        pinnedList = pinnedList.filter((r) => r.chatId !== chatId);
      }
    }
    return { ...page, priorityRows: { pinned: pinnedList }, rows: page.rows.map(setPin) };
  });

  return { ...data, pages };
}

function sortByActivity(rows: readonly MeChatRow[]): MeChatRow[] {
  return [...rows].sort((a, b) => {
    const aAt = Date.parse(a.activityAt ?? a.lastMessageAt ?? "") || 0;
    const bAt = Date.parse(b.activityAt ?? b.lastMessageAt ?? "") || 0;
    return bAt - aAt || b.chatId.localeCompare(a.chatId);
  });
}
