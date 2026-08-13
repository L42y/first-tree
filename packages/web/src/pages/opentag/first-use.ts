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

/**
 * How many of this Agent's Feishu chats are examined per read. An Agent has one
 * Bot, so its own Tasks are the overwhelming majority of this set and the first
 * page is already generous; the bound keeps a long-lived Agent from turning a
 * poll into an unbounded fan-out.
 */
export const FIRST_USE_SCAN_LIMIT = 20;

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
 */
export async function readOpenTagFirstUse(agentUuid: string, botBindingId: string): Promise<OpenTagFirstUse> {
  const candidates = await listMeChats({
    origin: ["feishu"],
    with: [agentUuid],
    // Archiving the Task does not un-use the Agent, so the terminal state has
    // to survive it. (Deleted rows are outside every view and stay excluded.)
    engagement: "all",
    limit: FIRST_USE_SCAN_LIMIT,
  });
  // `rows` is the complete additive stream — a pinned Task also appears here —
  // so the priority projection does not have to be scanned separately.
  for (const row of candidates.rows) {
    // The conversation list does not carry chat metadata, so ownership is
    // confirmed one candidate at a time. In practice this is the Agent's own
    // Task on the first iteration.
    const chat = await getChat(row.chatId);
    if (isFeishuTaskForBinding(chat.metadata, botBindingId)) return { state: "present", chatId: row.chatId };
  }
  return { state: "absent" };
}
