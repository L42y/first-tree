import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { RUNTIME_NOTICE_METADATA_KEY } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiHandler } from "../handlers/pi/index.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
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
  writeFileSync(promptCountFile, "0");
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
});
