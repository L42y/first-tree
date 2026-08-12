import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isCodexAuthError } from "../../handlers/auth-error-hint.js";
import {
  RUNTIME_READINESS_PROMPT,
  type RuntimeReadinessExecutionResult,
  type RuntimeReadinessInput,
  withIsolatedReadinessWorkspace,
} from "../readiness.js";
import { resolveCodexRuntimeBinary } from "./capability.js";

type CodexCliRunResult = {
  exitCode: number | null;
  completed: boolean;
  replied: boolean;
  unsafe: boolean;
  authFailure: boolean;
  failed: boolean;
};

type CodexCliRunInput = {
  binary: string;
  args: string[];
  cwd: string;
  prompt: string;
  signal: AbortSignal;
};

export type CodexReadinessDeps = {
  resolveBinary?: typeof resolveCodexRuntimeBinary;
  runCli?: (input: CodexCliRunInput) => Promise<CodexCliRunResult>;
};

function configArg(key: string, value: string | boolean | Record<string, never>): string {
  return `${key}=${JSON.stringify(value)}`;
}

function codexArgs(input: RuntimeReadinessInput): string[] {
  const disabledFeatures = [
    "apps",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "code_mode_host",
    "computer_use",
    "goals",
    "hooks",
    "image_generation",
    "in_app_browser",
    "multi_agent",
    "plugin_sharing",
    "plugins",
    "remote_plugin",
    "shell_snapshot",
    "shell_tool",
    "skill_mcp_dependency_install",
    "tool_call_mcp_elicitation",
    "tool_suggest",
    "unified_exec",
    "workspace_dependencies",
  ];
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    // Auth still comes from CODEX_HOME, but arbitrary user hooks/plugins/tool
    // settings cannot enter this controlled verification turn.
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-c",
    configArg("approval_policy", "never"),
    "-c",
    configArg("mcp_servers", {}),
    "-c",
    configArg("web_search", "disabled"),
  ];
  for (const feature of disabledFeatures) args.push("--disable", feature);
  if (input.config?.model) args.push("--model", input.config.model);
  if (input.config?.reasoningEffort) {
    args.push("-c", configArg("model_reasoning_effort", input.config.reasoningEffort));
  }
  if (input.config?.serviceTier) args.push("-c", configArg("service_tier", input.config.serviceTier));
  // A lone dash keeps the prompt out of argv/process listings and makes the
  // official CLI read it from stdin.
  args.push("-");
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function eventItemType(event: Record<string, unknown>): string | null {
  const item = asRecord(event.item);
  return typeof item?.type === "string" ? item.type : null;
}

/** Only passive response items are allowed; every new/unknown item fails closed. */
export function isSafeCodexReadinessItemType(type: string | null): boolean {
  return type === "agent_message" || type === "reasoning" || type === "error";
}

function classifyAuthText(text: string): boolean {
  return (
    isCodexAuthError(text) ||
    /(?:^|\D)(?:401|403)(?:\D|$)|unauthori[sz]ed|not logged in|login required|invalid.*(?:api key|credential)/iu.test(
      text,
    )
  );
}

async function runCodexCli(input: CodexCliRunInput): Promise<CodexCliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let completed = false;
    let replied = false;
    let unsafe = false;
    let failed = false;
    let authFailure = false;
    let authTail = "";
    let settled = false;

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      resolve({
        exitCode,
        completed,
        replied,
        unsafe,
        authFailure,
        failed,
      });
    };
    const abort = () => child.kill("SIGTERM");
    if (input.signal.aborted) abort();
    else input.signal.addEventListener("abort", abort, { once: true });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = asRecord(JSON.parse(line));
        if (!event || typeof event.type !== "string") return;
        const itemType = eventItemType(event);
        if (itemType !== null && !isSafeCodexReadinessItemType(itemType)) unsafe = true;
        if (event.type === "item.completed" && itemType === "agent_message") replied = true;
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.failed" || event.type === "error") {
          failed = true;
          const error = asRecord(event.error);
          const message = typeof event.message === "string" ? event.message : error?.message;
          if (typeof message === "string" && classifyAuthText(message)) authFailure = true;
        }
      } catch {
        // Ignore non-JSON diagnostic lines. stderr still feeds bounded auth
        // classification, and no raw provider output crosses this function.
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      authTail = `${authTail}${chunk.toString()}`.slice(-512);
      if (classifyAuthText(authTail)) authFailure = true;
    });
    child.once("error", reject);
    child.once("close", (code) => settle(code));
    child.stdin.end(input.prompt);
  });
}

function providerFailure(needsLogin: boolean): RuntimeReadinessExecutionResult {
  return {
    ok: false,
    error: {
      code: needsLogin ? "needs_login" : "provider_error",
      message: needsLogin ? "Codex authentication is required." : "Codex readiness turn failed.",
    },
  };
}

/** Run one ephemeral Codex CLI turn with the same binary and host identity as real work. */
export async function verifyCodexReadiness(
  input: RuntimeReadinessInput,
  deps: CodexReadinessDeps = {},
): Promise<RuntimeReadinessExecutionResult> {
  return withIsolatedReadinessWorkspace(async (cwd) => {
    try {
      const resolution = await (deps.resolveBinary ?? resolveCodexRuntimeBinary)();
      if (!resolution.ok) return providerFailure(false);
      const result = await (deps.runCli ?? runCodexCli)({
        binary: resolution.binary,
        args: codexArgs(input),
        cwd,
        prompt: RUNTIME_READINESS_PROMPT,
        signal: input.signal,
      });
      if (input.signal.aborted) return { ok: false, error: { code: "cancelled" } };
      if (result.unsafe) {
        return {
          ok: false,
          error: { code: "unsafe_activity", message: "Codex attempted to use a tool during readiness." },
        };
      }
      if (result.exitCode === 0 && result.completed && result.replied && !result.failed) return { ok: true };
      return providerFailure(result.authFailure);
    } catch {
      if (input.signal.aborted) return { ok: false, error: { code: "cancelled" } };
      return providerFailure(false);
    }
  });
}
