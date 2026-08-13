import { z } from "zod";
import { feishuMessageReferenceSchema, feishuOutboundMediaIdentitySchema } from "./message.js";

export const FEISHU_REQUIRED_SCOPES = [
  "im:message",
  "im:message:send_as_bot",
  "im:message.group_at_msg:readonly",
  "im:message.p2p_msg:readonly",
  "im:chat.members:read",
] as const;

export const feishuBotBindingStatusSchema = z.enum(["provisioning", "active", "error", "revoked"]);
export const feishuConnectionStatusSchema = z.enum(["disconnected", "connecting", "connected", "error"]);

export const feishuBotBindingSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  appId: z.string().nullable(),
  botOpenId: z.string().nullable(),
  botName: z.string().nullable(),
  botAvatarUrl: z.string().url().nullable(),
  tenantKey: z.string().nullable(),
  status: feishuBotBindingStatusSchema,
  connectionStatus: feishuConnectionStatusSchema,
  grantedScopes: z.array(z.string()),
  registrationUrl: z.string().url().nullable(),
  registrationExpiresAt: z.string().nullable(),
  lastConnectedAt: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  cli: z.object({
    state: z.enum(["ready", "missing", "offline", "unknown"]),
    version: z.string().nullable(),
    clientId: z.string().nullable(),
  }),
});
export type FeishuBotBinding = z.infer<typeof feishuBotBindingSchema>;

export const startFeishuRegistrationSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
});
export type StartFeishuRegistration = z.infer<typeof startFeishuRegistrationSchema>;

export const createFeishuSetupChatSchema = z.object({
  requestInstall: z.literal(true),
});
export type CreateFeishuSetupChat = z.infer<typeof createFeishuSetupChatSchema>;

export const createFeishuSetupChatResponseSchema = z.object({
  chatId: z.string(),
});
export type CreateFeishuSetupChatResponse = z.infer<typeof createFeishuSetupChatResponseSchema>;

export const feishuOutboundIntentRequestSchema = z
  .object({
    chatId: z.string().min(1),
    operation: z.enum(["send", "reply"]),
    targetChatId: z.string().min(1).optional(),
    targetMessageId: z.string().min(1).optional(),
    replyInThread: z.boolean().default(false),
    format: z.enum(["text", "markdown", "card", "file"]),
    content: z.unknown().optional(),
    media: feishuOutboundMediaIdentitySchema.optional(),
    /** Reuse an existing immutable outbound intent after a failed official CLI attempt. */
    canonicalMessageId: z.string().min(1).max(50).optional(),
  })
  .superRefine((value, context) => {
    if (value.format === "file" && !value.media) {
      context.addIssue({ code: "custom", path: ["media"], message: "File intents require immutable media identity" });
    }
    if (value.format !== "file" && value.content === undefined) {
      context.addIssue({ code: "custom", path: ["content"], message: "Text/card intents require content" });
    }
  });
export type FeishuOutboundIntentRequest = z.infer<typeof feishuOutboundIntentRequestSchema>;

export const feishuCredentialGrantSchema = z.object({
  appId: z.string().min(1),
  /** Agent-owned Bot credential; never include it in prompts, chat history, or logs. */
  appSecret: z.string().min(1),
  bindingId: z.string(),
});
export type FeishuCredentialGrant = z.infer<typeof feishuCredentialGrantSchema>;

export const feishuOutboundIntentResultSchema = z.object({
  canonicalMessageId: z.string(),
  idempotencyKey: z.string().max(50),
  targetChatId: z.string(),
  targetMessageId: z.string().nullable(),
});
export type FeishuOutboundIntentResult = z.infer<typeof feishuOutboundIntentResultSchema>;

export const feishuReferenceSelectionSchema = feishuMessageReferenceSchema.pick({
  chatId: true,
  messageId: true,
  threadId: true,
  rootId: true,
  parentId: true,
});
