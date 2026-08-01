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
import { mockCtxPlumbing } from "./test-helpers.js";

const RPC_CHILD_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const mode = process.env.FT_PI_TEST_MODE ?? "happy";

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

rl.on("line", (line) => {
  const req = JSON.parse(line);
  const id = req.id;
  if (req.command === "get_state") {
    write({ type: "response", id, success: true });
    return;
  }
  if (req.command === "prompt") {
    if (mode === "credential") {
      write({ type: "response", id, success: false, error: "missing credentials" });
      return;
    }
    write({ type: "response", id, success: true });
    write({ type: "message_update", update: { type: "text_delta", delta: "done" } });
    write({ type: "agent_settled", usage: { inputTokens: 1, outputTokens: 1 } });
    return;
  }
  if (req.command === "steer") {
    write({ type: "response", id, success: true });
    return;
  }
  if (req.command === "abort") {
    write({ type: "response", id, success: true });
    write({ type: "agent_settled" });
    return;
  }
  write({ type: "response", id, success: false, error: "unknown" });
});
`;

const VERSION_SCRIPT = `process.stdout.write("pi 0.80.4\\n");`;

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
    complete: async (_messages, outcome) => void completed.push(outcome),
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

function createSyntheticSupervisor(specs: ProviderProcessSpec[]): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const isVersion = spec.args[0] === "--version";
      const child = spawn(process.execPath, ["-e", isVersion ? VERSION_SCRIPT : RPC_CHILD_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FT_PI_TEST_MODE: process.env.FT_PI_TEST_MODE ?? "happy",
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

  it("steers while streaming and queues when a turn is active but not streaming", async () => {
    process.env.FT_PI_TEST_MODE = "streaming";
    const specs: ProviderProcessSpec[] = [];
    const streamingScript = `
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      function write(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
      let streaming = false;
      rl.on("line", (line) => {
        const req = JSON.parse(line);
        const id = req.id;
        if (req.command === "get_state") { write({ type: "response", id, success: true }); return; }
        if (req.command === "prompt") {
          write({ type: "response", id, success: true });
          streaming = true;
          write({ type: "message_update", update: { type: "text_delta", delta: "partial" } });
          setTimeout(() => {
            write({ type: "agent_settled", usage: { inputTokens: 1, outputTokens: 1 } });
            streaming = false;
          }, 80);
          return;
        }
        if (req.command === "steer") { write({ type: "response", id, success: true }); return; }
        write({ type: "response", id, success: false, error: "unknown" });
      });
    `;
    const supervisor: ProviderProcessSupervisor = {
      spawn(spec) {
        specs.push(spec);
        const isVersion = spec.args[0] === "--version";
        const child = spawn(process.execPath, ["-e", isVersion ? VERSION_SCRIPT : streamingScript], {
          ...spec.options,
          detached: false,
        });
        return {
          child,
          exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
        };
      },
    };
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: supervisor,
    });
    const sessionCtx = makeContext([]);
    const startToken = makeToken();
    const startPromise = handler.start(message("m1", "first"), sessionCtx, startToken);
    await vi.waitFor(() => expect(startToken.processingStarted).toHaveBeenCalled());
    const steerReceipt = handler.inject(message("m2", "steer-me"), makeToken());
    expect(steerReceipt).toEqual({ kind: "owned", mode: "processing" });
    await startPromise;
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
});
