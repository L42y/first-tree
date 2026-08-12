#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FeishuCliGrant, FeishuCliPreflight } from "@first-tree/shared";
import { ensureFreshAccessToken, resolveServerUrl } from "./core/bootstrap.js";
import {
  buildBotEnvironment,
  isUncontrolledMessageMutation,
  type OfficialResult,
  retryableFailure,
} from "./feishu-cli-policy.js";

const require = createRequire(import.meta.url);
const RETRY_DELAYS_MS = [250, 750] as const;
const OFFICIAL_CLI_TIMEOUT_MS = 30_000;
const FIRST_TREE_MESSAGE_FLAG = "--first-tree-message-id";

type ParsedImCommand = {
  operation: "im.send" | "im.reply";
  targetChatId?: string;
  targetMessageId?: string;
  replyInThread: boolean;
  format: "text" | "markdown" | "card" | "file";
  content: unknown;
};

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function removeFlag(args: string[], name: string, takesValue = true): void {
  for (;;) {
    const index = args.indexOf(name);
    if (index < 0) return;
    args.splice(index, takesValue ? 2 : 1);
  }
}

function setFlag(args: string[], name: string, value: string): void {
  removeFlag(args, name);
  args.push(name, value);
}

function parseContent(args: readonly string[]): Pick<ParsedImCommand, "format" | "content"> {
  const text = flagValue(args, "--text");
  if (text !== undefined) return { format: "text", content: text };
  const markdown = flagValue(args, "--markdown");
  if (markdown !== undefined) return { format: "markdown", content: markdown };
  const raw = flagValue(args, "--content");
  if (raw !== undefined) {
    let content: unknown = raw;
    try {
      content = JSON.parse(raw);
    } catch {
      // The official CLI owns final validation; preserve the exact input here.
    }
    return { format: flagValue(args, "--msg-type") === "interactive" ? "card" : "text", content };
  }
  for (const name of ["--file", "--image", "--video", "--audio"] as const) {
    const value = flagValue(args, name);
    if (value !== undefined) {
      return {
        format: "file",
        content: {
          kind: name.slice(2),
          value,
          ...(name === "--video" ? { cover: flagValue(args, "--video-cover") ?? null } : {}),
        },
      };
    }
  }
  throw new Error("Feishu IM writes require --text, --markdown, --content, or a media flag");
}

function parseImCommand(args: readonly string[]): ParsedImCommand | null {
  if (args[0] !== "im" || (args[1] !== "+messages-send" && args[1] !== "+messages-reply")) return null;
  const operation = args[1] === "+messages-reply" ? "im.reply" : "im.send";
  return {
    operation,
    targetChatId: flagValue(args, "--chat-id"),
    targetMessageId: flagValue(args, "--message-id"),
    replyInThread: args.includes("--reply-in-thread"),
    ...parseContent(args),
  };
}

function informationalCommand(args: readonly string[]): boolean {
  return (
    args.length === 0 ||
    args.includes("--help") ||
    args.includes("-h") ||
    args.includes("--version") ||
    ["doctor", "skills", "completion", "update"].includes(args[0] ?? "")
  );
}

function runtimeToken(): string | undefined {
  const path = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function brokerContext(): { serverUrl: string; agentId: string; runtimeSessionToken?: string } {
  const agentId = process.env.FIRST_TREE_AGENT_ID?.trim();
  if (!agentId) throw new Error("FIRST_TREE_AGENT_ID is required for controlled Feishu access");
  return {
    serverUrl: resolveServerUrl(process.env.FIRST_TREE_SERVER_URL),
    agentId,
    runtimeSessionToken: runtimeToken(),
  };
}

async function brokerRequest<T>(path: string, body: unknown): Promise<T> {
  const context = brokerContext();
  const accessToken = await ensureFreshAccessToken();
  const response = await fetch(`${context.serverUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "first-tree-feishu-cli/0.1.0",
      "x-agent-id": context.agentId,
      ...(context.runtimeSessionToken ? { "x-agent-runtime-session": context.runtimeSessionToken } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? `First Tree credential broker returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function officialRunner(): string {
  const packageJson = require.resolve("@larksuite/cli/package.json");
  return join(dirname(packageJson), "scripts", "run.js");
}

async function runOfficial(args: readonly string[], env: NodeJS.ProcessEnv): Promise<OfficialResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [officialRunner(), ...args], { env, stdio: ["inherit", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, OFFICIAL_CLI_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithBoundedRetries(args: readonly string[], env: NodeJS.ProcessEnv): Promise<OfficialResult> {
  let result = await runOfficial(args, env);
  for (const waitMs of RETRY_DELAYS_MS) {
    if (result.code === 0 || !retryableFailure(result)) break;
    await delay(waitMs);
    result = await runOfficial(args, env);
  }
  return result;
}

async function main(): Promise<void> {
  const originalArgs = process.argv.slice(2);
  if (informationalCommand(originalArgs)) {
    const result = await runOfficial(originalArgs, process.env);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
    return;
  }
  if (isUncontrolledMessageMutation(originalArgs)) {
    throw new Error("Use im +messages-send or im +messages-reply so every Feishu message enters First Tree history");
  }

  const canonicalMessageId = flagValue(originalArgs, FIRST_TREE_MESSAGE_FLAG);
  const brokerArgs = [...originalArgs];
  removeFlag(brokerArgs, FIRST_TREE_MESSAGE_FLAG);
  const parsedIm = parseImCommand(brokerArgs);
  const im = parsedIm && !brokerArgs.includes("--dry-run") ? parsedIm : null;
  if (canonicalMessageId && !im) {
    throw new Error(`${FIRST_TREE_MESSAGE_FLAG} is valid only for Feishu message send/reply retries`);
  }
  const body: FeishuCliPreflight = im
    ? {
        chatId: process.env.FIRST_TREE_CHAT_ID,
        operation: im.operation,
        command: brokerArgs.slice(0, 2).join(" "),
        targetChatId: im.targetChatId,
        targetMessageId: im.targetMessageId,
        replyInThread: im.replyInThread,
        format: im.format,
        content: im.content,
        canonicalMessageId,
      }
    : { operation: "write", command: brokerArgs.slice(0, 3).join(" "), replyInThread: false };

  const grant = await brokerRequest<FeishuCliGrant>("/api/v1/agent/feishu/cli/preflight", body);
  const args = [...brokerArgs];
  setFlag(args, "--as", "bot");
  if (im && grant.idempotencyKey) setFlag(args, "--idempotency-key", grant.idempotencyKey);
  if (im?.operation === "im.reply" && grant.targetMessageId) setFlag(args, "--message-id", grant.targetMessageId);
  if (im?.operation === "im.send" && grant.targetChatId) setFlag(args, "--chat-id", grant.targetChatId);
  if (im) {
    removeFlag(args, "--jq");
    removeFlag(args, "-q");
    removeFlag(args, "--json", false);
    setFlag(args, "--format", "json");
  }

  // The Bot belongs to Agent A. Keep its credential scoped to this child
  // process and out of prompts, chat history, logs, and persistent CLI config.
  const env = buildBotEnvironment(process.env, grant.appId, grant.appSecret);
  const result = im ? await runWithBoundedRetries(args, env) : await runOfficial(args, env);

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (im && result.code !== 0 && grant.canonicalMessageId) {
    process.stderr.write(
      `\nFirst Tree message ${grant.canonicalMessageId} remains the immutable send intent. ` +
        `Retry with ${FIRST_TREE_MESSAGE_FLAG} ${grant.canonicalMessageId}; do not create another message.\n`,
    );
  }
  process.exitCode = result.code;
}

main().catch((error) => {
  process.stderr.write(`lark-cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
