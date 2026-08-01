import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type ToolFileRef,
} from "@first-tree/shared";
import { ensureAgentBootstrap } from "../../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../../runtime/agent-config-cache.js";
import { fetchChatContext } from "../../runtime/chat-context.js";
import { renderChatContextPrompt, renderRuntimeOutputContract } from "../../runtime/chat-context-section.js";
import {
  type ContextTreeAttribution,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
} from "../../runtime/context-tree-file-refs.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../runtime/handler.js";
import { type ReconciledTeamSkill, reconcileManagedSkillsForConfig } from "../../runtime/managed-skills.js";
import {
  isSupportedPiVersion,
  PI_SUPPORTED_VERSION_RANGE,
  parsePiVersionOutput,
  resolvePiRuntimeBinary,
} from "../../runtime/pi-binary.js";
import { ProviderAttempt, type ProviderAttemptSettlement } from "../../runtime/provider-attempt.js";
import {
  createDefaultProviderProcessSupervisor,
  type ProviderProcessSupervisor,
  supportsDefaultProviderProcessSupervision,
} from "../../runtime/provider-process-supervisor.js";
import { maxProviderTurnRetryAttempts } from "../../runtime/provider-retry-policy.js";
import { redactErrorPreview } from "../../runtime/redact-error-preview.js";
import {
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  readSessionBriefingFingerprint,
  writeSessionBriefingFingerprint,
} from "../../runtime/session-briefing-fingerprint.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../../runtime/source-repos.js";
import { teamSkillBundleResolverFromSdk } from "../../runtime/team-skill-bundle-resolver.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../../runtime/workspace.js";
import { chunkAssistantText } from "../assistant-text.js";
import { formatAuthHint, isPiAuthError } from "../auth-error-hint.js";
import { buildPiRpcArgs, PiRpcClient } from "./rpc-client.js";

const RESULT_PREVIEW_LIMIT = 400;
const VERSION_GATE_TIMEOUT_MS = 30_000;
const PI_SESSIONS_DIR = ".first-tree-workspace/pi-sessions";
const PI_SKILLS_DIR = ".agents/skills";

export function stablePiSessionId(agentId: string, chatId: string): string {
  return createHash("sha256").update(`first-tree:${agentId}:${chatId}`).digest("hex").slice(0, 32);
}

export { buildPiRpcArgs } from "./rpc-client.js";

type ActiveTool = {
  name: string;
  args: unknown;
  startedAt: number;
  refs: ToolFileRef[];
};

type TurnObservation = {
  assistantText: string;
  settled: boolean;
  error: string | null;
  thinkingEmitted: boolean;
  unsafeToolEffectStarted: boolean;
  usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null;
};

type PreparedSession = {
  payload: AgentRuntimeConfigPayload;
  workspaceCwd: string;
  sessionId: string;
  sessionDir: string;
  skillsDir: string;
  briefing: string;
};

class PiBinaryVerifyTransientError extends Error {
  constructor(reason: string) {
    super(`pi --version smoke check did not complete (transient host condition); will retry. Detail: ${reason}`);
    this.name = "PiBinaryVerifyTransientError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function preview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, RESULT_PREVIEW_LIMIT);
  try {
    return JSON.stringify(value).slice(0, RESULT_PREVIEW_LIMIT);
  } catch {
    return String(value).slice(0, RESULT_PREVIEW_LIMIT);
  }
}

function inputPathForTool(_name: string, args: unknown): string | null {
  const record = asRecord(args);
  if (!record) return null;
  const keys = ["path", "file_path", "filePath", "file"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function piToolIsReadOnly(name: string): boolean {
  return name === "read" || name === "Grep" || name === "Glob";
}

export const createPiHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider ?? "pi");
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextTreePath = (config.contextTreePath as string | undefined) ?? null;
  const contextTreeRepoUrl = (config.contextTreeRepoUrl as string | undefined) ?? null;
  const contextTreeBranch = (config.contextTreeBranch as string | undefined) ?? null;
  const platform = (config.piPlatform as NodeJS.Platform | undefined) ?? process.platform;
  const resolveBinary =
    (config.piBinaryResolver as typeof resolvePiRuntimeBinary | undefined) ?? resolvePiRuntimeBinary;
  const processSupervisor =
    (config.providerProcessSupervisor as ProviderProcessSupervisor | undefined) ??
    createDefaultProviderProcessSupervisor(platform);
  const maxRetries = maxProviderTurnRetryAttempts();

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let rpcClient: PiRpcClient | null = null;
  let binary: string | null = null;
  let sessionId: string | null = null;
  let activePayload: AgentRuntimeConfigPayload | null = null;
  let reconciledTeamSkills: readonly ReconciledTeamSkill[] = [];
  let sourceReposForPrompt: ReturnType<typeof declaredSourceRepos> = [];
  let sessionActive = false;
  let initialTurnPreparing = false;
  let currentTurnPromise: Promise<boolean> | null = null;
  let streaming = false;
  let versionReady = false;
  let pendingChatContextPrompt: string | null = null;
  let drainScheduled = false;
  let drainInProgress = false;
  const queuedMessages: Array<{ message: SessionMessage; token: DeliveryToken }> = [];
  const activeTools = new Map<string, ActiveTool>();

  function emitSettlement(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "runtime", message: encodeProviderRetryEventMessage(settlement.eventPayload) },
    });
  }

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    for (const entry of payload.env) env[entry.key] = entry.value;
    const merged = sessionCtx.buildAgentEnv(env);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  function buildBriefing(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload, workspaceCwd: string): string {
    return buildAgentBriefing({
      identity: sessionCtx.agent,
      payload,
      workspacePath: workspaceCwd,
      sourceRepos: sourceReposForPrompt,
      contextTreePath,
      contextTreeRepoUrl,
      contextTreeBranch,
      teamSkills: reconciledTeamSkills,
    });
  }

  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<string | null> {
    try {
      return renderChatContextPrompt(await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent));
    } catch (error) {
      sessionCtx.log(`fetchChatContext failed: ${error instanceof Error ? error.message : String(error)}`);
      return renderChatContextPrompt(undefined);
    }
  }

  function nativeToolRefs(name: string, args: unknown, workspaceCwd: string): ToolFileRef[] {
    const lowered = name.toLowerCase();
    if (lowered === "bash") {
      const command = asRecord(args)?.command;
      if (typeof command !== "string") return [];
      const commandCwd = asRecord(args)?.cwd;
      return toolFileRefsFromShellCommand({
        command,
        cwd: typeof commandCwd === "string" ? commandCwd : workspaceCwd,
        contextTreePath,
        contextTreeRepoUrl,
        contextTreeBranch,
      });
    }
    if (lowered !== "read" && lowered !== "write" && lowered !== "edit") return [];
    const filePath = inputPathForTool(name, args);
    if (!filePath) return [];
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceCwd, filePath);
    const attribution: ContextTreeAttribution = { contextTreePath, contextTreeRepoUrl };
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, attribution);
    const write = lowered === "write" || lowered === "edit";
    return [
      {
        origin: write ? "file_change" : "tool_arg",
        localPath: absolutePath,
        pathKind: "file",
        ...(contextTreeRepoUrl && repoRelativePath
          ? {
              repoUrl: contextTreeRepoUrl,
              ...(contextTreeBranch ? { repoBranch: contextTreeBranch } : {}),
              repoRelativePath,
            }
          : {}),
      },
    ];
  }

  function emitToolCall(
    sessionCtx: SessionContext,
    toolCallId: string,
    tool: ActiveTool,
    status: "pending" | "ok" | "error",
    result?: unknown,
  ): void {
    sessionCtx.emitEvent({
      kind: "tool_call",
      payload: {
        toolUseId: toolCallId,
        name: tool.name,
        args: tool.args,
        status,
        ...(status !== "pending" ? { durationMs: Math.max(0, Date.now() - tool.startedAt) } : {}),
        ...(result !== undefined ? { resultPreview: preview(result) } : {}),
        ...(tool.refs.length > 0 ? { toolFileRefs: tool.refs } : {}),
      },
    });
  }

  function rejectMcpConfiguration(payload: AgentRuntimeConfigPayload): void {
    if (payload.mcpServers.length === 0) return;
    throw new Error(
      "Pi runtime provider mismatch: managed MCP servers are not supported for Pi agents. " +
        "Remove MCP server entries from the agent runtime configuration or choose a different runtime provider.",
    );
  }

  async function runVersionGate(
    activeBinary: string,
    env: Record<string, string>,
    workspaceCwd: string,
    _sessionCtx: SessionContext,
  ): Promise<void> {
    if (versionReady) return;
    const outcome = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      spawnError?: Error;
      timedOut?: boolean;
    }>((resolveOutcome) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (value: {
        exitCode: number | null;
        stdout: string;
        stderr: string;
        spawnError?: Error;
        timedOut?: boolean;
      }) => {
        if (settled) return;
        settled = true;
        resolveOutcome(value);
      };
      try {
        const supervised = processSupervisor.spawn({
          command: activeBinary,
          args: ["--version"],
          label: "pi compatible-version gate",
          timeoutMs: VERSION_GATE_TIMEOUT_MS,
          options: {
            cwd: workspaceCwd,
            env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            ...(platform === "win32" ? {} : { detached: true }),
          },
        });
        const child = supervised.child;
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", (error) => finish({ exitCode: null, stdout, stderr, spawnError: error }));
        child.on("close", (exitCode) => finish({ exitCode, stdout, stderr }));
      } catch (error) {
        finish({
          exitCode: null,
          stdout,
          stderr,
          spawnError: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });

    if (outcome.spawnError) {
      const code = (outcome.spawnError as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") throw new PiBinaryVerifyTransientError("`pi --version` timed out");
      throw outcome.spawnError;
    }
    const version = parsePiVersionOutput(`${outcome.stdout}\n${outcome.stderr}`);
    if (outcome.exitCode !== 0 || !isSupportedPiVersion(version)) {
      const detail = redactErrorPreview(outcome.stderr || outcome.stdout || `exit ${outcome.exitCode}`, 800);
      throw new Error(
        `Pi runtime provider mismatch: unsupported version. First Tree requires ${PI_SUPPORTED_VERSION_RANGE}; ` +
          `observed ${version ?? "no parseable version"}. ${detail}`,
      );
    }
    versionReady = true;
  }

  async function ensureRpcClient(prepared: PreparedSession, sessionCtx: SessionContext): Promise<PiRpcClient> {
    if (rpcClient && !rpcClient.isClosed) return rpcClient;
    if (!binary) throw new Error("Pi binary is not resolved");
    await mkdir(prepared.sessionDir, { recursive: true });
    const env = buildEnv(sessionCtx, prepared.payload);
    await runVersionGate(binary, env, prepared.workspaceCwd, sessionCtx);
    const args = buildPiRpcArgs({
      sessionId: prepared.sessionId,
      sessionDir: prepared.sessionDir,
      skillsDir: prepared.skillsDir,
      ...(prepared.payload.model ? { model: prepared.payload.model } : {}),
    });
    rpcClient = await PiRpcClient.start({
      binary,
      args,
      cwd: prepared.workspaceCwd,
      env,
      supervisor: processSupervisor,
      label: "pi rpc session",
      onEvent: (event) => {
        if (ctx) processPiEvent(event, ctx);
      },
      onLog: (message) => sessionCtx.log(message),
    });
    const state = await rpcClient.getState();
    if (!state.success) {
      const message = state.error ?? "pi get_state failed";
      await closeRpcClient();
      throw new Error(message);
    }
    return rpcClient;
  }

  async function closeRpcClient(): Promise<void> {
    const client = rpcClient;
    rpcClient = null;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      ctx?.log(`pi rpc close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function processPiEvent(event: Record<string, unknown>, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "message_update") {
      const update = asRecord(event.update) ?? asRecord(event.payload);
      if (update?.type === "text_delta" || event.subtype === "text_delta") {
        streaming = true;
        const delta =
          typeof update?.delta === "string"
            ? update.delta
            : typeof event.delta === "string"
              ? event.delta
              : typeof event.text === "string"
                ? event.text
                : "";
        if (delta) {
          if (turnObservation) turnObservation.assistantText += delta;
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: delta } });
        }
      }
      return;
    }
    if (type === "thinking_delta") {
      streaming = true;
      if (turnObservation && !turnObservation.thinkingEmitted) {
        turnObservation.thinkingEmitted = true;
        sessionCtx.emitEvent({ kind: "thinking", payload: {} });
      }
      return;
    }
    if (type === "tool_execution_start") {
      streaming = true;
      const toolCallId = String(event.toolCallId ?? event.id ?? `pi-tool-${activeTools.size + 1}`);
      const name = typeof event.name === "string" ? event.name : typeof event.tool === "string" ? event.tool : "tool";
      const args = event.args ?? event.input ?? {};
      const tool: ActiveTool = {
        name,
        args,
        startedAt: Date.now(),
        refs: cwd ? nativeToolRefs(name, args, cwd) : [],
      };
      activeTools.set(toolCallId, tool);
      if (turnObservation && !piToolIsReadOnly(name)) turnObservation.unsafeToolEffectStarted = true;
      emitToolCall(sessionCtx, toolCallId, tool, "pending");
      return;
    }
    if (type === "tool_execution_update") {
      return;
    }
    if (type === "tool_execution_end") {
      const toolCallId = String(event.toolCallId ?? event.id ?? "");
      const tool = activeTools.get(toolCallId);
      if (!tool) return;
      const isError = event.isError === true || event.success === false;
      emitToolCall(sessionCtx, toolCallId, tool, isError ? "error" : "ok", event.result ?? event.output);
      activeTools.delete(toolCallId);
      return;
    }
    if (type.startsWith("auto_retry")) {
      const message = typeof event.message === "string" ? event.message : type;
      sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: message.slice(0, 2000) } });
      return;
    }
    if (type === "agent_settled") {
      streaming = false;
      if (turnObservation) {
        turnObservation.settled = true;
        const usage = asRecord(event.usage) ?? asRecord(event.message);
        if (usage) {
          turnObservation.usage = {
            inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : undefined,
            cachedInputTokens: typeof usage.cachedInputTokens === "number" ? usage.cachedInputTokens : undefined,
            outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : undefined,
          };
        }
        resolveTurnSettled?.();
      }
      resolveAbortResponse?.();
      return;
    }
    if (type === "agent_end") {
      return;
    }
  }

  let turnObservation: TurnObservation | null = null;
  let resolveTurnSettled: (() => void) | null = null;
  let resolveAbortResponse: (() => void) | null = null;

  async function waitForSettled(): Promise<void> {
    if (turnObservation?.settled) return;
    await new Promise<void>((resolvePromise) => {
      resolveTurnSettled = resolvePromise;
    });
  }

  async function waitForAbortAndSettled(): Promise<void> {
    const settledPromise = turnObservation?.settled ? Promise.resolve() : waitForSettled();
    const abortPromise = new Promise<void>((resolvePromise) => {
      resolveAbortResponse = resolvePromise;
    });
    await Promise.all([settledPromise, abortPromise]);
    resolveAbortResponse = null;
    resolveTurnSettled = null;
  }

  function formatPiFailure(message: string): string {
    return isPiAuthError(message) ? formatAuthHint("pi", message) : message;
  }

  async function executeTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    client: PiRpcClient,
  ): Promise<boolean> {
    turnObservation = {
      assistantText: "",
      settled: false,
      error: null,
      thinkingEmitted: false,
      unsafeToolEffectStarted: false,
      usage: null,
    };
    resolveTurnSettled = null;
    resolveAbortResponse = null;
    activeTools.clear();
    streaming = false;

    for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
      if (!sessionActive) {
        token.retry(messages, "pi_turn_cancelled");
        return false;
      }
      const attempt = new ProviderAttempt({
        provider: runtimeProvider,
        scope: "provider_turn",
        source: "stream",
      });
      let promptResponse: Awaited<ReturnType<PiRpcClient["prompt"]>> | null = null;
      let thrown: Error | null = null;
      try {
        promptResponse = await client.prompt(prompt);
      } catch (error) {
        thrown = error instanceof Error ? error : new Error(String(error));
      }

      if (!sessionActive) {
        token.retry(messages, "pi_turn_cancelled");
        return false;
      }

      if (thrown) {
        attempt.recordSignal({ kind: "local_error", error: thrown });
        const settlement = attempt.settle({ attempt: attemptNumber });
        if (settlement?.decision.action === "retry") {
          emitSettlement(sessionCtx, settlement);
          const delayMs = settlement.decision.delayMs;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
          continue;
        }
        if (settlement) emitSettlement(sessionCtx, settlement);
        const formatted = formatPiFailure(thrown.message);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await token.complete(messages, {
          status: "error",
          completion: "consumed",
          reason: settlement?.decision.reasonCode ?? "pi_transport_error",
        });
        return false;
      }

      if (!promptResponse?.success) {
        const failure = promptResponse?.error ?? "pi prompt rejected";
        const formatted = formatPiFailure(failure);
        attempt.recordSignal({ kind: "provider_error", error: failure, messagePreview: formatted });
        const settlement = attempt.settle({ attempt: attemptNumber });
        if (settlement) emitSettlement(sessionCtx, settlement);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await token.complete(messages, {
          status: "error",
          completion: "consumed",
          reason: isPiAuthError(failure) ? "credential" : (settlement?.decision.reasonCode ?? "pi_preflight_failed"),
        });
        return false;
      }

      token.processingStarted(messages);
      await waitForSettled();

      if (!sessionActive) {
        token.retry(messages, "pi_turn_cancelled");
        return false;
      }

      if (!turnObservation.settled) {
        token.retry(messages, "pi_turn_not_settled");
        return false;
      }

      const assistantText = turnObservation.assistantText;
      for (const chunk of chunkAssistantText(assistantText)) {
        if (chunk.trim()) sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
      }
      if (turnObservation.usage) {
        sessionCtx.emitEvent({
          kind: "token_usage",
          payload: {
            provider: "pi",
            model: activePayload?.model || "pi-default",
            inputTokens: turnObservation.usage.inputTokens ?? 0,
            cachedInputTokens: turnObservation.usage.cachedInputTokens ?? 0,
            outputTokens: turnObservation.usage.outputTokens ?? 0,
          },
        });
      }
      try {
        await sessionCtx.forwardResult(assistantText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "runtime", message: `forward failed: ${message}` } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await token.complete(messages, { status: "error", completion: "consumed", reason: "forward_failed" });
        return false;
      }
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
      await token.complete(messages, { status: "success" });
      if (pendingChatContextPrompt !== null) pendingChatContextPrompt = null;
      return true;
    }

    token.retry(messages, "pi_retry_loop_exited");
    return false;
  }

  async function runTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    client: PiRpcClient,
  ): Promise<boolean> {
    const promise = executeTurn(prompt, sessionCtx, messages, token, client);
    currentTurnPromise = promise;
    try {
      return await promise;
    } finally {
      if (currentTurnPromise === promise) currentTurnPromise = null;
      turnObservation = null;
      resolveTurnSettled = null;
      resolveAbortResponse = null;
      streaming = false;
      scheduleQueuedMessagesDrain();
    }
  }

  async function mergeAndRun(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
    prepared: PreparedSession,
  ): Promise<void> {
    const prompts: string[] = [];
    let failed = false;
    for (const entry of drained) {
      try {
        prompts.push(await sessionCtx.formatInboundContent(entry.message));
      } catch (error) {
        failed = true;
        sessionCtx.log(
          `pi queued message formatting failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failed || prompts.length === 0) {
      for (const entry of drained) entry.token.retry(entry.message, "pi_queued_turn_format_failed");
      return;
    }
    const token = drained[0]?.token;
    if (!token) return;
    const client = await ensureRpcClient(prepared, sessionCtx);
    rejectMcpConfiguration(prepared.payload);
    await runTurn(
      prompts.join("\n\n"),
      sessionCtx,
      drained.map((entry) => entry.message),
      token,
      client,
    );
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress || initialTurnPreparing) return;
    if (!sessionActive || !ctx || !cwd || !sessionId || currentTurnPromise || queuedMessages.length === 0) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (!sessionActive || !ctx || !cwd || !sessionId || currentTurnPromise || queuedMessages.length === 0) return;
      const sessionCtx = ctx;
      const drained = queuedMessages.splice(0);
      drainInProgress = true;
      void (async () => {
        try {
          const payload = activePayload ?? { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
          const prepared: PreparedSession = {
            payload,
            workspaceCwd: cwd!,
            sessionId: sessionId!,
            sessionDir: join(cwd!, PI_SESSIONS_DIR),
            skillsDir: join(cwd!, PI_SKILLS_DIR),
            briefing: buildBriefing(sessionCtx, payload, cwd!),
          };
          await mergeAndRun(drained, sessionCtx, prepared);
        } catch (error) {
          sessionCtx.log(`pi queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          for (const entry of drained) entry.token.retry(entry.message, "pi_queued_turn_failed");
        }
      })().finally(() => {
        drainInProgress = false;
        scheduleQueuedMessagesDrain();
      });
    });
  }

  function retryQueuedMessages(reason: string): void {
    for (const entry of queuedMessages.splice(0)) entry.token.retry(entry.message, reason);
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<PreparedSession> {
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error("landing campaign trial agents require the codex app-server workspace-only runtime");
    }
    if (!supportsDefaultProviderProcessSupervision(platform)) {
      throw new Error(
        "Pi runtime provider is not supported on Windows in V1 (macOS/Linux only); First Tree fails closed on this platform.",
      );
    }
    ctx = sessionCtx;
    const workspaceCwd = acquireAgentHome(workspaceRoot);
    cwd = workspaceCwd;
    const resolvedSessionId = stablePiSessionId(sessionCtx.agent.agentId, sessionCtx.chatId);
    sessionId = resolvedSessionId;

    let runtimeConfig: AgentRuntimeConfig | null = null;
    let payload: AgentRuntimeConfigPayload | null = null;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
      payload = runtimeConfig.payload;
    }
    const payloadResolved = payload !== null;
    payload ??= { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
    if (payload.kind !== "pi") {
      throw new Error(`runtime provider mismatch: expected pi, got ${payload.kind}`);
    }
    rejectMcpConfiguration(payload);

    const resolution = resolveBinary(process.env);
    if (!resolution.ok) {
      throw new Error(resolution.error);
    }
    binary = resolution.binary;
    sessionCtx.log(`Pi binary: ${resolution.binary}`);

    sourceReposForPrompt = declaredSourceRepos(workspaceCwd, payload);
    reconciledTeamSkills = (
      await reconcileManagedSkillsForConfig(
        workspaceCwd,
        runtimeProvider,
        runtimeConfig,
        sessionCtx.log,
        teamSkillBundleResolverFromSdk(sessionCtx.sdk),
      )
    ).teamSkills;
    const briefing = buildBriefing(sessionCtx, payload, workspaceCwd);
    ensureAgentBootstrap({
      workspace: workspaceCwd,
      sessionCtx,
      contextTreePath,
      briefing,
      currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, payloadResolved),
    });
    markWorkspaceInitComplete(workspaceCwd);

    const chatContext = await fetchChatContextOrLog(sessionCtx);
    pendingChatContextPrompt = [renderRuntimeOutputContract(), chatContext].filter(Boolean).join("\n\n");
    activePayload = payload;
    sessionActive = true;

    return {
      payload,
      workspaceCwd,
      sessionId: resolvedSessionId,
      sessionDir: join(workspaceCwd, PI_SESSIONS_DIR),
      skillsDir: join(workspaceCwd, PI_SKILLS_DIR),
      briefing,
    };
  }

  async function buildTurnPrompt(
    _sessionCtx: SessionContext,
    basePrompt: string,
    prepared: PreparedSession,
  ): Promise<string> {
    const parts: string[] = [];
    if (pendingChatContextPrompt) parts.push(pendingChatContextPrompt);
    const fingerprint = computeBriefingFingerprint(prepared.briefing);
    if (readSessionBriefingFingerprint(prepared.workspaceCwd, prepared.sessionId) !== fingerprint) {
      parts.push(buildBriefingUpdateNotice(join(prepared.workspaceCwd, "AGENTS.md")));
    }
    parts.push(basePrompt);
    return parts.join("\n\n");
  }

  async function cleanupFailedInitialization(): Promise<void> {
    sessionActive = false;
    retryQueuedMessages("pi_initialization_failed");
    await closeRpcClient();
    cwd = null;
    ctx = null;
    sessionId = null;
    activePayload = null;
    sourceReposForPrompt = [];
    initialTurnPreparing = false;
    activeTools.clear();
    streaming = false;
  }

  return {
    async start(message, sessionCtx, token) {
      const explicitToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      let prepared: PreparedSession;
      try {
        prepared = await prepareSession(sessionCtx);
      } catch (error) {
        await cleanupFailedInitialization();
        throw error;
      }
      initialTurnPreparing = true;
      try {
        const client = await ensureRpcClient(prepared, sessionCtx);
        const basePrompt = await sessionCtx.formatInboundContent(message);
        const prompt = await buildTurnPrompt(sessionCtx, basePrompt, prepared);
        await runTurn(prompt, sessionCtx, [message], deliveryToken, client);
        writeSessionBriefingFingerprint(
          prepared.workspaceCwd,
          prepared.sessionId,
          computeBriefingFingerprint(prepared.briefing),
        );
      } catch (error) {
        if (error instanceof PiBinaryVerifyTransientError) {
          deliveryToken.retry([message], "pi_version_gate_transient");
          throw error;
        }
        await cleanupFailedInitialization();
        throw error;
      } finally {
        initialTurnPreparing = false;
        scheduleQueuedMessagesDrain();
      }
      return explicitToken
        ? { sessionId: prepared.sessionId, route: { kind: "owned", mode: "processing" } }
        : prepared.sessionId;
    },

    async resume(message, id, sessionCtx, token) {
      const explicitToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      let prepared: PreparedSession;
      try {
        prepared = await prepareSession(sessionCtx);
      } catch (error) {
        await cleanupFailedInitialization();
        throw error;
      }
      if (id !== prepared.sessionId) {
        sessionCtx.log(`pi resume ignored mismatched session id ${id}; using stable id ${prepared.sessionId}`);
      }
      if (message) {
        initialTurnPreparing = true;
        try {
          const client = await ensureRpcClient(prepared, sessionCtx);
          const basePrompt = await sessionCtx.formatInboundContent(message);
          const prompt = await buildTurnPrompt(sessionCtx, basePrompt, prepared);
          await runTurn(prompt, sessionCtx, [message], deliveryToken, client);
          writeSessionBriefingFingerprint(
            prepared.workspaceCwd,
            prepared.sessionId,
            computeBriefingFingerprint(prepared.briefing),
          );
        } catch (error) {
          if (error instanceof PiBinaryVerifyTransientError) {
            deliveryToken.retry([message], "pi_version_gate_transient");
            throw error;
          }
          await cleanupFailedInitialization();
          throw error;
        } finally {
          initialTurnPreparing = false;
          scheduleQueuedMessagesDrain();
        }
      } else {
        scheduleQueuedMessagesDrain();
      }
      return explicitToken
        ? {
            sessionId: prepared.sessionId,
            route: message ? { kind: "owned", mode: "processing" } : null,
          }
        : prepared.sessionId;
    },

    inject(message, token) {
      if (!ctx || !sessionActive) return { kind: "rejected", reason: "no_active_context", retryable: true };
      const deliveryToken = token ?? deliveryTokenFromSessionContext(ctx);
      if (streaming && rpcClient && !rpcClient.isClosed) {
        void (async () => {
          try {
            const preparedPayload = activePayload ?? { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
            rejectMcpConfiguration(preparedPayload);
            const formatted = await ctx?.formatInboundContent(message);
            const response = await rpcClient?.steer(formatted);
            if (!response.success) {
              const failure = response.error ?? "pi steer rejected";
              const formattedFailure = formatPiFailure(failure);
              ctx?.emitEvent({
                kind: "error",
                payload: { source: "sdk", message: formattedFailure.slice(0, 2000) },
              });
              await deliveryToken.terminalRejected([message], failure, {
                kind: "server_terminal_record",
                recordId: message.id,
              });
              return;
            }
            deliveryToken.processingStarted([message]);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            ctx?.log(`pi steer failed: ${messageText}`);
            deliveryToken.retry(message, "pi_steer_failed");
          }
        })();
        return { kind: "owned", mode: "processing" };
      }
      if (currentTurnPromise) {
        queuedMessages.push({ message, token: deliveryToken });
        scheduleQueuedMessagesDrain();
        return { kind: "owned", mode: "queued" };
      }
      queuedMessages.push({ message, token: deliveryToken });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason) {
      sessionActive = false;
      retryQueuedMessages(reason ?? "pi_suspend");
      if (streaming && rpcClient && !rpcClient.isClosed) {
        try {
          const response = await rpcClient.abort();
          if (!response.success) {
            ctx?.log(`pi abort during suspend failed: ${response.error ?? "unknown"}`);
          } else {
            resolveAbortResponse?.();
          }
          await waitForAbortAndSettled();
        } catch (error) {
          ctx?.log(`pi suspend abort failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await closeRpcClient();
      ctx = null;
      cwd = null;
      sessionId = null;
      activePayload = null;
      streaming = false;
    },

    async shutdown() {
      sessionActive = false;
      retryQueuedMessages("pi_shutdown");
      if (streaming && rpcClient && !rpcClient.isClosed) {
        try {
          const response = await rpcClient.abort();
          if (!response.success) {
            ctx?.log(`pi abort during shutdown failed: ${response.error ?? "unknown"}`);
          } else {
            resolveAbortResponse?.();
          }
          await waitForAbortAndSettled();
        } catch (error) {
          ctx?.log(`pi shutdown abort failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await closeRpcClient();
      ctx = null;
      cwd = null;
      sessionId = null;
      activePayload = null;
      streaming = false;
    },
  } satisfies AgentHandler;
};
