import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { and, eq, or, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import type { imBotBindings } from "../../../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../../../db/schema/im-chat-bindings.js";
import { messages } from "../../../db/schema/messages.js";
import { createLogger } from "../../../observability/index.js";
import { safeFeishuErrorContext } from "./safe-error.js";

const log = createLogger("feishu-inbound-trigger");

type Binding = typeof imBotBindings.$inferSelect;
type ChatBinding = typeof imChatBindings.$inferSelect;

export type FeishuParentMessage = {
  chatId: string | null;
  sender: {
    id: string | null;
    idType: string | null;
    senderType: string | null;
    openBotId: string | null;
  };
};

export type FeishuParentMessageReader = (messageId: string) => Promise<FeishuParentMessage | null>;

export type FeishuInboundTrigger =
  | { state: "accepted"; kind: "p2p" | "exact_mention"; chatBinding?: undefined }
  | { state: "accepted"; kind: "active_thread" | "direct_reply"; chatBinding: ChatBinding }
  | { state: "ignored"; reason: "group_without_trigger" };

/** Resolve every group wake-up rule before ingestion performs any write or provider-resource work. */
export async function resolveFeishuInboundTrigger(
  db: Database,
  binding: Binding,
  input: NormalizedMessage,
  readParentMessage: FeishuParentMessageReader,
): Promise<FeishuInboundTrigger> {
  if (input.chatType !== "group") return { state: "accepted", kind: "p2p" };

  const exactBotMention = input.mentionedBot && input.mentions.some((mention) => mention.openId === binding.botOpenId);
  if (exactBotMention) return { state: "accepted", kind: "exact_mention" };

  const chatBinding = await findActiveChatBinding(db, binding.id, input.chatId);
  if (!chatBinding) return { state: "ignored", reason: "group_without_trigger" };

  if (hasThreadRelationship(input) && (await hasAcceptedThreadMessage(db, binding.id, chatBinding.chatId, input))) {
    return { state: "accepted", kind: "active_thread", chatBinding };
  }

  if (!input.replyToMessageId) return { state: "ignored", reason: "group_without_trigger" };
  try {
    const parent = await readParentMessage(input.replyToMessageId);
    if (
      parent?.chatId === input.chatId &&
      parent.sender.senderType === "app" &&
      parent.sender.openBotId === binding.botOpenId
    ) {
      return { state: "accepted", kind: "direct_reply", chatBinding };
    }
  } catch (error) {
    log.warn(
      {
        bindingId: binding.id,
        replyToMessageId: input.replyToMessageId,
        ...safeFeishuErrorContext(error),
      },
      "Failed to verify Feishu reply parent",
    );
  }
  return { state: "ignored", reason: "group_without_trigger" };
}

function hasThreadRelationship(input: NormalizedMessage): boolean {
  return Boolean(input.threadId || input.rootId);
}

async function hasAcceptedThreadMessage(
  db: Database,
  botBindingId: string,
  chatId: string,
  input: NormalizedMessage,
): Promise<boolean> {
  const relationshipPredicates = [
    input.threadId
      ? sql`${messages.metadata} -> 'feishu' -> 'reference' ->> 'threadId' = ${input.threadId}`
      : undefined,
    input.rootId ? sql`${messages.metadata} -> 'feishu' -> 'reference' ->> 'rootId' = ${input.rootId}` : undefined,
    input.rootId ? sql`${messages.metadata} -> 'feishu' -> 'reference' ->> 'messageId' = ${input.rootId}` : undefined,
  ].filter((predicate) => predicate !== undefined);
  if (relationshipPredicates.length === 0) return false;

  const relationship = relationshipPredicates.length === 1 ? relationshipPredicates[0] : or(...relationshipPredicates);
  const [match] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.senderKind, "integration"),
        eq(messages.senderProvider, "feishu"),
        sql`${messages.metadata} -> 'feishu' ->> 'direction' = 'inbound'`,
        sql`${messages.metadata} -> 'feishu' ->> 'botBindingId' = ${botBindingId}`,
        relationship,
      ),
    )
    .limit(1);
  return Boolean(match);
}

export async function findActiveChatBinding(
  db: Database,
  botBindingId: string,
  feishuChatId: string,
): Promise<ChatBinding | null> {
  const [row] = await db
    .select()
    .from(imChatBindings)
    .where(
      and(
        eq(imChatBindings.botBindingId, botBindingId),
        eq(imChatBindings.feishuChatId, feishuChatId),
        eq(imChatBindings.status, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}
