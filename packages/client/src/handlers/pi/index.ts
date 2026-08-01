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
import {
  type ContextTreeGitWriteTracker,
  createContextTreeGitWriteTracker,
} from "../../runtime/context-tree-git-status.js";
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
import { formatAuthHint, isPiAuthError } from "../auth-error-hint.js";
import { buildPiRpcArgs, PiRpcClient, PiRpcProtocolError, PiRpcTransportError } from "./rpc-client.js";

const RESULT_PREVIEW_LIMIT = 400;
const VERSION_GATE_TIMEOUT_MS = 30_000;
const PI_SESSIONS_DIR = ".first-tree-workspace/pi-sessions";
const PI_SKILLS_DIR = ".agents/skills";
const NORMAL_STOP_REASONS = new Set(["stop", "toolUse", "length"]);

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

type CustodyEntry = {
  messages: readonly SessionMessage[];
  token: DeliveryToken;
};

type PiUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };

type TurnObservation = {
  assistantText: string;
  settled: boolean;
  turnError: string | null;
  thinkingEmitted: boolean;
  unsafeToolEffectStarted: boolean;
  userVisibleEmitted: boolean;
  usage: PiUsage | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  autoRetryFailed: string | null;
  attempt: ProviderAttempt;
};

type PreparedSession = {
  payload: AgentRuntimeConfigPayload;
  workspaceCwd: string;
  sessionId: string;
  sessionDir: string;
  skillsDir: string;
  briefing: string;
};

export class PiBinaryVerifyTransientError extends Error {
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
  const lowered = name.toLowerCase();
  return lowered === "read" || lowered === "grep" || lowered === "find" || lowered === "ls";
}

function spawnScopedFingerprint(payload: AgentRuntimeConfigPayload, skillsDir: string): string {
  const envEntries = [...payload.env].map((entry) => `${entry.key}=${entry.value}`).sort();
  return JSON.stringify({
    model: payload.model ?? "",
    env: envEntries,
    skillsDir,
    gitRepos: payload.gitRepos ?? [],
  });
}

function normalizePiUsage(usage: Record<string, unknown> | null): PiUsage | null {
  if (!usage) return null;
  const input =
    typeof usage.input === "number" ? usage.input : typeof usage.inputTokens === "number" ? usage.inputTokens : null;
  const output =
    typeof usage.output === "number"
      ? usage.output
      : typeof usage.outputTokens === "number"
        ? usage.outputTokens
        : null;
  const cacheRead =
    typeof usage.cacheRead === "number"
      ? usage.cacheRead
      : typeof usage.cachedInputTokens === "number"
        ? usage.cachedInputTokens
        : typeof usage.cacheReadTokens === "number"
          ? usage.cacheReadTokens
          : 0;
  if (input === null && output === null) return null;
  return {
    inputTokens: input ?? 0,
    cachedInputTokens: cacheRead,
    outputTokens: output ?? 0,
  };
}

function readTurnUsage(observation: TurnObservation): PiUsage | null {
  // Break CFA: event callbacks assign usage after the loop resets it to null.
  return observation.usage;
}

function extractAssistantMessageFields(message: Record<string, unknown> | null): {
  usage: PiUsage | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
} {
  if (!message || message.role !== "assistant") {
    return { usage: null, provider: null, model: null, stopReason: null };
  }
  return {
    usage: normalizePiUsage(asRecord(message.usage)),
    provider: typeof message.provider === "string" ? message.provider : null,
    model: typeof message.model === "string" ? message.model : null,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
  };
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
  const versionGateTimeoutMs =
    typeof config.piVersionGateTimeoutMs === "number" ? config.piVersionGateTimeoutMs : VERSION_GATE_TIMEOUT_MS;
  const settlementTimeoutMs =
    typeof config.piSettlementTimeoutMs === "number" ? config.piSettlementTimeoutMs : undefined;

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
  const pendingSteerWork = new Set<Promise<void>>();
  const gitWriteTracker: ContextTreeGitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });
  let turnObservation: TurnObservation | null = null;
  let turnCustody: CustodyEntry[] = [];
  let activeSpawnFingerprint: string | null = null;

  async function awaitPendingSteers(): Promise<void> {
    while (pendingSteerWork.size > 0) {
      await Promise.all([...pendingSteerWork]);
    }
  }

  function emitSettlement(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "runtime", message: encodeProviderRetryEventMessage(settlement.eventPayload) },
    });
  }

  function updateReplaySafety(observation: TurnObservation): void {
    if (observation.unsafeToolEffectStarted) {
      observation.attempt.setReplaySafety("unsafe");
    } else if (observation.userVisibleEmitted) {
      observation.attempt.markUserVisibleOutput();
    } else {
      observation.attempt.setReplaySafety("pre_provider");
    }
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
    const record = asRecord(args);
    const pathCandidate =
      inputPathForTool(name, args) ??
      (typeof record?.path === "string"
        ? record.path
        : typeof record?.pattern === "string"
          ? record.pattern
          : typeof record?.target_directory === "string"
            ? record.target_directory
            : null);
    if (!pathCandidate) return [];
    if (
      lowered !== "read" &&
      lowered !== "write" &&
      lowered !== "edit" &&
      lowered !== "grep" &&
      lowered !== "find" &&
      lowered !== "ls"
    ) {
      return [];
    }
    const absolutePath = isAbsolute(pathCandidate) ? resolve(pathCandidate) : resolve(workspaceCwd, pathCandidate);
    const attribution: ContextTreeAttribution = { contextTreePath, contextTreeRepoUrl };
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, attribution);
    const write = lowered === "write" || lowered === "edit";
    const pathKind =
      lowered === "grep" || lowered === "find" || lowered === "ls" ? ("directory" as const) : ("file" as const);
    return [
      {
        origin: write ? "file_change" : "tool_arg",
        localPath: absolutePath,
        pathKind,
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

  function refsForCompletedTool(input: {
    ok: boolean;
    readOnly: boolean;
    providerRefs: ToolFileRef[];
    toolName: string;
    toolUseId: string;
  }): ToolFileRef[] | undefined {
    if (input.readOnly) return input.providerRefs.length > 0 ? input.providerRefs : undefined;
    if (!input.ok) {
      gitWriteTracker.captureBaseline();
      return undefined;
    }
    const gitStatusRefs = gitWriteTracker.refsForSuccessfulToolCall({
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      existingRefs: input.providerRefs,
    });
    const refs = [...input.providerRefs, ...gitStatusRefs];
    return refs.length > 0 ? refs : undefined;
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
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      spawnError?: Error;
      timedOut: boolean;
    }>((resolveOutcome) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
        spawnError?: Error;
        timedOut: boolean;
      }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveOutcome(value);
      };
      try {
        const supervised = processSupervisor.spawn({
          command: activeBinary,
          args: ["--version"],
          label: "pi compatible-version gate",
          timeoutMs: versionGateTimeoutMs,
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
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
          // If the child ignores TERM (or the test supervisor never auto-kills),
          // still surface the timeout without waiting forever.
          setTimeout(() => {
            finish({ exitCode: null, signal: "SIGTERM", stdout, stderr, timedOut: true });
          }, 50);
        }, versionGateTimeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", (error) =>
          finish({ exitCode: null, signal: null, stdout, stderr, spawnError: error, timedOut }),
        );
        child.on("close", (exitCode, signal) => finish({ exitCode, signal: signal ?? null, stdout, stderr, timedOut }));
      } catch (error) {
        finish({
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          spawnError: error instanceof Error ? error : new Error(String(error)),
          timedOut,
        });
      }
    });

    if (outcome.spawnError) {
      const code = (outcome.spawnError as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT" || outcome.timedOut) {
        throw new PiBinaryVerifyTransientError("`pi --version` timed out");
      }
      throw outcome.spawnError;
    }
    if (outcome.timedOut) {
      throw new PiBinaryVerifyTransientError("`pi --version` timed out");
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

  function validateGetState(response: Awaited<ReturnType<PiRpcClient["getState"]>>, expectedSessionId: string): void {
    if (!response.success) {
      throw new Error(response.error ?? "pi get_state failed");
    }
    const data = asRecord(response.data);
    if (!data) {
      throw new PiRpcProtocolError("pi get_state response missing data object");
    }
    const reported = data.sessionId;
    if (typeof reported !== "string" || reported.length === 0) {
      throw new PiRpcProtocolError("pi get_state response missing sessionId");
    }
    if (reported !== expectedSessionId) {
      throw new Error(`Pi session identity mismatch: expected ${expectedSessionId}, get_state reported ${reported}`);
    }
  }

  function assertConfiguredModel(state: Awaited<ReturnType<PiRpcClient["getState"]>>, model: string): void {
    if (!model) return;
    const data = asRecord(state.data);
    const reported = asRecord(data?.model);
    const reportedId = typeof reported?.id === "string" ? reported.id : null;
    const reportedProvider = typeof reported?.provider === "string" ? reported.provider : null;
    const composite =
      reportedProvider && reportedId ? `${reportedProvider}/${reportedId}` : (reportedId ?? reportedProvider);
    // Accept exact id, provider/id, or a configured value that ends with the model id.
    if (
      composite === model ||
      reportedId === model ||
      (reportedId !== null && (model.endsWith(`/${reportedId}`) || model === reportedId))
    ) {
      return;
    }
    throw new Error(
      `Pi model mismatch: configured ${model}, get_state reported ${composite ?? "no model"}. ` +
        "First Tree does not mutate operator-global Pi config; restart the RPC session after a model change.",
    );
  }

  async function ensureRpcClient(prepared: PreparedSession, sessionCtx: SessionContext): Promise<PiRpcClient> {
    rejectMcpConfiguration(prepared.payload);
    const nextFingerprint = spawnScopedFingerprint(prepared.payload, prepared.skillsDir);
    if (rpcClient && !rpcClient.isClosed && activeSpawnFingerprint === nextFingerprint) {
      return rpcClient;
    }
    if (rpcClient && !rpcClient.isClosed) {
      sessionCtx.log("pi spawn-scoped config changed; restarting RPC process against the stable session id");
      await closeRpcClient();
    }
    if (!binary) throw new Error("Pi binary is not resolved");
    await mkdir(prepared.sessionDir, { recursive: true });
    const env = buildEnv(sessionCtx, prepared.payload);
    await runVersionGate(binary, env, prepared.workspaceCwd, sessionCtx);
    // Empty model: inherit whatever the persisted Pi session already selected.
    // Clearing config does not force a host-default reset on an existing session file.
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
      ...(settlementTimeoutMs !== undefined ? { settlementTimeoutMs } : {}),
      onEvent: (event) => {
        if (ctx) processPiEvent(event, ctx);
      },
      onLog: (message) => sessionCtx.log(message),
    });
    activeSpawnFingerprint = nextFingerprint;
    try {
      const state = await rpcClient.getState();
      validateGetState(state, prepared.sessionId);
      if (prepared.payload.model) assertConfiguredModel(state, prepared.payload.model);
    } catch (error) {
      await closeRpcClient();
      throw error;
    }
    return rpcClient;
  }

  async function closeRpcClient(): Promise<void> {
    const client = rpcClient;
    rpcClient = null;
    activeSpawnFingerprint = null;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      ctx?.log(`pi rpc close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function adoptAssistantMessage(message: Record<string, unknown> | null): void {
    if (!turnObservation) return;
    const fields = extractAssistantMessageFields(message);
    if (fields.usage) turnObservation.usage = fields.usage;
    if (fields.provider) turnObservation.provider = fields.provider;
    if (fields.model) turnObservation.model = fields.model;
    if (fields.stopReason) turnObservation.stopReason = fields.stopReason;
  }

  function processPiEvent(event: Record<string, unknown>, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "message_update") {
      const assistantEvent = asRecord(event.assistantMessageEvent);
      const eventType = typeof assistantEvent?.type === "string" ? assistantEvent.type : "";
      if (eventType === "text_delta") {
        streaming = true;
        const delta = typeof assistantEvent?.delta === "string" ? assistantEvent.delta : "";
        if (delta && turnObservation) {
          turnObservation.assistantText += delta;
          turnObservation.userVisibleEmitted = true;
          updateReplaySafety(turnObservation);
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: delta } });
        }
        return;
      }
      if (eventType === "thinking_delta" || eventType === "thinking_start") {
        streaming = true;
        if (turnObservation && !turnObservation.thinkingEmitted) {
          turnObservation.thinkingEmitted = true;
          sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        }
        return;
      }
      if (eventType === "error") {
        streaming = true;
        const reason =
          typeof assistantEvent?.reason === "string"
            ? assistantEvent.reason
            : typeof assistantEvent?.error === "string"
              ? assistantEvent.error
              : "assistant message error";
        if (turnObservation) {
          turnObservation.turnError = reason;
          updateReplaySafety(turnObservation);
        }
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: reason.slice(0, 2000) } });
        return;
      }
      return;
    }

    if (type === "message_end" || type === "turn_end") {
      adoptAssistantMessage(asRecord(event.message));
      return;
    }

    if (type === "tool_execution_start") {
      streaming = true;
      const toolCallId = String(event.toolCallId ?? `pi-tool-${activeTools.size + 1}`);
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const args = event.args ?? {};
      const tool: ActiveTool = {
        name,
        args,
        startedAt: Date.now(),
        refs: cwd ? nativeToolRefs(name, args, cwd) : [],
      };
      activeTools.set(toolCallId, tool);
      if (turnObservation && !piToolIsReadOnly(name)) {
        turnObservation.unsafeToolEffectStarted = true;
        updateReplaySafety(turnObservation);
      }
      emitToolCall(sessionCtx, toolCallId, tool, "pending");
      return;
    }

    if (type === "tool_execution_update") {
      return;
    }

    if (type === "tool_execution_end") {
      const toolCallId = String(event.toolCallId ?? "");
      const tool = activeTools.get(toolCallId);
      if (!tool) return;
      const isError = event.isError === true;
      const refs =
        refsForCompletedTool({
          ok: !isError,
          readOnly: piToolIsReadOnly(tool.name),
          providerRefs: tool.refs,
          toolName: tool.name,
          toolUseId: toolCallId,
        }) ?? [];
      tool.refs = refs;
      emitToolCall(sessionCtx, toolCallId, tool, isError ? "error" : "ok", event.result);
      activeTools.delete(toolCallId);
      return;
    }

    if (type === "auto_retry_start") {
      const message =
        typeof event.errorMessage === "string" ? `pi auto_retry_start: ${event.errorMessage}` : "pi auto_retry_start";
      sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: message.slice(0, 2000) } });
      return;
    }

    if (type === "auto_retry_end") {
      if (event.success === false) {
        const finalError = typeof event.finalError === "string" ? event.finalError : "pi auto_retry_end failed";
        if (turnObservation) turnObservation.autoRetryFailed = finalError;
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: finalError.slice(0, 2000) } });
      }
      return;
    }

    if (type === "agent_settled") {
      streaming = false;
      if (turnObservation) turnObservation.settled = true;
      return;
    }
  }

  function formatPiFailure(message: string): string {
    return isPiAuthError(message) ? formatAuthHint("pi", message) : message;
  }

  async function completeCustody(outcome: Parameters<DeliveryToken["complete"]>[1]): Promise<"settled" | "retry"> {
    let disposition: "settled" | "retry" = "settled";
    const entries = turnCustody.splice(0);
    for (const entry of entries) {
      const result = await entry.token.complete(entry.messages, outcome);
      if (result === "retry") disposition = "retry";
    }
    return disposition;
  }

  function retryCustody(reason: string): void {
    for (const entry of turnCustody.splice(0)) entry.token.retry(entry.messages, reason);
  }

  async function settleAcceptedTurnFailure(
    sessionCtx: SessionContext,
    attemptNumber: number,
    failure: string,
  ): Promise<"retry_attempt" | "finished"> {
    if (!turnObservation) {
      retryCustody("pi_turn_missing_observation");
      return "finished";
    }
    updateReplaySafety(turnObservation);
    const formatted = formatPiFailure(failure);
    turnObservation.attempt.recordSignal({
      kind: "provider_error",
      error: failure,
      messagePreview: formatted,
    });
    const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
    if (settlement && settlement.decision.action === "retry") {
      emitSettlement(sessionCtx, settlement);
      const delayMs = settlement.decision.delayMs;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      return "retry_attempt";
    }
    if (settlement) emitSettlement(sessionCtx, settlement);
    const failedUsage = readTurnUsage(turnObservation);
    if (failedUsage) {
      sessionCtx.emitEvent({
        kind: "token_usage",
        payload: {
          provider: turnObservation.provider ?? "pi",
          model: turnObservation.model ?? (activePayload?.model || "pi-default"),
          inputTokens: failedUsage.inputTokens,
          cachedInputTokens: failedUsage.cachedInputTokens,
          outputTokens: failedUsage.outputTokens,
        },
      });
    }
    sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
    await completeCustody({
      status: "error",
      completion: "consumed",
      reason: settlement?.decision.reasonCode ?? "pi_accepted_turn_failed",
    });
    return "finished";
  }

  async function executeTurn(
    prompt: string,
    sessionCtx: SessionContext,
    custody: CustodyEntry[],
    client: PiRpcClient,
  ): Promise<boolean> {
    turnCustody = custody.map((entry) => ({ messages: entry.messages, token: entry.token }));
    turnObservation = {
      assistantText: "",
      settled: false,
      turnError: null,
      thinkingEmitted: false,
      unsafeToolEffectStarted: false,
      userVisibleEmitted: false,
      usage: null,
      provider: null,
      model: null,
      stopReason: null,
      autoRetryFailed: null,
      attempt: new ProviderAttempt({
        provider: runtimeProvider,
        scope: "provider_turn",
        source: "stream",
      }),
    };
    activeTools.clear();
    streaming = false;

    for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
      if (!sessionActive) {
        retryCustody("pi_turn_cancelled");
        return false;
      }
      turnObservation.assistantText = "";
      turnObservation.settled = false;
      turnObservation.turnError = null;
      turnObservation.thinkingEmitted = false;
      turnObservation.unsafeToolEffectStarted = false;
      turnObservation.userVisibleEmitted = false;
      turnObservation.usage = null;
      turnObservation.provider = null;
      turnObservation.model = null;
      turnObservation.stopReason = null;
      turnObservation.autoRetryFailed = null;
      turnObservation.attempt = new ProviderAttempt({
        provider: runtimeProvider,
        scope: "provider_turn",
        source: "stream",
      });
      client.clearSettled();
      activeTools.clear();
      streaming = false;
      gitWriteTracker.captureBaseline();

      let promptResponse: Awaited<ReturnType<PiRpcClient["prompt"]>> | null = null;
      let thrown: Error | null = null;
      try {
        promptResponse = await client.prompt(prompt);
      } catch (error) {
        thrown = error instanceof Error ? error : new Error(String(error));
      }

      if (!sessionActive) {
        retryCustody("pi_turn_cancelled");
        return false;
      }

      if (thrown) {
        // prompt() writes the JSONL command before awaiting the response. A
        // timeout/transport loss after that write is unknown/provider_entered
        // custody — fence the process and do not auto-resend the same prompt.
        const afterWrite =
          thrown instanceof PiRpcTransportError ||
          thrown instanceof PiRpcProtocolError ||
          /timed out|transport|closed|exited/i.test(thrown.message);
        if (afterWrite) {
          turnObservation.attempt.setReplaySafety("provider_entered");
          turnObservation.attempt.recordSignal({ kind: "transport_close", error: thrown });
          const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
          if (settlement) emitSettlement(sessionCtx, settlement);
          const formatted = formatPiFailure(thrown.message);
          sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          await closeRpcClient();
          await completeCustody({
            status: "error",
            completion: "consumed",
            reason: settlement?.decision.reasonCode ?? "pi_prompt_response_unknown",
          });
          return false;
        }
        updateReplaySafety(turnObservation);
        turnObservation.attempt.recordSignal({ kind: "local_error", error: thrown });
        const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
        if (settlement && settlement.decision.action === "retry") {
          emitSettlement(sessionCtx, settlement);
          const delayMs = settlement.decision.delayMs;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
          continue;
        }
        if (settlement) emitSettlement(sessionCtx, settlement);
        const formatted = formatPiFailure(thrown.message);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await completeCustody({
          status: "error",
          completion: "consumed",
          reason: settlement?.decision.reasonCode ?? "pi_transport_error",
        });
        return false;
      }

      // Prompt was accepted: later failures start at provider_entered.
      turnObservation.attempt.setReplaySafety("provider_entered");

      if (!promptResponse?.success) {
        // Preflight rejection: prompt was not accepted. Failures after acceptance
        // arrive through events; do not FT-retry an unaccepted prompt here.
        const failure = promptResponse?.error ?? "pi prompt rejected";
        const formatted = formatPiFailure(failure);
        turnObservation.attempt.recordSignal({
          kind: "provider_error",
          error: failure,
          messagePreview: formatted,
        });
        const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
        if (settlement) emitSettlement(sessionCtx, settlement);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await completeCustody({
          status: "error",
          completion: "consumed",
          reason: isPiAuthError(failure) ? "credential" : (settlement?.decision.reasonCode ?? "pi_preflight_failed"),
        });
        return false;
      }

      for (const entry of turnCustody) entry.token.processingStarted(entry.messages);

      try {
        await client.waitForSettled();
      } catch (error) {
        await awaitPendingSteers();
        const transportError = error instanceof Error ? error : new Error(String(error));
        if (!sessionActive) {
          retryCustody("pi_turn_cancelled");
          return false;
        }
        updateReplaySafety(turnObservation);
        turnObservation.attempt.recordSignal({
          kind:
            transportError instanceof PiRpcProtocolError || transportError instanceof PiRpcTransportError
              ? "local_error"
              : "transport_close",
          error: transportError,
        });
        const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
        if (settlement && settlement.decision.action === "retry") {
          emitSettlement(sessionCtx, settlement);
          const delayMs = settlement.decision.delayMs;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
          continue;
        }
        if (settlement) emitSettlement(sessionCtx, settlement);
        const formatted = formatPiFailure(transportError.message);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await completeCustody({
          status: "error",
          completion: "consumed",
          reason: settlement?.decision.reasonCode ?? "pi_settlement_failed",
        });
        return false;
      }

      if (!sessionActive) {
        retryCustody("pi_turn_cancelled");
        return false;
      }

      await awaitPendingSteers();

      const acceptedFailure =
        turnObservation.autoRetryFailed ??
        turnObservation.turnError ??
        (turnObservation.stopReason && !NORMAL_STOP_REASONS.has(turnObservation.stopReason)
          ? `pi stopReason=${turnObservation.stopReason}`
          : null);
      if (acceptedFailure) {
        const result = await settleAcceptedTurnFailure(sessionCtx, attemptNumber, acceptedFailure);
        if (result === "retry_attempt") continue;
        return false;
      }

      const successUsage = readTurnUsage(turnObservation);
      if (successUsage) {
        sessionCtx.emitEvent({
          kind: "token_usage",
          payload: {
            provider: turnObservation.provider ?? "pi",
            model: turnObservation.model ?? (activePayload?.model || "pi-default"),
            inputTokens: successUsage.inputTokens,
            cachedInputTokens: successUsage.cachedInputTokens,
            outputTokens: successUsage.outputTokens,
          },
        });
      }

      const assistantText = turnObservation.assistantText;
      try {
        await sessionCtx.forwardResult(assistantText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "runtime", message: `forward failed: ${message}` } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await completeCustody({
          status: "error",
          completion: "consumed",
          reason: "forward_failed",
        });
        return false;
      }
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
      const completion = await completeCustody({ status: "success" });
      if (completion === "retry") return false;
      pendingChatContextPrompt = null;
      return true;
    }

    retryCustody("pi_retry_loop_exited");
    return false;
  }

  async function runTurn(
    prompt: string,
    sessionCtx: SessionContext,
    custody: CustodyEntry[],
    client: PiRpcClient,
  ): Promise<boolean> {
    const promise = executeTurn(prompt, sessionCtx, custody, client);
    currentTurnPromise = promise;
    try {
      return await promise;
    } finally {
      if (currentTurnPromise === promise) currentTurnPromise = null;
      turnObservation = null;
      turnCustody = [];
      streaming = false;
      scheduleQueuedMessagesDrain();
    }
  }

  async function refreshPreparedSession(sessionCtx: SessionContext): Promise<PreparedSession> {
    if (!cwd || !sessionId) throw new Error("pi session is not prepared");
    let runtimeConfig: AgentRuntimeConfig | null = null;
    let payload: AgentRuntimeConfigPayload | null = activePayload;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
      payload = runtimeConfig.payload;
    }
    payload ??= { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
    if (payload.kind !== "pi") {
      throw new Error(`runtime provider mismatch: expected pi, got ${payload.kind}`);
    }
    rejectMcpConfiguration(payload);
    sourceReposForPrompt = declaredSourceRepos(cwd, payload);
    reconciledTeamSkills = (
      await reconcileManagedSkillsForConfig(
        cwd,
        runtimeProvider,
        runtimeConfig,
        sessionCtx.log,
        teamSkillBundleResolverFromSdk(sessionCtx.sdk),
      )
    ).teamSkills;
    const briefing = buildBriefing(sessionCtx, payload, cwd);
    activePayload = payload;
    return {
      payload,
      workspaceCwd: cwd,
      sessionId,
      sessionDir: join(cwd, PI_SESSIONS_DIR),
      skillsDir: join(cwd, PI_SKILLS_DIR),
      briefing,
    };
  }

  async function mergeAndRun(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const prepared = await refreshPreparedSession(sessionCtx);
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
    const client = await ensureRpcClient(prepared, sessionCtx);
    const prompt = await buildTurnPrompt(sessionCtx, prompts.join("\n\n"), prepared);
    const delivered = await runTurn(
      prompt,
      sessionCtx,
      drained.map((entry) => ({ messages: [entry.message], token: entry.token })),
      client,
    );
    if (delivered) {
      writeSessionBriefingFingerprint(
        prepared.workspaceCwd,
        prepared.sessionId,
        computeBriefingFingerprint(prepared.briefing),
      );
    }
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
          await mergeAndRun(drained, sessionCtx);
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
    retryCustody("pi_initialization_failed");
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

  async function abortAndWaitForSettlement(reason: string): Promise<void> {
    const client = rpcClient;
    if (!client || client.isClosed) return;
    const settledPromise = client.hasSettled ? Promise.resolve() : client.waitForSettled();
    try {
      const abortPromise = client.abort();
      const [abortResult] = await Promise.all([abortPromise, settledPromise]);
      if (!abortResult.success) {
        ctx?.log(`pi abort during ${reason} failed: ${abortResult.error ?? "unknown"}`);
      }
    } catch (error) {
      ctx?.log(`pi ${reason} abort failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await settledPromise;
      } catch {
        // settlement already failed with the same transport error
      }
    }
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
        const delivered = await runTurn(prompt, sessionCtx, [{ messages: [message], token: deliveryToken }], client);
        if (delivered) {
          writeSessionBriefingFingerprint(
            prepared.workspaceCwd,
            prepared.sessionId,
            computeBriefingFingerprint(prepared.briefing),
          );
        }
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
        await cleanupFailedInitialization();
        throw new Error(`Pi resume session identity mismatch: expected ${prepared.sessionId}, resume requested ${id}`);
      }
      if (message) {
        initialTurnPreparing = true;
        try {
          const client = await ensureRpcClient(prepared, sessionCtx);
          const basePrompt = await sessionCtx.formatInboundContent(message);
          const prompt = await buildTurnPrompt(sessionCtx, basePrompt, prepared);
          const delivered = await runTurn(prompt, sessionCtx, [{ messages: [message], token: deliveryToken }], client);
          if (delivered) {
            writeSessionBriefingFingerprint(
              prepared.workspaceCwd,
              prepared.sessionId,
              computeBriefingFingerprint(prepared.briefing),
            );
          }
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
        const steerWork = (async () => {
          try {
            const preparedPayload = activePayload ?? { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
            rejectMcpConfiguration(preparedPayload);
            const formatted = await ctx?.formatInboundContent(message);
            if (!formatted || !rpcClient) {
              deliveryToken.retry(message, "pi_steer_unavailable");
              return;
            }
            const response = await rpcClient.steer(formatted);
            if (!response.success) {
              // Common settle-vs-steer race: retain custody and queue as the next prompt.
              const failure = response.error ?? "pi steer rejected";
              ctx?.log(`pi steer rejected (${failure}); queueing inbound message for the next prompt`);
              queuedMessages.push({ message, token: deliveryToken });
              scheduleQueuedMessagesDrain();
              return;
            }
            deliveryToken.processingStarted([message]);
            turnCustody.push({ messages: [message], token: deliveryToken });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            ctx?.log(`pi steer failed: ${messageText}`);
            deliveryToken.retry(message, "pi_steer_failed");
          }
        })();
        pendingSteerWork.add(steerWork);
        void steerWork.finally(() => pendingSteerWork.delete(steerWork));
        return { kind: "owned", mode: "processing" };
      }
      queuedMessages.push({ message, token: deliveryToken });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason) {
      sessionActive = false;
      retryQueuedMessages(reason ?? "pi_suspend");
      if (streaming && rpcClient && !rpcClient.isClosed) {
        await abortAndWaitForSettlement("suspend");
        retryCustody(reason ?? "pi_suspend");
      } else {
        retryCustody(reason ?? "pi_suspend");
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
        await abortAndWaitForSettlement("shutdown");
        retryCustody("pi_shutdown");
      } else {
        retryCustody("pi_shutdown");
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
