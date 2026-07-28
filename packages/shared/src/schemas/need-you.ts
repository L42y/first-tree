import { z } from "zod";
import { messageSchema } from "./message.js";

export const NEED_YOU_DEFAULT_LIMIT = 50;
export const NEED_YOU_MAX_LIMIT = 100;

/**
 * FIFO query for the current human's open `chat ask` requests inside one
 * Team. The cursor is opaque and may only be reused with the same Team/viewer.
 */
export const listNeedYouRequestsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(NEED_YOU_MAX_LIMIT).default(NEED_YOU_DEFAULT_LIMIT),
});
export type ListNeedYouRequestsQuery = z.infer<typeof listNeedYouRequestsQuerySchema>;

export const needYouAskerSchema = z.object({
  agentId: z.string(),
  name: z.string().nullable(),
  displayName: z.string(),
  avatarColorToken: z.string().nullable(),
  avatarImageUrl: z.string().nullable(),
});
export type NeedYouAsker = z.infer<typeof needYouAskerSchema>;

/**
 * One request-level review item. Chat metadata is intentionally compact; the
 * review surface fetches the existing chat-detail contract only for the active
 * item, keeping a large queue inexpensive.
 */
export const needYouRequestItemSchema = z.object({
  request: messageSchema,
  chat: z.object({
    id: z.string(),
    title: z.string(),
    topic: z.string().nullable(),
    description: z.string().nullable(),
  }),
  asker: needYouAskerSchema,
});
export type NeedYouRequestItem = z.infer<typeof needYouRequestItemSchema>;

export const listNeedYouRequestsResponseSchema = z.object({
  items: z.array(needYouRequestItemSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export type ListNeedYouRequestsResponse = z.infer<typeof listNeedYouRequestsResponseSchema>;

/** Durable request thread used to correlate Ask agent clarifications/replies. */
export const requestThreadResponseSchema = z.object({
  items: z.array(messageSchema),
});
export type RequestThreadResponse = z.infer<typeof requestThreadResponseSchema>;
