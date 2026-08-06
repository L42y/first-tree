import {
  ASK_AGENT_METADATA_KEY,
  CHAT_ENGAGEMENT_STATUSES,
  type ListNeedYouRequestsQuery,
  type ListNeedYouRequestsResponse,
  MESSAGE_FORMATS,
  type Message,
  messageSourceSchema,
  type RequestThreadResponse,
} from "@first-tree/shared";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { resolveAvatarImageUrl } from "./agent.js";

const NEED_YOU_CURSOR_VERSION = "v1";

function encodeNeedYouCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${NEED_YOU_CURSOR_VERSION}|${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function parseNeedYouCursor(cursor: string): { createdAt: Date; id: string } {
  let decoded = "";
  if (/^[A-Za-z0-9_-]+$/.test(cursor)) {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") === cursor) decoded = bytes.toString("utf8");
  }
  const [version, iso, id, ...extra] = decoded.split("|");
  const createdAt = new Date(iso ?? "");
  if (version !== NEED_YOU_CURSOR_VERSION || Number.isNaN(createdAt.getTime()) || !id || extra.length > 0) {
    throw new BadRequestError("cursor must be the nextCursor value from a previous Need you page");
  }
  return { createdAt, id };
}

export function openRequestPredicate(viewerAgentId: string) {
  return and(
    eq(messages.format, MESSAGE_FORMATS.REQUEST),
    sql`${messages.metadata} -> 'mentions' @> jsonb_build_array(${viewerAgentId}::text)`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${messages} AS resolver
      WHERE resolver.chat_id = ${messages.chatId}
        AND resolver.metadata -> 'resolves' ->> 'request' = ${messages.id}::text
        AND resolver.metadata -> 'resolves' ->> 'kind' IN ('answered', 'closed')
        AND resolver.sender_id IN (${messages.senderId}, ${viewerAgentId})
    )`,
  );
}

/**
 * Current human's cross-Chat, request-level FIFO review queue inside one Team.
 * The query derives lifecycle from durable request/resolution rows instead of
 * trusting the per-chat counter, so the exact total and the returned items
 * share one authority.
 */
export async function listNeedYouRequests(
  db: Database,
  viewerAgentId: string,
  organizationId: string,
  query: ListNeedYouRequestsQuery,
): Promise<ListNeedYouRequestsResponse> {
  const cursor = query.cursor ? parseNeedYouCursor(query.cursor) : null;
  const common = and(
    eq(chats.organizationId, organizationId),
    sql`${chats.parentChatId} IS NULL`,
    eq(chatMembership.agentId, viewerAgentId),
    sql`COALESCE(${chatUserState.engagementStatus}, ${CHAT_ENGAGEMENT_STATUSES.ACTIVE})
        = ${CHAT_ENGAGEMENT_STATUSES.ACTIVE}`,
    openRequestPredicate(viewerAgentId),
  );
  const cursorPredicate = cursor
    ? sql`(date_trunc('milliseconds', ${messages.createdAt}), ${messages.id})
          > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::text)`
    : sql`TRUE`;

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        requestId: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        format: messages.format,
        content: messages.content,
        metadata: messages.metadata,
        inReplyTo: messages.inReplyTo,
        source: messages.source,
        createdAt: messages.createdAt,
        chatTopic: chats.topic,
        chatDescription: chats.description,
        askerName: agents.name,
        askerDisplayName: agents.displayName,
        askerType: agents.type,
        askerAvatarColorToken: agents.avatarColorToken,
        askerAvatarImageUpdatedAt: agents.avatarImageUpdatedAt,
      })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .innerJoin(chatMembership, and(eq(chatMembership.chatId, chats.id), eq(chatMembership.agentId, viewerAgentId)))
      .leftJoin(chatUserState, and(eq(chatUserState.chatId, chats.id), eq(chatUserState.agentId, viewerAgentId)))
      .innerJoin(agents, eq(agents.uuid, messages.senderId))
      .where(and(common, cursorPredicate))
      .orderBy(sql`date_trunc('milliseconds', ${messages.createdAt}) ASC`, asc(messages.id))
      .limit(query.limit + 1),
    db
      .select({ value: count() })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .innerJoin(chatMembership, and(eq(chatMembership.chatId, chats.id), eq(chatMembership.agentId, viewerAgentId)))
      .leftJoin(chatUserState, and(eq(chatUserState.chatId, chats.id), eq(chatUserState.agentId, viewerAgentId)))
      .where(common),
  ]);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const total = Number(totalRows[0]?.value ?? 0);

  return {
    items: page.map((row) => {
      const request: Message = {
        id: row.requestId,
        chatId: row.chatId,
        senderId: row.senderId,
        format: row.format,
        content: row.content,
        metadata: row.metadata,
        inReplyTo: row.inReplyTo,
        source: messageSourceSchema.parse(row.source),
        createdAt: row.createdAt.toISOString(),
      };
      const askerAvatarImageUrl = resolveAvatarImageUrl({
        uuid: row.senderId,
        type: row.askerType,
        avatarImageUpdatedAt: row.askerAvatarImageUpdatedAt,
        userAvatarUrl: null,
      });
      return {
        request,
        chat: {
          id: row.chatId,
          title: row.chatTopic?.trim() || `Chat with ${row.askerDisplayName}`,
          topic: row.chatTopic,
          description: row.chatDescription,
        },
        asker: {
          agentId: row.senderId,
          name: row.askerName,
          displayName: row.askerDisplayName,
          avatarColorToken: row.askerAvatarColorToken,
          avatarImageUrl: askerAvatarImageUrl,
        },
      };
    }),
    total,
    nextCursor: hasMore && last ? encodeNeedYouCursor(last.createdAt, last.requestId) : null,
  };
}

/**
 * Request-scoped durable thread: the request, direct replies under it, every
 * trusted Ask agent clarification, and the agent replies threaded to those
 * clarifications. This stays complete even when the latest chat-message window
 * no longer contains an earlier clarification.
 */
export async function listRequestThread(
  db: Database,
  chatId: string,
  requestId: string,
): Promise<RequestThreadResponse> {
  const [request] = await db
    .select({ id: messages.id, format: messages.format })
    .from(messages)
    .where(and(eq(messages.id, requestId), eq(messages.chatId, chatId)))
    .limit(1);
  if (!request) throw new NotFoundError(`Message "${requestId}" not found in this chat`);
  if (request.format !== MESSAGE_FORMATS.REQUEST) {
    throw new BadRequestError(`Message "${requestId}" is not a request`);
  }

  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        sql`(
          ${messages.id} = ${requestId}
          OR ${messages.inReplyTo} = ${requestId}
          OR ${messages.inReplyTo} IN (
            SELECT clarification.id
            FROM ${messages} AS clarification
            WHERE clarification.chat_id = ${chatId}
              AND clarification.in_reply_to = ${requestId}
              AND clarification.metadata -> ${ASK_AGENT_METADATA_KEY} ->> 'requestId' = ${requestId}
          )
        )`,
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id));

  return {
    items: rows.map((row) => ({
      id: row.id,
      chatId: row.chatId,
      senderId: row.senderId,
      format: row.format,
      content: row.content,
      metadata: row.metadata,
      inReplyTo: row.inReplyTo,
      source: messageSourceSchema.parse(row.source),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
