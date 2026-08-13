import { chatMetadataSchema } from "@first-tree/shared";
import { getChat } from "../../api/chats.js";
import { listMeChats } from "../../api/me-chats.js";
import type { OpenTagFirstUse } from "./flow.js";

/**
 * Has this exact Agent been used for real in Feishu yet?
 *
 * This entry finishes on a fact it does not produce: Feishu ingress creates the
 * Task when a real person messages the Bot, and this module only reads whether
 * that already happened. Nothing here writes, starts, or acknowledges anything —
 * a Task that does not exist cannot be brought into existence from this page.
 *
 * What makes the answer exact is the Bot binding. A Feishu Task is identified by
 * its Bot binding plus the external chat, and a Bot belongs to exactly one
 * Agent, so a chat carrying this Agent's binding id can only be this Agent's
 * work. The two query filters are narrowing, not proof: the Team comes from the
 * endpoint's own scope, and an Agent invited into a teammate's Feishu Task is
 * also a speaker in a Feishu-origin chat, so "speaks in a Feishu chat" alone
 * would let a neighbour's first use finish this member's setup.
 */

/** Candidates requested per page. */
export const FIRST_USE_PAGE_SIZE = 50;

/**
 * How many pages a single read will walk before giving up.
 *
 * The conversation list is ordered by recent activity, so a Task the member is
 * using right now sorts to the top and the first page answers the live wait.
 * The pages exist for the other case: revisiting the entry long after first
 * use, once other Feishu conversations have become more active. Reaching this
 * bound means the candidate set was never exhausted, which is reported as
 * `unknown` rather than `absent` — see {@link readOpenTagFirstUse}.
 */
export const FIRST_USE_MAX_PAGES = 10;

/**
 * How often the page re-asks while the member is over in Feishu sending that
 * first message. It stops once the answer is `present` — the fact is terminal.
 */
export const FIRST_USE_POLL_MS = 5_000;

/** Whether a chat's metadata proves it is this exact Bot binding's Feishu Task. */
export function isFeishuTaskForBinding(metadata: unknown, botBindingId: string): boolean {
  const parsed = chatMetadataSchema.safeParse(metadata);
  if (!parsed.success || parsed.data.source !== "feishu") return false;
  return parsed.data.botBindingId === botBindingId;
}

/**
 * Resolve first use, or throw. A thrown read is reported as {@link OpenTagFirstUse}
 * `unknown` by the caller rather than being flattened into `absent` here, so a
 * failing API can never be mistaken for a member who has not started yet.
 *
 * `absent` is only ever returned once the candidate list has been walked to its
 * end. A page that stops early proves nothing: the list is ordered by recent
 * activity, not by relevance, so an unexamined page can still hold the Task.
 * Answering `absent` from a partial page would strand a member who really did
 * use their Agent — and strand them permanently, because every poll would
 * re-read the same first page and reach the same wrong conclusion.
 */
export async function readOpenTagFirstUse(agentUuid: string, botBindingId: string): Promise<OpenTagFirstUse> {
  let cursor: string | undefined;
  for (let page = 0; page < FIRST_USE_MAX_PAGES; page++) {
    const candidates = await listMeChats({
      origin: ["feishu"],
      with: [agentUuid],
      // Archiving the Task does not un-use the Agent, so the terminal state has
      // to survive it. (Deleted rows are outside every view and stay excluded.)
      engagement: "all",
      limit: FIRST_USE_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    // `rows` is the complete additive stream — a pinned Task also appears here —
    // so the priority projection does not have to be scanned separately.
    for (const row of candidates.rows) {
      // The conversation list does not carry chat metadata, so ownership is
      // confirmed one candidate at a time. This Agent owns one Bot, so in
      // practice its own Task is the first and only candidate.
      const chat = await getChat(row.chatId);
      if (isFeishuTaskForBinding(chat.metadata, botBindingId)) return { state: "present", chatId: row.chatId };
    }
    if (!candidates.nextCursor) return { state: "absent" };
    cursor = candidates.nextCursor;
  }
  // Pages remained unread, so this Agent's Task may still be among them.
  return { state: "unknown" };
}
