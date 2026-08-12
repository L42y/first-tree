import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { FeishuOutboundMediaIdentity } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface IntentOptions {
  agent?: string;
  chat?: string;
  operation: "send" | "reply";
  targetChat?: string;
  targetMessage?: string;
  replyInThread?: boolean;
  format: "text" | "markdown" | "card" | "file";
  content?: string;
  contentFile?: string;
  mediaFile?: string;
  mediaKind?: "file" | "image" | "video" | "audio";
  videoCover?: string;
  canonicalMessageId?: string;
}

export function registerFeishuIntentCommand(feishu: Command): void {
  feishu
    .command("intent")
    .description(
      "Validate and record one immutable outbound Feishu intent before the Agent calls official lark-cli directly.",
    )
    .requiredOption("--operation <operation>", "send|reply")
    .requiredOption("--format <format>", "text|markdown|card|file")
    .option("--chat <chatId>", "First Tree chat (default: FIRST_TREE_CHAT_ID)")
    .option("--target-chat <chatId>", "Feishu chat ID for a new top-level send")
    .option("--target-message <messageId>", "Feishu message ID for a reply")
    .option("--reply-in-thread", "Ask Feishu to keep the reply in its thread")
    .option("--content <value>", "Text, Markdown, or card JSON string stored as the canonical intent")
    .option("-F, --content-file <path>", "Read intent content from a UTF-8 file")
    .option("--media-file <path>", "Media file whose filename, size, and SHA-256 identify the immutable intent")
    .option("--media-kind <kind>", "file|image|video|audio", "file")
    .option("--video-cover <path>", "Video cover file included in the immutable media identity")
    .option("--canonical-message-id <id>", "Validate a retry against an existing canonical intent")
    .option("--agent <name>", "Agent name (default: FIRST_TREE_AGENT_ID / local agent resolution)")
    .action(async (options: IntentOptions) => {
      try {
        validateOptions(options);
        const chatId = options.chat ?? process.env.FIRST_TREE_CHAT_ID;
        if (!chatId) fail("NO_CHAT_CONTEXT", "Pass --chat or run inside a session with FIRST_TREE_CHAT_ID.", 2);

        const media = options.format === "file" ? await createMediaIdentity(options) : undefined;
        const content = options.format === "file" ? undefined : await readIntentContent(options);
        const result = await createSdk(options.agent).createFeishuOutboundIntent({
          chatId,
          operation: options.operation,
          targetChatId: options.targetChat,
          targetMessageId: options.targetMessage,
          replyInThread: options.replyInThread === true,
          format: options.format,
          content,
          media,
          canonicalMessageId: options.canonicalMessageId,
        });
        success({
          ...result,
          hint:
            "Now call the official lark-cli directly with --as bot and use idempotencyKey as its idempotency UUID. " +
            "Run `first-tree feishu credential-env` first when Bot environment variables are not loaded.",
        });
      } catch (error) {
        handleSdkError(error);
      }
    });
}

function validateOptions(options: IntentOptions): void {
  if (!(["send", "reply"] as const).includes(options.operation)) {
    fail("INVALID_OPERATION", "--operation must be send or reply.", 2);
  }
  if (!(["text", "markdown", "card", "file"] as const).includes(options.format)) {
    fail("INVALID_FORMAT", "--format must be text, markdown, card, or file.", 2);
  }
  if (options.content !== undefined && options.contentFile !== undefined) {
    fail("CONFLICTING_CONTENT", "Pass --content or --content-file, not both.", 2);
  }
  if (options.format === "file" && !options.mediaFile) {
    fail("MISSING_MEDIA", "--format file requires --media-file.", 2);
  }
  if (options.format !== "file" && options.mediaFile) {
    fail("UNEXPECTED_MEDIA", "--media-file requires --format file.", 2);
  }
  if (options.operation === "send" && !options.targetChat) {
    fail("MISSING_TARGET", "--operation send requires --target-chat.", 2);
  }
  if (options.operation === "reply" && !options.targetMessage) {
    fail("MISSING_TARGET", "--operation reply requires --target-message.", 2);
  }
}

async function readIntentContent(options: IntentOptions): Promise<string> {
  if (options.contentFile) return readFile(options.contentFile, "utf8");
  if (options.content !== undefined) return options.content;
  fail("MISSING_CONTENT", "Text, Markdown, and card intents require --content or --content-file.", 2);
}

async function createMediaIdentity(options: IntentOptions): Promise<FeishuOutboundMediaIdentity> {
  const path = options.mediaFile;
  if (!path) fail("MISSING_MEDIA", "--format file requires --media-file.", 2);
  const kind = options.mediaKind ?? "file";
  if (!(["file", "image", "video", "audio"] as const).includes(kind)) {
    fail("INVALID_MEDIA_KIND", "--media-kind must be file, image, video, or audio.", 2);
  }
  if (options.videoCover && kind !== "video") {
    fail("UNEXPECTED_COVER", "--video-cover is valid only with --media-kind video.", 2);
  }
  const primary = await describeFile(path);
  const cover = options.videoCover ? await describeFile(options.videoCover) : undefined;
  return { kind, ...primary, ...(cover ? { cover } : {}) };
}

export async function describeFile(path: string): Promise<{ filename: string; size: number; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return { filename: basename(path), size: info.size, sha256: hash.digest("hex") };
}
