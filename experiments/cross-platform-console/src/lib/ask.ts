import type { Message } from "@first-tree/shared";
import { askRequestSchema, type AskRequest } from "@first-tree/shared";
import { api } from "./api";

/**
 * "Ask user" support (format="request").
 *
 * Mirrors the web console's model (packages/shared/src/schemas/message.ts):
 *  - The question is the message `content`; `metadata.request` carries the
 *    optional options + multiSelect affordance.
 *  - The target human is the sole entry in `metadata.mentions`.
 *  - A question is resolved ONLY by a later message replying with
 *    `inReplyTo` + `metadata.resolves = { request, kind: "answered" | "closed" }`.
 *    Only the target may write a resolution.
 */

export type ParsedRequest = {
  request: AskRequest;
  /** Sole targeted human's agent id. */
  targetAgentId: string | null;
};

export function parseAskRequest(message: Message): ParsedRequest | null {
  if (message.format !== "request") return null;
  const parsed = askRequestSchema.safeParse(message.metadata?.request ?? {});
  if (!parsed.success) return null;
  const mentions = Array.isArray(message.metadata?.mentions)
    ? (message.metadata?.mentions as unknown[]).filter((m): m is string => typeof m === "string")
    : [];
  return { request: parsed.data, targetAgentId: mentions[0] ?? null };
}

export function findResolutionMessage(
  messages: Message[],
  requestId: string,
): Message | null {
  for (const msg of messages) {
    const resolves = msg.metadata?.resolves as { request?: unknown } | undefined;
    if (resolves && typeof resolves.request === "string" && resolves.request === requestId) {
      return msg;
    }
  }
  return null;
}

export async function resolveAskRequest(
  chatId: string,
  question: Message,
  kind: "answered" | "closed",
  content: string,
): Promise<Message> {
  return api.post<Message>(`/chats/${encodeURIComponent(chatId)}/messages`, {
    format: "text",
    content,
    source: "web",
    inReplyTo: question.id,
    metadata: { resolves: { request: question.id, kind } },
  });
}
