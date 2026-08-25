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

/**
 * The answer affordance is optional decoration; the question itself is the
 * message body. A payload that fails the schema — more than four options, a
 * label over five words, a missing description — must therefore degrade to a
 * free-text ask rather than yield `null`, because a `null` here silently
 * renders no dock at all and strands a question the user is required to
 * answer. Over-long option lists are salvaged to the first four rather than
 * dropped outright.
 */
function parseAskPayload(raw: unknown): AskRequest {
  const strict = askRequestSchema.safeParse(raw ?? {});
  if (strict.success) return strict.data;

  const options = (raw as { options?: unknown })?.options;
  if (Array.isArray(options) && options.length > 4) {
    const trimmed = askRequestSchema.safeParse({
      ...(raw as object),
      options: options.slice(0, 4),
    });
    if (trimmed.success) return trimmed.data;
  }
  return { multiSelect: false };
}

export function parseAskRequest(message: Message): ParsedRequest | null {
  if (message.format !== "request") return null;
  const mentions = Array.isArray(message.metadata?.mentions)
    ? (message.metadata?.mentions as unknown[]).filter((m): m is string => typeof m === "string")
    : [];
  return {
    request: parseAskPayload(message.metadata?.request),
    targetAgentId: mentions[0] ?? null,
  };
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

/**
 * Server-authoritative open asks for THIS viewer — window-independent and
 * scoped server-side to the caller's human agent. This is the source of
 * truth for whether a dock should render (client-side mention matching
 * missed asks that fell outside the loaded message page).
 */
export async function fetchOpenRequests(
  chatId: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  const res = await api.get<Message[]>(
    `/chats/${encodeURIComponent(chatId)}/open-requests`,
    { signal },
  );
  return Array.isArray(res) ? res : [];
}

/** Ask the original agent for clarification WITHOUT resolving the ask. */
export async function askAgentForClarification(
  chatId: string,
  requestId: string,
  content: string,
): Promise<void> {
  await api.post(
    `/chats/${encodeURIComponent(chatId)}/requests/${encodeURIComponent(requestId)}/ask-agent`,
    { content },
  );
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
