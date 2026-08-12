import type { Command } from "commander";
import { registerFeishuCredentialEnvCommand } from "./credential-env.js";
import { registerFeishuIntentCommand } from "./intent.js";

export function registerFeishuCommands(program: Command): void {
  const feishu = program
    .command("feishu")
    .description("Record Feishu delivery intent and prepare the bound Bot identity for official lark-cli");
  registerFeishuIntentCommand(feishu);
  registerFeishuCredentialEnvCommand(feishu);
}
