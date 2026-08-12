import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  RUNTIME_READINESS_PROMPT,
  type RuntimeReadinessExecutionResult,
  type RuntimeReadinessInput,
  withIsolatedReadinessWorkspace,
} from "../readiness.js";
import { resolveClaudeCodeExecutable } from "./executable.js";
import { detectClaudeAuthFailure } from "./index.js";

type ClaudeReadinessQuery = (input: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export type ClaudeReadinessDeps = {
  runQuery?: ClaudeReadinessQuery;
  resolveExecutable?: typeof resolveClaudeCodeExecutable;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assistantUsedTool(message: SDKMessage): boolean {
  if (message.type !== "assistant") return false;
  const payload = asRecord(message);
  const nested = asRecord(payload?.message);
  const content = nested?.content;
  return Array.isArray(content) && content.some((item) => asRecord(item)?.type === "tool_use");
}

function isClaudeAuthText(message: string): boolean {
  return /invalid api key|authentication_failed|not logged in|please run \/login|oauth.*(?:expired|revoked)/iu.test(
    message,
  );
}

function failureResult(message: string): RuntimeReadinessExecutionResult {
  const needsLogin = isClaudeAuthText(message);
  return {
    ok: false,
    error: {
      code: needsLogin ? "needs_login" : "provider_error",
      message: needsLogin ? "Claude authentication is required." : "Claude readiness turn failed.",
    },
  };
}

/** Run one no-tools Claude SDK turn with filesystem settings disabled. */
export async function verifyClaudeCodeReadiness(
  input: RuntimeReadinessInput,
  deps: ClaudeReadinessDeps = {},
): Promise<RuntimeReadinessExecutionResult> {
  const runQuery = deps.runQuery ?? query;
  const resolution = (deps.resolveExecutable ?? resolveClaudeCodeExecutable)({ includeLoginShell: false });

  return withIsolatedReadinessWorkspace(async (cwd) => {
    let assistantError: string | null = null;
    let authFailure = false;
    try {
      const messages = runQuery({
        prompt: RUNTIME_READINESS_PROMPT,
        options: {
          cwd,
          abortController: abortControllerFor(input.signal),
          maxTurns: 1,
          tools: [],
          allowedTools: [],
          disallowedTools: [],
          mcpServers: {},
          agents: {},
          skills: [],
          settingSources: [],
          permissionMode: "dontAsk",
          persistSession: false,
          ...(input.config?.model ? { model: input.config.model } : {}),
          ...(resolution.path ? { pathToClaudeCodeExecutable: resolution.path } : {}),
        },
      });
      for await (const message of messages) {
        if (detectClaudeAuthFailure(message)) authFailure = true;
        if (assistantUsedTool(message)) {
          return {
            ok: false,
            error: { code: "unsafe_activity", message: "Claude attempted to use a tool during readiness." },
          };
        }
        if (message.type === "assistant") {
          const record = asRecord(message);
          if (typeof record?.error === "string") assistantError = record.error;
        }
        if (message.type !== "result") continue;
        if (message.subtype === "success" && !message.is_error) return { ok: true };
        const record = asRecord(message);
        const status = record?.api_error_status;
        const errors = Array.isArray(record?.errors)
          ? record.errors.filter((item): item is string => typeof item === "string")
          : [];
        if (status === 401 || status === 403 || errors.some(isClaudeAuthText)) {
          authFailure = true;
        }
        return failureResult(authFailure ? "authentication_failed" : (assistantError ?? message.subtype));
      }
      return failureResult(authFailure ? "authentication_failed" : "Claude readiness turn ended without a result.");
    } catch (err) {
      if (input.signal.aborted) return { ok: false, error: { code: "cancelled" } };
      return failureResult(err instanceof Error ? err.message : String(err));
    }
  });
}

/** The SDK requires an AbortController rather than a bare AbortSignal. */
function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
}
