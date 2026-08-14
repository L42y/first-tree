import {
  type FeishuReferenceContext,
  type FeishuReferenceContextMessage,
  hasCurrentFeishuRequiredScopes,
  readFeishuMessageMetadata,
} from "@first-tree/shared";
import type { Client } from "@larksuiteoapi/node-sdk";
import { eq } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { imBotBindings } from "../../../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../../../db/schema/im-chat-bindings.js";
import { messages } from "../../../db/schema/messages.js";
import { ForbiddenError, NotFoundError } from "../../../errors.js";
import { isFeishuBotUsable } from "./binding-state.js";
import { convertFeishuContent } from "./content.js";
import { type FeishuHistoryItem, readFeishuHistoryPage } from "./provider-reader.js";

const MAX_HISTORY_PAGES = 3;
const HISTORY_PAGE_SIZE = 50;
const THREAD_MESSAGE_LIMIT = 20;
const CHAT_MESSAGE_LIMIT = 10;
// Keep the message array below the public 64 KiB response ceiling while
// reserving room for the DTO envelope. The Client separately enforces the
// exact 64 KiB rendered-prompt ceiling.
const REFERENCE_CONTEXT_BYTES = 63 * 1024;

type BindingRow = typeof imBotBindings.$inferSelect;

export type FeishuReferenceContextTarget = {
  binding: BindingRow;
  canonicalChatId: string;
  feishuChatId: string;
  externalMessageId: string;
  scope: "thread" | "chat";
  containerId: string;
  sentAt: string | null;
};

/** Resolve and authorize the provider coordinate from one immutable canonical trigger message. */
export async function loadFeishuReferenceContextTarget(
  db: Database,
  agentId: string,
  firstTreeMessageId: string,
): Promise<FeishuReferenceContextTarget> {
  const [row] = await db
    .select({
      message: messages,
      chatBinding: imChatBindings,
      binding: imBotBindings,
    })
    .from(messages)
    .innerJoin(imChatBindings, eq(imChatBindings.chatId, messages.chatId))
    .innerJoin(imBotBindings, eq(imBotBindings.id, imChatBindings.botBindingId))
    .where(eq(messages.id, firstTreeMessageId))
    .limit(1);
  if (!row) throw new NotFoundError("Feishu reference trigger not found");
  if (row.binding.agentId !== agentId) {
    throw new ForbiddenError("Feishu reference trigger does not belong to this Agent runtime");
  }

  const feishu = readFeishuMessageMetadata(row.message.metadata);
  if (
    row.message.senderKind !== "integration" ||
    row.message.senderProvider !== "feishu" ||
    row.message.source !== "feishu" ||
    !feishu ||
    feishu.direction !== "inbound" ||
    feishu.botBindingId !== row.binding.id ||
    feishu.reference.chatId !== row.chatBinding.feishuChatId ||
    row.chatBinding.status !== "active" ||
    !isFeishuBotUsable(row.binding)
  ) {
    throw new NotFoundError("Canonical message is not bound to an active Feishu conversation");
  }

  const scope = feishu.reference.threadId ? "thread" : "chat";
  return {
    binding: row.binding,
    canonicalChatId: row.message.chatId,
    feishuChatId: row.chatBinding.feishuChatId,
    externalMessageId: feishu.reference.messageId,
    scope,
    containerId: feishu.reference.threadId ?? feishu.reference.chatId,
    sentAt: feishu.reference.sentAt ?? null,
  };
}

/** Read a bounded, inert provider-history window without creating canonical messages or attachments. */
export async function readFeishuReferenceContext(
  client: Pick<Client, "request">,
  target: FeishuReferenceContextTarget,
  signal: AbortSignal,
): Promise<FeishuReferenceContext> {
  if (!hasCurrentFeishuRequiredScopes(target.binding.grantedScopes)) {
    return unavailable(target.scope, "permission_denied");
  }
  const triggerTime = providerTimeMs(target.sentAt);
  if (triggerTime === null) return unavailable(target.scope, "reference_unavailable");

  const limit = target.scope === "thread" ? THREAD_MESSAGE_LIMIT : CHAT_MESSAGE_LIMIT;
  const candidates: FeishuReferenceContextMessage[] = [];
  let pageToken: string | undefined;
  let boundaryReached = false;
  let exhausted = false;
  let pageCapReached = false;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const response = await readFeishuHistoryPage(client, {
      scope: target.scope,
      containerId: target.containerId,
      pageSize: HISTORY_PAGE_SIZE,
      pageToken,
      signal,
    });
    const items = response.items;
    for (const item of items) {
      const itemId = item.message_id;
      const itemTime = providerTimeMs(item.create_time);
      if (!itemId || itemTime === null) continue;
      if (itemId === target.externalMessageId) {
        boundaryReached = true;
        continue;
      }
      if (itemTime > triggerTime) continue;
      if (itemTime < triggerTime) boundaryReached = true;
      if (!boundaryReached) continue;
      if (item.chat_id !== target.feishuChatId) continue;
      if (target.scope === "thread" && item.thread_id !== target.containerId) continue;
      candidates.push(convertHistoryMessage(item, target.binding.botOpenId));
      if (candidates.length > limit) break;
    }

    const hasMore = response.hasMore;
    if (candidates.length > limit) break;
    if (!hasMore) {
      exhausted = true;
      break;
    }
    if (page === MAX_HISTORY_PAGES - 1) pageCapReached = true;
    pageToken = response.pageToken;
  }

  if (!boundaryReached) return unavailable(target.scope, "reference_unavailable");
  const countTruncated = pageCapReached || candidates.length > limit || (!exhausted && candidates.length >= limit);
  const fitted = fitReferenceContext(candidates.slice(0, limit));
  return {
    state: "available",
    scope: target.scope,
    messages: fitted.messages.slice().reverse(),
    truncated: countTruncated || fitted.truncated,
  };
}

function convertHistoryMessage(item: FeishuHistoryItem, botOpenId: string | null): FeishuReferenceContextMessage {
  const isBot =
    item.sender?.id === botOpenId ||
    item.sender?.open_bot_id === botOpenId ||
    item.sender?.sender_type === "app" ||
    item.sender?.sender_type === "bot";
  const converted = convertFeishuContent({
    messageType: item.msg_type ?? "unknown",
    rawContent: item.body?.content ?? "",
    mentions: item.mentions?.map((mention) => ({
      key: mention.key,
      openId: mention.id_type === "open_id" ? mention.id : undefined,
      userId: mention.id_type === "user_id" ? mention.id : undefined,
      name: mention.name,
      isBot: mention.id === botOpenId,
    })),
  });
  return {
    externalMessageId: item.message_id ?? "unknown",
    senderId: item.sender?.id ?? item.sender?.open_bot_id ?? "unknown",
    senderName: item.sender?.sender_name?.trim() || (isBot ? "Feishu Bot" : "Feishu user"),
    isBot,
    content: converted.content,
    sentAt: new Date(providerTimeMs(item.create_time) ?? 0).toISOString(),
  };
}

function fitReferenceContext(messagesNewestFirst: FeishuReferenceContextMessage[]): {
  messages: FeishuReferenceContextMessage[];
  truncated: boolean;
} {
  const kept: FeishuReferenceContextMessage[] = [];
  let truncated = false;
  for (const message of messagesNewestFirst) {
    const candidate = [...kept, message];
    if (serializedBytes(candidate) <= REFERENCE_CONTEXT_BYTES) {
      kept.push(message);
      continue;
    }
    truncated = true;
    if (kept.length === 0) kept.push(trimMessageToBudget(message));
    break;
  }
  return { messages: kept, truncated };
}

function trimMessageToBudget(message: FeishuReferenceContextMessage): FeishuReferenceContextMessage {
  let low = 0;
  let high = message.content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...message, content: `${message.content.slice(0, middle)}…` };
    if (serializedBytes([candidate]) <= REFERENCE_CONTEXT_BYTES) low = middle;
    else high = middle - 1;
  }
  return { ...message, content: `${message.content.slice(0, low)}…` };
}

function serializedBytes(messages: FeishuReferenceContextMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function providerTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function unavailable(
  scope: "thread" | "chat",
  reason: "permission_denied" | "provider_unavailable" | "reference_unavailable",
): FeishuReferenceContext {
  return { state: "unavailable", scope, messages: [], truncated: false, reason };
}
