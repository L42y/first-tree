import { CHAT_ENGAGEMENT_VIEWS, chatEngagementViewSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { getWorkspaceChatExactForAgent, listWorkspaceChatsForAgent } from "../../core/workspace-chat-list.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseLimit } from "./_shared/io.js";

export function registerChatListCommand(chat: Command): void {
  chat
    .command("list")
    .description(
      "List chats this agent participates in (structural inventory by default; " +
        "--engagement lists the signed-in user's Workspace Active/Archived view instead)",
    )
    .option("-l, --limit <number>", "Maximum chats to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .option(
      "--engagement <view>",
      `Workspace engagement view (${CHAT_ENGAGEMENT_VIEWS.join(" | ")}) — lists the signed-in user's Workspace projection, restricted to chats where the selected agent is a speaker`,
    )
    .option(
      "--chat <chatId>",
      "Exact one-chat preflight before `chat archive` — merges the Workspace row's attention fields with the raw member chat detail (metadata, lastReadAt, …); the detail's engagement is the current-state verdict (requires --engagement; cannot combine with --cursor)",
    )
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: { limit: string; cursor?: string; engagement?: string; chat?: string; agent?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        if (options.engagement === undefined) {
          if (options.chat !== undefined) {
            fail("CHAT_REQUIRES_ENGAGEMENT", `--chat requires --engagement <${CHAT_ENGAGEMENT_VIEWS.join("|")}>.`, 2);
          }
          const sdk = createSdk(options.agent);
          const result = await sdk.listChats({ limit, cursor: options.cursor });
          success(result);
          return;
        }
        const parsedEngagement = chatEngagementViewSchema.safeParse(options.engagement);
        if (!parsedEngagement.success) {
          fail(
            "INVALID_ENGAGEMENT",
            `--engagement must be one of: ${CHAT_ENGAGEMENT_VIEWS.join(", ")} (got "${options.engagement}").`,
            2,
          );
        }
        const engagement = parsedEngagement.data;
        if (options.chat !== undefined && options.cursor !== undefined) {
          fail(
            "CONFLICTING_ARGS",
            "--chat cannot be combined with --cursor: an exact lookup returns at most one item.",
            2,
          );
        }
        const sdk = createSdk(options.agent);
        const result =
          options.chat !== undefined
            ? await getWorkspaceChatExactForAgent(sdk, options.chat, engagement)
            : await listWorkspaceChatsForAgent(sdk, { engagement, limit, cursor: options.cursor });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
