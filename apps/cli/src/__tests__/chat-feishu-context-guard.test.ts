import type { ChatExternalChannel } from "@first-tree/shared";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

const docCaptureMock = vi.hoisted(() => ({
  captureOutboundDocs: vi.fn(async (content: string) => ({ content })),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../core/doc-capture.js", () => docCaptureMock);
vi.mock("../cli/output.js", () => outputMocks);

import {
  checkFeishuChatContext,
  FEISHU_CHAT_CONTEXT_CODE,
  FEISHU_CHAT_CONTEXT_UNKNOWN_CODE,
  feishuChatContextMessage,
  resolveFeishuChatContext,
} from "../core/feishu-chat-context.js";

/**
 * Pins the two CLI-side preconditions the server cannot enforce.
 *
 * `chat create` never transmits the originating chat (`createTaskChatSchema`
 * has no field for it, and there is no header), and `chat open` runs on the
 * user scope and starts an interactive REPL. Both are therefore refused here,
 * from `FIRST_TREE_CHAT_ID` plus the live `externalChannel` signal — and both
 * must fail CLOSED, because there is no server-side boundary behind them to
 * catch a wrong guess.
 */

type DetailRow = { externalChannel?: ChatExternalChannel | null };

function reader(impl: () => Promise<DetailRow>) {
  return { getChatDetail: vi.fn(impl) };
}

describe("resolveFeishuChatContext", () => {
  it("reports a bridged chat", async () => {
    const sdk = reader(async () => ({ externalChannel: "feishu" }));
    expect(await resolveFeishuChatContext(sdk, "chat-1")).toEqual({ kind: "bridged" });
    expect(sdk.getChatDetail).toHaveBeenCalledWith("chat-1");
  });

  it("reports an ordinary chat", async () => {
    expect(
      await resolveFeishuChatContext(
        reader(async () => ({ externalChannel: null })),
        "chat-1",
      ),
    ).toEqual({ kind: "unbridged" });
  });

  it("treats a server that predates the field as unbridged", async () => {
    expect(
      await resolveFeishuChatContext(
        reader(async () => ({})),
        "chat-1",
      ),
    ).toEqual({ kind: "unbridged" });
  });

  it("reports `unknown` — never `unbridged` — when the lookup throws", async () => {
    const state = await resolveFeishuChatContext(
      reader(async () => {
        throw new Error("connection refused");
      }),
      "chat-1",
    );
    expect(state).toEqual({ kind: "unknown", reason: "connection refused" });
  });
});

describe("checkFeishuChatContext", () => {
  it("refuses `chat create` inside a bridged chat and names the Feishu path", async () => {
    const refusal = await checkFeishuChatContext(
      reader(async () => ({ externalChannel: "feishu" })),
      "chat-1",
      "create",
    );
    expect(refusal?.code).toBe(FEISHU_CHAT_CONTEXT_CODE);
    expect(refusal?.message).toContain("chat create");
    expect(refusal?.message).toContain("feishu intent");
    expect(refusal?.message).toContain("lark-cli");
  });

  it("refuses `chat open` inside a bridged chat", async () => {
    const refusal = await checkFeishuChatContext(
      reader(async () => ({ externalChannel: "feishu" })),
      "chat-1",
      "open",
    );
    expect(refusal?.code).toBe(FEISHU_CHAT_CONTEXT_CODE);
    expect(refusal?.message).toContain("chat open");
  });

  /**
   * Regression for the `--agent <other>` bypass: the overridden agent is not a
   * member of the origin chat, so the lookup 403s. Treating that as "not a
   * Feishu chat" is what let the create through.
   */
  it("refuses with a distinct code when the origin lookup is inconclusive", async () => {
    const refusal = await checkFeishuChatContext(
      reader(async () => {
        throw Object.assign(new Error("Not a participant of this chat"), { statusCode: 403 });
      }),
      "chat-1",
      "create",
    );
    expect(refusal?.code).toBe(FEISHU_CHAT_CONTEXT_UNKNOWN_CODE);
    expect(refusal?.message).toContain("Could not determine");
    expect(refusal?.message).toContain("Not a participant of this chat");
  });

  it("allows both commands in an ordinary chat", async () => {
    for (const command of ["create", "open"] as const) {
      expect(
        await checkFeishuChatContext(
          reader(async () => ({ externalChannel: null })),
          "chat-1",
          command,
        ),
      ).toBeNull();
    }
  });

  it("skips the lookup entirely outside an agent session", async () => {
    const sdk = reader(async () => ({ externalChannel: "feishu" }));
    expect(await checkFeishuChatContext(sdk, undefined, "create")).toBeNull();
    expect(sdk.getChatDetail).not.toHaveBeenCalled();
  });
});

describe("feishuChatContextMessage", () => {
  it("explains why each command is wrong here, not just that it is refused", () => {
    expect(feishuChatContextMessage("create")).toContain("nobody in the Feishu group can see");
    expect(feishuChatContextMessage("open")).toContain("interactive REPL");
  });
});

/**
 * Command-level wiring, where the actual bypass lived: the origin-chat lookup
 * has to run under the SESSION identity, not under `--agent`.
 */
describe("`chat create` origin-chat resolution", () => {
  const originalChatId = process.env.FIRST_TREE_CHAT_ID;
  const originalAgentId = process.env.FIRST_TREE_AGENT_ID;

  /** Session agent sees the bridged origin chat; `other` is not a member of it. */
  function wireAgents(): { createTaskChat: ReturnType<typeof vi.fn> } {
    const createTaskChat = vi.fn(async () => ({ chatId: "new-chat", messageId: "m1" }));
    const sessionSdk = {
      getChatDetail: vi.fn(async () => ({ externalChannel: "feishu" as const })),
      createTaskChat,
    };
    const overriddenSdk = {
      getChatDetail: vi.fn(async () => {
        throw Object.assign(new Error("Not a participant of this chat"), { statusCode: 403 });
      }),
      createTaskChat,
    };
    localAgentMocks.createSdk.mockImplementation((agentName?: string) =>
      agentName === undefined ? sessionSdk : overriddenSdk,
    );
    return { createTaskChat };
  }

  async function runCreate(args: string[]): Promise<void> {
    const { registerChatCommands } = await import("../commands/chat/index.js");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    registerChatCommands(program);
    await program.parseAsync(["node", "test", "chat", "create", ...args]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
    process.env.FIRST_TREE_CHAT_ID = "origin-chat";
    process.env.FIRST_TREE_AGENT_ID = "agent-session";
  });

  afterEach(() => {
    if (originalChatId === undefined) delete process.env.FIRST_TREE_CHAT_ID;
    else process.env.FIRST_TREE_CHAT_ID = originalChatId;
    if (originalAgentId === undefined) delete process.env.FIRST_TREE_AGENT_ID;
    else process.env.FIRST_TREE_AGENT_ID = originalAgentId;
  });

  it("refuses `--agent <other>` from a bridged session instead of creating", async () => {
    const { createTaskChat } = wireAgents();

    await expect(runCreate(["hello", "--to", "someone", "--agent", "other"])).rejects.toThrow(
      /bridged to a Feishu conversation/,
    );
    expect(createTaskChat).not.toHaveBeenCalled();
    expect(outputMocks.fail).toHaveBeenCalledWith(FEISHU_CHAT_CONTEXT_CODE, expect.any(String), 2);
  });

  it("refuses rather than creating when the session lookup itself is inconclusive", async () => {
    const createTaskChat = vi.fn(async () => ({ chatId: "new-chat", messageId: "m1" }));
    localAgentMocks.createSdk.mockImplementation(() => ({
      getChatDetail: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      createTaskChat,
    }));

    await expect(runCreate(["hello", "--to", "someone"])).rejects.toThrow(/Could not determine/);
    expect(createTaskChat).not.toHaveBeenCalled();
    expect(outputMocks.fail).toHaveBeenCalledWith(FEISHU_CHAT_CONTEXT_UNKNOWN_CODE, expect.any(String), 2);
  });

  it("still creates under `--agent <other>` when the session chat is not bridged", async () => {
    const createTaskChat = vi.fn(async () => ({ chatId: "new-chat", messageId: "m1" }));
    const sessionSdk = {
      getChatDetail: vi.fn(async () => ({ externalChannel: null })),
      createTaskChat,
    };
    // The overridden agent is still not a member of the origin chat; its
    // inability to see that chat must not matter to an ordinary create.
    const overriddenSdk = {
      getChatDetail: vi.fn(async () => {
        throw new Error("should never be consulted");
      }),
      createTaskChat,
    };
    localAgentMocks.createSdk.mockImplementation((agentName?: string) =>
      agentName === undefined ? sessionSdk : overriddenSdk,
    );

    await runCreate(["hello", "--to", "someone", "--agent", "other"]);
    expect(createTaskChat).toHaveBeenCalledTimes(1);
    expect(overriddenSdk.getChatDetail).not.toHaveBeenCalled();
    expect(sessionSdk.getChatDetail).toHaveBeenCalledWith("origin-chat");
  });
});
