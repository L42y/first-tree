import {
  FEISHU_INTEGRATION_SENDER_ID,
  type FeishuExternalAuthor,
  feishuMessageMetadataSchema,
  MESSAGE_SOURCES,
} from "@first-tree/shared";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { chats } from "../../../db/schema/chats.js";
import type { imBotBindings } from "../../../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../../../db/schema/im-chat-bindings.js";
import { messages } from "../../../db/schema/messages.js";
import { processedEvents } from "../../../db/schema/processed-events.js";
import { createLogger } from "../../../observability/index.js";
import { uuidv7 } from "../../../uuid.js";
import type { AttachmentObjectQuota } from "../../attachment.js";
import { addChatParticipants } from "../../chat/membership/participants.js";
import { sendMessage } from "../../chat/message.js";
import { claimEvent, unclaimEvent } from "../../event-dedup.js";
import { type Notifier, notifyRecipients } from "../../notifier.js";
import { isFeishuBotUsable } from "./binding-state.js";
import { convertFeishuContent } from "./content.js";
import {
  type FeishuParentMessageReader,
  findActiveChatBinding,
  resolveFeishuInboundTrigger,
} from "./inbound-trigger.js";
import { type FeishuResourceDownloader, hydrateFeishuResources } from "./resource-hydrator.js";
import { safeFeishuErrorContext } from "./safe-error.js";
import { externalAuthorIdentity, type FeishuChatMembersReader, type FeishuSenderNameResolver } from "./sender-name.js";

const log = createLogger("feishu-inbound");
const ACKNOWLEDGEMENT_EMOJI = "Get";

type Binding = typeof imBotBindings.$inferSelect;

export type FeishuInboundResult =
  | { state: "ignored"; reason: "group_without_trigger" | "bot_echo" | "inactive_binding" }
  | { state: "duplicate" }
  | { state: "created"; chatId: string; messageId: string };

export async function ingestFeishuMessage(
  db: Database,
  notifier: Notifier,
  binding: Binding,
  input: NormalizedMessage,
  dependencies: {
    senderNames: FeishuSenderNameResolver;
    readMembers: FeishuChatMembersReader;
    downloadResource: FeishuResourceDownloader;
    addReaction: (input: { messageId: string; emojiType: string }) => Promise<unknown>;
    readParentMessage: FeishuParentMessageReader;
    attachmentObjectQuota: AttachmentObjectQuota;
  },
): Promise<FeishuInboundResult> {
  if (!isFeishuBotUsable(binding)) return { state: "ignored", reason: "inactive_binding" };
  if (input.senderId === binding.botOpenId) return { state: "ignored", reason: "bot_echo" };
  const trigger = await resolveFeishuInboundTrigger(db, binding, input, dependencies.readParentMessage);
  if (trigger.state === "ignored") return trigger;

  if (await findExistingMessage(db, binding.id, input.messageId)) return { state: "duplicate" };
  const eventId = extractEventId(input.raw) ?? input.messageId;
  const eventPlatform = `feishu:${binding.id}`;
  const claimed = await claimRecoverableEvent(db, eventId, eventPlatform);
  if (!claimed) return { state: "duplicate" };
  acknowledgeFeishuMessage(binding.id, input.messageId, dependencies.addReaction);

  try {
    const chatBinding = trigger.chatBinding ?? (await resolveOrCreateChatBinding(db, binding, input));
    const authorIdentity = externalAuthorIdentity(input, binding.tenantKey);
    const displayName = await dependencies.senderNames.resolve({
      botBindingId: binding.id,
      tenantKey: authorIdentity.tenantKey ?? null,
      chatId: input.chatId,
      idType: "open_id",
      id: authorIdentity.openId,
      eventName: authorIdentity.eventName,
      readMembers: dependencies.readMembers,
    });
    const externalAuthor: FeishuExternalAuthor = { ...authorIdentity, displayName };
    const rawMessage = rawMessageFromEvent(input.raw);
    const converted = convertFeishuContent({
      messageType: rawMessage?.messageType ?? input.rawContentType,
      rawContent: rawMessage?.content ?? JSON.stringify({ text: input.content }),
      fallbackContent: input.content,
      mentions: input.mentions,
    });
    const descriptors = mergeResourceDescriptors(
      converted.resources,
      input.resources.map((resource) => ({ ...resource, origin: "message" as const })),
    );
    const hydrated = await hydrateFeishuResources(db, {
      organizationId: binding.organizationId,
      botBindingId: binding.id,
      messageId: input.messageId,
      descriptors,
      download: dependencies.downloadResource,
      attachmentObjectQuota: dependencies.attachmentObjectQuota,
    });
    const content = [converted.content, ...hydrated.unavailableNotes.map((note) => `> ${note}`)]
      .filter(Boolean)
      .join("\n\n");
    const feishuMetadata = feishuMessageMetadataSchema.parse({
      version: 1,
      direction: "inbound",
      botBindingId: binding.id,
      reference: {
        messageId: input.messageId,
        chatId: input.chatId,
        chatType: input.chatType,
        threadId: input.threadId ?? null,
        rootId: input.rootId ?? null,
        parentId: input.replyToMessageId ?? null,
        sentAt: providerTimestamp(input.createTime),
      },
      externalAuthor,
      eventId,
      messageType: rawMessage?.messageType ?? input.rawContentType,
      mentions: converted.mentions,
      resources: hydrated.resources,
    });
    const { message, recipients } = await sendMessage(
      db,
      chatBinding.chatId,
      FEISHU_INTEGRATION_SENDER_ID,
      {
        format: "markdown",
        content,
        metadata: {
          mentions: [binding.agentId],
          feishu: feishuMetadata,
          ...(hydrated.attachments.length > 0 ? { attachments: hydrated.attachments } : {}),
        },
        source: MESSAGE_SOURCES.FEISHU,
      },
      {
        addressedToAgentIds: [binding.agentId],
        integrationSender: {
          kind: "integration",
          provider: "feishu",
          organizationId: binding.organizationId,
        },
        allowFeishuMetadata: true,
      },
    );
    notifyRecipients(notifier, recipients, message.id);
    return { state: "created", chatId: chatBinding.chatId, messageId: message.id };
  } catch (error) {
    if (await findExistingMessage(db, binding.id, input.messageId)) return { state: "duplicate" };
    await unclaimEvent(db, eventId, eventPlatform).catch((unclaimError) => {
      log.warn(
        { bindingId: binding.id, eventId, ...safeFeishuErrorContext(unclaimError) },
        "Failed to release Feishu event claim",
      );
    });
    throw error;
  }
}

function acknowledgeFeishuMessage(
  bindingId: string,
  messageId: string,
  addReaction: (input: { messageId: string; emojiType: string }) => Promise<unknown>,
): void {
  void Promise.resolve()
    .then(() => addReaction({ messageId, emojiType: ACKNOWLEDGEMENT_EMOJI }))
    .catch((error) => {
      log.warn(
        { bindingId, messageId, emojiType: ACKNOWLEDGEMENT_EMOJI, ...safeFeishuErrorContext(error) },
        "Failed to acknowledge Feishu message with a reaction",
      );
    });
}

function mergeResourceDescriptors<T extends { type: string; fileKey: string }>(
  primary: readonly T[],
  fallback: readonly T[],
): T[] {
  const seen = new Set<string>();
  return [...primary, ...fallback].filter((resource) => {
    const key = `${resource.type}:${resource.fileKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerTimestamp(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function findExistingMessage(db: Database, botBindingId: string, messageId: string): Promise<boolean> {
  const [duplicate] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.senderKind, "integration"),
        eq(messages.senderProvider, "feishu"),
        sql`${messages.metadata} -> 'feishu' ->> 'botBindingId' = ${botBindingId}`,
        sql`${messages.metadata} -> 'feishu' -> 'reference' ->> 'messageId' = ${messageId}`,
      ),
    )
    .limit(1);
  return Boolean(duplicate);
}

async function claimRecoverableEvent(db: Database, eventId: string, platform: string): Promise<boolean> {
  if (await claimEvent(db, eventId, platform)) return true;
  const staleBefore = new Date(Date.now() - 5 * 60 * 1_000);
  const stale = await db
    .delete(processedEvents)
    .where(
      and(
        eq(processedEvents.eventId, eventId),
        eq(processedEvents.platform, platform),
        sql`${processedEvents.createdAt} < ${staleBefore}`,
      ),
    )
    .returning({ id: processedEvents.id });
  return stale.length > 0 ? claimEvent(db, eventId, platform) : false;
}

async function resolveOrCreateChatBinding(db: Database, binding: Binding, input: NormalizedMessage) {
  const existing = await findActiveChatBinding(db, binding.id, input.chatId);
  if (existing) return existing;

  try {
    return await db.transaction(async (tx) => {
      const [raced] = await tx
        .select()
        .from(imChatBindings)
        .where(and(eq(imChatBindings.botBindingId, binding.id), eq(imChatBindings.feishuChatId, input.chatId)))
        .limit(1);
      if (raced) return raced;

      const chatId = uuidv7();
      const [chat] = await tx
        .insert(chats)
        .values({
          id: chatId,
          organizationId: binding.organizationId,
          type: "group",
          topic: null,
          metadata: {
            source: "feishu",
            botBindingId: binding.id,
            externalChatId: input.chatId,
            externalChatType: input.chatType,
          },
        })
        .returning();
      if (!chat) throw new Error("Feishu chat creation returned no row");

      await addChatParticipants(tx, chatId, [{ agentId: binding.agentId, role: "owner" }], { source: "feishu" });

      const [created] = await tx
        .insert(imChatBindings)
        .values({
          id: uuidv7(),
          botBindingId: binding.id,
          feishuChatId: input.chatId,
          chatId,
          feishuChatType: input.chatType,
        })
        .returning();
      if (!created) throw new Error("Feishu chat binding creation returned no row");
      return created;
    });
  } catch (error) {
    const raced = await findActiveChatBinding(db, binding.id, input.chatId);
    if (raced) return raced;
    throw error;
  }
}

function rawMessageFromEvent(raw: unknown): { messageType: string; content: string } | null {
  const record = asRecord(raw);
  const event = asRecord(record?.event) ?? record;
  const message = asRecord(event?.message);
  const messageType = readString(message, "message_type");
  const content = readString(message, "content");
  return messageType && content ? { messageType, content } : null;
}

function extractEventId(raw: unknown): string | null {
  const record = asRecord(raw);
  return readString(asRecord(record?.header), "event_id") ?? readString(record, "event_id");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function logFeishuInboundFailure(bindingId: string, error: unknown): void {
  log.error({ bindingId, ...safeFeishuErrorContext(error) }, "Feishu inbound message failed");
}
