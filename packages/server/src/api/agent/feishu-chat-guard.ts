import { isRuntimeNoticeMetadata, type SendMessage } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { imChatBindings } from "../../db/schema/im-chat-bindings.js";
import { ForbiddenError } from "../../errors.js";

/**
 * Agent-scope counterpart of `assertWebMutableChat` in `api/chats.ts`.
 *
 * A chat bridged to a Feishu conversation lives in Feishu: the humans in it
 * read the Feishu group, not the First Tree web app. An agent that answers
 * with `chat send` / `chat ask` / `chat invite` writes into a surface nobody
 * on the other side can see, so the reply is silently lost. These routes fail
 * fast instead and name the path that actually delivers.
 *
 * Authority is `im_chat_bindings`, filtered to `status = 'active'` — NOT
 * `chats.metadata.source`, which is a soft label that stays `"feishu"` after a
 * binding detaches. The Web helper predates the `status` column and does not
 * filter; the agent scope does, so a detached chat becomes an ordinary First
 * Tree chat again for the agent.
 *
 * DELIBERATELY NOT GUARDED HERE:
 *   - `messageService.sendMessage` itself. The Feishu bridge's own outbound
 *     delivery (`POST /agent/feishu/intents`) reuses that exact service call
 *     with the same `source: "cli"` and the same agent `senderId`; a guard in
 *     the service layer would break the bot's own replies. The bridge is
 *     distinguishable only by its route, which is why this lives in the
 *     route/adapter layer and is applied per-route.
 *   - `PATCH /agent/chats/:chatId` (`chat update`). Topic/description are
 *     First-Tree-side metadata the agent briefing requires it to maintain;
 *     they are not a message to a human in the Feishu group.
 *   - `POST /agent/chats/:chatId/archive`. That writes the calling human's
 *     private engagement row, i.e. personal view state — the same class the
 *     Web boundary deliberately keeps working on Feishu chats (`/read`,
 *     `/unread`, `/pin` are all unguarded there).
 */

/** Machine-readable code surfaced to the CLI through `AppError.attrs.code`. */
export const FEISHU_AGENT_CHAT_WRITE_CODE = "FEISHU_CHAT_AGENT_WRITE_FORBIDDEN";

const FEISHU_AGENT_CHAT_WRITE_MESSAGE =
  "This chat is bridged to a Feishu conversation, so a First Tree chat write here reaches nobody: " +
  "the humans in it only ever see the Feishu group. Reply through the Feishu path instead — record the " +
  "delivery with `feishu intent`, then send it with the official `lark-cli --as bot`.";

/** True when the chat currently has an active Feishu conversation binding. */
export async function isFeishuBridgedChat(db: Database, chatId: string): Promise<boolean> {
  const [binding] = await db
    .select({ id: imChatBindings.id })
    .from(imChatBindings)
    .where(and(eq(imChatBindings.chatId, chatId), eq(imChatBindings.status, "active")))
    .limit(1);
  return binding !== undefined;
}

/** Reject an agent-scope chat write that would land outside the Feishu group. */
export async function assertAgentMutableChat(db: Database, chatId: string): Promise<void> {
  if (await isFeishuBridgedChat(db, chatId)) {
    throw new ForbiddenError(FEISHU_AGENT_CHAT_WRITE_MESSAGE, { code: FEISHU_AGENT_CHAT_WRITE_CODE });
  }
}

/**
 * Provider-failure runtime notices are exempt.
 *
 * `runtime/runtime-notice.ts::postProviderFailureRuntimeNotice` posts through
 * the same agent message route when a provider terminally fails. That row is
 * the only in-product signal an operator gets that the agent could not run at
 * all — suppressing it on a Feishu chat would make the chat look merely idle.
 * It is recipientless and silent (`purpose: "agent-final-text"`), so it wakes
 * nobody and cannot be used as a back door for ordinary conversation.
 *
 * Both markers are required: the silent delivery profile alone is not enough,
 * because deliberate agent sends may also carry it.
 */
export function isProviderFailureRuntimeNotice(body: SendMessage): boolean {
  return body.purpose === "agent-final-text" && isRuntimeNoticeMetadata(body.metadata);
}

/** Apply the Feishu boundary to an agent message send, honouring the notice exemption. */
export async function assertAgentSendableChat(db: Database, chatId: string, body: SendMessage): Promise<void> {
  if (isProviderFailureRuntimeNotice(body)) return;
  await assertAgentMutableChat(db, chatId);
}
