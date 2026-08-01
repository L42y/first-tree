import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, SessionEvent } from "@first-tree/shared";
import { encodeProviderRetryEventMessage, RUNTIME_NOTICE_METADATA_KEY } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiHandler, type PiRetrySleep } from "../handlers/pi/index.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { AgentHandler } from "../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../runtime/provider-process-supervisor.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

function mockAckEntry() {
  return vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
}

const RPC_CHILD_SCRIPT = `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const mode = process.env.FT_PI_TEST_MODE ?? "happy";
const expectedSessionId = process.env.FT_PI_EXPECTED_SESSION_ID ?? "";
const promptCountFile = process.env.FT_PI_PROMPT_COUNT_FILE ?? "";
const bashStartFile = process.env.FT_PI_BASH_START_FILE ?? "";
const bashStartCountFile = process.env.FT_PI_BASH_START_COUNT_FILE ?? "";

function bump(file) {
  if (!file) return;
  let n = 0;
  try { n = Number(fs.readFileSync(file, "utf8")) || 0; } catch {}
  fs.writeFileSync(file, String(n + 1));
}
function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
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
    bump(promptCountFile);
    if (mode === "preflight_capacity") {
      write({ type: "response", id, command: "prompt", success: false, error: "provider overloaded" });
      return;
    }
    if (mode === "exhausted_retry") {
      write({ type: "response", id, command: "prompt", success: true });
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "error",
          error: { role: "assistant", errorMessage: "temporary provider blip", stopReason: "error" },
        },
      });
      write({ type: "auto_retry_end", success: false, attempt: 1, finalError: "provider overloaded" });
      write({ type: "agent_settled" });
      return;
    }
    if (mode === "bash_hold_until_abort") {
      write({ type: "response", id, command: "prompt", success: true });
      write({
        type: "tool_execution_start",
        toolCallId: "bash-hold-1",
        toolName: "bash",
        args: { command: "sleep 60" },
      });
      bump(bashStartCountFile);
      if (bashStartFile) {
        try { fs.writeFileSync(bashStartFile, "1"); } catch {}
      }
      return;
    }
    // Prompt line written; response withheld; unsafe tool may still start.
    if (mode === "prompt_write_tool_no_response") {
      write({
        type: "tool_execution_start",
        toolCallId: "bash-hold-1",
        toolName: "bash",
        args: { command: "sleep 60" },
      });
      bump(bashStartCountFile);
      if (bashStartFile) {
        try { fs.writeFileSync(bashStartFile, "1"); } catch {}
      }
      return;
    }
    // Prompt accepted; no first stream event / settlement.
    if (mode === "prompt_accepted_no_events") {
      write({ type: "response", id, command: "prompt", success: true });
      if (bashStartFile) {
        try { fs.writeFileSync(bashStartFile, "1"); } catch {}
      }
      return;
    }
    write({ type: "response", id, command: "prompt", success: true });
    write({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
    });
    write({ type: "agent_settled" });
    return;
  }
  if (command === "abort") {
    if (mode === "bash_hold_until_abort" || mode === "prompt_write_tool_no_response") {
      write({ type: "tool_execution_end", toolCallId: "bash-hold-1", isError: true, result: "aborted" });
      write({ type: "agent_settled" });
      write({ type: "response", id, command: "abort", success: true });
      return;
    }
    if (mode === "prompt_accepted_no_events") {
      write({ type: "agent_settled" });
      write({ type: "response", id, command: "abort", success: true });
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

const roots: string[] = [];
let workspaceRoot = "";
let promptCountFile = "";
let bashStartFile = "";
let bashStartCountFile = "";

function runtimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
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

function createSyntheticSupervisor(specs: ProviderProcessSpec[]): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const isVersion = spec.args[0] === "--version";
      const sessionIdArgIndex = spec.args.indexOf("--session-id");
      const expectedSessionId = sessionIdArgIndex >= 0 ? String(spec.args[sessionIdArgIndex + 1] ?? "") : "";
      const child = spawn(process.execPath, ["-e", isVersion ? VERSION_SCRIPT : RPC_CHILD_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FT_PI_TEST_MODE: process.env.FT_PI_TEST_MODE ?? "happy",
          FT_PI_EXPECTED_SESSION_ID: expectedSessionId,
          FT_PI_PROMPT_COUNT_FILE: promptCountFile,
          FT_PI_BASH_START_FILE: bashStartFile,
          FT_PI_BASH_START_COUNT_FILE: bashStartCountFile,
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
  workspaceRoot = mkdtempSync(join(tmpdir(), "pi-session-custody-"));
  roots.push(workspaceRoot);
  promptCountFile = join(workspaceRoot, "prompt-count.txt");
  bashStartFile = join(workspaceRoot, "bash-start.txt");
  bashStartCountFile = join(workspaceRoot, "bash-start-count.txt");
  writeFileSync(promptCountFile, "0");
  writeFileSync(bashStartFile, "0");
  writeFileSync(bashStartCountFile, "0");
  delete process.env.FT_PI_TEST_MODE;
});

afterEach(() => {
  delete process.env.FT_PI_TEST_MODE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi handler → SessionManager custody", () => {
  it("posts durable exhausted-retry notice before ACK with a single prompt write", async () => {
    process.env.FT_PI_TEST_MODE = "exhausted_retry";
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-pi" });
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      getChatContext: vi.fn().mockResolvedValue(null),
    } as unknown as FirstTreeHubSDK;

    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });

    const sm = new SessionManager({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () => handler,
      handlerConfig: { workspaceRoot, runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry,
      agentConfigCache: cache(runtimeConfig()),
    });

    await sm.dispatch(mockEntry({ id: 77, chatId: "chat-pi-exhausted", messageId: "msg-pi-exhausted", content: "go" }));

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "chat-pi-exhausted",
      expect.objectContaining({
        source: "api",
        format: "text",
        metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true },
        purpose: "agent-final-text",
      }),
    );
    const notice = String(sendMessage.mock.calls[0]?.[1].content);
    expect(notice).toContain("Pi could not run this turn");
    expect(notice).not.toContain("provider overloaded");
    expect(notice).not.toContain("temporary provider blip");
    expect(ackEntry).toHaveBeenCalledWith(77);
    const noticeOrder = sendMessage.mock.invocationCallOrder[0];
    const ackOrder = ackEntry.mock.invocationCallOrder[0];
    expect(noticeOrder).toBeTypeOf("number");
    expect(ackOrder).toBeTypeOf("number");
    expect(noticeOrder as number).toBeLessThan(ackOrder as number);

    await sm.shutdown();
  });

  function makePiSessionManager(input: {
    specs: ProviderProcessSpec[];
    ackEntry: ReturnType<typeof mockAckEntry>;
    sendMessage: ReturnType<typeof vi.fn>;
    onHandler?: (handler: ReturnType<typeof createPiHandler>) => void;
    recoverChat?: (chatId: string) => Promise<void>;
  }): SessionManager {
    const sdk = {
      register: vi.fn(),
      sendMessage: input.sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      getChatContext: vi.fn().mockResolvedValue(null),
    } as unknown as FirstTreeHubSDK;
    return new SessionManager({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () => {
        const handler = createPiHandler({
          workspaceRoot,
          runtimeProvider: "pi",
          agentConfigCache: cache(runtimeConfig()),
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(input.specs),
        });
        input.onHandler?.(handler);
        return handler;
      },
      handlerConfig: { workspaceRoot, runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry: input.ackEntry,
      ...(input.recoverChat ? { recoverChat: input.recoverChat } : {}),
      agentConfigCache: cache(runtimeConfig()),
    });
  }

  it.each([
    ["agent_runtime_switch"],
    ["runtime switched by server"],
    ["operator stop"],
  ] as const)("graceful manager shutdown reason %s settles accepted bash once without start adoption", async (shutdownReason) => {
    process.env.FT_PI_TEST_MODE = "bash_hold_until_abort";
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-shutdown" });
    const shutdownCalls: Array<{ reason?: string; opts?: { settleProviderEntered?: boolean } }> = [];

    const sm = makePiSessionManager({
      specs,
      ackEntry,
      sendMessage,
      onHandler: (handler) => {
        const original = handler.shutdown.bind(handler);
        handler.shutdown = async (reason, opts) => {
          shutdownCalls.push({ reason, opts });
          return original(reason, opts);
        };
      },
    });

    const entry = mockEntry({
      id: 88,
      chatId: "chat-pi-shutdown-replay",
      messageId: "msg-pi-shutdown-replay",
      content: "run sleep 60",
    });
    const dispatchPromise = sm.dispatch(entry);
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);

    await sm.shutdown(shutdownReason);
    await dispatchPromise;

    // Full manager drain settles explicitly; a later stale-start discard may
    // retire the same handler without settleProviderEntered (ACK-none path).
    expect(shutdownCalls[0]).toEqual({
      reason: shutdownReason,
      opts: { settleProviderEntered: true },
    });
    expect(shutdownCalls.filter((call) => call.opts?.settleProviderEntered === true)).toHaveLength(1);
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(88);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const noticeOrder = sendMessage.mock.invocationCallOrder[0];
    const ackOrder = ackEntry.mock.invocationCallOrder[0];
    expect(noticeOrder as number).toBeLessThan(ackOrder as number);
    // Deferred start receipt must not adopt/resurrect after manager drain.
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("deferred resume race: manager shutdown settles accepted token without resume adoption", async () => {
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-resume" });
    const sm = makePiSessionManager({ specs, ackEntry, sendMessage });

    await sm.dispatch(mockEntry({ id: 70, chatId: "chat-pi-resume-race", messageId: "msg-first", content: "first" }));
    expect(ackEntry).toHaveBeenCalledWith(70);
    await sm.handleCommand("chat-pi-resume-race", "session:suspend");

    process.env.FT_PI_TEST_MODE = "bash_hold_until_abort";
    writeFileSync(bashStartFile, "0");
    writeFileSync(bashStartCountFile, "0");
    const promptsBeforeResume = Number(readFileSync(promptCountFile, "utf8")) || 0;

    const resumePromise = sm.dispatch(
      mockEntry({ id: 71, chatId: "chat-pi-resume-race", messageId: "msg-resume", content: "run sleep" }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeResume + 1);

    await sm.shutdown("client_switch_interrupted");
    await resumePromise;

    expect(ackEntry).toHaveBeenCalledWith(71);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 71)).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const noticeOrder = sendMessage.mock.invocationCallOrder[0];
    const ack71Index = ackEntry.mock.calls.findIndex((call) => call[0] === 71);
    const ack71Order = ackEntry.mock.invocationCallOrder[ack71Index];
    expect(noticeOrder as number).toBeLessThan(ack71Order as number);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("graceful manager shutdown during pre-provider prompt rejection leaves zero ACK and no prompt write", async () => {
    process.env.FT_PI_TEST_MODE = "preflight_capacity";
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-unused" });
    const sdk = {
      register: vi.fn(),
      sendMessage,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      getChatContext: vi.fn().mockResolvedValue(null),
    } as unknown as FirstTreeHubSDK;

    let pendingSleep: { resolve: (value: boolean) => void } | null = null;
    const gatedSleep: PiRetrySleep = async (_delayMs, signal) => {
      if (signal.aborted) return false;
      return await new Promise<boolean>((resolve) => {
        const onAbort = () => {
          pendingSleep = null;
          resolve(false);
        };
        pendingSleep = { resolve };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const sm = new SessionManager({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        createPiHandler({
          workspaceRoot,
          runtimeProvider: "pi",
          agentConfigCache: cache(runtimeConfig()),
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(specs),
          piRetrySleep: gatedSleep,
        }),
      handlerConfig: { workspaceRoot, runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry,
      agentConfigCache: cache(runtimeConfig()),
    });

    const entry = mockEntry({
      id: 91,
      chatId: "chat-pi-preprovider",
      messageId: "msg-pi-preprovider",
      content: "blocked",
    });
    const dispatchPromise = sm.dispatch(entry);
    await vi.waitFor(() => expect(pendingSleep).not.toBeNull());
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
    await dispatchPromise;

    expect(ackEntry).not.toHaveBeenCalled();
    // Prompt was attempted once before preflight rejection; shutdown must not
    // invent a second provider write while leaving custody recoverable.
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(pendingSleep).toBeNull();
  });

  it("deferred start after shutdown rejects non-terminal ctx mutations while notice-before-ACK settles", async () => {
    let releaseStart: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    let inFlightStart: Promise<void> | null = null;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const sessionEvents: SessionEvent[] = [];
    const registryPath = join(workspaceRoot, "sessions-deferred.json");
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-deferred" });
    const forwardCalls: string[] = [];
    const mutationCalls: string[] = [];

    const deferredHandler: AgentHandler = {
      start: async (message, ctx, token) => {
        let resolveInFlight: (() => void) | undefined;
        inFlightStart = new Promise<void>((resolve) => {
          resolveInFlight = resolve;
        });
        try {
          signalStarted?.();
          await gate;
          // Shutdown fence is up — these mutations must be rejected / no-ops.
          ctx.replaceSessionId?.("should-not-persist", "deferred_probe");
          mutationCalls.push("replaceSessionId");
          ctx.failSessionForRecovery?.("deferred_probe", "should-not-persist");
          mutationCalls.push("failSessionForRecovery");
          ctx.retryTurn(message, "deferred_probe_retry");
          mutationCalls.push("retryTurn");
          ctx.markMessagesConsumed(message);
          mutationCalls.push("markMessagesConsumed");
          ctx.recordProviderActivity();
          mutationCalls.push("recordProviderActivity");
          await ctx.forwardResult("deferred probe forward");
          forwardCalls.push("forwardResult");
          ctx.emitEvent({ kind: "assistant_text", payload: { text: "deferred probe" } });
          mutationCalls.push("assistant_text");
          ctx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          mutationCalls.push("turn_end");

          // Narrow drain path: terminal provider-failure event + token settle.
          ctx.emitEvent({
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_failure_terminal",
                provider: "pi",
                scope: "provider_turn",
                category: "unknown",
                reasonCode: "unsafe_replay",
                replaySafety: "unsafe",
                userSeverity: "error",
                messagePreview: "deferred drain settle",
              }),
            },
          });
          if (!token) throw new Error("expected delivery token");
          await token.complete([message], {
            status: "error",
            completion: "consumed",
            reason: "unsafe_replay",
          });
          return { sessionId: "should-not-adopt", route: { kind: "owned", mode: "processing" } };
        } finally {
          resolveInFlight?.();
        }
      },
      resume: async () => ({ sessionId: "unused", route: null }),
      inject: () => ({ kind: "rejected", reason: "no_active_context", retryable: true }),
      suspend: async () => {},
      // Mirror Pi: release the deferred start and wait for notice+ACK before
      // SessionManager invalidates the settlement lease.
      shutdown: async () => {
        releaseStart?.();
        await inFlightStart;
      },
    };

    const sm = new SessionManager({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () => deferredHandler,
      handlerConfig: { workspaceRoot, runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        register: vi.fn(),
        sendMessage,
        sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
        getChatContext: vi.fn().mockResolvedValue(null),
      } as unknown as FirstTreeHubSDK,
      log: silentLogger(),
      ackEntry,
      registryPath,
      onSessionEvent: (_chatId, event) => void sessionEvents.push(event),
      agentConfigCache: cache(runtimeConfig()),
    });

    const dispatchPromise = sm.dispatch(
      mockEntry({ id: 92, chatId: "chat-deferred-mutate", messageId: "msg-deferred", content: "go" }),
    );
    await started;
    await sm.shutdown("client_switch_interrupted");
    await dispatchPromise;

    expect(ackEntry).toHaveBeenCalledWith(92);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const noticeOrder = sendMessage.mock.invocationCallOrder[0];
    const ackOrder = ackEntry.mock.invocationCallOrder[0];
    expect(noticeOrder as number).toBeLessThan(ackOrder as number);
    // Non-terminal session events must not cross the drain fence.
    expect(sessionEvents.some((event) => event.kind === "assistant_text")).toBe(false);
    expect(sessionEvents.some((event) => event.kind === "turn_end")).toBe(false);
    expect(
      sessionEvents.some(
        (event) => event.kind === "error" && JSON.stringify(event.payload).includes("provider_failure_terminal"),
      ),
    ).toBe(true);
    // Unadopted provider session id must not land in the registry mid-drain.
    if (existsSync(registryPath)) {
      const raw = JSON.parse(readFileSync(registryPath, "utf8")) as {
        entries?: Record<string, { claudeSessionId?: string }>;
      };
      const ids = Object.values(raw.entries ?? {}).map((entry) => entry.claudeSessionId);
      expect(ids).not.toContain("should-not-persist");
      expect(ids).not.toContain("should-not-adopt");
    }
    expect(forwardCalls).toEqual(["forwardResult"]);
    expect(mutationCalls.length).toBeGreaterThan(0);
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("prompt write withheld + unsafe tool start: manager shutdown settles once without late mutation", async () => {
    process.env.FT_PI_TEST_MODE = "prompt_write_tool_no_response";
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-write-gap" });
    const sm = makePiSessionManager({ specs, ackEntry, sendMessage });

    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 93,
        chatId: "chat-pi-write-gap",
        messageId: "msg-pi-write-gap",
        content: "run sleep",
      }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);

    await sm.shutdown("agent_runtime_switch");
    await dispatchPromise;

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(93);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.invocationCallOrder[0] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[0] as number,
    );
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("prompt accepted with no first event: manager shutdown aborts and settles without replay", async () => {
    process.env.FT_PI_TEST_MODE = "prompt_accepted_no_events";
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-no-events" });
    const sm = makePiSessionManager({ specs, ackEntry, sendMessage });

    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 94,
        chatId: "chat-pi-no-events",
        messageId: "msg-pi-no-events",
        content: "hello",
      }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);

    await sm.shutdown("runtime switched by server");
    await dispatchPromise;

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).toHaveBeenCalledWith(94);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.invocationCallOrder[0] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[0] as number,
    );
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("operator suspend after prompt write + unsafe tool settles once; resume cannot replay", async () => {
    process.env.FT_PI_TEST_MODE = "prompt_write_tool_no_response";
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-operator-suspend" });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const suspendCalls: Array<{ reason?: string; opts?: { settleProviderEntered?: boolean } }> = [];
    const sm = makePiSessionManager({
      specs,
      ackEntry,
      sendMessage,
      recoverChat,
      onHandler: (handler) => {
        const original = handler.suspend.bind(handler);
        handler.suspend = async (reason, opts) => {
          suspendCalls.push({ reason, opts });
          return original(reason, opts);
        };
      },
    });

    const chatId = "chat-pi-operator-suspend-write";
    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 96,
        chatId,
        messageId: "msg-pi-operator-suspend-write",
        content: "run sleep",
      }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);

    await sm.handleCommand(chatId, "session:suspend");
    const suspending = (sm as unknown as { sessions: Map<string, { suspending: Promise<void> | null }> }).sessions.get(
      chatId,
    )?.suspending;
    await Promise.all([suspending ?? Promise.resolve(), dispatchPromise]);

    expect(suspendCalls.some((call) => call.opts?.settleProviderEntered === true)).toBe(true);
    expect(ackEntry).toHaveBeenCalledWith(96);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 96)).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.invocationCallOrder[0] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[0] as number,
    );
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    // Settled prefix leaves no recovery debt for the server to redeliver/replay.
    expect(recoverChat).not.toHaveBeenCalled();

    // Control resume (no inbox input) must not create prompt/tool #2.
    await sm.handleCommand(chatId, "session:resume");
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 96)).toHaveLength(1);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("operator suspend before prompt write: zero prompt writes and no ACK", async () => {
    let releaseRefresh: (() => void) | undefined;
    let signalRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefresh = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const config = runtimeConfig();
    const gatedCache: AgentConfigCache = {
      get: () => config,
      refresh: async () => {
        signalRefresh?.();
        await refreshGate;
        return config;
      },
      refreshIfNewer: async () => config,
      updateSdk: () => {},
      updateUrls: () => {},
      allReferencedUrls: () => new Set(),
      forget: () => {},
    };
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "unused" });
    const sm = new SessionManager({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        createPiHandler({
          workspaceRoot,
          runtimeProvider: "pi",
          agentConfigCache: gatedCache,
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(specs),
        }),
      handlerConfig: { workspaceRoot, runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        register: vi.fn(),
        sendMessage,
        sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
        getChatContext: vi.fn().mockResolvedValue(null),
      } as unknown as FirstTreeHubSDK,
      log: silentLogger(),
      ackEntry,
      agentConfigCache: gatedCache,
    });

    const chatId = "chat-pi-operator-suspend-before-write";
    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 98,
        chatId,
        messageId: "msg-pi-operator-suspend-before-write",
        content: "blocked early",
      }),
    );
    await refreshStarted;
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(0);

    await sm.handleCommand(chatId, "session:suspend");
    releaseRefresh?.();
    await dispatchPromise;

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(0);
    expect(ackEntry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("true before-write shutdown control: zero prompt writes, recoverable (no ACK)", async () => {
    let releaseRefresh: (() => void) | undefined;
    let signalRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefresh = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const config = runtimeConfig();
    const gatedCache: AgentConfigCache = {
      get: () => config,
      refresh: async () => {
        signalRefresh?.();
        await refreshGate;
        return config;
      },
      refreshIfNewer: async () => config,
      updateSdk: () => {},
      updateUrls: () => {},
      allReferencedUrls: () => new Set(),
      forget: () => {},
    };
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const sendMessage = vi.fn().mockResolvedValue({ id: "unused" });
    const sm = new SessionManager({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        createPiHandler({
          workspaceRoot,
          runtimeProvider: "pi",
          agentConfigCache: gatedCache,
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(specs),
        }),
      handlerConfig: { workspaceRoot, runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        register: vi.fn(),
        sendMessage,
        sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
        getChatContext: vi.fn().mockResolvedValue(null),
      } as unknown as FirstTreeHubSDK,
      log: silentLogger(),
      ackEntry,
      agentConfigCache: gatedCache,
    });

    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 95,
        chatId: "chat-pi-before-write",
        messageId: "msg-pi-before-write",
        content: "blocked early",
      }),
    );
    await refreshStarted;
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(0);

    await sm.shutdown("operator stop");
    releaseRefresh?.();
    await dispatchPromise;

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(0);
    expect(ackEntry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });
});
