import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { resolveClaudeCodeExecutable } from "../providers/claude/executable.js";
import { verifyClaudeCodeReadiness } from "../providers/claude/readiness.js";
import {
  classifyCodexReadinessAuthText,
  isSafeCodexReadinessItemType,
  runCodexCli,
  verifyCodexReadiness,
} from "../providers/codex/readiness.js";
import { RUNTIME_READINESS_PROMPT, withIsolatedReadinessWorkspace } from "../providers/readiness.js";

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("runtime readiness provider boundary", () => {
  it("uses and removes one isolated read-only workspace", async () => {
    const modes: number[] = [];
    const remove = vi.fn(async () => undefined);
    const result = await withIsolatedReadinessWorkspace(
      async (cwd) => {
        expect(cwd).toBe("/tmp/isolated-readiness");
        return { ok: true };
      },
      {
        makeTemp: async () => "/tmp/isolated-readiness",
        setMode: async (_path, mode) => {
          modes.push(mode);
        },
        list: async () => [],
        remove,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(modes).toEqual([0o500, 0o700]);
    expect(remove).toHaveBeenCalledWith("/tmp/isolated-readiness");
  });

  it("fails closed when a provider mutates the isolated workspace", async () => {
    const result = await withIsolatedReadinessWorkspace(async () => ({ ok: true }), {
      makeTemp: async () => "/tmp/isolated-readiness",
      setMode: async () => undefined,
      list: async () => ["unexpected"],
      remove: async () => undefined,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unsafe_activity" } });
  });

  it("does not report a provider result when isolated-workspace cleanup fails", async () => {
    await expect(
      withIsolatedReadinessWorkspace(async () => ({ ok: true }), {
        makeTemp: async () => "/tmp/isolated-readiness",
        setMode: async () => undefined,
        list: async () => [],
        remove: async () => {
          throw new Error("cleanup failed");
        },
      }),
    ).rejects.toThrow("cleanup failed");
  });

  it("runs Claude through the official SDK with tools and setting sources disabled", async () => {
    const seen: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const result = await verifyClaudeCodeReadiness(
      { signal: signal(), config: { model: "claude-test" } },
      {
        resolveExecutable: () => ({ path: "/opt/claude", source: "path" }),
        runQuery: async function* (input) {
          seen.push({ prompt: input.prompt, options: input.options as unknown as Record<string, unknown> });
          // The provider SDK result union has telemetry fields irrelevant to
          // this boundary test; production parsing only reads these three.
          yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(seen[0]?.prompt).toBe(RUNTIME_READINESS_PROMPT);
    expect(seen[0]?.options).toMatchObject({
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      agents: {},
      skills: [],
      settingSources: [],
      permissionMode: "dontAsk",
      persistSession: false,
      model: "claude-test",
      pathToClaudeCodeExecutable: "/opt/claude",
    });
    expect(String(seen[0]?.options.cwd)).toContain("first-tree-readiness-");
  });

  it("classifies Claude auth failure without returning provider output", async () => {
    const result = await verifyClaudeCodeReadiness(
      { signal: signal() },
      {
        resolveExecutable: () => ({ path: "/opt/claude", source: "path" }),
        runQuery: async function* () {
          yield {
            type: "assistant",
            error: "authentication_failed",
            message: { content: [] },
          } as unknown as SDKMessage;
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: "private provider output that must not cross the seam",
          } as unknown as SDKMessage;
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "needs_login", message: "Claude authentication is required." },
    });
    expect(JSON.stringify(result)).not.toContain("private provider output");
  });

  it("keeps an ambiguous Claude 403 as a provider failure", async () => {
    const result = await verifyClaudeCodeReadiness(
      { signal: signal() },
      {
        resolveExecutable: () => ({ path: "/opt/claude", source: "path" }),
        runQuery: async function* () {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            api_error_status: 403,
            errors: ["request forbidden by regional policy"],
          } as unknown as SDKMessage;
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "provider_error", message: "Claude readiness turn failed." },
    });
  });

  it("uses the login-shell Claude executable shared by capability detection and normal sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-claude-readiness-"));
    const loginBin = join(home, "login-bin");
    const executable = join(loginBin, "claude");
    mkdirSync(loginBin);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const resolveExecutable = vi.fn((options: Parameters<typeof resolveClaudeCodeExecutable>[0] = {}) =>
      resolveClaudeCodeExecutable({
        ...options,
        env: { HOME: home, PATH: "" },
        wellKnownDirs: () => [],
        loginShellPathDirs: () => [loginBin],
      }),
    );
    let resolvedPath: unknown;

    try {
      const result = await verifyClaudeCodeReadiness(
        { signal: signal() },
        {
          resolveExecutable,
          runQuery: async function* ({ options }) {
            resolvedPath = options.pathToClaudeCodeExecutable;
            yield { type: "result", subtype: "success", is_error: false } as SDKMessage;
          },
        },
      );

      expect(result).toEqual({ ok: true });
      expect(resolvedPath).toBe(executable);
      expect(resolveExecutable).toHaveBeenCalledWith();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs Codex through the actual CLI in an ephemeral no-tools mode and rejects tool activity", async () => {
    let invocation: { binary: string; args: string[]; cwd: string; prompt: string; signal: AbortSignal } | undefined;
    const result = await verifyCodexReadiness(
      { signal: signal(), config: { model: "gpt-test", reasoningEffort: "low" } },
      {
        resolveBinary: async () => ({
          ok: true,
          binary: "/opt/codex",
          runtimeSource: "bundled",
          runtimePath: null,
          version: "0.144.1",
        }),
        runCli: async (input) => {
          invocation = input;
          return {
            exitCode: 0,
            completed: true,
            replied: true,
            unsafe: true,
            authFailure: false,
            failed: false,
          };
        },
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "unsafe_activity" } });
    expect(invocation?.binary).toBe("/opt/codex");
    expect(invocation?.prompt).toBe(RUNTIME_READINESS_PROMPT);
    expect(invocation?.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "read-only",
        'approval_policy="never"',
        "mcp_servers={}",
        "--disable",
        "computer_use",
        "shell_tool",
        "unified_exec",
        "--model",
        "gpt-test",
        'model_reasoning_effort="low"',
        "-",
      ]),
    );
    expect(invocation?.args).not.toContain(RUNTIME_READINESS_PROMPT);
    expect(String(invocation?.cwd)).toContain("first-tree-readiness-");
  });

  it("fails closed for every Codex item outside passive response events", () => {
    expect(isSafeCodexReadinessItemType("agent_message")).toBe(true);
    expect(isSafeCodexReadinessItemType("reasoning")).toBe(true);
    expect(isSafeCodexReadinessItemType("error")).toBe(true);
    expect(isSafeCodexReadinessItemType("computer_use")).toBe(false);
    expect(isSafeCodexReadinessItemType("future_tool_type")).toBe(false);
  });

  it("classifies Codex host-identity login failure without returning provider output", async () => {
    const result = await verifyCodexReadiness(
      { signal: signal() },
      {
        resolveBinary: async () => ({
          ok: true,
          binary: "/opt/codex",
          runtimeSource: "bundled",
          runtimePath: null,
          version: "0.144.1",
        }),
        runCli: async () => ({
          exitCode: 1,
          completed: false,
          replied: false,
          unsafe: false,
          authFailure: true,
          failed: true,
        }),
      },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "needs_login", message: "Codex authentication is required." },
    });
  });

  it("keeps an ambiguous Codex 403 as a provider failure", () => {
    expect(classifyCodexReadinessAuthText("HTTP 403 Forbidden from the configured proxy")).toBe(false);
    expect(classifyCodexReadinessAuthText("HTTP 401 Unauthorized")).toBe(true);
    expect(classifyCodexReadinessAuthText("invalid API key")).toBe(true);
  });

  it("hard-stops an uncooperative Codex process and permits the next run", async () => {
    const controller = new AbortController();
    const first = runCodexCli({
      binary: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      prompt: "",
      signal: controller.signal,
      terminationGraceMs: 25,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(first).resolves.toMatchObject({ completed: false, replied: false });

    const second = await runCodexCli({
      binary: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message'}}));" +
          "console.log(JSON.stringify({type:'turn.completed'}));",
      ],
      cwd: process.cwd(),
      prompt: "",
      signal: signal(),
      terminationGraceMs: 25,
    });
    expect(second).toMatchObject({ exitCode: 0, completed: true, replied: true, failed: false });
  });
});
