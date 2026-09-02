import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";

type ChatListProjection = Pick<ListMeChatsResponse, "rows"> & {
  priorityRows?: Pick<ListMeChatsResponse["priorityRows"], "pinned">;
  nextCursor?: ListMeChatsResponse["nextCursor"];
};

/**
 * React Query can expose a projection while a page is hydrating or when a cached
 * payload predates `priorityRows`. Cache reducers must tolerate that partial
 * shape instead of crashing the chat during render.
 */
function patchChatListProjection(
  previous: ChatListProjection | undefined,
  patchRow: (row: MeChatRow) => MeChatRow,
): ListMeChatsResponse | undefined {
  if (!previous) return undefined;

  return {
    ...previous,
    priorityRows: { pinned: (previous.priorityRows?.pinned ?? []).map(patchRow) },
    rows: (previous.rows ?? []).map(patchRow),
    nextCursor: previous.nextCursor ?? null,
  };
}

export function markChatRowsRead(
  previous: ChatListProjection | undefined,
  chatId: string,
): ListMeChatsResponse | undefined {
  return patchChatListProjection(previous, (row) =>
    row.chatId === chatId ? { ...row, unreadMentionCount: 0, chatHasExplicitMentionToMe: false } : row,
  );
}

export function patchChatListActivity(
  previous: ChatListProjection | undefined,
  chatId: string,
  preview: string,
  activityAt: string,
): ListMeChatsResponse | undefined {
  return patchChatListProjection(previous, (row) => {
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
