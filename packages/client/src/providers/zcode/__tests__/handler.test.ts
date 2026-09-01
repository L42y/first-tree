import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../../../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { clearZcodeAttemptCacheForTests, createZcodeHandler } from "../index.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  clearZcodeAttemptCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    payload: {
      kind: "zcode",
      prompt: { append: "managed prompt" },
      model: "zai/glm-5.3-flash",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      mode: "plan",
    },
    updatedAt: new Date(0).toISOString(),
    updatedBy: "test",
  };
}

function cache(config: AgentRuntimeConfig): AgentConfigCache {
  return {
    get: () => config,
    refresh: async () => config,
    refreshIfNewer: async () => config,
    updateSdk: () => {},
    updateUrls: () => {},
    allReferencedUrls: () => new Set(),
    forget: () => {},
  };
}

function message(id: string, content: string): SessionMessage {
  return {
    inboxEntryId: 1,
    id,
    chatId: "chat-1",
    senderId: "human-1",
    format: "text",
    content,
    metadata: null,
  };
}

function deliveryToken() {
  return {
    processingStarted: vi.fn(),
    complete: vi.fn(async () => {}),
    retry: vi.fn(),
    terminalRejected: vi.fn(async () => {}),
  } satisfies DeliveryToken;
}

function context(events: unknown[], forwarded: string[]): SessionContext {
  return {
    agent: {
      agentId: "agent-1",
      inboxId: "inbox-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: {
      serverUrl: "https://example.test",
      getChatDetail: async () => ({
        id: "chat-1",
        title: "ZCode test",
        topic: null,
        description: null,
      }),
      listChatParticipants: async () => [],
    } as unknown as SessionContext["sdk"],
    log: vi.fn(),
    chatId: "chat-1",
    recordProviderActivity: vi.fn(),
    emitEvent: (event) => events.push(event),
    forwardResult: async (text) => {
      forwarded.push(text);
    },
    markMessagesConsumed: vi.fn(),
    finishTurn: vi.fn(async () => {}),
    retryTurn: vi.fn(),
    failSessionForRecovery: vi.fn(),
    buildAgentEnv: (env) => ({ ...env, FIRST_TREE_AGENT_ID: "agent-1" }),
    formatInboundContent: async (entry) => String(entry.content),
    resolveSenderLabel: async () => "human",
    formatFromHeader: async () => "[From: human]",
    publishTeamSkillCommands: () => {},
  };
}

const TURN_SCRIPT = `
process.stdout.write(Buffer.from(process.env.FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64 ?? "", "base64"));
`;

function turnSupervisor(specs: ProviderProcessSpec[], outputs: string[]): ProviderProcessSupervisor {
  let turn = 0;
  return {
    spawn(spec) {
      specs.push(spec);
      const output = outputs[turn++] ?? "";
      const child = spawn(process.execPath, ["-e", TURN_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from(output, "utf8").toString("base64"),
        },
        detached: false,
      });
      return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
    },
  };
}

describe("ZCode production turn handler", () => {
  it("runs one supervised canonical turn, adopts sess_ identity, and settles delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-handler-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const token = deliveryToken();
    const handler = createZcodeHandler({
      workspaceRoot: root,
      agentName: "zcode-test-agent",
      runtimeProvider: "zcode",
      agentConfigCache: cache(runtimeConfig()),
      zcodeBinaryResolver: () => ({ ok: true, binary: "/host/zcode" }),
      providerProcessSupervisor: turnSupervisor(specs, [
        JSON.stringify({
          sessionId: "sess_confirmed",
          response: "done",
          usage: { inputTokens: 5, cacheReadTokens: 2, outputTokens: 1 },
        }),
      ]),
      zcodeTurnTimeoutMs: 5_000,
    });

    const started = await handler.start(message("m-1", "please plan"), sessionCtx, token);

    expect(started.sessionId).toBe("sess_confirmed");
    expect(specs).toHaveLength(1);
    const spec = specs.at(0);
    if (!spec) throw new Error("expected one ZCode process");
    expect(spec.command).toBe("/host/zcode");
    expect(spec.options.shell).toBe(false);
    expect(spec.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(spec.args.slice(0, 4)).toEqual(["--json", "--no-color", "--mode", "plan"]);
    expect(spec.args).toEqual(expect.arrayContaining(["--cwd", root]));
    const promptIndex = spec.args.indexOf("--prompt");
    const prompt = spec.args[promptIndex + 1];
    expect(prompt).toContain("/model zai/glm-5.3-flash");
    expect(prompt).toContain("please plan");
    expect(spec.args).not.toContain("--resume");
    expect(forwarded).toEqual(["done"]);
    expect(token.complete).toHaveBeenCalledWith([expect.objectContaining({ id: "m-1" })], { status: "success" });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "token_usage",
        payload: expect.objectContaining({
          provider: "zcode",
          model: "zai/glm-5.3-flash",
          inputTokens: 5,
          cachedInputTokens: 2,
          outputTokens: 1,
        }),
      }),
    );
    await handler.shutdown();
  });

  it("refuses configured MCP instead of guessing a headless projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-handler-mcp-"));
    roots.push(root);
    const config = runtimeConfig();
    config.payload = {
      ...config.payload,
      mcpServers: [{ name: "repo", transport: "stdio", command: "mcp-bin" }],
    };
    const specs: ProviderProcessSpec[] = [];
    const sessionCtx = context([], []);
    const token = deliveryToken();
    const handler = createZcodeHandler({
      workspaceRoot: root,
      agentName: "zcode-test-agent",
      runtimeProvider: "zcode",
      agentConfigCache: cache(config),
      zcodeBinaryResolver: () => ({ ok: true, binary: "/host/zcode" }),
      providerProcessSupervisor: turnSupervisor(specs, []),
      zcodeTurnTimeoutMs: 5_000,
    });

    await expect(handler.start(message("m-mcp", "use MCP"), sessionCtx, token)).rejects.toThrow(
      /safe non-interactive MCP projection contract/,
    );
    expect(specs).toEqual([]);
    expect(token.processingStarted).not.toHaveBeenCalled();
  });
});
