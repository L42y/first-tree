import type { Command } from "commander";
import { registerGithubFollowCommand } from "./follow.js";
import { registerGithubFollowingCommand } from "./following.js";
import { registerGithubReplyCommand } from "./reply.js";
import { registerGithubUnfollowCommand } from "./unfollow.js";

export function registerGithubCommands(program: Command): void {
  const github = program
    .command("github")
    .description(
      "GitHub entity attention and recipient-bound App task replies. Follow wires an entity's webhook events " +
        "into the current chat; reply publishes one server-authored task run's terminal outcome as the App. " +
        "One attention line lives in exactly one chat (409 → --rebind moves it, never duplicates).",
    );
  registerGithubFollowCommand(github);
  registerGithubUnfollowCommand(github);
  registerGithubFollowingCommand(github);
  registerGithubReplyCommand(github);
}
