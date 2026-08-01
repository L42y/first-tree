import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiHandler, stablePiSessionId } from "../handlers/pi/index.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../runtime/provider-process-supervisor.js";
import { readSessionBriefingFingerprint } from "../runtime/session-briefing-fingerprint.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const RPC_CHILD_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const mode = process.env.FT_PI_TEST_MODE ?? "happy";
const expectedSessionId = process.env.FT_PI_EXPECTED_SESSION_ID ?? "";

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function assistantMessage(text, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "openai-codex",
    model: "gpt-test",
    usage: { input: 11, output: 5, cacheRead: 2, cacheWrite: 0 },
    stopReason,
  };
}

rl.on("line", (line) => {
  const req = JSON.parse(line);
  const id = req.id;
  const command = req.type;
  if (command === "get_state") {
    write({
      type: "response",
      id,
      command: "get_state",
      success: true,
      data: { sessionId: expectedSessionId, isStreaming: false, messageCount: 0 },
    });
    return;
  }
  if (command === "prompt") {
    if (mode === "credential") {
      write({ type: "response", id, command: "prompt", success: false, error: "missing credentials" });
      return;
    }
    write({ type: "response", id, command: "prompt", success: true });
    if (mode === "accepted_error") {
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "error", reason: "error" },
      });
      write({ type: "message_end", message: assistantMessage("", "error") });
      write({ type: "auto_retry_end", success: false, attempt: 1, finalError: "provider overloaded" });
      write({ type: "agent_settled" });
      return;
    }
    if (mode === "settlement_timeout") {
      return;
    }
    write({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" },
    });
    write({ type: "message_end", message: assistantMessage("done") });
    if (mode === "abort_settled_first") {
      write({ type: "agent_settled" });
      return;
    }
    if (mode === "streaming") {
      setTimeout(() => write({ type: "agent_settled" }), 120);
      return;
    }
    write({ type: "agent_settled" });
    return;
  }
  if (command === "steer") {
    write({ type: "response", id, command: "steer", success: true });
    return;
  }
  if (command === "abort") {
    if (mode === "abort_settled_first") {
      setTimeout(() => write({ type: "response", id, command: "abort", success: true }), 30);
      return;
    }
    write({ type: "response", id, command: "abort", success: true });
    write({ type: "agent_settled" });
    return;
  }
  write({ type: "response", id, command: command ?? "unknown", success: false, error: "unknown" });
});
`;

const VERSION_SCRIPT = `process.stdout.write("pi 0.80.5\\n");`;
const VERSION_HANG_SCRIPT = `setInterval(() => {}, 1000);`;

let workspaceRoot: string;
const roots: string[] = [];

function runtimeConfig(mcp = false): AgentRuntimeConfig {
  return {
    agentId: "agent-pi",
    version: 1,
    payload: {
      kind: "pi",
      prompt: { append: "" },
      model: "",
      mcpServers: mcp ? [{ name: "repo", transport: "stdio", command: "mcp-bin", args: ["--stdio"] }] : [],
      env: [],
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
    chatId: "chat-pi",
    senderId: "human-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeToken(): DeliveryToken & {
  processingStarted: ReturnType<typeof vi.fn>;
  completed: unknown[];
  retried: string[];
} {
  const completed: unknown[] = [];
  const retried: string[] = [];
  const processingStarted = vi.fn();
  return {
    processingStarted,
    completed,
    retried,
    complete: async (_messages, outcome) => {
      completed.push(outcome);
      return "settled";
    },
    retry: (_messages, reason) => void retried.push(reason),
    terminalRejected: vi.fn(async () => {}),
  };
}

function makeContext(events: SessionEvent[]): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: "agent-pi",
      inboxId: "inbox-pi",
      displayName: "pi-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-pi",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: (value) => void events.push(value),
    ...mockCtxPlumbing({ sendMessage }, "chat-pi"),
  };
}

function createSyntheticSupervisor(
  specs: ProviderProcessSpec[],
  options?: { hangVersion?: boolean },
): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const isVersion = spec.args[0] === "--version";
      const sessionIdArgIndex = spec.args.indexOf("--session-id");
      const expectedSessionId = sessionIdArgIndex >= 0 ? String(spec.args[sessionIdArgIndex + 1] ?? "") : "";
      const script = isVersion ? (options?.hangVersion ? VERSION_HANG_SCRIPT : VERSION_SCRIPT) : RPC_CHILD_SCRIPT;
      const child = spawn(process.execPath, ["-e", script], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FT_PI_TEST_MODE: process.env.FT_PI_TEST_MODE ?? "happy",
          FT_PI_EXPECTED_SESSION_ID: expectedSessionId,
        },
        detached: false,
      });
      return {
        child,
        exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
      };
    },
  };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "pi-handler-test-"));
  roots.push(workspaceRoot);
  delete process.env.FT_PI_TEST_MODE;
});

afterEach(() => {
  delete process.env.FT_PI_TEST_MODE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi handler", () => {
  it("uses a stable session id and skills path in rpc args", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const events: SessionEvent[] = [];
    const token = makeToken();
    const expectedId = stablePiSessionId("agent-pi", "chat-pi");
    const result = await handler.start(message("m1", "work"), makeContext(events), token);

    expect(result).toMatchObject({ sessionId: expectedId, route: { kind: "owned", mode: "processing" } });
    expect(expectedId).toBe(createHash("sha256").update("first-tree:agent-pi:chat-pi").digest("hex").slice(0, 32));
    const rpcSpec = specs.find((spec) => spec.args.includes("--mode"));
    expect(rpcSpec?.args).toEqual(
      expect.arrayContaining(["--skill", join(workspaceRoot, ".agents", "skills"), "--session-id", expectedId]),
    );
    expect(token.processingStarted).toHaveBeenCalled();
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "success" } });
    expect(events.filter((event) => event.kind === "assistant_text")).toEqual([
      { kind: "assistant_text", payload: { text: "done" } },
    ]);
    expect(events).toContainEqual({
      kind: "token_usage",
      payload: {
        provider: "openai-codex",
        model: "gpt-test",
        inputTokens: 11,
        cachedInputTokens: 2,
        outputTokens: 5,
      },
    });
    await handler.shutdown();
  });

  it("rejects MCP configuration before launching pi", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig(true)),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const token = makeToken();
    await expect(handler.start(message("m1", "work"), makeContext([]), token)).rejects.toThrow(
      "managed MCP servers are not supported",
    );
    expect(specs.filter((spec) => spec.args.includes("--mode"))).toHaveLength(0);
  });

  it("terminates credential preflight without waiting for agent_settled", async () => {
    process.env.FT_PI_TEST_MODE = "credential";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const events: SessionEvent[] = [];
    const token = makeToken();
    await handler.start(message("m1", "work"), makeContext(events), token);
    expect(token.processingStarted).not.toHaveBeenCalled();
    expect(token.completed).toEqual([expect.objectContaining({ status: "error", completion: "consumed" })]);
    expect(events.some((event) => event.kind === "turn_end" && event.payload?.status === "success")).toBe(false);
    await handler.shutdown();
  });

  it("does not report accepted-turn failures as success", async () => {
    process.env.FT_PI_TEST_MODE = "accepted_error";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const events: SessionEvent[] = [];
    const token = makeToken();
    await handler.start(message("m1", "work"), makeContext(events), token);
    expect(token.completed).toEqual([expect.objectContaining({ status: "error", completion: "consumed" })]);
    expect(events.some((event) => event.kind === "turn_end" && event.payload?.status === "success")).toBe(false);
    await handler.shutdown();
  });

  it("fails closed on mismatched resume session id", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    await expect(handler.resume(undefined, "not-the-stable-id", makeContext([]))).rejects.toThrow(
      /resume session identity mismatch/,
    );
  });

  it("does not write briefing fingerprint when the turn fails", async () => {
    process.env.FT_PI_TEST_MODE = "credential";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const expectedId = stablePiSessionId("agent-pi", "chat-pi");
    await handler.start(message("m1", "work"), makeContext([]), makeToken());
    expect(readSessionBriefingFingerprint(workspaceRoot, expectedId)).toBeNull();
    await handler.shutdown();
  });

  it("surfaces version-gate supervisor timeout as transient", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { hangVersion: true }),
      piVersionGateTimeoutMs: 40,
    });
    const token = makeToken();
    await expect(handler.start(message("m1", "work"), makeContext([]), token)).rejects.toThrow(/timed out/);
    expect(token.retried).toContain("pi_version_gate_transient");
  });

  it("latches abort whether agent_settled arrives before or after the abort response", async () => {
    process.env.FT_PI_TEST_MODE = "abort_settled_first";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      piSettlementTimeoutMs: 500,
    });
    const startToken = makeToken();
    const startPromise = handler.start(message("m1", "first"), makeContext([]), startToken);
    await vi.waitFor(() => expect(startToken.processingStarted).toHaveBeenCalled());
    await expect(handler.shutdown()).resolves.toBeUndefined();
    await startPromise;
  });

  it("completes steered custody on agent_settled", async () => {
    process.env.FT_PI_TEST_MODE = "streaming";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const sessionCtx = makeContext([]);
    const startToken = makeToken();
    const steerToken = makeToken();
    const startPromise = handler.start(message("m1", "first"), sessionCtx, startToken);
    await vi.waitFor(() => expect(startToken.processingStarted).toHaveBeenCalled());
    const steerReceipt = handler.inject(message("m2", "steer-me"), steerToken);
    expect(steerReceipt).toEqual({ kind: "owned", mode: "processing" });
    await startPromise;
    await vi.waitFor(() => expect(steerToken.processingStarted).toHaveBeenCalled());
    await vi.waitFor(() => expect(steerToken.completed.length).toBe(1));
    expect(startToken.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(steerToken.completed).toEqual([expect.objectContaining({ status: "success" })]);
    await handler.shutdown();
  });

  it("queues injects when no turn is streaming", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const sessionCtx = makeContext([]);
    await handler.resume(undefined, stablePiSessionId("agent-pi", "chat-pi"), sessionCtx);
    const receipt = handler.inject(message("m-queue", "queued"), makeToken());
    expect(receipt).toEqual({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => expect(specs.some((spec) => spec.args.includes("--mode"))).toBe(true));
    await handler.shutdown();
  });

  it("writes briefing fingerprint only after a successful delivery", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const expectedId = stablePiSessionId("agent-pi", "chat-pi");
    await handler.start(message("m1", "work"), makeContext([]), makeToken());
    expect(readSessionBriefingFingerprint(workspaceRoot, expectedId)).toBeTypeOf("string");
    await handler.shutdown();
  });
});
