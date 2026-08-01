import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, SessionEvent } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiHandler, stablePiSessionId } from "../handlers/pi/index.js";
import { buildPiRpcArgs, PiRpcClient } from "../handlers/pi/rpc-client.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
import type { ProviderProcessSupervisor } from "../runtime/provider-process-supervisor.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const runHostSmoke = process.env.FT_PI_HOST_SMOKE === "1";

function hostSupervisor(): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      const child = spawn(spec.command, [...spec.args], {
        ...spec.options,
        detached: false,
      });
      return {
        child,
        exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
      };
    },
  };
}

function runtimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-pi-smoke",
    version: 1,
    payload: {
      kind: "pi",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
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

function message(content: string): SessionMessage {
  return {
    inboxEntryId: 1,
    id: "m-smoke",
    chatId: "chat-pi-smoke",
    senderId: "human-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeToken(): DeliveryToken & { completed: unknown[] } {
  const completed: unknown[] = [];
  return {
    completed,
    processingStarted: vi.fn(),
    complete: async (_messages, outcome) => {
      completed.push(outcome);
      return "settled";
    },
    retry: vi.fn(),
    terminalRejected: vi.fn(async () => {}),
  };
}

function makeContext(events: SessionEvent[]): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: "agent-pi-smoke",
      inboxId: "inbox-pi-smoke",
      displayName: "pi-smoke",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-pi-smoke",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: (value) => void events.push(value),
    ...mockCtxPlumbing({ sendMessage }, "chat-pi-smoke"),
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(runHostSmoke)("Pi host smoke (real 0.83.x)", () => {
  it("correlates command responses, streams text once, normalizes usage, settles, exits cleanly", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "ft-pi-host-smoke-"));
    roots.push(sessionDir);
    const sessionId = `ftsmoke${Date.now().toString(16)}`.slice(0, 32);
    const events: string[] = [];
    let assistantText = "";
    let usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;

    const client = await PiRpcClient.start({
      binary: process.env.PI_BIN ?? "pi",
      args: buildPiRpcArgs({
        sessionId,
        sessionDir,
        skillsDir: join(sessionDir, "skills"),
      }),
      cwd: sessionDir,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
      supervisor: hostSupervisor(),
      settlementTimeoutMs: 180_000,
      onEvent(event) {
        events.push(String(event.type));
        if (event.type === "message_update") {
          const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (ame?.type === "text_delta" && typeof ame.delta === "string") {
            assistantText += ame.delta;
          }
        }
        if (event.type === "message_end" || event.type === "turn_end") {
          const messagePayload = event.message as
            | { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } }
            | undefined;
          if (messagePayload?.role === "assistant" && messagePayload.usage) {
            usage = {
              inputTokens: messagePayload.usage.input ?? 0,
              cachedInputTokens: messagePayload.usage.cacheRead ?? 0,
              outputTokens: messagePayload.usage.output ?? 0,
            };
          }
        }
      },
    });

    const state = await client.getState();
    expect(state.command).toBe("get_state");
    expect(state.success).toBe(true);
    expect((state.data as { sessionId?: string } | undefined)?.sessionId).toBe(sessionId);

    const prompt = await client.prompt("Reply with exactly: FT_PI_SMOKE_OK");
    expect(prompt.command).toBe("prompt");
    expect(prompt.success).toBe(true);

    await client.waitForSettled();
    expect(events).toContain("agent_settled");
    expect(assistantText.length).toBeGreaterThan(0);
    expect(events.filter((type) => type === "message_update").length).toBeGreaterThan(0);
    if (!usage) throw new Error("expected normalized usage from assistant message");
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(0);

    await client.close();
    expect(client.isClosed).toBe(true);
  }, 240_000);

  it("runs a full First Tree product-path local turn through createPiHandler", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-pi-handler-smoke-"));
    roots.push(workspaceRoot);
    const events: SessionEvent[] = [];
    const token = makeToken();
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: process.env.PI_BIN ?? "pi" }),
      providerProcessSupervisor: hostSupervisor(),
      piSettlementTimeoutMs: 180_000,
    });

    const result = await handler.start(
      message("Reply with exactly: FT_PI_HANDLER_SMOKE_OK"),
      makeContext(events),
      token,
    );
    expect(result).toMatchObject({
      sessionId: stablePiSessionId("agent-pi-smoke", "chat-pi-smoke"),
      route: { kind: "owned", mode: "processing" },
    });
    expect(token.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(events.some((event) => event.kind === "assistant_text")).toBe(true);
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "success" } });
    await handler.shutdown();
  }, 240_000);
});
