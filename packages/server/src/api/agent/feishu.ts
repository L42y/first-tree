import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type FeishuOutboundMediaIdentity,
  feishuOutboundIntentRequestSchema,
  MESSAGE_SOURCES,
  readFeishuMessageMetadata,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { imBotBindings } from "../../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../../db/schema/im-chat-bindings.js";
import { messages } from "../../db/schema/messages.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import * as messageService from "../../services/chat/message.js";
import { renderCodeSpan } from "../../services/integrations/feishu/markdown.js";
import { uuidv7 } from "../../uuid.js";

type BoundConversation = {
  chatId: string;
  feishuChatId: string;
  feishuChatType: "p2p" | "group";
  botBindingId: string;
  agentId: string;
};

function canonicalPayload(
  format: "text" | "markdown" | "card" | "file",
  content: unknown,
  media?: FeishuOutboundMediaIdentity,
): {
  format: "text" | "markdown" | "card";
  content: unknown;
} {
  if (format !== "file") return { format, content };
  const kind = media?.kind ?? "file";
  const filename = media?.filename ?? "attachment";
  return { format: "markdown", content: `Sent a Feishu ${kind}: ${renderCodeSpan(filename)}` };
}

function payloadSha256(format: string, content: unknown, media?: FeishuOutboundMediaIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify([format, content, media ?? null]))
    .digest("hex");
}

async function loadBoundConversation(
  app: FastifyInstance,
  chatId: string,
  agentId: string,
  bindingId: string,
): Promise<BoundConversation> {
  const [binding] = await app.db
    .select({
      chatId: imChatBindings.chatId,
      feishuChatId: imChatBindings.feishuChatId,
      feishuChatType: imChatBindings.feishuChatType,
      botBindingId: imBotBindings.id,
      agentId: imBotBindings.agentId,
    })
    .from(imChatBindings)
    .innerJoin(imBotBindings, eq(imBotBindings.id, imChatBindings.botBindingId))
    .where(
      and(eq(imChatBindings.chatId, chatId), eq(imChatBindings.status, "active"), eq(imBotBindings.status, "active")),
    )
    .limit(1);
  if (!binding) throw new NotFoundError("This chat is not bound to an active Feishu conversation");
  if (binding.agentId !== agentId) {
    throw new ForbiddenError("Only the Agent bound to this Feishu Bot may send externally");
  }
  if (binding.botBindingId !== bindingId) {
    throw new ForbiddenError("Feishu Bot binding does not belong to this Agent runtime");
  }
  if (binding.feishuChatType !== "p2p" && binding.feishuChatType !== "group") {
    throw new BadRequestError("Feishu chat binding has an unsupported chat type");
  }
  return { ...binding, feishuChatType: binding.feishuChatType };
}

async function assertReplyTarget(
  app: FastifyInstance,
  input: { chatId: string; botBindingId: string; externalMessageId: string },
): Promise<void> {
  const [target] = await app.db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, input.chatId),
        sql`${messages.metadata} -> 'feishu' ->> 'botBindingId' = ${input.botBindingId}`,
        sql`${messages.metadata} -> 'feishu' ->> 'direction' = 'inbound'`,
        sql`${messages.metadata} -> 'feishu' -> 'reference' ->> 'messageId' = ${input.externalMessageId}`,
      ),
    )
    .limit(1);
  if (!target) throw new ForbiddenError("Reply target is not an inbound Feishu message from this Bot and chat");
}

/** Agent-runtime-only credential and immutable intent endpoints for direct official lark-cli use. */
export async function agentFeishuRoutes(app: FastifyInstance): Promise<void> {
  app.post("/feishu/credentials", async (request, reply) => {
    const identity = requireAgent(request);
    const grant = await app.feishuIntegration.getCliGrant(identity.uuid);
    return reply.send({ appId: grant.appId, appSecret: grant.appSecret, bindingId: grant.binding.id });
  });

  app.post("/feishu/intents", async (request, reply) => {
    const identity = requireAgent(request);
    const body = feishuOutboundIntentRequestSchema.parse(request.body);
    const grant = await app.feishuIntegration.getCliGrant(identity.uuid);
    const binding = await loadBoundConversation(app, body.chatId, identity.uuid, grant.binding.id);
    if (body.targetChatId && body.targetChatId !== binding.feishuChatId) {
      throw new ForbiddenError("Feishu target does not belong to this Agent and chat binding");
    }
    if (body.operation === "send" && !body.targetChatId) {
      throw new BadRequestError("Feishu send requires a target chat ID");
    }
    if (body.operation === "reply") {
      if (!body.targetMessageId) throw new BadRequestError("Feishu reply requires a target message ID");
      await assertReplyTarget(app, {
        chatId: body.chatId,
        botBindingId: binding.botBindingId,
        externalMessageId: body.targetMessageId,
      });
    }

    const payload = canonicalPayload(body.format, body.content, body.media);
    const payloadDigest = payloadSha256(body.format, body.content, body.media);
    const operation = body.operation;
    const canonicalMessageId = body.canonicalMessageId ?? uuidv7();
    if (body.canonicalMessageId) {
      const [existing] = await app.db
        .select({
          senderId: messages.senderId,
          format: messages.format,
          content: messages.content,
          metadata: messages.metadata,
        })
        .from(messages)
        .where(and(eq(messages.id, body.canonicalMessageId), eq(messages.chatId, body.chatId)))
        .limit(1);
      const feishu = readFeishuMessageMetadata(existing?.metadata);
      const expectedIntent = {
        operation,
        chatId: binding.feishuChatId,
        chatType: binding.feishuChatType,
        targetMessageId: body.targetMessageId ?? null,
        replyInThread: body.replyInThread,
        idempotencyKey: body.canonicalMessageId,
        payloadSha256: payloadDigest,
        media: body.media ?? null,
      };
      if (
        !existing ||
        existing.senderId !== identity.uuid ||
        existing.format !== payload.format ||
        !isDeepStrictEqual(existing.content, payload.content) ||
        !feishu ||
        feishu.direction !== "outbound" ||
        feishu.botBindingId !== binding.botBindingId ||
        !isDeepStrictEqual(feishu.intent, expectedIntent)
      ) {
        throw new ForbiddenError("The requested retry does not match the original immutable Feishu message intent");
      }
    } else {
      await messageService.sendMessage(
        app.db,
        body.chatId,
        identity.uuid,
        {
          format: payload.format,
          content: payload.content,
          metadata: {
            mentions: [],
            feishu: {
              version: 1,
              direction: "outbound",
              botBindingId: binding.botBindingId,
              intent: {
                operation,
                chatId: binding.feishuChatId,
                chatType: binding.feishuChatType,
                targetMessageId: body.targetMessageId ?? null,
                replyInThread: body.replyInThread,
                idempotencyKey: canonicalMessageId,
                payloadSha256: payloadDigest,
                media: body.media ?? null,
              },
            },
          },
          source: MESSAGE_SOURCES.CLI,
        },
        {
          messageId: canonicalMessageId,
          allowRecipientlessSend: true,
          allowFeishuMetadata: true,
          forceSilentFanOut: true,
        },
      );
    }

    return reply.send({
      canonicalMessageId,
      idempotencyKey: canonicalMessageId,
      targetChatId: binding.feishuChatId,
      targetMessageId: body.targetMessageId ?? null,
    });
  });
}
