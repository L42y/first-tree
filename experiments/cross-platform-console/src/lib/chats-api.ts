import type {
  ChatDetail,
  ChatTokenUsage,
  ListMeChatsQuery,
  ListMeChatsResponse,
  MeChatRow,
  Message,
  SendMessage,
} from "@first-tree/shared";
import { chatDetailSchema, listMeChatsResponseSchema, messageSchema } from "@first-tree/shared";
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

/** Cumulative model usage for a chat; wide-screen surfaces render this compactly. */
export async function getChatTokenUsage(chatId: string): Promise<ChatTokenUsage> {
  return api.get<ChatTokenUsage>(`/chats/${encodeURIComponent(chatId)}/token-usage`);
}

export type PaginatedMessages = {
  items: Message[];
  nextCursor: string | null;
};

export async function listChatMessages(
  chatId: string,
  params?: { limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<PaginatedMessages> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const query = qs.toString();
  return api.get<PaginatedMessages>(`/chats/${encodeURIComponent(chatId)}/messages${query ? `?${query}` : ""}`, {
    signal,
  });
}

export async function sendChatMessage(chatId: string, content: string, mentions: string[]): Promise<Message> {
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

export type ChatRowsPage = {
  rows: MeChatRow[];
  nextCursor: string | null;
};

/**
 * One page of chat rows for a filter — used by the Chats screen's infinite
 * list. Pinned rows are server-attached to every page's response, so they
 * are only kept on the first page (no cursor yet) to avoid duplicates.
 */
export async function fetchChatRowsPage(
  filter: "all" | "unread",
  cursor: string | undefined,
  signal?: AbortSignal,
  engagement: "active" | "archived" = "active",
): Promise<ChatRowsPage> {
  const page = await listMeChats({ limit: 50, cursor, filter, engagement }, { signal });
  const pinnedIds = new Set(page.priorityRows.pinned.map((row) => row.chatId));
  const rest = page.rows.filter((row) => !pinnedIds.has(row.chatId));
  const rows = cursor ? rest : [...page.priorityRows.pinned, ...rest];
  return { rows, nextCursor: page.nextCursor };
}

/**
 * Full paginated + deduped chat rows for a filter — shared by the tab-bar
 * unread badge, Attention, and Quick Actions, which all need the complete
 * set (badge counts, cross-chat search) rather than an incremental page.
 */
export async function fetchChatRows(
  filter: "all" | "unread",
  signal?: AbortSignal,
  engagement: "active" | "archived" = "active",
): Promise<MeChatRow[]> {
  const collected: MeChatRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await listMeChats({ limit: 50, cursor: cursor ?? undefined, filter, engagement }, { signal });
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

/**
 * Start a task chat with an agent — mirrors the web console's
 * `createMeTaskChat` body (POST {withOrg}/chats).
 */
export async function createTaskChat(recipientAgentId: string, message: string): Promise<{ chatId: string }> {
  return api.post<{ chatId: string }>(withOrg("/chats"), {
    mode: "task",
    initialRecipientAgentIds: [recipientAgentId],
    initialRecipientNames: [],
    contextParticipantAgentIds: [],
    contextParticipantNames: [],
    initialMessage: {
      format: "text",
      content: message,
      source: "web",
    },
  });
}

/** Rename a chat (`PATCH /chats/:id`, same body as web). */
export async function renameChat(chatId: string, topic: string): Promise<void> {
  await api.patch(`/chats/${encodeURIComponent(chatId)}`, { topic });
}

/** Archive or restore a chat (`POST /chats/:id/engagement`). */
export async function setChatEngagement(chatId: string, status: "active" | "archived" | "deleted"): Promise<void> {
  await api.post(`/chats/${encodeURIComponent(chatId)}/engagement`, { status });
}

/**
 * Add speaking participants to a chat (`POST /chats/:id/participants`,
 * idempotent server-side). The mention picker uses this to pull someone in
 * from the org directory before addressing them.
 */
export async function addChatParticipants(chatId: string, agentIds: string[]): Promise<void> {
  await api.post(`/chats/${encodeURIComponent(chatId)}/participants`, { participantIds: agentIds });
}

export type ChatLinkedEntity = {
  entityType: string;
  entityKey: string;
  htmlUrl: string;
  title: string | null;
  state: string | null;
  number: number | null;
};

/** GitHub entities followed into this chat (PRs, issues, …). */
export async function listChatGithubEntities(chatId: string, signal?: AbortSignal): Promise<ChatLinkedEntity[]> {
  const res = await api.get<{ items?: ChatLinkedEntity[] }>(`/chats/${encodeURIComponent(chatId)}/github-entities`, {
    signal,
  });
  return res.items ?? [];
}

/** GitLab merge requests / issues followed into this chat. */
export async function listChatGitlabEntities(chatId: string, signal?: AbortSignal): Promise<ChatLinkedEntity[]> {
  const res = await api.get<{ items?: ChatLinkedEntity[] }>(`/chats/${encodeURIComponent(chatId)}/gitlab-entities`, {
    signal,
  });
  return res.items ?? [];
}

export type ChatCronJob = {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  state: string;
  nextRunAt: string | null;
};

/** Scheduled jobs whose control chat is this one. */
export async function listChatCronJobs(chatId: string, signal?: AbortSignal): Promise<ChatCronJob[]> {
  const res = await api.get<{ items?: ChatCronJob[] }>(`/chats/${encodeURIComponent(chatId)}/cron-jobs`, { signal });
  return res.items ?? [];
}
