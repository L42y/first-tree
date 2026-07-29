import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type ToolFileRef,
} from "@first-tree/shared";
import { ensureAgentBootstrap } from "../../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../../runtime/agent-config-cache.js";
import { type ChatContext, fetchChatContext } from "../../runtime/chat-context.js";
import { renderChatContextPrompt, renderRuntimeOutputContract } from "../../runtime/chat-context-section.js";
import { resolveContextTreeRelativePath, toolFileRefsFromShellCommand } from "../../runtime/context-tree-file-refs.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
} from "../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../runtime/handler.js";
import { type ReconciledTeamSkill, reconcileManagedSkillsForConfig } from "../../runtime/managed-skills.js";
import {
  isSupportedOpenCodeVersion,
  OPENCODE_SUPPORTED_VERSION_RANGE,
  parseOpenCodeVersionOutput,
  resolveOpenCodeRuntimeBinary,
} from "../../runtime/opencode-binary.js";
import { ProviderAttempt, type ProviderAttemptSettlement } from "../../runtime/provider-attempt.js";
import {
  createDefaultProviderProcessSupervisor,
  type ProviderProcessSupervisor,
} from "../../runtime/provider-process-supervisor.js";
import { redactErrorPreview } from "../../runtime/redact-error-preview.js";
import {
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  readSessionBriefingFingerprint,
  writeSessionBriefingFingerprint,
} from "../../runtime/session-briefing-fingerprint.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../../runtime/source-repos.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../../runtime/workspace.js";
import { chunkAssistantText } from "../assistant-text.js";
import { formatAuthHint, isOpenCodeAuthError } from "../auth-error-hint.js";
import { consumedErrorOutcome } from "../turn-settlement.js";
import { type OpenCodeStreamEvent, OpenCodeStreamParser, type OpenCodeUsage } from "./parser.js";

export const OPENCODE_PENDING_SESSION_PREFIX = "opencode-pending-";

const STDERR_TAIL_LIMIT = 8_000;
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 5_000;
const FINAL_CLOSE_WAIT_MS = 2_000;
const DB_GATE_TIMEOUT_MS = 30_000;
const CONFIG_CONTENT_ENV_MAX_BYTES = 16 * 1024;
const WINDOWS_ENV_BLOCK_MAX_CHARS = 30_000;
const OPENCODE_CONFIG_RUNTIME_DIR = join(".first-tree-workspace", "opencode-config");

export function isOpenCodePendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(OPENCODE_PENDING_SESSION_PREFIX);
}

type OpenCodeMcpConfig =
  | { type: "local"; command: string[]; enabled: true }
  | { type: "remote"; url: string; headers?: Record<string, string>; enabled: true };

export type OpenCodeMcpProjection = {
  servers: Record<string, OpenCodeMcpConfig>;
  aliases: Array<{ configuredName: string; managedName: string }>;
};

export function mapOpenCodeMcpServers(payload: AgentRuntimeConfigPayload, scope: string): OpenCodeMcpProjection {
  const out: Record<string, OpenCodeMcpConfig> = {};
  const aliases: OpenCodeMcpProjection["aliases"] = [];
  for (const [index, server] of payload.mcpServers.entries()) {
    const managedName = `first-tree-${scope}-mcp-${index + 1}`;
    aliases.push({ configuredName: server.name, managedName });
    if (server.transport === "stdio") {
      out[managedName] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        enabled: true,
      };
    } else {
      out[managedName] = {
        type: "remote",
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
        enabled: true,
      };
    }
  }
  return { servers: out, aliases };
}

export function buildOpenCodeConfigContent(input: {
  payload: AgentRuntimeConfigPayload;
  managedAgentName: string;
  scope: string;
}): string {
  const mcp = mapOpenCodeMcpServers(input.payload, input.scope);
  const aliasNotice =
    mcp.aliases.length === 0
      ? ""
      : `\nManaged MCP aliases:\n${mcp.aliases
          .map(({ configuredName, managedName }) => `- ${configuredName}: ${managedName}`)
          .join("\n")}`;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    agent: {
      [input.managedAgentName]: {
        description: "First Tree managed agent",
        mode: "primary",
        prompt:
          "You are running as a First Tree managed OpenCode agent. Read and follow the workspace AGENTS.md. " +
          "Use the First Tree runtime CLI for teammate communication when instructed." +
          aliasNotice,
        ...(input.payload.model ? { model: input.payload.model } : {}),
        permission: {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
          websearch: "allow",
          task: "allow",
        },
      },
    },
    mcp: mcp.servers,
  });
}

export function buildOpenCodeTurnArgs(input: {
  cwd: string;
  model: string;
  resumeSessionId: string | null;
  managedAgentName: string;
}): string[] {
  const args = [
    "run",
    "--format",
    "json",
    "--auto",
    "--agent",
    input.managedAgentName,
    "--title",
    "First Tree managed turn",
    "--dir",
    input.cwd,
    "--print-logs",
    "--log-level",
    "ERROR",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.resumeSessionId) args.push("--session", input.resumeSessionId);
  return args;
}

export type OpenCodeConfigProjection = {
  env: Record<string, string>;
  cleanup: () => void;
  transport: "env" | "file";
};

export function projectOpenCodeConfig(
  env: Record<string, string>,
  configContent: string,
  deps: {
    maxEnvBytes?: number;
    maxWindowsEnvChars?: number;
    makeTempDir?: () => string;
    platform?: NodeJS.Platform;
    runtimeRoot?: string;
  } = {},
): OpenCodeConfigProjection {
  const maxEnvBytes = deps.maxEnvBytes ?? CONFIG_CONTENT_ENV_MAX_BYTES;
  const platform = deps.platform ?? process.platform;
  const maxWindowsEnvChars = deps.maxWindowsEnvChars ?? WINDOWS_ENV_BLOCK_MAX_CHARS;
  const privateEnv = { ...env };
  delete privateEnv.OPENCODE_CONFIG_CONTENT;
  const contentEnv = { ...privateEnv, OPENCODE_CONFIG_CONTENT: configContent };
  if (
    Buffer.byteLength(configContent, "utf8") <= maxEnvBytes &&
    (platform !== "win32" || windowsEnvBlockChars(contentEnv) <= maxWindowsEnvChars)
  ) {
    return {
      env: contentEnv,
      cleanup: () => {},
      transport: "env",
    };
  }

  if (privateEnv.OPENCODE_CONFIG) {
    throw new Error(
      "OpenCode private projection is too large for the child environment and cannot replace the host OPENCODE_CONFIG",
    );
  }
  let configDir: string;
  if (deps.makeTempDir) {
    configDir = deps.makeTempDir();
  } else {
    if (!deps.runtimeRoot) {
      throw new Error("OpenCode file-backed projection requires a runtime-owned workspace directory");
    }
    mkdirSync(deps.runtimeRoot, { recursive: true, mode: 0o700 });
    chmodSync(deps.runtimeRoot, 0o700);
    configDir = mkdtempSync(join(deps.runtimeRoot, "turn-"));
  }
  const configPath = join(configDir, "opencode.json");
  try {
    writeFileSync(configPath, configContent, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(configDir, 0o700);
    chmodSync(configPath, 0o600);
  } catch (error) {
    rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
  const fileEnv = {
    ...privateEnv,
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", snapshot: false }),
  };
  if (platform === "win32" && windowsEnvBlockChars(fileEnv) > maxWindowsEnvChars) {
    rmSync(configDir, { recursive: true, force: true });
    throw new Error("OpenCode runtime provider mismatch: child environment exceeds the safe Windows block limit");
  }
  return {
    env: fileEnv,
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
    transport: "file",
  };
}

function windowsEnvBlockChars(env: Readonly<Record<string, string>>): number {
  let total = 1;
  for (const [key, value] of Object.entries(env)) total += key.length + 1 + value.length + 1;
  return total;
}

type ProcessOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  spawnError?: Error;
};

type TurnState = {
  parser: OpenCodeStreamParser;
  sessionIds: Set<string>;
  terminalReasons: string[];
  errors: string[];
  text: string[];
  usage: OpenCodeUsage | null;
  sawProviderActivity: boolean;
  sawUnsafeTool: boolean;
  protocolDiagnostics: string[];
};

const dbGatePromises = new Map<string, Promise<void>>();
const providerTurnFailureAttempts = new Map<string, number>();

export function clearOpenCodeDbGateCacheForTests(): void {
  dbGatePromises.clear();
  providerTurnFailureAttempts.clear();
}

export const createOpenCodeHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider ?? "opencode");
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextTreePath = (config.contextTreePath as string | undefined) ?? null;
  const contextTreeRepoUrl = (config.contextTreeRepoUrl as string | undefined) ?? null;
  const contextTreeBranch = (config.contextTreeBranch as string | undefined) ?? null;
  const resolveBinary =
    (config.opencodeBinaryResolver as typeof resolveOpenCodeRuntimeBinary | undefined) ?? resolveOpenCodeRuntimeBinary;
  const processSupervisor =
    (config.providerProcessSupervisor as ProviderProcessSupervisor | undefined) ??
    createDefaultProviderProcessSupervisor();
  const turnTimeoutMs =
    typeof config.opencodeTurnTimeoutMs === "number" && config.opencodeTurnTimeoutMs > 0
      ? config.opencodeTurnTimeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;
  const retrySleep =
    (config.opencodeRetrySleep as ((delayMs: number) => Promise<void>) | undefined) ??
    ((delayMs: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs)));
  const configProjector =
    (config.opencodeConfigProjector as typeof projectOpenCodeConfig | undefined) ?? projectOpenCodeConfig;
  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let activeConfig: AgentRuntimeConfig | null = null;
  let teamSkills: readonly ReconciledTeamSkill[] = [];
  let binary: string | null = null;
  let providerSessionId: string | null = null;
  let pendingSyntheticId: string | null = null;
  let sessionActive = false;
  let initialTurnPreparing = false;
  let currentAbort: AbortController | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let versionReady = false;
  let generation = 0;
  let drainScheduled = false;
  let drainInProgress = false;
  let pendingChatContextPrompt: string | null = null;
  let projectionScope: string | null = null;
  let managedAgentName: string | null = null;
  let privateConfigRuntimeRoot: string | null = null;
  const queue: Array<{ message: SessionMessage; token: DeliveryToken }> = [];

  function deliveryAttemptKey(sessionCtx: SessionContext, messages: readonly SessionMessage[]): string {
    return `${sessionCtx.agent.agentId}\0${sessionCtx.chatId}\0${messages.map((message) => message.id).join("\0")}`;
  }

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const base: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") base[key] = value;
    }
    for (const entry of payload.env) base[entry.key] = entry.value;
    const merged = sessionCtx.buildAgentEnv(base);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === "string") env[key] = value;
    }
    delete env.OPENCODE_CONFIG_CONTENT;
    return env;
  }

  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
    try {
      return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
    } catch (error) {
      sessionCtx.log(`OpenCode chat-context fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  function buildBriefing(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload, workspaceCwd: string): string {
    return buildAgentBriefing({
      identity: sessionCtx.agent,
      payload,
      workspacePath: workspaceCwd,
      sourceRepos: declaredSourceRepos(workspaceCwd, payload),
      contextTreePath,
      contextTreeRepoUrl,
      contextTreeBranch,
      teamSkills,
    });
  }

  async function refreshProjection(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    briefing: string;
  }> {
    if (!cwd) throw new Error("OpenCode workspace is not prepared");
    let runtimeConfig = activeConfig;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    }
    const payload: AgentRuntimeConfigPayload =
      runtimeConfig?.payload ??
      ({
        kind: "opencode",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      } satisfies AgentRuntimeConfigPayload);
    if (payload.kind !== "opencode") {
      throw new Error(`OpenCode handler received ${payload.kind} runtime config`);
    }
    teamSkills = (await reconcileManagedSkillsForConfig(cwd, runtimeProvider, runtimeConfig, sessionCtx.log))
      .teamSkills;
    const briefing = buildBriefing(sessionCtx, payload, cwd);
    ensureAgentBootstrap({
      workspace: cwd,
      sessionCtx,
      contextTreePath,
      briefing,
      currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, runtimeConfig !== null),
    });
    markWorkspaceInitComplete(cwd);
    activeConfig = runtimeConfig;
    return { payload, briefing };
  }

  function runProcess(input: {
    command: string;
    args: string[];
    prompt?: string;
    env: Record<string, string>;
    workspaceCwd: string;
    state?: TurnState;
    sessionCtx: SessionContext;
    abortSignal: AbortSignal;
    timeoutMs: number;
    turnGeneration: number;
    label: string;
  }): Promise<ProcessOutcome> {
    return new Promise((resolveOutcome) => {
      let supervised: ReturnType<ProviderProcessSupervisor["spawn"]>;
      try {
        supervised = processSupervisor.spawn({
          command: input.command,
          args: input.args,
          label: input.label,
          timeoutMs: input.timeoutMs,
          options: {
            cwd: input.workspaceCwd,
            env: input.env,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            ...(process.platform === "win32" ? {} : { detached: true }),
          },
        });
      } catch (error) {
        resolveOutcome({
          exitCode: null,
          signal: null,
          stdoutTail: "",
          stderrTail: "",
          spawnError: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }
      const child = supervised.child;
      let stdoutTail = "";
      let stderrTail = "";
      let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
      let stdoutEnded = false;
      let settled = false;
      let spawnError: Error | undefined;

      const finish = (): void => {
        if (settled || !closed || !stdoutEnded) return;
        settled = true;
        resolveOutcome({ ...closed, stdoutTail, stderrTail, spawnError });
      };
      const handleEvents = (events: OpenCodeStreamEvent[]): void => {
        if (!input.state) return;
        for (const event of events) {
          try {
            handleEvent(event, input.state, input.sessionCtx);
          } catch (error) {
            input.sessionCtx.log(
              `OpenCode event handling failed (${event.kind}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };
      const terminate = (): void => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          // The process may already be gone.
        }
        const hardKill = setTimeout(() => {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            // Ignore a completed process.
          }
        }, KILL_GRACE_MS);
        hardKill.unref?.();
        const finalWait = setTimeout(() => {
          stdoutEnded = true;
          closed ??= { exitCode: null, signal: "SIGKILL" };
          finish();
        }, KILL_GRACE_MS + FINAL_CLOSE_WAIT_MS);
        finalWait.unref?.();
      };
      input.abortSignal.addEventListener("abort", terminate, { once: true });

      child.on("error", (error) => {
        spawnError = error;
        closed ??= { exitCode: null, signal: null };
        stdoutEnded = true;
        finish();
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutTail = (stdoutTail + chunk).slice(-STDERR_TAIL_LIMIT);
        if (input.state && !input.abortSignal.aborted && generation === input.turnGeneration) {
          handleEvents(input.state.parser.push(chunk));
        }
      });
      child.stdout?.on("end", () => {
        if (input.state && !input.abortSignal.aborted && generation === input.turnGeneration) {
          handleEvents(input.state.parser.flush());
        }
        stdoutEnded = true;
        finish();
      });
      child.stdout?.on("error", () => {
        stdoutEnded = true;
        finish();
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
      child.on("close", (exitCode, signal) => {
        input.abortSignal.removeEventListener("abort", terminate);
        closed = { exitCode, signal };
        finish();
      });
      child.stdin?.on("error", () => {
        // EPIPE is classified from close + stderr.
      });
      if (input.prompt !== undefined) child.stdin?.write(input.prompt);
      child.stdin?.end();
    });
  }

  function handleEvent(event: OpenCodeStreamEvent, state: TurnState, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    state.sawProviderActivity = true;
    switch (event.kind) {
      case "session":
        state.sessionIds.add(event.sessionId);
        break;
      case "text":
        state.text.push(event.text);
        break;
      case "tool":
        if (!isReadOnlyTool(event.name)) state.sawUnsafeTool = true;
        {
          const toolFileRefs = event.status === "pending" ? undefined : fileRefsForTool(event.name, event.args);
          sessionCtx.emitEvent({
            kind: "tool_call",
            payload: {
              toolUseId: event.toolUseId,
              name: event.name,
              args: event.args,
              status: event.status,
              ...(event.resultPreview ? { resultPreview: event.resultPreview } : {}),
              ...(toolFileRefs && toolFileRefs.length > 0 ? { toolFileRefs } : {}),
            },
          });
        }
        break;
      case "usage":
        state.usage = event.usage;
        break;
      case "terminal":
        state.terminalReasons.push(event.reason);
        break;
      case "error":
        state.errors.push(event.message);
        break;
      case "reasoning":
        break;
      case "unknown":
        if (state.protocolDiagnostics.length < 5) {
          sessionCtx.log(`OpenCode protocol diagnostic: ${event.note}`);
        }
        state.protocolDiagnostics.push(event.note);
        break;
    }
  }

  function fileRefsForTool(name: string, args: unknown): ToolFileRef[] | undefined {
    if (!cwd) return undefined;
    const values = asRecord(args);
    if (name.toLowerCase() === "bash") {
      const command = typeof values?.command === "string" ? values.command : null;
      if (!command) return undefined;
      return toolFileRefsFromShellCommand({
        command,
        cwd,
        contextTreePath,
        contextTreeRepoUrl,
        contextTreeBranch,
      });
    }
    const rawPath =
      typeof values?.path === "string"
        ? values.path
        : typeof values?.filePath === "string"
          ? values.filePath
          : typeof values?.file_path === "string"
            ? values.file_path
            : null;
    if (!rawPath) return undefined;
    const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, {
      contextTreePath,
      contextTreeRepoUrl,
    });
    const write = /^(edit|write|patch)$/i.test(name);
    return [
      {
        origin: write ? "file_change" : "tool_arg",
        localPath: rawPath,
        pathKind: "file",
        ...(contextTreeRepoUrl && repoRelativePath && repoRelativePath !== "/"
          ? {
              repoUrl: contextTreeRepoUrl,
              ...(contextTreeBranch ? { repoBranch: contextTreeBranch } : {}),
              repoRelativePath,
            }
          : {}),
      },
    ];
  }

  async function ensureDbReady(input: {
    activeBinary: string;
    env: Record<string, string>;
    workspaceCwd: string;
    sessionCtx: SessionContext;
    abortSignal: AbortSignal;
    turnGeneration: number;
  }): Promise<void> {
    const dataHome = input.env.XDG_DATA_HOME ?? input.env.APPDATA ?? input.env.HOME ?? "";
    const key = `${input.activeBinary}\0${dataHome}`;
    let gate = dbGatePromises.get(key);
    if (!gate) {
      gate = (async () => {
        const outcome = await runProcess({
          command: input.activeBinary,
          args: ["db", "SELECT 1 AS ready", "--format", "json"],
          env: input.env,
          workspaceCwd: input.workspaceCwd,
          sessionCtx: input.sessionCtx,
          abortSignal: input.abortSignal,
          timeoutMs: DB_GATE_TIMEOUT_MS,
          turnGeneration: input.turnGeneration,
          label: "opencode database readiness",
        });
        if (outcome.spawnError || outcome.exitCode !== 0) {
          throw (
            outcome.spawnError ??
            new Error(`OpenCode database readiness failed (${outcome.exitCode}): ${outcome.stderrTail}`)
          );
        }
      })().catch((error) => {
        dbGatePromises.delete(key);
        throw error;
      });
      dbGatePromises.set(key, gate);
    }
    await gate;
  }

  async function ensureSupportedVersion(input: {
    activeBinary: string;
    env: Record<string, string>;
    workspaceCwd: string;
    sessionCtx: SessionContext;
    abortSignal: AbortSignal;
    turnGeneration: number;
  }): Promise<void> {
    if (versionReady) return;
    const outcome = await runProcess({
      command: input.activeBinary,
      args: ["--version"],
      env: input.env,
      workspaceCwd: input.workspaceCwd,
      sessionCtx: input.sessionCtx,
      abortSignal: input.abortSignal,
      timeoutMs: DB_GATE_TIMEOUT_MS,
      turnGeneration: input.turnGeneration,
      label: "opencode compatible-version gate",
    });
    const version = parseOpenCodeVersionOutput(`${outcome.stdoutTail}\n${outcome.stderrTail}`);
    if (outcome.spawnError || outcome.exitCode !== 0 || !isSupportedOpenCodeVersion(version)) {
      const detail = redactErrorPreview(
        outcome.spawnError?.message || outcome.stderrTail || outcome.stdoutTail || `exit ${outcome.exitCode}`,
        800,
      );
      throw new Error(
        `OpenCode runtime provider mismatch: unsupported version. First Tree requires ${OPENCODE_SUPPORTED_VERSION_RANGE}; ` +
          `observed ${version ?? "no parseable version"}. ${detail}`,
      );
    }
    versionReady = true;
  }

  function adoptSessionId(sessionCtx: SessionContext, id: string): void {
    if (providerSessionId === id) return;
    const synthetic = pendingSyntheticId;
    providerSessionId = id;
    if (synthetic) {
      pendingSyntheticId = null;
      sessionCtx.replaceSessionId?.(id, "opencode_session_id_confirmed");
      if (cwd) {
        const baseline = readSessionBriefingFingerprint(cwd, synthetic);
        if (baseline) writeSessionBriefingFingerprint(cwd, id, baseline);
      }
    }
  }

  function emitProviderTurnSettlementEvent(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(settlement.eventPayload),
      },
    });
  }

  function consumedReasonForProviderSettlement(settlement: ProviderAttemptSettlement): TurnConsumedErrorReason {
    return settlement.decision.action === "stop" && settlement.decision.terminalKind === "capacity_wait_required"
      ? "capacity_wait_required"
      : settlement.decision.action === "stop" && settlement.decision.terminalKind === "exhausted"
        ? "provider_retry_exhausted"
        : settlement.decision.reasonCode;
  }

  async function settleFailure(input: {
    failure: string;
    spawnError?: Error;
    state: Pick<TurnState, "sawProviderActivity" | "sawUnsafeTool" | "text">;
    sessionCtx: SessionContext;
    messages: readonly SessionMessage[];
    token: DeliveryToken;
  }): Promise<boolean> {
    const attemptKey = deliveryAttemptKey(input.sessionCtx, input.messages);
    const replaySafety = input.state.sawUnsafeTool
      ? "unsafe"
      : input.state.text.length > 0
        ? "user_visible"
        : input.state.sawProviderActivity
          ? "pre_visible"
          : "pre_provider";
    const displayMessage = isOpenCodeAuthError(input.failure)
      ? formatAuthHint("opencode", input.failure)
      : input.failure;
    const attempt = new ProviderAttempt({
      provider: runtimeProvider,
      scope: "provider_turn",
      source: input.spawnError ? "sdk" : "stream",
      replaySafety,
    });
    attempt.recordSignal({
      kind: input.spawnError ? "local_error" : "provider_error",
      error: input.spawnError ?? input.failure,
      messagePreview: displayMessage,
    });
    const attemptNumber = (providerTurnFailureAttempts.get(attemptKey) ?? 0) + 1;
    providerTurnFailureAttempts.set(attemptKey, attemptNumber);
    const settlement = attempt.settle({ attempt: attemptNumber });
    if (!settlement) {
      input.token.retry(input.messages, "opencode_unclassified_failure");
      return false;
    }

    emitProviderTurnSettlementEvent(input.sessionCtx, settlement);
    input.sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "sdk", message: displayMessage },
    });
    input.sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
    if (settlement.decision.action === "retry") {
      await retrySleep(settlement.decision.delayMs);
      input.token.retry(input.messages, settlement.decision.reasonCode);
      if (input.state.sawProviderActivity) {
        input.sessionCtx.failSessionForRecovery?.("opencode_turn_retryable_failure", providerSessionId ?? undefined);
      }
      return false;
    }
    const completion = await input.token.complete(
      input.messages,
      consumedErrorOutcome(consumedReasonForProviderSettlement(settlement)),
    );
    if (completion === "retry") return false;
    providerTurnFailureAttempts.delete(attemptKey);
    pendingChatContextPrompt = null;
    return true;
  }

  async function runTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const workspaceCwd = cwd;
    const activeBinary = binary;
    const activeProjectionScope = projectionScope;
    const activeManagedAgentName = managedAgentName;
    const activePrivateConfigRuntimeRoot = privateConfigRuntimeRoot;
    if (
      !workspaceCwd ||
      !activeBinary ||
      !activeProjectionScope ||
      !activeManagedAgentName ||
      !activePrivateConfigRuntimeRoot ||
      !sessionActive
    ) {
      token.retry(messages, sessionActive ? "opencode_not_prepared" : "opencode_session_inactive");
      return false;
    }
    const turnGeneration = ++generation;
    const abort = new AbortController();
    currentAbort = abort;
    let observedState: TurnState | null = null;
    const promise = (async () => {
      const { payload } = await refreshProjection(sessionCtx);
      const env = buildEnv(sessionCtx, payload);
      await ensureSupportedVersion({
        activeBinary,
        env,
        workspaceCwd,
        sessionCtx,
        abortSignal: abort.signal,
        turnGeneration,
      });
      await ensureDbReady({
        activeBinary,
        env,
        workspaceCwd,
        sessionCtx,
        abortSignal: abort.signal,
        turnGeneration,
      });
      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) return false;

      const oneShotPrompt = pendingChatContextPrompt;
      const providerPrompt = oneShotPrompt ? `${oneShotPrompt}\n\n${prompt}` : prompt;
      const expectedSessionId = providerSessionId;
      const state: TurnState = {
        parser: new OpenCodeStreamParser(),
        sessionIds: new Set(),
        terminalReasons: [],
        errors: [],
        text: [],
        usage: null,
        sawProviderActivity: false,
        sawUnsafeTool: false,
        protocolDiagnostics: [],
      };
      observedState = state;
      token.processingStarted(messages);
      const timeout = setTimeout(() => abort.abort(), turnTimeoutMs);
      timeout.unref?.();
      let outcome: ProcessOutcome;
      try {
        const configProjection = configProjector(
          env,
          buildOpenCodeConfigContent({
            payload,
            managedAgentName: activeManagedAgentName,
            scope: activeProjectionScope,
          }),
          { runtimeRoot: activePrivateConfigRuntimeRoot },
        );
        try {
          outcome = await runProcess({
            command: activeBinary,
            args: buildOpenCodeTurnArgs({
              cwd: workspaceCwd,
              model: payload.model,
              resumeSessionId: expectedSessionId,
              managedAgentName: activeManagedAgentName,
            }),
            prompt: `${providerPrompt}\n`,
            env: configProjection.env,
            workspaceCwd,
            state,
            sessionCtx,
            abortSignal: abort.signal,
            timeoutMs: turnTimeoutMs,
            turnGeneration,
            label: `opencode turn ${sessionCtx.chatId}`,
          });
        } finally {
          configProjection.cleanup();
        }
      } finally {
        clearTimeout(timeout);
      }

      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) {
        return settleFailure({
          failure: "OpenCode turn aborted or timed out before a safe terminal event",
          spawnError: new Error("OpenCode turn aborted or timed out"),
          state,
          sessionCtx,
          messages,
          token,
        });
      }

      const ids = [...state.sessionIds];
      const protocolErrors: string[] = [];
      if (ids.length !== 1) protocolErrors.push(`expected one session ID, observed ${ids.length}`);
      if (expectedSessionId && ids[0] !== expectedSessionId) {
        protocolErrors.push(`resume session mismatch: expected ${expectedSessionId}, observed ${ids[0] ?? "none"}`);
      }
      if (state.terminalReasons.length !== 1) {
        protocolErrors.push(`expected one terminal step_finish event, observed ${state.terminalReasons.length}`);
      }
      if (state.errors.length > 0) protocolErrors.push(...state.errors);
      if (state.protocolDiagnostics.length > 0) {
        protocolErrors.push(
          `unsupported or malformed OpenCode JSONL (${state.protocolDiagnostics.length} line${
            state.protocolDiagnostics.length === 1 ? "" : "s"
          })`,
        );
      }
      if (/agent\s+["'][^"']+["']\s+not found.*falling back to default agent/i.test(outcome.stderrTail)) {
        protocolErrors.push("managed agent was not selected");
      }

      const success = !outcome.spawnError && outcome.exitCode === 0 && protocolErrors.length === 0;
      if (success) {
        const id = ids[0];
        if (!id) throw new Error("OpenCode success without session ID");
        adoptSessionId(sessionCtx, id);
        const finalText = state.text.join("");
        for (const chunk of chunkAssistantText(finalText)) {
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
        }
        if (state.usage) {
          sessionCtx.emitEvent({
            kind: "token_usage",
            payload: {
              provider: "opencode",
              model: payload.model || "opencode-default",
              inputTokens: state.usage.inputTokens,
              cachedInputTokens: state.usage.cachedInputTokens,
              outputTokens: state.usage.outputTokens,
            },
          });
        }
        try {
          await sessionCtx.forwardResult(finalText);
        } catch (error) {
          sessionCtx.emitEvent({
            kind: "error",
            payload: {
              source: "runtime",
              message: `forwardResult failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
            },
          });
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          const completion = await token.complete(messages, {
            status: "error",
            completion: "consumed",
            reason: "forward_failed",
          });
          if (completion === "retry") return false;
          providerTurnFailureAttempts.delete(deliveryAttemptKey(sessionCtx, messages));
          pendingChatContextPrompt = null;
          return true;
        }
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
        const completion = await token.complete(messages, { status: "success" });
        if (completion === "retry") return false;
        providerTurnFailureAttempts.delete(deliveryAttemptKey(sessionCtx, messages));
        if (pendingChatContextPrompt === oneShotPrompt) pendingChatContextPrompt = null;
        return true;
      }

      const rawFailure = [
        ...protocolErrors,
        outcome.spawnError?.message,
        outcome.stderrTail,
        outcome.exitCode === null ? `signal ${outcome.signal ?? "unknown"}` : `exit ${outcome.exitCode}`,
      ]
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n")
        .slice(0, 2000);
      const failure = redactErrorPreview(rawFailure, 2000);
      return settleFailure({
        failure,
        ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}),
        state,
        sessionCtx,
        messages,
        token,
      });
    })();
    currentTurnPromise = promise.then(
      () => {},
      () => {},
    );
    try {
      return await promise;
    } catch (error) {
      const failure = redactErrorPreview(error instanceof Error ? error.message : String(error), 2000);
      return await settleFailure({
        failure,
        spawnError: error instanceof Error ? error : new Error(String(error)),
        state: observedState ?? { sawProviderActivity: false, sawUnsafeTool: false, text: [] },
        sessionCtx,
        messages,
        token,
      });
    } finally {
      if (generation === turnGeneration) {
        currentAbort = null;
        currentTurnPromise = null;
        scheduleDrain();
      }
    }
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<{
    briefing: string;
    workspaceCwd: string;
  }> {
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error("landing campaign trial agents require the codex app-server runtime");
    }
    ctx = sessionCtx;
    cwd = acquireAgentHome(workspaceRoot);
    projectionScope = stableOpenCodeScope(sessionCtx.agent.agentId);
    managedAgentName = `first-tree-${projectionScope}`;
    privateConfigRuntimeRoot = join(
      cwd,
      OPENCODE_CONFIG_RUNTIME_DIR,
      stableOpenCodeScope(`${sessionCtx.agent.agentId}\0${sessionCtx.chatId}`),
    );
    rmSync(privateConfigRuntimeRoot, { recursive: true, force: true });
    mkdirSync(privateConfigRuntimeRoot, { recursive: true, mode: 0o700 });
    chmodSync(privateConfigRuntimeRoot, 0o700);
    const resolution = resolveBinary(process.env);
    if (!resolution.ok) {
      throw new Error(resolution.error);
    }
    binary = resolution.binary;
    sessionCtx.log(`OpenCode binary: ${resolution.binary}`);
    const { briefing } = await refreshProjection(sessionCtx);
    const chatContext = await fetchChatContextOrLog(sessionCtx);
    pendingChatContextPrompt = [renderRuntimeOutputContract(), renderChatContextPrompt(chatContext)]
      .filter(Boolean)
      .join("\n\n");
    sessionActive = true;
    return { briefing, workspaceCwd: cwd };
  }

  async function runQueued(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const token = drained[0]?.token;
    if (!token) return;
    const messages = drained.map((entry) => entry.message);
    const parts: string[] = [];
    try {
      for (const message of messages) parts.push(await sessionCtx.formatInboundContent(message));
    } catch (error) {
      sessionCtx.log(`OpenCode queued formatting failed: ${error instanceof Error ? error.message : String(error)}`);
      for (const entry of drained) entry.token.retry(entry.message, "opencode_queued_format_failed");
      return;
    }
    const sessionKey = providerSessionId ?? pendingSyntheticId;
    let fingerprint: string | null = null;
    if (cwd && sessionKey) {
      const projection = await refreshProjection(sessionCtx);
      fingerprint = computeBriefingFingerprint(projection.briefing);
      if (readSessionBriefingFingerprint(cwd, sessionKey) !== fingerprint) {
        parts.unshift(buildBriefingUpdateNotice(join(cwd, "AGENTS.md")));
      }
    }
    const delivered = await runTurn(parts.join("\n\n"), sessionCtx, messages, token);
    if (delivered && fingerprint && cwd && sessionKey) {
      writeSessionBriefingFingerprint(cwd, providerSessionId ?? sessionKey, fingerprint);
    }
  }

  function scheduleDrain(): void {
    if (
      drainScheduled ||
      drainInProgress ||
      queue.length === 0 ||
      !ctx ||
      !sessionActive ||
      currentTurnPromise ||
      initialTurnPreparing
    ) {
      return;
    }
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (
        drainInProgress ||
        queue.length === 0 ||
        !ctx ||
        !sessionActive ||
        currentTurnPromise ||
        initialTurnPreparing
      ) {
        scheduleDrain();
        return;
      }
      const drained = queue.splice(0);
      const sessionCtx = ctx;
      drainInProgress = true;
      void runQueued(drained, sessionCtx)
        .catch((error) => {
          sessionCtx.log(`OpenCode queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          for (const entry of drained) entry.token.retry(entry.message, "opencode_queued_turn_failed");
        })
        .finally(() => {
          drainInProgress = false;
          scheduleDrain();
        });
    });
  }

  function retryQueue(reason: string): void {
    for (const entry of queue.splice(0)) entry.token.retry(entry.message, reason);
  }

  return {
    async start(message, sessionCtx, token) {
      const explicit = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      initialTurnPreparing = true;
      let completed = false;
      let delivered = false;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
        const prompt = await sessionCtx.formatInboundContent(message);
        delivered = await runTurn(prompt, sessionCtx, [message], deliveryToken);
        completed = delivered;
      } finally {
        initialTurnPreparing = false;
        if (completed) scheduleDrain();
      }
      if (!providerSessionId) pendingSyntheticId = `${OPENCODE_PENDING_SESSION_PREFIX}${randomUUID()}`;
      const sessionId = providerSessionId ?? pendingSyntheticId;
      if (!sessionId) throw new Error("OpenCode session id unresolved");
      if (delivered) {
        writeSessionBriefingFingerprint(workspaceCwd, sessionId, computeBriefingFingerprint(briefing));
      }
      return explicit ? { sessionId, route: { kind: "owned", mode: "processing" } } : sessionId;
    },

    async resume(message, sessionId, sessionCtx, token) {
      const explicit = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      initialTurnPreparing = true;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
      } catch (error) {
        initialTurnPreparing = false;
        throw error;
      }
      if (isOpenCodePendingSessionId(sessionId)) {
        pendingSyntheticId = sessionId;
        providerSessionId = null;
      } else {
        providerSessionId = sessionId;
        pendingSyntheticId = null;
      }
      const fingerprint = computeBriefingFingerprint(briefing);
      if (message) {
        let prompt = await sessionCtx.formatInboundContent(message);
        if (readSessionBriefingFingerprint(workspaceCwd, sessionId) !== fingerprint) {
          prompt = `${buildBriefingUpdateNotice(join(workspaceCwd, "AGENTS.md"))}\n\n${prompt}`;
        }
        try {
          const delivered = await runTurn(prompt, sessionCtx, [message], deliveryToken);
          if (delivered) {
            writeSessionBriefingFingerprint(workspaceCwd, providerSessionId ?? sessionId, fingerprint);
          }
        } finally {
          initialTurnPreparing = false;
          scheduleDrain();
        }
      } else {
        initialTurnPreparing = false;
        scheduleDrain();
      }
      const effectiveId = providerSessionId ?? pendingSyntheticId ?? sessionId;
      return explicit
        ? { sessionId: effectiveId, route: message ? { kind: "owned", mode: "processing" } : null }
        : effectiveId;
    },

    inject(message, token) {
      if (!ctx) return { kind: "rejected", reason: "no_active_context", retryable: true };
      queue.push({ message, token: token ?? deliveryTokenFromSessionContext(ctx) });
      scheduleDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason) {
      sessionActive = false;
      retryQueue(reason ?? "opencode_suspend_before_terminal");
      generation++;
      currentAbort?.abort();
      await currentTurnPromise;
      currentAbort = null;
      currentTurnPromise = null;
      initialTurnPreparing = false;
    },

    async shutdown(reason) {
      sessionActive = false;
      retryQueue(reason ?? "opencode_shutdown_before_terminal");
      generation++;
      currentAbort?.abort();
      await currentTurnPromise;
      currentAbort = null;
      currentTurnPromise = null;
      cwd = null;
      ctx = null;
      activeConfig = null;
      teamSkills = [];
      binary = null;
      providerSessionId = null;
      pendingSyntheticId = null;
      versionReady = false;
      if (privateConfigRuntimeRoot) {
        rmSync(privateConfigRuntimeRoot, { recursive: true, force: true });
      }
      projectionScope = null;
      managedAgentName = null;
      privateConfigRuntimeRoot = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
      queue.length = 0;
    },
  } satisfies AgentHandler;
};

function isReadOnlyTool(name: string): boolean {
  return /^(read|glob|grep|list|ls|webfetch|websearch)$/i.test(name);
}

export function stableOpenCodeScope(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
