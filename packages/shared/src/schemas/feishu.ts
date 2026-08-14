import { z } from "zod";
import { feishuMessageReferenceSchema, feishuOutboundMediaIdentitySchema } from "./message.js";

const FEISHU_MESSAGING_SCOPES = [
  "im:message",
  "im:message:send_as_bot",
  "im:message.group_at_msg:readonly",
  "im:message.p2p_msg:readonly",
  "im:chat.members:read",
  "im:chat:readonly",
  "im:message:readonly",
  "im:message.reactions:read",
] as const;

const FEISHU_DOCUMENT_SCOPES = [
  "docx:document:create",
  "docx:document:readonly",
  "docx:document:write_only",
  "docs:document.media:upload",
  "docs:document.media:download",
  "docs:permission.member:create",
  "docs:permission.member:retrieve",
  "docs:permission.member:update",
  "drive:drive.metadata:readonly",
  "drive:file:upload",
  "drive:file:download",
  "space:document:delete",
  "space:folder:create",
  "wiki:wiki",
] as const;

const FEISHU_SHEET_SCOPES = [
  "sheets:spreadsheet:create",
  "sheets:spreadsheet:read",
  "sheets:spreadsheet:write_only",
  "sheets:spreadsheet.meta:read",
] as const;

const FEISHU_BASE_SCOPES = [
  "base:app:create",
  "base:app:read",
  "base:app:update",
  "base:table:create",
  "base:table:read",
  "base:table:update",
  "base:table:delete",
  "base:field:create",
  "base:field:read",
  "base:field:update",
  "base:field:delete",
  "base:record:create",
  "base:record:read",
  "base:record:retrieve",
  "base:record:update",
  "base:record:delete",
  "base:view:read",
  "base:view:write_only",
] as const;

const FEISHU_CALENDAR_SCOPES = [
  "calendar:calendar:create",
  "calendar:calendar:read",
  "calendar:calendar:update",
  "calendar:calendar:delete",
  "calendar:calendar.event:create",
  "calendar:calendar.event:read",
  "calendar:calendar.event:update",
  "calendar:calendar.event:delete",
  "calendar:calendar.event:reply",
  "calendar:calendar.free_busy:read",
] as const;

const FEISHU_TASK_SCOPES = [
  "task:task:read",
  "task:task:write",
  "task:tasklist:read",
  "task:tasklist:write",
  "task:comment:read",
  "task:comment:write",
  "task:attachment:read",
  "task:attachment:write",
] as const;

export const FEISHU_REQUIRED_SCOPES = [
  ...FEISHU_MESSAGING_SCOPES,
  ...FEISHU_DOCUMENT_SCOPES,
  ...FEISHU_SHEET_SCOPES,
  ...FEISHU_BASE_SCOPES,
  ...FEISHU_CALENDAR_SCOPES,
  ...FEISHU_TASK_SCOPES,
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
  /**
   * A member explicitly asked to try again, rather than a surface ensuring the
   * Task exists. The two must stay distinguishable: ensuring runs on every
   * load, reload, and extra tab and has to stay a no-op, while a retry has to
   * reach an Agent that may have already consumed the original request.
   */
  retry: z.boolean().optional().default(false),
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
