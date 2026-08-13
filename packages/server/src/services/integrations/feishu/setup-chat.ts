import { MESSAGE_SOURCES } from "@first-tree/shared";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { messages } from "../../../db/schema/messages.js";
import {
  type CreateTaskChatResult,
  createChat,
  type TaskChatReuseActivity,
  type TaskChatReuseContext,
} from "../../chat/conversation.js";
import { sendMessage } from "../../chat/message.js";
import { feishuCliSetupKickoffKey } from "../../onboarding-kickoff.js";

/**
 * The Agent's own machine check for Feishu. It is deliberately ordinary work in
 * an ordinary Task: OpenTag and Agent Detail both ask for it, and the Agent
 * inspects its Computer, installs the official CLI, and verifies it.
 */
const INSTALL_PROMPT = `请检查当前机器是否已安装飞书官方 lark-cli。如果没有，请根据当前 OS 和环境使用官方方式安装；不要擅自使用 sudo，遇到管理员权限时先询问我。安装后运行 lark-cli --version 和 lark-cli doctor 验证并回复结果。不要手工配置或输出 App Secret：需要调用 Bot 时，先用 First Tree 的 feishu credential-env 命令生成临时环境文件，source 后直接调用官方 lark-cli，并在完成后删除该临时文件。`;

/**
 * How recently the Task must have been asked before a retry declines to ask
 * again.
 *
 * A member only reaches the retry after a wait that is already much longer than
 * this, so the cooldown is invisible on the path it exists for. What it stops is
 * a burst — a double click, or two tabs both sitting on the recovery state —
 * turning one intent into several identical requests at the Agent.
 */
const RETRY_COOLDOWN_MS = 30_000;

export type FeishuCliSetupChatInput = {
  agent: { uuid: string; organizationId: string; displayName: string; clientId: string | null };
  humanAgentId: string;
  /**
   * The member explicitly asked to try again. Ensuring the Task exists — which
   * every load, reload, and extra tab does — must not set this: those are not
   * new intent, and waking the Agent for each of them would turn a background
   * mechanism into a stream of interruptions.
   */
  retry: boolean;
};

/**
 * Create the Agent's Feishu CLI setup Task, or converge on the one it already
 * has.
 *
 * Reuse is not the same as doing nothing. An ensure call is satisfied by the
 * Task existing, but a retry has to reach an Agent that may have consumed the
 * original request long ago and stopped — so it asks again, in the same Task,
 * rather than opening a second one or reporting a retry that never happened.
 */
export async function createOrReuseFeishuCliSetupChat(
  db: Database,
  input: FeishuCliSetupChatInput,
): Promise<CreateTaskChatResult> {
  return createChat(db, {
    mode: "task",
    initiatorAgentId: input.humanAgentId,
    organizationId: input.agent.organizationId,
    initialRecipientAgentIds: [input.agent.uuid],
    contextParticipantAgentIds: [],
    // Create-or-reuse, because this is asked for automatically as well as by
    // hand: OpenTag asks the moment the member commits to Feishu, and that
    // request repeats on every reload, retry, and extra tab.
    onboardingKickoffKey: feishuCliSetupKickoffKey(input.humanAgentId, input.agent.uuid, input.agent.clientId),
    ...(input.retry
      ? { onTaskReuse: (tx: Database, context: TaskChatReuseContext) => askAgainInExistingTask(tx, input, context) }
      : {}),
    topic: `配置 ${input.agent.displayName} 的飞书 CLI`,
    initialMessage: {
      format: "markdown",
      content: INSTALL_PROMPT,
      metadata: { mentions: [input.agent.uuid] },
      source: MESSAGE_SOURCES.WEB,
    },
    source: "manual",
  });
}

/**
 * Ask the Agent again, inside the Task it already has.
 *
 * Re-arming the original message would not be enough: once the Agent has taken
 * that inbox entry the delivery is finished, and flipping a flag on it wakes
 * nobody. A new message in the same Task is what a retry actually is — the same
 * request, asked again — and it keeps the conversation single.
 *
 * This runs inside the keyed reuse transaction, which already holds the chat row
 * `FOR UPDATE`, so the read below settles concurrent retries against each other
 * rather than racing them.
 */
async function askAgainInExistingTask(
  db: Database,
  input: FeishuCliSetupChatInput,
  context: TaskChatReuseContext,
): Promise<TaskChatReuseActivity | null> {
  const [newest] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.chatId, context.chat.id))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  if (newest && Date.now() - newest.createdAt.getTime() < RETRY_COOLDOWN_MS) return null;

  const sent = await sendMessage(
    db,
    context.chat.id,
    input.humanAgentId,
    {
      format: "markdown",
      content: INSTALL_PROMPT,
      metadata: { mentions: [input.agent.uuid] },
      source: MESSAGE_SOURCES.WEB,
    },
    { deferPostCommitEffects: true },
  );
  if (!sent.deferredPostCommitEffects) {
    throw new Error("Feishu CLI setup retry did not return deferred post-commit effects");
  }
  return { ...sent, deferredPostCommitEffects: sent.deferredPostCommitEffects };
}
