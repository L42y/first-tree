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

/** One member's repeatable search for one Agent's first use. */
export type OpenTagFirstUseScan = (signal?: AbortSignal) => Promise<OpenTagFirstUse>;

/**
 * Build the search this entry polls.
 *
 * The scan runs to the end of the list rather than to a page bound. A bound
 * would only move the horizon: the poll behind it starts over from the first
 * page every time, so a Task beyond the bound stays unreachable no matter how
 * long the member waits, which is exactly the convergence this entry promises.
 *
 * What makes exhaustion affordable is the verdict cache. Confirming a candidate
 * costs a chat read, because the conversation list does not carry chat
 * metadata — but a chat's Bot binding is written once by ingress and never
 * changes, so a candidate ruled out stays ruled out. Later polls therefore walk
 * the list again but pay for only the conversations they have not seen before,
 * instead of re-reading hundreds of the same chats every five seconds.
 *
 * The cache is per member and per Agent by construction: the caller builds one
 * of these per (member, Agent, Bot) and throws it away when any of them change.
 */
export function createOpenTagFirstUseScan(agentUuid: string, botBindingId: string): OpenTagFirstUseScan {
  const ruledOut = new Set<string>();

  return async (signal?: AbortSignal): Promise<OpenTagFirstUse> => {
    let cursor: string | undefined;
    for (;;) {
      // A superseded poll stops walking rather than finishing a scan whose
      // answer nobody will read. Its own result is `unknown` — abandoning a
      // search establishes nothing either way.
      if (signal?.aborted) return { state: "unknown" };
      const page = await listMeChats(
        {
          origin: ["feishu"],
          with: [agentUuid],
          // Archiving the Task does not un-use the Agent, so the terminal state
          // has to survive it. (Deleted rows are outside every view already.)
          engagement: "all",
          limit: FIRST_USE_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        signal ? { signal } : undefined,
      );
      // `rows` is the complete additive stream — a pinned Task also appears
      // here — so the priority projection is not scanned separately.
      for (const row of page.rows) {
        if (ruledOut.has(row.chatId)) continue;
        if (signal?.aborted) return { state: "unknown" };
        const chat = await getChat(row.chatId);
        if (isFeishuTaskForBinding(chat.metadata, botBindingId)) return { state: "present", chatId: row.chatId };
        ruledOut.add(row.chatId);
      }
      // Only the end of the list licenses `absent`. Anything earlier is a
      // partial answer, and this one gets written to a membership.
      if (!page.nextCursor) return { state: "absent" };
      cursor = page.nextCursor;
    }
  };
}
