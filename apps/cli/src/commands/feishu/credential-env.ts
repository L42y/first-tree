import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeishuCredentialGrant } from "@first-tree/shared";
import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface CredentialOptions {
  agent?: string;
}

export function registerFeishuCredentialEnvCommand(feishu: Command): void {
  feishu
    .command("credential-env")
    .description(
      "Write this Agent's Bot App ID/Secret to a mode-0600 temporary shell file. Source it, call the official " +
        "lark-cli directly, then delete it. The secret is never printed.",
    )
    .option("--agent <name>", "Agent name (default: FIRST_TREE_AGENT_ID / local agent resolution)")
    .action(async (options: CredentialOptions) => {
      try {
        const grant = await createSdk(options.agent).createFeishuCredentialGrant();
        const envFile = await writeCredentialEnvironment(grant);
        success({
          bindingId: grant.bindingId,
          envFile,
          shell: process.platform === "win32" ? "powershell" : "posix",
          hint:
            process.platform === "win32"
              ? `Dot-source ${envFile}, call official lark-cli with --as bot, then Remove-Item ${envFile}.`
              : `Source ${envFile}, call official lark-cli with --as bot, then remove ${envFile}.`,
        });
      } catch (error) {
        handleSdkError(error);
      }
    });
}

export async function writeCredentialEnvironment(grant: FeishuCredentialGrant): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "first-tree-feishu-"));
  const windows = process.platform === "win32";
  const path = join(directory, windows ? "bot-env.ps1" : "bot-env.sh");
  const content = windows
    ? [
        `$env:LARKSUITE_CLI_APP_ID=${powerShellQuote(grant.appId)}`,
        `$env:LARKSUITE_CLI_APP_SECRET=${powerShellQuote(grant.appSecret)}`,
        `$env:LARKSUITE_CLI_CONFIG_DIR=${powerShellQuote(directory)}`,
        "$env:LARKSUITE_CLI_BRAND='feishu'",
        "Remove-Item Env:LARKSUITE_CLI_USER_ACCESS_TOKEN -ErrorAction SilentlyContinue",
        "Remove-Item Env:LARKSUITE_CLI_TENANT_ACCESS_TOKEN -ErrorAction SilentlyContinue",
      ].join("\n")
    : [
        `export LARKSUITE_CLI_APP_ID=${posixQuote(grant.appId)}`,
        `export LARKSUITE_CLI_APP_SECRET=${posixQuote(grant.appSecret)}`,
        `export LARKSUITE_CLI_CONFIG_DIR=${posixQuote(directory)}`,
        "export LARKSUITE_CLI_BRAND='feishu'",
        "unset LARKSUITE_CLI_USER_ACCESS_TOKEN LARKSUITE_CLI_TENANT_ACCESS_TOKEN",
      ].join("\n");
  await writeFile(path, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  if (!windows) await chmod(path, 0o600);
  return path;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
