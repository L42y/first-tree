import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPiHandler,
  parsePiModelSelector,
  resolvePiNativeToolRefs,
  sanitizePiProviderDetail,
  stablePiSessionId,
} from "../handlers/pi/index.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import { clearGitRepoIdentityCacheForTests } from "../runtime/git-repo-identity.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../runtime/handler.js";
import * as managedSkills from "../runtime/managed-skills.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../runtime/provider-process-supervisor.js";
import { readSessionBriefingFingerprint } from "../runtime/session-briefing-fingerprint.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const RPC_CHILD_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const mode = process.env.FT_PI_TEST_MODE ?? "happy";
const expectedSessionId = process.env.FT_PI_EXPECTED_SESSION_ID ?? "";
const promptCountFile = process.env.FT_PI_PROMPT_COUNT_FILE ?? "";
const steerCountFile = process.env.FT_PI_STEER_COUNT_FILE ?? "";
const failRemainFile = process.env.FT_PI_PREFLIGHT_FAIL_REMAINING_FILE ?? "";
const lastPromptFile = process.env.FT_PI_LAST_PROMPT_FILE ?? "";
const modelProvider = process.env.FT_PI_STATE_PROVIDER ?? "openai-codex";
const modelId = process.env.FT_PI_STATE_MODEL ?? "gpt-test";
const thinkingLevel = process.env.FT_PI_STATE_THINKING ?? "";

function bump(file) {
  if (!file) return;
  let n = 0;
  try { n = Number(fs.readFileSync(file, "utf8")) || 0; } catch {}
  fs.writeFileSync(file, String(n + 1));
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function assistantMessage(text, stopReason = "stop", usage) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "openai-codex",
    model: "gpt-test",
    usage: usage ?? { input: 11, output: 5, cacheRead: 2, cacheWrite: 0 },
    stopReason,
  };
}

rl.on("line", (line) => {
  const req = JSON.parse(line);
  const id = req.id;
  const command = req.type;
  if (command === "get_state") {
    const data = {
      sessionId: expectedSessionId,
      isStreaming: false,
      messageCount: 0,
      model: { id: modelId, provider: modelProvider },
    };
    if (thinkingLevel) data.thinkingLevel = thinkingLevel;
    if (mode === "skill_echo") {
      const skillDir = process.env.FT_PI_SKILL_MARKER_DIR ?? "";
      try {
        data.skillMarker = fs.readFileSync(path.join(skillDir, "marker.txt"), "utf8").trim();
      } catch {
        data.skillMarker = "";
      }
    }
    write({ type: "response", id, command: "get_state", success: true, data });
    return;
  }
  if (command === "prompt") {
    bump(promptCountFile);
    if (lastPromptFile && typeof req.message === "string") {
      try { fs.writeFileSync(lastPromptFile, req.message); } catch {}
    }
    if (failRemainFile) {
      let left = 0;
      try { left = Number(fs.readFileSync(failRemainFile, "utf8")) || 0; } catch {}
      if (left > 0) {
        fs.writeFileSync(failRemainFile, String(left - 1));
        write({ type: "response", id, command: "prompt", success: false, error: "provider overloaded" });
        return;
      }
    }
    if (mode === "credential") {
      write({ type: "response", id, command: "prompt", success: false, error: "missing credentials" });
      return;
    }
    if (mode === "preflight_capacity") {
      write({ type: "response", id, command: "prompt", success: false, error: "provider overloaded" });
      return;
    }
    if (mode === "before_write_closed") {
      // Parent closes stdin before we can reply; do nothing.
      return;
    }
    if (mode === "command_mismatch") {
      write({ type: "response", id, command: "get_state", success: true, data: {} });
      return;
    }
    write({ type: "response", id, command: "prompt", success: true });
    if (mode === "accepted_error" || mode === "exhausted_retry") {
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "error",
          error: { role: "assistant", errorMessage: "temporary provider blip", stopReason: "error" },
        },
      });
      write({ type: "auto_retry_start", attempt: 1, errorMessage: "temporary provider blip" });
      write({ type: "auto_retry_end", success: false, attempt: 1, finalError: "provider overloaded" });
      write({ type: "message_end", message: assistantMessage("", "error") });
      write({ type: "agent_settled" });
      return;
    }
    if (mode === "successful_retry") {
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "error",
          error: { role: "assistant", errorMessage: "retryable blip", stopReason: "error" },
        },
      });
      write({ type: "auto_retry_start", attempt: 1, errorMessage: "retryable blip" });
      write({ type: "auto_retry_end", success: true, attempt: 1 });
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "recovered" },
      });
      write({ type: "message_end", message: assistantMessage("recovered") });
      write({ type: "agent_settled" });
      return;
    }
    if (mode === "settlement_timeout" || mode === "after_write_hang") {
      return;
    }
    if (mode === "usage_multi") {
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "part" },
      });
      write({
        type: "message_end",
        message: assistantMessage("part", "stop", { input: 10, output: 2, cacheRead: 1, cacheWrite: 3 }),
      });
      write({
        type: "turn_end",
        message: assistantMessage("part", "stop", { input: 10, output: 2, cacheRead: 1, cacheWrite: 3 }),
      });
      write({
        type: "message_end",
        message: {
          ...assistantMessage("more", "stop", { input: 4, output: 6, cacheRead: 0, cacheWrite: 1 }),
          timestamp: 2,
        },
      });
      write({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          provider: "openai-codex",
          model: "gpt-test",
          usage: { input: "bad", output: -1, cacheRead: NaN, cacheWrite: Infinity },
          stopReason: "stop",
          timestamp: 3,
        },
      });
      write({ type: "agent_settled" });
      return;
    }
    if (mode === "tools" || mode === "tools_write") {
      write({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "grep",
        args: { pattern: "secret-pattern-not-a-path", path: "src" },
      });
      write({ type: "tool_execution_end", toolCallId: "t1", isError: false, result: "ok" });
      write({
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "READ",
        args: { path: "README.md" },
      });
      write({ type: "tool_execution_end", toolCallId: "t2", isError: false, result: "ok" });
      if (mode === "tools_write") {
        const treePath = process.env.FT_PI_TREE_PATH ?? "";
        const pathJoin = require("node:path").join;
        const fs = require("node:fs");
        // Let the parent drain each tool_execution_end (and capture its git
        // baseline) before the next mutation lands on disk.
        const yieldToParent = () => {
          try {
            require("node:child_process").execFileSync("sleep", ["0.05"]);
          } catch {}
        };
        // Read a tree-local path so handler pending refs carry repoHeadCommit.
        if (treePath) {
          write({
            type: "tool_execution_start",
            toolCallId: "t2b",
            toolName: "read",
            args: { path: pathJoin(treePath, "NODE.md") },
          });
          write({ type: "tool_execution_end", toolCallId: "t2b", isError: false, result: "root" });
          yieldToParent();
        }
        const writeTarget = treePath ? pathJoin(treePath, "NODE.md") : "NODE.md";
        write({
          type: "tool_execution_start",
          toolCallId: "t3",
          toolName: "write",
          args: { path: writeTarget },
        });
        if (treePath) {
          try {
            // Dirty both the write target and a sidecar. Same-path git deltas
            // are deduped against file_change refs; the sidecar proves emission.
            fs.writeFileSync(writeTarget, "updated-by-pi-write\\n");
            fs.mkdirSync(pathJoin(treePath, "domains"), { recursive: true });
            fs.writeFileSync(pathJoin(treePath, "domains", "write-sidecar.md"), "sidecar\\n");
          } catch {}
        }
        write({ type: "tool_execution_end", toolCallId: "t3", isError: false, result: "ok" });
        yieldToParent();
        const editTarget = treePath ? pathJoin(treePath, "README.md") : "README.md";
        write({
          type: "tool_execution_start",
          toolCallId: "t3b",
          toolName: "edit",
          args: { path: editTarget },
        });
        if (treePath) {
          try {
            fs.writeFileSync(editTarget, "edited\\n");
            fs.writeFileSync(pathJoin(treePath, "domains", "edit-sidecar.md"), "edit-side\\n");
          } catch {}
        }
        write({ type: "tool_execution_end", toolCallId: "t3b", isError: false, result: "ok" });
        yieldToParent();
        write({
          type: "tool_execution_start",
          toolCallId: "t4",
          toolName: "bash",
          args: {
            // Keep command non-path-extractable so git_status_delta is not
            // deduped against shell-arg file refs.
            command: "true",
            cwd: treePath || process.cwd(),
          },
        });
        if (treePath) {
          try {
            fs.writeFileSync(pathJoin(treePath, "domains", "shell.md"), "shell-delta\\n");
          } catch {}
        }
        write({ type: "tool_execution_end", toolCallId: "t4", isError: false, result: "ok" });
      }
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tools-done" },
      });
      write({ type: "message_end", message: assistantMessage("tools-done") });
      write({ type: "agent_settled" });
      return;
    }
    write({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: mode === "skill_echo" ? "skill-ok" : "done" },
    });
    write({ type: "message_end", message: assistantMessage(mode === "skill_echo" ? "skill-ok" : "done") });
    if (mode === "abort_settled_first") {
      write({ type: "agent_settled" });
      return;
    }
    if (mode === "streaming") {
      setTimeout(() => write({ type: "agent_settled" }), 120);
      return;
    }
    if (mode === "steer_after_write_hang") {
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streaming" },
      });
      setTimeout(() => write({ type: "agent_settled" }), 200);
      return;
    }
    write({ type: "agent_settled" });
    return;
  }
  if (command === "steer") {
    bump(steerCountFile);
    if (mode === "steer_after_write_hang") {
      // Accepted write, lost response — never reply.
      return;
    }
    if (mode === "steer_reject") {
      write({ type: "response", id, command: "steer", success: false, error: "not streaming" });
      return;
    }
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
let promptCountFile = "";
let steerCountFile = "";
let preflightFailRemainFile = "";
let lastPromptFile = "";

function runtimeConfig(overrides: Partial<AgentRuntimeConfig["payload"]> & { mcp?: boolean } = {}): AgentRuntimeConfig {
  const { mcp, prompt, model, env, gitRepos, resourceSkills, mcpServers } = overrides;
  return {
    agentId: "agent-pi",
    version: 1,
    payload: {
      kind: "pi",
      prompt: prompt ?? { append: "" },
      model: model ?? "",
      mcpServers: mcp
        ? [{ name: "repo", transport: "stdio", command: "mcp-bin", args: ["--stdio"] }]
        : (mcpServers ?? []),
      env: env ?? [],
      gitRepos: gitRepos ?? [],
      resourceSkills: resourceSkills ?? [],
    },
    updatedAt: new Date(0).toISOString(),
    updatedBy: "test",
  };
}

function cache(config: AgentRuntimeConfig): AgentConfigCache & { set: (next: AgentRuntimeConfig) => void } {
  let current = config;
  return {
    get: () => current,
    refresh: async () => current,
    refreshIfNewer: async () => current,
    updateSdk: () => {},
    updateUrls: () => {},
    allReferencedUrls: () => new Set(),
    forget: () => {},
    set: (next) => {
      current = next;
    },
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

function makeContext(events: SessionEvent[], logs: string[] = []): SessionContext {
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
    log: (line) => void logs.push(line),
    recordProviderActivity: () => {},
    emitEvent: (value) => void events.push(value),
    ...mockCtxPlumbing({ sendMessage }, "chat-pi"),
  };
}

function createSyntheticSupervisor(
  specs: ProviderProcessSpec[],
  options?: { hangVersion?: boolean; skillMarkerDir?: string },
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
          FT_PI_PROMPT_COUNT_FILE: promptCountFile,
          FT_PI_STEER_COUNT_FILE: steerCountFile,
          FT_PI_PREFLIGHT_FAIL_REMAINING_FILE: preflightFailRemainFile,
          FT_PI_LAST_PROMPT_FILE: lastPromptFile,
          FT_PI_STATE_PROVIDER: process.env.FT_PI_STATE_PROVIDER ?? "openai-codex",
          FT_PI_STATE_MODEL: process.env.FT_PI_STATE_MODEL ?? "gpt-test",
          FT_PI_STATE_THINKING: process.env.FT_PI_STATE_THINKING ?? "",
          FT_PI_SKILL_MARKER_DIR: options?.skillMarkerDir ?? "",
          FT_PI_TREE_PATH: process.env.FT_PI_TREE_PATH ?? "",
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

function readCount(file: string): number {
  try {
    return Number(readFileSync(file, "utf8")) || 0;
  } catch {
    return 0;
  }
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "pi-handler-test-"));
  roots.push(workspaceRoot);
  promptCountFile = join(workspaceRoot, "prompt-count.txt");
  steerCountFile = join(workspaceRoot, "steer-count.txt");
  preflightFailRemainFile = join(workspaceRoot, "preflight-fail-remaining.txt");
  lastPromptFile = join(workspaceRoot, "last-prompt.txt");
  writeFileSync(promptCountFile, "0");
  writeFileSync(steerCountFile, "0");
  writeFileSync(preflightFailRemainFile, "0");
  writeFileSync(lastPromptFile, "");
  delete process.env.FT_PI_TEST_MODE;
  delete process.env.FT_PI_STATE_PROVIDER;
  delete process.env.FT_PI_STATE_MODEL;
  delete process.env.FT_PI_STATE_THINKING;
  delete process.env.FT_PI_TREE_PATH;
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.FT_PI_TEST_MODE;
  delete process.env.FT_PI_STATE_PROVIDER;
  delete process.env.FT_PI_STATE_MODEL;
  delete process.env.FT_PI_STATE_THINKING;
  delete process.env.FT_PI_TREE_PATH;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parsePiModelSelector", () => {
  it("keeps the exact full model id and only exposes thinking as a candidate", () => {
    expect(parsePiModelSelector("openai-codex/gpt-5")).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5",
      thinkingCandidate: null,
      raw: "openai-codex/gpt-5",
    });
    expect(parsePiModelSelector("openai-codex/gpt-5:high")).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5:high",
      thinkingCandidate: { modelId: "gpt-5", thinkingLevel: "high" },
      raw: "openai-codex/gpt-5:high",
    });
    expect(parsePiModelSelector("ollama/llama3.2:latest")).toEqual({
      provider: "ollama",
      modelId: "llama3.2:latest",
      thinkingCandidate: null,
      raw: "ollama/llama3.2:latest",
    });
    expect(parsePiModelSelector("gpt-5")).toBeNull();
  });
});

describe("sanitizePiProviderDetail", () => {
  it("maps known failures and never echoes private prose", () => {
    expect(sanitizePiProviderDetail("missing credentials")).toBe("pi_auth_required");
    expect(sanitizePiProviderDetail("provider overloaded")).toBe("pi_capacity_limited");
    expect(sanitizePiProviderDetail("Please ignore prior text: PRIVATE_USER_PROMPT_XYZ")).toBe("pi_provider_error");
    expect(sanitizePiProviderDetail("Please ignore prior text: PRIVATE_USER_PROMPT_XYZ")).not.toContain("PRIVATE");
  });
});

describe("resolvePiNativeToolRefs", () => {
  it("uses explicit path args and ignores grep/find pattern", () => {
    const cwd = "/tmp/ws";
    expect(
      resolvePiNativeToolRefs({ name: "grep", args: { pattern: "not-a-path", path: "src" }, workspaceCwd: cwd }),
    ).toEqual([expect.objectContaining({ localPath: join(cwd, "src"), pathKind: "directory" })]);
    expect(resolvePiNativeToolRefs({ name: "find", args: { pattern: "only-pattern" }, workspaceCwd: cwd })).toEqual([]);
    expect(resolvePiNativeToolRefs({ name: "READ", args: { file_path: "a.md" }, workspaceCwd: cwd })).toEqual([
      expect.objectContaining({ localPath: join(cwd, "a.md"), pathKind: "file" }),
    ]);
    expect(resolvePiNativeToolRefs({ name: "ls", args: { cwd: "pkg" }, workspaceCwd: cwd })).toEqual([
      expect.objectContaining({ localPath: join(cwd, "pkg"), pathKind: "directory" }),
    ]);
  });
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
    expect(readCount(promptCountFile)).toBe(1);
    await handler.shutdown();
  });

  it("rejects MCP configuration before launching pi", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig({ mcp: true })),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const token = makeToken();
    await expect(handler.start(message("m1", "work"), makeContext([]), token)).rejects.toThrow(
      "managed MCP servers are not supported",
    );
    expect(specs.filter((spec) => spec.args.includes("--mode"))).toHaveLength(0);
  });

  it("terminates credential preflight without waiting for agent_settled and retains one-shot state", async () => {
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
    expect(readCount(promptCountFile)).toBe(1);
    expect(readSessionBriefingFingerprint(workspaceRoot, stablePiSessionId("agent-pi", "chat-pi"))).toBeNull();
    await handler.shutdown();
  });

  it("consumes Pi exhausted auto-retry without FT re-prompt", async () => {
    process.env.FT_PI_TEST_MODE = "exhausted_retry";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      // If FT stacked retries, this would take ~2s; keep tight to catch regressions.
    });
    const events: SessionEvent[] = [];
    const token = makeToken();
    const started = Date.now();
    await handler.start(message("m1", "work"), makeContext(events), token);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(readCount(promptCountFile)).toBe(1);
    expect(token.completed).toEqual([
      expect.objectContaining({ status: "error", completion: "consumed", reason: "provider_retry_exhausted" }),
    ]);
    expect(events.some((event) => event.kind === "turn_end" && event.payload?.status === "success")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          event.payload?.source === "runtime" &&
          String(event.payload?.message).includes("provider_retry_exhausted"),
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("provider overloaded");
    // Accepted terminal failure still advances one-shot briefing fingerprint.
    expect(readSessionBriefingFingerprint(workspaceRoot, stablePiSessionId("agent-pi", "chat-pi"))).toBeTypeOf(
      "string",
    );
    await handler.shutdown();
  });

  it("treats successful Pi auto-retry as success with a single prompt write", async () => {
    process.env.FT_PI_TEST_MODE = "successful_retry";
    const specs: ProviderProcessSpec[] = [];
    const logs: string[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const events: SessionEvent[] = [];
    const token = makeToken();
    await handler.start(message("m1", "work"), makeContext(events, logs), token);
    expect(readCount(promptCountFile)).toBe(1);
    expect(token.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(events).toContainEqual({ kind: "assistant_text", payload: { text: "recovered" } });
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "success" } });
    expect(events.some((event) => event.kind === "error" && String(event.payload?.message).includes("retryable"))).toBe(
      false,
    );
    expect(logs.some((line) => line.includes("provisional error"))).toBe(true);
    expect(logs.join("\n")).not.toContain("retryable blip");
    await handler.shutdown();
  });

  it("follows shared preflight retry then succeeds with extra prompt writes", async () => {
    writeFileSync(preflightFailRemainFile, "2");
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
    expect(readCount(promptCountFile)).toBe(3);
    expect(token.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(
      events.filter(
        (event) =>
          event.kind === "error" &&
          event.payload?.source === "runtime" &&
          String(event.payload?.message).includes("provider_retry_scheduled"),
      ).length,
    ).toBe(2);
    await handler.shutdown();
  }, 10_000);

  it("consumes exhausted preflight capacity after shared retry budget", async () => {
    process.env.FT_PI_TEST_MODE = "preflight_capacity";
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
    expect(readCount(promptCountFile)).toBe(3);
    expect(token.completed).toEqual([
      expect.objectContaining({ status: "error", completion: "consumed", reason: "provider_retry_exhausted" }),
    ]);
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          event.payload?.source === "runtime" &&
          String(event.payload?.message).includes("provider_retry_exhausted"),
      ),
    ).toBe(true);
    await handler.shutdown();
  }, 10_000);

  it("does not resend after settlement timeout once prompt was accepted", async () => {
    process.env.FT_PI_TEST_MODE = "settlement_timeout";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      piSettlementTimeoutMs: 40,
    });
    const token = makeToken();
    await handler.start(message("m1", "work"), makeContext([]), token);
    expect(readCount(promptCountFile)).toBe(1);
    expect(token.completed).toEqual([
      expect.objectContaining({ status: "error", completion: "consumed", reason: expect.any(String) }),
    ]);
    expect(token.retried).toEqual([]);
    await handler.shutdown();
  });

  it("aggregates multi-call usage including cacheWrite and ignores malformed telemetry", async () => {
    process.env.FT_PI_TEST_MODE = "usage_multi";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const events: SessionEvent[] = [];
    await handler.start(message("m1", "work"), makeContext(events), makeToken());
    expect(events).toContainEqual({
      kind: "token_usage",
      payload: {
        provider: "openai-codex",
        model: "gpt-test",
        // call1: input10+cacheWrite3=13, cacheRead1, out2; call2: 4+1=5, 0, 6 → 18/1/8
        inputTokens: 18,
        cachedInputTokens: 1,
        outputTokens: 8,
      },
    });
    await handler.shutdown();
  });

  it("attributes lowercase tools with path refs and ignores pattern-only grep", async () => {
    process.env.FT_PI_TEST_MODE = "tools";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const events: SessionEvent[] = [];
    await handler.start(message("m1", "work"), makeContext(events), makeToken());
    const toolEvents = events.filter((event) => event.kind === "tool_call");
    const grepPending = toolEvents.find(
      (event) => event.payload?.name === "grep" && event.payload?.status === "pending",
    );
    expect(JSON.stringify(grepPending?.payload?.toolFileRefs ?? [])).not.toContain("secret-pattern");
    expect(grepPending?.payload?.toolFileRefs).toEqual([
      expect.objectContaining({ localPath: join(workspaceRoot, "src") }),
    ]);
    const readPending = toolEvents.find(
      (event) => event.payload?.name === "READ" && event.payload?.status === "pending",
    );
    expect(readPending?.payload?.toolFileRefs).toEqual([
      expect.objectContaining({ localPath: join(workspaceRoot, "README.md") }),
    ]);
    await handler.shutdown();
  });

  it("accepts thinking-split get_state when Pi resolved prefix + thinking level", async () => {
    process.env.FT_PI_STATE_PROVIDER = "openai-codex";
    process.env.FT_PI_STATE_MODEL = "gpt-test";
    process.env.FT_PI_STATE_THINKING = "high";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig({ model: "openai-codex/gpt-test:high" })),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    await handler.start(message("m1", "work"), makeContext([]), makeToken());
    await handler.shutdown();
  });

  it("accepts exact full model ids ending in a thinking-level suffix", async () => {
    process.env.FT_PI_STATE_PROVIDER = "openai-codex";
    process.env.FT_PI_STATE_MODEL = "gpt-test:high";
    delete process.env.FT_PI_STATE_THINKING;
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig({ model: "openai-codex/gpt-test:high" })),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    await handler.start(message("m1", "work"), makeContext([]), makeToken());
    await handler.shutdown();
  });

  it("accepts non-thinking colon suffixes such as :latest as exact model ids", async () => {
    process.env.FT_PI_STATE_PROVIDER = "ollama";
    process.env.FT_PI_STATE_MODEL = "llama3.2:latest";
    delete process.env.FT_PI_STATE_THINKING;
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig({ model: "ollama/llama3.2:latest" })),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    await handler.start(message("m1", "work"), makeContext([]), makeToken());
    await handler.shutdown();
  });

  it("fails closed when get_state provider mismatches configured model id", async () => {
    process.env.FT_PI_STATE_PROVIDER = "anthropic";
    process.env.FT_PI_STATE_MODEL = "gpt-test";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig({ model: "openai-codex/gpt-test" })),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    await expect(handler.start(message("m1", "work"), makeContext([]), makeToken())).rejects.toThrow(/model mismatch/);
  });

  it("rewrites AGENTS.md and restarts RPC when prompt/skills digest change between turns", async () => {
    let skillRevision = 1;
    vi.spyOn(managedSkills, "reconcileManagedSkillsForConfig").mockImplementation(async () => ({
      ok: true,
      resourceConfigVersion: skillRevision,
      installed: [],
      skipped: [],
      removed: [],
      teamSkills: [
        {
          key: "resource:demo",
          name: "demo",
          description: "demo skill",
          target: "demo",
          revision: String(skillRevision),
          installedDigest: `sha256:${"ab".repeat(32)}` as `sha256:${string}`,
        },
      ],
      failures: [],
      staleTeamSnapshot: false,
    }));

    const skillDir = join(workspaceRoot, ".agents", "skills", "demo");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "marker.txt"), "skill-v1");

    const agentCache = cache(runtimeConfig({ prompt: { append: "briefing-v1" } }));
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: agentCache,
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { skillMarkerDir: skillDir }),
    });
    const sessionCtx = makeContext([]);
    await handler.start(message("m1", "first"), sessionCtx, makeToken());
    expect(readFileSync(join(workspaceRoot, "AGENTS.md"), "utf8")).toContain("briefing-v1");
    const rpcSpawnsAfterFirst = specs.filter((spec) => spec.args.includes("--mode")).length;
    expect(rpcSpawnsAfterFirst).toBe(1);

    skillRevision = 2;
    writeFileSync(join(skillDir, "marker.txt"), "skill-v2");
    agentCache.set(runtimeConfig({ prompt: { append: "briefing-v2" } }));
    await handler.resume(message("m2", "second"), stablePiSessionId("agent-pi", "chat-pi"), sessionCtx, makeToken());
    expect(readFileSync(join(workspaceRoot, "AGENTS.md"), "utf8")).toContain("briefing-v2");
    const rpcSpawnsAfterSecond = specs.filter((spec) => spec.args.includes("--mode")).length;
    expect(rpcSpawnsAfterSecond).toBe(2);
    expect(readCount(promptCountFile)).toBe(2);
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
    const events: SessionEvent[] = [];
    const sessionCtx = makeContext(events);
    const startToken = makeToken();
    const steerToken = makeToken();
    const startPromise = handler.start(message("m1", "first"), sessionCtx, startToken);
    await vi.waitFor(() => expect(startToken.processingStarted).toHaveBeenCalled());
    await vi.waitFor(() => expect(events.some((event) => event.kind === "assistant_text")).toBe(true));
    const steerReceipt = handler.inject(message("m2", "steer-me"), steerToken);
    expect(steerReceipt).toEqual({ kind: "owned", mode: "processing" });
    await startPromise;
    await vi.waitFor(() => expect(steerToken.processingStarted).toHaveBeenCalled());
    await vi.waitFor(() => expect(steerToken.completed.length).toBe(1));
    expect(startToken.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(steerToken.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(readCount(steerCountFile)).toBe(1);
    await handler.shutdown();
  });

  it("consumes after-write steer loss without duplicating the steer", async () => {
    process.env.FT_PI_TEST_MODE = "steer_after_write_hang";
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      piSettlementTimeoutMs: 300,
      piRequestTimeoutMs: 80,
    });
    const sessionCtx = makeContext([]);
    const startToken = makeToken();
    const steerToken = makeToken();
    const startPromise = handler.start(message("m1", "first"), sessionCtx, startToken);
    await vi.waitFor(() => expect(startToken.processingStarted).toHaveBeenCalled());
    handler.inject(message("m2", "steer-me"), steerToken);
    await startPromise;
    await vi.waitFor(() => expect(steerToken.completed.length + steerToken.retried.length).toBeGreaterThan(0), {
      timeout: 2000,
    });
    expect(readCount(steerCountFile)).toBe(1);
    expect(steerToken.retried).toEqual([]);
    expect(steerToken.completed).toEqual([
      expect.objectContaining({ status: "error", completion: "consumed", reason: "pi_steer_after_write_unknown" }),
    ]);
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

  it("writes briefing fingerprint after accepted delivery boundary", async () => {
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

  it("hot-path inject advances each new briefing once without resume reset", async () => {
    let skillRevision = 1;
    vi.spyOn(managedSkills, "reconcileManagedSkillsForConfig").mockImplementation(async () => ({
      ok: true,
      resourceConfigVersion: skillRevision,
      installed: [],
      skipped: [],
      removed: [],
      teamSkills: [
        {
          key: "resource:demo",
          name: "demo",
          description: "demo skill",
          target: "demo",
          revision: String(skillRevision),
          installedDigest: `sha256:${"cd".repeat(32)}` as `sha256:${string}`,
        },
      ],
      failures: [],
      staleTeamSnapshot: false,
    }));

    const agentCache = cache(runtimeConfig({ prompt: { append: "briefing-hot-1" } }));
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: agentCache,
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const sessionCtx = makeContext([]);
    const expectedId = stablePiSessionId("agent-pi", "chat-pi");
    await handler.start(message("m1", "first"), sessionCtx, makeToken());
    const fp1 = readSessionBriefingFingerprint(workspaceRoot, expectedId);
    expect(fp1).toBeTypeOf("string");
    expect(readFileSync(join(workspaceRoot, "AGENTS.md"), "utf8")).toContain("briefing-hot-1");

    skillRevision = 2;
    agentCache.set(runtimeConfig({ prompt: { append: "briefing-hot-2" } }));
    const token2 = makeToken();
    expect(handler.inject(message("m2", "second"), token2)).toEqual({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => expect(token2.completed.length).toBe(1));
    expect(token2.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(readFileSync(join(workspaceRoot, "AGENTS.md"), "utf8")).toContain("briefing-hot-2");
    const fp2 = readSessionBriefingFingerprint(workspaceRoot, expectedId);
    expect(fp2).toBeTypeOf("string");
    expect(fp2).not.toBe(fp1);
    const secondPrompt = readFileSync(lastPromptFile, "utf8");
    expect(secondPrompt).toContain("re-read your instructions");

    const token3 = makeToken();
    expect(handler.inject(message("m3", "third"), token3)).toEqual({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => expect(token3.completed.length).toBe(1));
    const thirdPrompt = readFileSync(lastPromptFile, "utf8");
    expect(thirdPrompt).not.toContain("re-read your instructions");
    expect(specs.filter((spec) => spec.args.includes("--mode")).length).toBe(2);
    await handler.shutdown();
  });

  it("emits durable terminal notice for live MCP rejection without writing a prompt", async () => {
    const agentCache = cache(runtimeConfig());
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: agentCache,
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const events: SessionEvent[] = [];
    const sessionCtx = makeContext(events);
    await handler.start(message("m1", "first"), sessionCtx, makeToken());
    const promptsAfterStart = readCount(promptCountFile);
    agentCache.set(runtimeConfig({ mcp: true }));
    const token2 = makeToken();
    expect(handler.inject(message("m2", "mcp-now"), token2)).toEqual({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => expect(token2.completed.length).toBe(1));
    expect(readCount(promptCountFile)).toBe(promptsAfterStart);
    expect(token2.retried).toEqual([]);
    expect(token2.completed).toEqual([expect.objectContaining({ status: "error", completion: "consumed" })]);
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          event.payload?.source === "runtime" &&
          String(event.payload?.message).includes("provider_failure_terminal"),
      ),
    ).toBe(true);
    await handler.shutdown();
  });

  it("consumes active model-refresh mismatch with durable notice and no prompt rewrite", async () => {
    process.env.FT_PI_STATE_PROVIDER = "openai-codex";
    process.env.FT_PI_STATE_MODEL = "gpt-test";
    const agentCache = cache(runtimeConfig({ model: "openai-codex/gpt-test" }));
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: agentCache,
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });
    const events: SessionEvent[] = [];
    const sessionCtx = makeContext(events);
    await handler.start(message("m1", "first"), sessionCtx, makeToken());
    const promptsAfterStart = readCount(promptCountFile);
    // Mutate cached model so the next hot-path inject restarts RPC and fails
    // assertConfiguredModel against the still-reported get_state id.
    agentCache.set(runtimeConfig({ model: "openai-codex/other-model" }));
    const token2 = makeToken();
    expect(handler.inject(message("m2", "model-now"), token2)).toEqual({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => expect(token2.completed.length).toBe(1));
    expect(readCount(promptCountFile)).toBe(promptsAfterStart);
    expect(token2.retried).toEqual([]);
    expect(token2.completed).toEqual([
      expect.objectContaining({
        status: "error",
        completion: "consumed",
        reason: "pi_model_configuration_error",
      }),
    ]);
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          event.payload?.source === "runtime" &&
          String(event.payload?.message).includes("provider_failure_terminal"),
      ),
    ).toBe(true);
    await handler.shutdown();
  });

  it("attaches Context Tree HEAD on read tools and git-status deltas on write", async () => {
    const { execFileSync } = await import("node:child_process");
    clearGitRepoIdentityCacheForTests();
    const tree = join(workspaceRoot, "context-tree");
    mkdirSync(join(tree, "domains"), { recursive: true });
    execFileSync("git", ["init"], { cwd: tree });
    execFileSync("git", ["config", "user.email", "agent@example.com"], { cwd: tree });
    execFileSync("git", ["config", "user.name", "Agent"], { cwd: tree });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/first-tree-context.git"], {
      cwd: tree,
    });
    writeFileSync(join(tree, "NODE.md"), "root\n");
    writeFileSync(join(tree, "README.md"), "readme\n");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src", "x.ts"), "export {}\n");
    execFileSync("git", ["add", "."], { cwd: tree });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tree });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" }).trim();
    process.env.FT_PI_TEST_MODE = "tools_write";
    process.env.FT_PI_TREE_PATH = tree;

    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      contextTreePath: tree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });
    const events: SessionEvent[] = [];
    await handler.start(message("m1", "work"), makeContext(events), makeToken());
    const toolEvents = events.filter((event) => event.kind === "tool_call");
    const readTreePending = toolEvents.find(
      (event) =>
        event.payload?.name === "read" &&
        event.payload?.status === "pending" &&
        event.payload?.toolFileRefs?.some((ref) => ref.repoRelativePath === "NODE.md"),
    );
    expect(readTreePending?.payload?.toolFileRefs).toEqual([
      expect.objectContaining({
        repoHeadCommit: head,
        repoRelativePath: "NODE.md",
        origin: "tool_arg",
      }),
    ]);

    const writeOk = toolEvents.find((event) => event.payload?.name === "write" && event.payload?.status === "ok");
    expect(writeOk).toBeDefined();
    expect(writeOk?.payload?.toolFileRefs?.some((ref) => ref.origin === "git_status_delta")).toBe(true);
    const editOk = toolEvents.find((event) => event.payload?.name === "edit" && event.payload?.status === "ok");
    expect(editOk?.payload?.toolFileRefs?.some((ref) => ref.origin === "git_status_delta")).toBe(true);
    const bashOk = toolEvents.find((event) => event.payload?.name === "bash" && event.payload?.status === "ok");
    expect(bashOk?.payload?.toolFileRefs?.some((ref) => ref.origin === "git_status_delta")).toBe(true);
    await handler.shutdown();
  });
});
