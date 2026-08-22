import type {
  ChatDetail,
  ListMeChatsQuery,
  ListMeChatsResponse,
  MeChatRow,
  Message,
  SendMessage,
} from "@first-tree/shared";
import {
  chatDetailSchema,
  listMeChatsResponseSchema,
  messageSchema,
} from "@first-tree/shared";
import { api, withOrg } from "./api";

export type ListMeChatsQueryInput = Partial<
  Pick<ListMeChatsQuery, "cursor" | "limit" | "filter" | "engagement" | "origin" | "with" | "watching">
>;

export async function listMeChats(
  params?: ListMeChatsQueryInput,
  opts?: { signal?: AbortSignal },
): Promise<ListMeChatsResponse> {
  const qs = new URLSearchParams();
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.filter) qs.set("filter", params.filter);
  if (params?.engagement) qs.set("engagement", params.engagement);
  if (params?.origin && params.origin.length > 0) qs.set("origin", params.origin.join(","));
  if (params?.with && params.with.length > 0) qs.set("with", params.with.join(","));
  if (params?.watching) qs.set("watching", "1");
  const query = qs.toString();
  const res = await api.get<unknown>(withOrg(`/chats${query ? `?${query}` : ""}`), opts);
  return listMeChatsResponseSchema.parse(res);
}

export async function getChat(chatId: string): Promise<ChatDetail> {
  const res = await api.get<unknown>(`/chats/${encodeURIComponent(chatId)}`);
  return chatDetailSchema.parse(res);
}

export type PaginatedMessages = {
  items: Message[];
  nextCursor: string | null;
};


export async function listChatMessages(
  chatId: string,
  params?: { limit?: number; cursor?: string },
): Promise<PaginatedMessages> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api.get<PaginatedMessages>(
    `/chats/${encodeURIComponent(chatId)}/messages${query ? `?${query}` : ""}`,
  );
}

export async function sendChatMessage(
  chatId: string,
  content: string,
  mentions: string[],
): Promise<Message> {
  const metadata = mentions.length > 0 ? { mentions } : undefined;
  const body: SendMessage = {
    format: "text",
    content,
    source: "web",
    ...(metadata ? { metadata } : {}),
  };
  return api.post<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, body);
}

export async function markMeChatRead(chatId: string): Promise<void> {
  await api.post(`/chats/${encodeURIComponent(chatId)}/read`);
}

/**
 * Full paginated + deduped chat rows for a filter — shared by the Chats
 * screen and the tab-bar unread badge so both see identical data.
 */
export async function fetchChatRows(
  filter: "all" | "unread",
  signal?: AbortSignal,
): Promise<MeChatRow[]> {
  const collected: MeChatRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await listMeChats(
      { limit: 50, cursor: cursor ?? undefined, filter },
      { signal },
    );
    const pinnedIds = new Set(page.priorityRows.pinned.map((row) => row.chatId));
    const ordered = [...page.priorityRows.pinned, ...page.rows.filter((row) => !pinnedIds.has(row.chatId))];
    for (const row of ordered) {
      if (seen.has(row.chatId)) continue;
      seen.add(row.chatId);
      collected.push(row);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return collected;
}
