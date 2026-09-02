import type { MeChatRow } from "@first-tree/shared";

/**
 * Native chat lists cache fully merged, deduped `MeChatRow[]` pages under
 * `["me", "chats", "list", ...]`. Reducers operate on rows so every filter,
 * engagement view, and tab badge projection stays consistent.
 */
function patchChatRows(
  previous: MeChatRow[] | undefined,
  patchRow: (row: MeChatRow) => MeChatRow,
): MeChatRow[] | undefined {
  if (!Array.isArray(previous)) return previous;
  return previous.map(patchRow);
}

export function clearChatUnreadRows(previous: MeChatRow[] | undefined, chatId: string): MeChatRow[] | undefined {
  return patchChatRows(previous, (row) =>
    row.chatId === chatId ? { ...row, unreadMentionCount: 0, chatHasExplicitMentionToMe: false } : row,
  );
}

export function patchChatRowActivity(
  previous: MeChatRow[] | undefined,
  chatId: string,
  preview: string,
  activityAt: string,
): MeChatRow[] | undefined {
  return patchChatRows(previous, (row) => {
    if (row.chatId !== chatId) return row;

    return {
      ...row,
      chatHasExplicitMentionToMe: false,
      unreadMentionCount: 0,
      lastMessageAt: activityAt,
      lastMessagePreview: preview,
      activityAt,
    };
  });
}

/**
 * Guards reloads from a build whose optimistic reducer briefly transformed
 * row arrays into paginated-projection objects.
 */
export function asChatRows(value: unknown): MeChatRow[] {
  return Array.isArray(value) ? value : [];
}
