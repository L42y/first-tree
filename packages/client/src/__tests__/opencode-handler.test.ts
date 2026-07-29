import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenCodeConfigContent,
  buildOpenCodeTurnArgs,
  clearOpenCodeDbGateCacheForTests,
  createOpenCodeHandler,
  mapOpenCodeMcpServers,
} from "../handlers/opencode/index.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../runtime/provider-process-supervisor.js";

const roots: string[] = [];

afterEach(() => {
  clearOpenCodeDbGateCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    payload: {
      kind: "opencode",
      prompt: { append: "managed prompt" },
      model: "openai/gpt-test",
      mcpServers: [{ name: "repo", transport: "stdio", command: "mcp-bin", args: ["--stdio"] }],
      env: [{ key: "PROVIDER_ENV", value: "local", sensitive: true }],
      gitRepos: [],
      resourceSkills: [],
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

function createSyntheticSupervisor(
  specs: ProviderProcessSpec[],
  options: { version?: string; turnDelayMs?: number } = {},
): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const isDb = spec.args[0] === "db";
      const isVersion = spec.args[0] === "--version";
      const resumed = spec.args.includes("--session") ? spec.args[spec.args.indexOf("--session") + 1] : "ses_new";
      const script = isVersion
        ? `process.stdout.write(${JSON.stringify(`${options.version ?? "1.18.7"}\n`)})`
        : isDb
          ? "process.stdout.write('[{\"ready\":1}]\\n')"
          : `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  setTimeout(() => {
    const sid = ${JSON.stringify(resumed)};
    process.stdout.write(JSON.stringify({type:"step_start",sessionID:sid,part:{sessionID:sid}}) + "\\n");
    process.stdout.write(JSON.stringify({type:"text",sessionID:sid,part:{text:input.trim()}}) + "\\n");
    process.stdout.write(JSON.stringify({type:"step_finish",sessionID:sid,part:{reason:"stop",tokens:{input:3,output:2}}}) + "\\n");
  }, ${JSON.stringify(options.turnDelayMs ?? 0)});
});
`;
      const child = spawn(process.execPath, ["-e", script], {
        ...spec.options,
        detached: false,
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      return { child, exited };
    },
  };
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
        title: "OpenCode test",
        topic: "OpenCode",
        description: null,
      }),
      listChatParticipants: async () => [
        {
          agentId: "human-1",
          name: "human",
          displayName: "Human",
          type: "human",
          role: "member",
          mode: "default",
          accessMode: "speaker",
        },
      ],
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
    buildAgentEnv: (env) => ({
      ...env,
      FIRST_TREE_AGENT_ID: "agent-1",
      FIRST_TREE_CHAT_ID: "chat-1",
      FIRST_TREE_PROVIDER: "opencode",
      FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: "/private/token",
    }),
    formatInboundContent: async (entry) => `[From: human]\n${String(entry.content)}`,
    resolveSenderLabel: async () => "human",
    formatFromHeader: async () => "[From: human]",
  };
}

describe("OpenCode V1 handler", () => {
  it("builds private MCP/agent config and provider-native argv", () => {
    const config = runtimeConfig().payload;
    expect(mapOpenCodeMcpServers(config)).toEqual({
      repo: { type: "local", command: ["mcp-bin", "--stdio"], enabled: true },
    });
    const projected = JSON.parse(buildOpenCodeConfigContent({ payload: config, standingPrompt: "standing" }));
    expect(projected.agent["first-tree"]).toMatchObject({
      mode: "primary",
      prompt: "standing",
      model: "openai/gpt-test",
    });
    expect(buildOpenCodeTurnArgs({ cwd: "/work", model: "openai/gpt-test", resumeSessionId: "ses_1" })).toEqual(
      expect.arrayContaining([
        "run",
        "--format",
        "json",
        "--auto",
        "--agent",
        "first-tree",
        "--model",
        "openai/gpt-test",
        "--session",
        "ses_1",
      ]),
    );
  });

  it("serializes DB readiness, sends prompt only on stdin, and resumes the confirmed session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-handler-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const cfg = runtimeConfig();
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(cfg),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      opencodeTurnTimeoutMs: 5_000,
    });

    const firstToken = deliveryToken();
    const started = await handler.start(message("m1", "first prompt"), sessionCtx, firstToken);
    expect(started).toMatchObject({ sessionId: "ses_new", route: { kind: "owned", mode: "processing" } });
    expect(specs.map((spec) => spec.args[0])).toEqual(["--version", "db", "run"]);
    const firstRun = specs[2];
    expect(firstRun?.args).not.toContain("first prompt");
    expect(firstRun?.options.env).toMatchObject({
      FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: "/private/token",
      PROVIDER_ENV: "local",
    });
    expect(String(firstRun?.options.env?.OPENCODE_CONFIG_CONTENT)).toContain('"first-tree"');
    expect(forwarded).toContain("[From: human]\nfirst prompt");
    expect(firstToken.complete).toHaveBeenCalledWith([expect.objectContaining({ id: "m1" })], {
      status: "success",
    });

    await handler.suspend();
    const secondToken = deliveryToken();
    await handler.resume(message("m2", "second prompt"), "ses_new", sessionCtx, secondToken);
    const secondRun = specs.at(-1);
    expect(secondRun?.args).toEqual(expect.arrayContaining(["--session", "ses_new"]));
    expect(specs.filter((spec) => spec.args[0] === "db")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "token_usage" }));
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "success" } });
    await handler.shutdown();
  });

  it("queues active injects instead of steering the current process", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-queue-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { turnDelayMs: 100 }),
    });
    const sessionCtx = context([], []);
    const startPromise = handler.start(message("m1", "first"), sessionCtx, deliveryToken());
    await vi.waitFor(() => {
      expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(1);
    });
    const receipt = handler.inject(message("m2", "queued"), deliveryToken());
    expect(receipt).toEqual({ kind: "owned", mode: "queued" });
    expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(1);
    await startPromise;
    await vi.waitFor(() => {
      expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(2);
    });
    await handler.shutdown();
  });

  it("fails closed through the supervisor before DB or turn launch on a version mismatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-version-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { version: "1.18.8" }),
    });

    await expect(handler.start(message("m1", "never submitted"), context([], []), deliveryToken())).rejects.toThrow(
      /requires opencode-ai@1\.18\.7.*observed 1\.18\.8/i,
    );
    expect(specs.map((spec) => spec.args)).toEqual([["--version"]]);
    await handler.shutdown();
  });
});
