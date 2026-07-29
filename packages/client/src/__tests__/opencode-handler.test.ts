import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { parseProviderRetryEventMessage } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenCodeConfigContent,
  buildOpenCodeTurnArgs,
  clearOpenCodeDbGateCacheForTests,
  createOpenCodeHandler,
  mapOpenCodeMcpServers,
  projectOpenCodeConfig,
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

function successfulTurn(sessionId = "ses_new", text = "ok"): string {
  return [
    JSON.stringify({ type: "step_start", sessionID: sessionId, part: { sessionID: sessionId } }),
    JSON.stringify({ type: "text", sessionID: sessionId, part: { text } }),
    JSON.stringify({ type: "step_finish", sessionID: sessionId, part: { reason: "stop" } }),
  ].join("\n");
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
  options: { version?: string; turnDelayMs?: number; capturedInputs?: string[] } = {},
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
      if (!isDb && !isVersion && child.stdin && options.capturedInputs) {
        const stdin = child.stdin;
        const write = stdin.write.bind(stdin);
        stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          options.capturedInputs?.push(String(chunk));
          return Reflect.apply(write, stdin, [chunk, ...args]);
        }) as typeof stdin.write;
      }
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      return { child, exited };
    },
  };
}

function createProtocolSupervisor(
  specs: ProviderProcessSpec[],
  turnOutputs: string[],
  capturedInputs: string[] = [],
): ProviderProcessSupervisor {
  let turn = 0;
  return {
    spawn(spec) {
      specs.push(spec);
      const output =
        spec.args[0] === "--version"
          ? "1.18.9\n"
          : spec.args[0] === "db"
            ? '[{"ready":1}]\n'
            : (turnOutputs[turn++] ?? "");
      const child = spawn(
        process.execPath,
        [
          "-e",
          `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(output)}));`,
        ],
        {
          ...spec.options,
          detached: false,
        },
      );
      if (spec.args[0] === "run" && child.stdin) {
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          capturedInputs.push(String(chunk));
          return Reflect.apply(write, child.stdin, [chunk, ...args]);
        }) as typeof child.stdin.write;
      }
      return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
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
    expect(mapOpenCodeMcpServers(config, "scope-a")).toEqual({
      servers: {
        "first-tree-scope-a-mcp-1": { type: "local", command: ["mcp-bin", "--stdio"], enabled: true },
      },
      aliases: [{ configuredName: "repo", managedName: "first-tree-scope-a-mcp-1" }],
    });
    const projected = JSON.parse(
      buildOpenCodeConfigContent({
        payload: config,
        managedAgentName: "first-tree-scope-a",
        scope: "scope-a",
      }),
    );
    expect(projected.agent["first-tree-scope-a"]).toMatchObject({
      mode: "primary",
      model: "openai/gpt-test",
    });
    expect(projected.agent["first-tree-scope-a"].prompt).not.toContain("Current Chat Context");
    expect(projected.mcp).toHaveProperty("first-tree-scope-a-mcp-1");
    expect(
      buildOpenCodeTurnArgs({
        cwd: "/work",
        model: "openai/gpt-test",
        resumeSessionId: "ses_1",
        managedAgentName: "first-tree-scope-a",
      }),
    ).toEqual(
      expect.arrayContaining([
        "run",
        "--format",
        "json",
        "--auto",
        "--agent",
        "first-tree-scope-a",
        "--model",
        "openai/gpt-test",
        "--session",
        "ses_1",
      ]),
    );
  });

  it("moves oversized private config out of the Windows-sensitive environment block and cleans it", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-config-"));
    roots.push(root);
    const projection = projectOpenCodeConfig(
      { BASE: "1", OPENCODE_CONFIG: "/operator/override", OPENCODE_CONFIG_CONTENT: "stale" },
      '{"secret":"value"}',
      {
        maxEnvBytes: 1,
        makeTempDir: () => root,
      },
    );
    expect(projection.transport).toBe("file");
    expect(JSON.parse(String(projection.env.OPENCODE_CONFIG_CONTENT))).toEqual({
      autoupdate: false,
      share: "disabled",
      snapshot: false,
    });
    expect(String(projection.env.OPENCODE_CONFIG_CONTENT)).not.toContain("secret");
    expect(projection.env.OPENCODE_CONFIG).toBe(join(root, "opencode.json"));
    expect(readFileSync(join(root, "opencode.json"), "utf8")).toBe('{"secret":"value"}');
    projection.cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it("fails closed when even the file-backed projection cannot fit a Windows environment block", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-config-overflow-"));
    roots.push(root);
    expect(() =>
      projectOpenCodeConfig({ HUGE: "x".repeat(1_000) }, '{"agent":{}}', {
        platform: "win32",
        maxWindowsEnvChars: 100,
        makeTempDir: () => root,
      }),
    ).toThrow(/exceeds the safe Windows block limit/i);
    expect(existsSync(root)).toBe(false);
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
    expect(String(firstRun?.options.env?.OPENCODE_CONFIG_CONTENT)).toContain('"first-tree-');
    expect(String(firstRun?.options.env?.OPENCODE_CONFIG_CONTENT)).not.toContain("Current Chat Context");
    expect(forwarded.some((text) => text.includes("[From: human]\nfirst prompt"))).toBe(true);
    expect(forwarded[0]).toContain("<first-tree-current-chat-context");
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
    const inputs: string[] = [];
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { turnDelayMs: 100, capturedInputs: inputs }),
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
    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    expect(inputs[0]).toContain("<first-tree-current-chat-context");
    expect(inputs[1]).not.toContain("<first-tree-current-chat-context");
    await handler.shutdown();
  });

  it("fails closed on unknown JSONL even when it carries a valid session id, then preserves one-shot context", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-protocol-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: Array<{ kind?: string; payload?: { message?: string } }> = [];
    const sessionCtx = context(events, []);
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor(
        specs,
        [`${JSON.stringify({ type: "future", sessionID: "ses_new" })}\n`, `${successfulTurn()}\n`],
        inputs,
      ),
    });
    const firstToken = deliveryToken();
    await handler.start(message("m1", "first"), sessionCtx, firstToken);
    expect(firstToken.retry).toHaveBeenCalled();
    expect(firstToken.complete).not.toHaveBeenCalled();
    expect(
      events.some((event) => event.payload?.message && parseProviderRetryEventMessage(event.payload.message)),
    ).toBe(true);
    expect(vi.mocked(sessionCtx.log).mock.calls.flat().join("\n")).not.toContain('"type":"future"');

    const secondToken = deliveryToken();
    expect(handler.inject(message("m2", "second"), secondToken)).toEqual({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalled());
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain("<first-tree-current-chat-context");
    expect(inputs[1]).toContain("<first-tree-current-chat-context");
    await handler.shutdown();
  });

  it("emits a standard terminal provider failure before consuming a credential failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-auth-"));
    roots.push(root);
    const events: Array<{ kind?: string; payload?: { message?: string } }> = [];
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "error",
        sessionID: "ses_new",
        error: { message: "401 Unauthorized: invalid API key" },
      }),
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [`${output}\n`]),
    });
    const token = deliveryToken();
    await handler.start(message("m1", "first"), context(events, []), token);
    const retryPayloads = events
      .map((event) => (event.payload?.message ? parseProviderRetryEventMessage(event.payload.message) : null))
      .filter((value) => value !== null);
    expect(retryPayloads).toContainEqual(
      expect.objectContaining({ event: "provider_failure_terminal", provider: "opencode", category: "credential" }),
    );
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m1" })],
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    await handler.shutdown();
  });

  it("fails closed when OpenCode warns that the managed agent fell back", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-agent-fallback-"));
    roots.push(root);
    const forwarded: string[] = [];
    const output = `agent "first-tree-missing" not found. Falling back to default agent\n${successfulTurn()}\n`;
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [output]),
    });
    const token = deliveryToken();
    await handler.start(message("m1", "first"), context([], forwarded), token);
    expect(forwarded).toEqual([]);
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m1" })],
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    await handler.shutdown();
  });

  it("treats a completed non-read-only tool event as an unsafe replay fence", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-effect-"));
    roots.push(root);
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_new",
        part: {
          id: "tool-1",
          tool: "bash",
          state: { status: "completed", input: { command: "touch effect" }, output: "done" },
        },
      }),
      "not-json",
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [`${output}\n`]),
    });
    const token = deliveryToken();
    await handler.start(message("m1", "first"), context([], []), token);
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m1" })],
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    await handler.shutdown();
  });

  it("serializes one shared data-home DB gate across handler instances", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-db-shared-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const supervisor = createSyntheticSupervisor(specs, { turnDelayMs: 25 });
    const create = () =>
      createOpenCodeHandler({
        workspaceRoot: root,
        runtimeProvider: "opencode",
        agentConfigCache: cache(runtimeConfig()),
        opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
        providerProcessSupervisor: supervisor,
      });
    const left = create();
    const right = create();
    await Promise.all([
      left.start(message("m1", "left"), context([], []), deliveryToken()),
      right.start(message("m2", "right"), context([], []), deliveryToken()),
    ]);
    expect(specs.filter((spec) => spec.args[0] === "db")).toHaveLength(1);
    const agentNames = specs
      .filter((spec) => spec.args[0] === "run")
      .map((spec) => spec.args[spec.args.indexOf("--agent") + 1]);
    expect(new Set(agentNames).size).toBe(2);
    await left.shutdown();
    await right.shutdown();
  });

  it("accepts later compatible 1.x releases", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-version-ok-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { version: "1.18.9" }),
    });

    await expect(handler.start(message("m1", "submitted"), context([], []), deliveryToken())).resolves.toMatchObject({
      sessionId: "ses_new",
    });
    expect(specs.map((spec) => spec.args[0])).toEqual(["--version", "db", "run"]);
    await handler.shutdown();
  });

  it("fails closed through the supervisor before DB or turn launch outside the supported range", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-version-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { version: "2.0.0" }),
    });

    const token = deliveryToken();
    await handler.start(message("m1", "never submitted"), context([], []), token);
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m1" })],
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    expect(specs.map((spec) => spec.args)).toEqual([["--version"]]);
    await handler.shutdown();
  });
});
