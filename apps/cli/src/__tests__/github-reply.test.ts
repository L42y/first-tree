import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number) => {
    throw new Error(`${code}:${message}:${exitCode}`);
  }),
  success: vi.fn(),
}));
const sdk = { submitGithubTaskReply: vi.fn() };
const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  }),
}));

vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);

const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalRuntimeFile = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
let tempDir: string;
let bodyFile: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tempDir = await mkdtemp(join(tmpdir(), "github-reply-cli-"));
  bodyFile = join(tempDir, "reply.md");
  await writeFile(bodyFile, "Completed.\n", "utf8");
  const runtimeFile = join(tempDir, "runtime-token");
  await writeFile(runtimeFile, "runtime-proof\n", "utf8");
  process.env.FIRST_TREE_CHAT_ID = "chat-42";
  process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = runtimeFile;
  localAgentMocks.createSdk.mockReturnValue(sdk);
  sdk.submitGithubTaskReply.mockResolvedValue({
    commentId: 42,
    commentUrl: "https://github.com/owner/repo/issues/42#issuecomment-42",
    appActor: "first-tree-staging[bot]",
  });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  setEnv("FIRST_TREE_CHAT_ID", originalChatId);
  setEnv("FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE", originalRuntimeFile);
});

async function run(args: string[]): Promise<void> {
  const { registerGithubCommands } = await import("../commands/github/index.js");
  const root = new Command();
  registerGithubCommands(root);
  await root.parseAsync(["node", "test", "github", "reply", ...args]);
}

describe("github reply", () => {
  it("submits only the server-derived chat, run id, and file body", async () => {
    await run(["--run", "run-42", "--body-file", bodyFile]);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith();
    expect(sdk.submitGithubTaskReply).toHaveBeenCalledWith("chat-42", "run-42", { body: "Completed.\n" });
    expect(outputMocks.success).toHaveBeenCalledWith(expect.objectContaining({ appActor: "first-tree-staging[bot]" }));
  });

  it("fails before SDK creation without current chat/runtime proof and rejects reserved content", async () => {
    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(run(["--run", "run-42", "--body-file", bodyFile])).rejects.toThrow("NO_CHAT_CONTEXT");
    process.env.FIRST_TREE_CHAT_ID = "chat-42";
    delete process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
    await expect(run(["--run", "run-42", "--body-file", bodyFile])).rejects.toThrow("NO_RUNTIME_SESSION");
    process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = join(tempDir, "missing");
    await expect(run(["--run", "run-42", "--body-file", bodyFile])).rejects.toThrow("NO_RUNTIME_SESSION");

    const runtimeFile = join(tempDir, "runtime-token");
    await writeFile(runtimeFile, "runtime-proof\n", "utf8");
    process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE = runtimeFile;
    await writeFile(bodyFile, "<!-- first-tree-github-task-reply-run:spoof -->", "utf8");
    await expect(run(["--run", "run-42", "--body-file", bodyFile])).rejects.toThrow("INVALID_GITHUB_TASK_REPLY");
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
  });

  it("rejects oversized files and propagates SDK publication errors", async () => {
    await writeFile(bodyFile, Buffer.alloc(64 * 1024 + 1, "x"));
    await expect(run(["--run", "run-42", "--body-file", bodyFile])).rejects.toThrow("REPLY_BODY_TOO_LARGE");
    await writeFile(bodyFile, "Done", "utf8");
    sdk.submitGithubTaskReply.mockRejectedValueOnce(new Error("publisher unavailable"));
    await expect(run(["--run", "run-42", "--body-file", bodyFile])).rejects.toThrow("publisher unavailable");
    expect(localAgentMocks.handleSdkError).toHaveBeenCalled();
  });

  it("exposes one direct reply command without repo/entity/provider options", async () => {
    const { registerGithubCommands } = await import("../commands/github/index.js");
    const root = new Command();
    registerGithubCommands(root);
    const github = root.commands.find((command) => command.name() === "github");
    const reply = github?.commands.find((command) => command.name() === "reply");
    expect(reply?.commands).toHaveLength(0);
    expect(reply?.options.map((option) => option.long).sort()).toEqual(["--body-file", "--run"]);
  });
});

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
