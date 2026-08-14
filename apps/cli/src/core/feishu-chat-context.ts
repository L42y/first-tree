import type { ChatExternalChannel } from "@first-tree/shared";

/**
 * Advisory agent-session preconditions for the two chat commands the server
 * cannot gate.
 *
 * `POST /agent/chats` never learns which chat the caller is sitting in — the
 * originating chat is not in `createTaskChatSchema`, not a header, and
 * `chat create` does not read `FIRST_TREE_CHAT_ID`. `chat open` is worse: it
 * runs on the user scope and starts an interactive REPL, which is meaningless
 * in a non-interactive agent session. So both are refused client-side, before
 * anything is created.
 *
 * This is a usability rail, not the boundary. The real boundary stays on the
 * server for the routes that can carry a chat id (`chat send` / `chat ask` /
 * `chat invite`), and this check deliberately fails open: if the lookup cannot
 * complete, the command proceeds and the server decides.
 *
 * The signal is `ChatDetail.externalChannel`, the same live
 * `im_chat_bindings` state the server-side guard enforces — not
 * `metadata.source`, which stays `"feishu"` after a binding detaches and would
 * refuse commands the server would happily accept.
 */

export const FEISHU_CHAT_CONTEXT_CODE = "FEISHU_CHAT_CONTEXT";

export const FEISHU_GUARDED_COMMANDS = ["create", "open"] as const;
export type FeishuGuardedCommand = (typeof FEISHU_GUARDED_COMMANDS)[number];

/**
 * Minimal SDK surface this check needs, so tests can supply a stub.
 * `externalChannel` is optional here even though `ChatDetail` declares it:
 * a server older than the field simply omits it from the JSON body, and the
 * SDK does not re-parse the response through Zod.
 */
export type ChatDetailReader = {
  getChatDetail(chatId: string): Promise<{ externalChannel?: ChatExternalChannel | null }>;
};

export type FeishuChatContextRefusal = {
  code: string;
  message: string;
};

const REASONS: Record<FeishuGuardedCommand, string> = {
  create:
    "`chat create` would open a First Tree task chat nobody in the Feishu group can see, and the new chat would " +
    "carry no way back to them.",
  open: "`chat open` starts an interactive REPL against a First Tree chat, which an agent session cannot drive.",
};

/** Build the refusal text for one guarded command. */
export function feishuChatContextMessage(command: FeishuGuardedCommand): string {
  return (
    `This agent session is running inside a chat bridged to a Feishu conversation. ${REASONS[command]} ` +
    "Reply in the Feishu conversation instead — record the delivery with `feishu intent`, then send it with the " +
    "official `lark-cli --as bot`. To reach a First Tree teammate about this work, hand off from a chat that is " +
    "not bridged."
  );
}

/**
 * Resolve whether the current agent session sits in a Feishu-bridged chat.
 *
 * Returns `false` when there is no chat context and when the lookup fails —
 * an advisory rail must never turn a transient server or auth problem into a
 * refused command.
 */
export async function isFeishuBridgedChatContext(sdk: ChatDetailReader, chatId: string): Promise<boolean> {
  try {
    const detail = await sdk.getChatDetail(chatId);
    return detail.externalChannel === "feishu";
  } catch {
    // Fail open — see the module note. The server remains the boundary.
    return false;
  }
}

/**
 * Full precondition for a guarded command: returns the refusal to report, or
 * `null` when the command may proceed.
 */
export async function checkFeishuChatContext(
  sdk: ChatDetailReader,
  chatId: string | undefined,
  command: FeishuGuardedCommand,
): Promise<FeishuChatContextRefusal | null> {
  if (!chatId) return null;
  if (!(await isFeishuBridgedChatContext(sdk, chatId))) return null;
  return { code: FEISHU_CHAT_CONTEXT_CODE, message: feishuChatContextMessage(command) };
}
