import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

type Options = {
  agent?: string;
};

export function registerChatArchiveCommand(chat: Command): void {
  chat
    .command("archive [chatId]")
    .description(
      "Archive a chat from the signed-in user's conversation list. The selected agent must participate in the chat. " +
        "Defaults to FIRST_TREE_CHAT_ID; archived chats return to Active when a new message arrives.",
    )
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (chatId: string | undefined, options: Options) => {
      const targetChatId = chatId ?? process.env.FIRST_TREE_CHAT_ID;
      if (!targetChatId) {
        fail(
          "NO_CHAT_CONTEXT",
          "`chat archive` needs a chat to target. Pass a chat id from `chat list`, or run it from an agent session that exports FIRST_TREE_CHAT_ID.",
          2,
        );
      }

      try {
        const sdk = createSdk(options.agent);
        const result = await sdk.archiveChat(targetChatId);
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
