import type { ChatExternalChannel } from "@first-tree/shared";

/**
 * Agent-session preconditions for the two chat commands the server cannot gate.
 *
 * `POST /agent/chats` never learns which chat the caller is sitting in — the
 * originating chat is not in `createTaskChatSchema`, not a header, and the
 * route has nothing to look up. `chat open` is worse: it runs on the user scope
 * and starts an interactive REPL, which is meaningless in a non-interactive
 * agent session. So both are refused client-side, before anything is created.
 *
 * The signal is `ChatDetail.externalChannel`, the same live `im_chat_bindings`
 * state the server-side guard enforces — not `metadata.source`, which stays
 * `"feishu"` after a binding detaches and would refuse commands the server
 * would happily accept.
 *
 * FAIL CLOSED. An earlier revision treated any lookup failure as "not a Feishu
 * chat" and proceeded. That was a real bypass, not just a rough edge: `chat
 * create --agent <other>` ran the origin lookup as the overridden agent, and an
 * agent that is not a member of the origin chat gets a 403 — which the
 * fail-open path read as permission to create. Two changes close it:
 *
 *   1. The origin chat is resolved under the SESSION identity (see
 *      `chat create`), so the lookup is performed by an agent that can
 *      actually see the chat. `--agent` still chooses who creates the new
 *      chat; it no longer decides who is allowed to answer the origin
 *      question. An unrelated agent's membership never becomes a requirement
 *      for an ordinary create.
 *   2. An inconclusive answer refuses instead of allowing.
 *
 * Refusing on an inconclusive lookup costs nothing in practice: the lookup and
 * the create talk to the same server with the same credentials, so a failure
 * here means the create was going to fail anyway. All the refusal changes is
 * that the operator gets a precise reason instead of a confusing downstream
 * error — and in the one case where the lookup fails but the create would have
 * succeeded, guessing is exactly what produced this bug.
 */

export const FEISHU_CHAT_CONTEXT_CODE = "FEISHU_CHAT_CONTEXT";
export const FEISHU_CHAT_CONTEXT_UNKNOWN_CODE = "FEISHU_CHAT_CONTEXT_UNKNOWN";

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

/**
 * Tri-state on purpose. Collapsing `unknown` into `unbridged` is precisely the
 * fail-open that let `--agent <other>` through.
 */
export type FeishuChatContextState = { kind: "bridged" } | { kind: "unbridged" } | { kind: "unknown"; reason: string };

const REASONS: Record<FeishuGuardedCommand, string> = {
  create:
    "`chat create` would open a First Tree task chat nobody in the Feishu group can see, and the new chat would " +
    "carry no way back to them.",
  open: "`chat open` starts an interactive REPL against a First Tree chat, which an agent session cannot drive.",
};

/** Build the refusal text for one guarded command in a confirmed bridged chat. */
export function feishuChatContextMessage(command: FeishuGuardedCommand): string {
  return (
    `This agent session is running inside a chat bridged to a Feishu conversation. ${REASONS[command]} ` +
    "Reply in the Feishu conversation instead — record the delivery with `feishu intent`, then send it with the " +
    "official `lark-cli --as bot`. To reach a First Tree teammate about this work, hand off from a chat that is " +
    "not bridged."
  );
}

/** Build the refusal text for an origin check that could not be completed. */
export function feishuChatContextUnknownMessage(command: FeishuGuardedCommand, reason: string): string {
  return (
    `Could not determine whether this agent session's chat is bridged to a Feishu conversation (${reason}). ` +
    `\`chat ${command}\` is refused rather than guessed, because ${REASONS[command]} ` +
    "Retry once the server is reachable; if this session is not attached to a chat at all, unset " +
    "FIRST_TREE_CHAT_ID, or run the command from a session whose chat is not bridged."
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

/**
 * Resolve whether the current session's chat is bridged to Feishu.
 *
 * The caller must pass an SDK bound to an identity that can actually read the
 * chat — in practice the session agent, never a `--agent` override.
 */
export async function resolveFeishuChatContext(sdk: ChatDetailReader, chatId: string): Promise<FeishuChatContextState> {
  let detail: { externalChannel?: ChatExternalChannel | null };
  try {
    detail = await sdk.getChatDetail(chatId);
  } catch (error) {
    return { kind: "unknown", reason: describeError(error) };
  }
  return detail.externalChannel === "feishu" ? { kind: "bridged" } : { kind: "unbridged" };
}

/**
 * Full precondition for a guarded command: returns the refusal to report, or
 * `null` when the command may proceed.
 *
 * `chatId` absent means there is no agent-session chat context to check, which
 * is the ordinary operator-terminal case and is allowed.
 */
export async function checkFeishuChatContext(
  sdk: ChatDetailReader,
  chatId: string | undefined,
  command: FeishuGuardedCommand,
): Promise<FeishuChatContextRefusal | null> {
  if (!chatId) return null;
  const state = await resolveFeishuChatContext(sdk, chatId);
  if (state.kind === "unbridged") return null;
  if (state.kind === "bridged") {
    return { code: FEISHU_CHAT_CONTEXT_CODE, message: feishuChatContextMessage(command) };
  }
  return {
    code: FEISHU_CHAT_CONTEXT_UNKNOWN_CODE,
    message: feishuChatContextUnknownMessage(command, state.reason),
  };
}
