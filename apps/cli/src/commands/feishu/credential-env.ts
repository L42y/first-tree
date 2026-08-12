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

const FEISHU_TENANT_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";

export function registerFeishuCredentialEnvCommand(feishu: Command): void {
  feishu
    .command("credential-env")
    .description(
      "Write this Agent's Bot credential environment to a mode-0600 temporary shell file. Source it, call the official " +
        "lark-cli directly, then delete it. The secret is never printed.",
    )
    .option("--agent <name>", "Agent name (default: FIRST_TREE_AGENT_ID / local agent resolution)")
    .action(async (options: CredentialOptions) => {
      try {
        const grant = await createSdk(options.agent).createFeishuCredentialGrant();
        const tenantAccessToken = await requestTenantAccessToken(grant);
        const envFile = await writeCredentialEnvironment(grant, tenantAccessToken);
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

export async function requestTenantAccessToken(
  grant: FeishuCredentialGrant,
  request: typeof fetch = fetch,
): Promise<string> {
  const response = await request(FEISHU_TENANT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: grant.appId, app_secret: grant.appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isTenantTokenResponse(payload)) {
    const providerMessage = readProviderMessage(payload);
    throw new Error(`Feishu tenant token exchange failed${providerMessage ? `: ${providerMessage}` : ""}`);
  }
  return payload.tenant_access_token;
}

export async function writeCredentialEnvironment(
  grant: FeishuCredentialGrant,
  tenantAccessToken: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "first-tree-feishu-"));
  const windows = process.platform === "win32";
  const path = join(directory, windows ? "bot-env.ps1" : "bot-env.sh");
  const content = windows
    ? [
        `$env:LARKSUITE_CLI_APP_ID=${powerShellQuote(grant.appId)}`,
        `$env:LARKSUITE_CLI_APP_SECRET=${powerShellQuote(grant.appSecret)}`,
        `$env:LARKSUITE_CLI_CONFIG_DIR=${powerShellQuote(directory)}`,
        "$env:LARKSUITE_CLI_BRAND='feishu'",
        `$env:LARKSUITE_CLI_TENANT_ACCESS_TOKEN=${powerShellQuote(tenantAccessToken)}`,
        "Remove-Item Env:LARKSUITE_CLI_USER_ACCESS_TOKEN -ErrorAction SilentlyContinue",
      ].join("\n")
    : [
        `export LARKSUITE_CLI_APP_ID=${posixQuote(grant.appId)}`,
        `export LARKSUITE_CLI_APP_SECRET=${posixQuote(grant.appSecret)}`,
        `export LARKSUITE_CLI_CONFIG_DIR=${posixQuote(directory)}`,
        "export LARKSUITE_CLI_BRAND='feishu'",
        `export LARKSUITE_CLI_TENANT_ACCESS_TOKEN=${posixQuote(tenantAccessToken)}`,
        "unset LARKSUITE_CLI_USER_ACCESS_TOKEN",
      ].join("\n");
  await writeFile(path, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  if (!windows) await chmod(path, 0o600);
  return path;
}

function isTenantTokenResponse(value: unknown): value is { code: 0; tenant_access_token: string } {
  if (!value || typeof value !== "object") return false;
  return (
    "code" in value &&
    value.code === 0 &&
    "tenant_access_token" in value &&
    typeof value.tenant_access_token === "string" &&
    value.tenant_access_token.length > 0
  );
}

function readProviderMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("msg" in value)) return null;
  return typeof value.msg === "string" && value.msg.length > 0 ? value.msg : null;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
