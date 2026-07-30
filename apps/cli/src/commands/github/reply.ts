import { readFile, stat } from "node:fs/promises";
import { GITHUB_TASK_REPLY_BODY_MAX_BYTES, githubTaskReplyRequestSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

type ReplyOptions = {
  run?: string;
  bodyFile?: string;
};

export function registerGithubReplyCommand(github: Command): void {
  github
    .command("reply")
    .description("Publish the terminal outcome for one server-authored GitHub App task run.")
    .requiredOption("--run <runId>", "Server-authored GitHub task run id")
    .requiredOption("--body-file <path>", "Reply body file (`-` reads stdin)")
    .action(async (options: ReplyOptions) => {
      try {
        const chatId = process.env.FIRST_TREE_CHAT_ID?.trim();
        if (!chatId) {
          fail("NO_CHAT_CONTEXT", "GitHub task reply requires the run's active FIRST_TREE_CHAT_ID session.", 2);
        }
        const runtimeTokenFile = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE?.trim();
        if (!runtimeTokenFile) {
          fail("NO_RUNTIME_SESSION", "GitHub task reply requires the active agent runtime session token.", 3);
        }
        const runtimeToken = await readFile(runtimeTokenFile, "utf8").catch(() => "");
        if (!runtimeToken.trim()) {
          fail("NO_RUNTIME_SESSION", "GitHub task reply requires a readable active runtime session token.", 3);
        }

        const body = await readReplyBody(options.bodyFile ?? "");
        const parsed = githubTaskReplyRequestSchema.safeParse({ body });
        if (!parsed.success) {
          fail("INVALID_GITHUB_TASK_REPLY", parsed.error.issues.map((issue) => issue.message).join("; "), 2);
        }
        success(await createSdk().submitGithubTaskReply(chatId, options.run ?? "", parsed.data));
      } catch (error) {
        handleSdkError(error);
      }
    });
}

async function readReplyBody(path: string): Promise<string> {
  if (path === "-") {
    if (process.stdin.isTTY) {
      fail("NO_REPLY_BODY", "--body-file - requires reply body content on stdin.", 2);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > GITHUB_TASK_REPLY_BODY_MAX_BYTES) {
        fail("REPLY_BODY_TOO_LARGE", `Reply body exceeds ${GITHUB_TASK_REPLY_BODY_MAX_BYTES} bytes.`, 2);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    fail("REPLY_BODY_FILE_INVALID", `--body-file must name a readable regular file: ${path}`, 2);
  }
  if (info.size > GITHUB_TASK_REPLY_BODY_MAX_BYTES) {
    fail("REPLY_BODY_TOO_LARGE", `Reply body exceeds ${GITHUB_TASK_REPLY_BODY_MAX_BYTES} bytes.`, 2);
  }
  return readFile(path, "utf8").catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("REPLY_BODY_FILE_UNREADABLE", `Unable to read --body-file: ${detail}`, 2);
  });
}
