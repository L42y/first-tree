/**
 * Thin ACP (Agent Client Protocol v1) transport for the Grok Build CLI.
 *
 * One short-lived `grok ... stdio` process per provider turn; this module
 * owns the child lifecycle and the JSON-RPC sequence:
 *
 *   spawn → ndJsonStream over stdio → initialize (EMPTY clientCapabilities,
 *   so Grok keeps file/terminal ops on its own local backends) →
 *   session/new (first turn) or session/load (resume; NEVER silently falls
 *   back to session/new on failure — replay safety) → session/prompt →
 *   drain queued notification handlers → end stdin → require exit 0.
 *
 * Auth is deliberately NOT negotiated: Grok auto-selects its
 * `defaultAuthMethodId`, and an explicit `authenticate(cached_token)` can
 * fall through to the interactive grok.com flow. Auth failures surface as
 * prompt/JSON-RPC errors and classify through the retry policy.
 *
 * Replay fence: after `session/load`, Grok replays historical updates from
 * prior turns. The wrapper drains the replay before sending the current
 * prompt (bounded quiet-window — the SDK dispatches notification handlers
 * asynchronously, so a naive "prompt sent" boolean races the replay), drops
 * every notification that arrives before the current `session/prompt`
 * request has been sent, and drops routed updates whose sessionId
 * contradicts the active session. Prompt-id correlation of
 * `turn_completed` usage stays in the handler (events.ts + index.ts).
 *
 * The defensive `session/request_permission` handler always denies: under
 * `--always-approve` + yoloMode it must never fire, and auto-approving would
 * silently widen the approval posture.
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { InitializeResponse, McpServer, NewSessionResponse } from "@agentclientprotocol/sdk";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import type { ProviderProcessSupervisor } from "../../runtime/provider-process-supervisor.js";
import { grokNotificationSessionId } from "./events.js";

export const GROK_ACP_PROTOCOL_VERSION = 1;

/** Canonical argv prefix shared by turn spawns and model discovery. */
export const GROK_ACP_BASE_ARGS: readonly string[] = ["--no-auto-update", "agent", "--no-leader", "--always-approve"];

/**
 * Canonical turn argv (exported so tests can lock the spawn contract).
 * `--model` / `--effort` are omitted when the config values are empty so
 * Grok falls back to its local defaults; the prompt NEVER rides argv.
 */
export function buildGrokTurnArgs(input: { model: string; reasoningEffort: string }): string[] {
  const args = [...GROK_ACP_BASE_ARGS];
  if (input.model) args.push("--model", input.model);
  if (input.reasoningEffort) args.push("--effort", input.reasoningEffort);
  args.push("stdio");
  return args;
}

/** Bounded stderr tail kept for failure classification (never persisted raw). */
const STDERR_TAIL_LIMIT = 8_192;
/** Grace between SIGTERM and SIGKILL on abort, and the final close wait. */
const KILL_GRACE_MS = 5_000;
const FINAL_CLOSE_WAIT_MS = 10_000;
/** Pre-prompt (replay-fence) drops are logged a bounded number of times. */
const REPLAY_DROP_LOG_LIMIT = 3;
/**
 * Post-session/load replay drain: historical updates stream in right after
 * the load response; the prompt is sent only after the inbound channel has
 * been quiet for REPLAY_QUIET_MS (hard-capped at REPLAY_DRAIN_CAP_MS). The
 * SDK dispatches notification handlers asynchronously, so without the drain
 * a replayed chunk can be dispatched after our continuation has already
 * marked the prompt as sent.
 */
export const GROK_ACP_REPLAY_QUIET_MS = 25;
export const GROK_ACP_REPLAY_DRAIN_CAP_MS = 2_000;

export type GrokAcpMcpCapabilities = { http: boolean; sse: boolean };

function headerRecordToArray(headers: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

/**
 * Map First Tree managed MCP servers to the ACP schema. HTTP/SSE entries are
 * dropped (with one log line per server) when the agent did not advertise the
 * transport in its initialize response — never claim a transport the agent
 * did not offer.
 */
export function mapGrokAcpMcpServers(
  servers: AgentRuntimeConfigPayload["mcpServers"],
  capabilities: GrokAcpMcpCapabilities,
  log: (message: string) => void,
): McpServer[] {
  const mapped: McpServer[] = [];
  for (const server of servers) {
    if (server.transport === "stdio") {
      mapped.push({ name: server.name, command: server.command, args: server.args ?? [], env: [] });
      continue;
    }
    if (!capabilities[server.transport]) {
      log(
        `grok ACP: dropping MCP server "${server.name}" — agent did not advertise mcpCapabilities.${server.transport}`,
      );
      continue;
    }
    mapped.push({
      name: server.name,
      type: server.transport,
      url: server.url,
      headers: headerRecordToArray(server.headers),
    });
  }
  return mapped;
}

export type GrokAcpFailurePhase = "initialize" | "session_new" | "session_load" | "prompt";

export type GrokAcpAttemptInput = {
  supervisor: ProviderProcessSupervisor;
  binary: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  abortSignal: AbortSignal;
  label: string;
  /** Advertised as clientInfo.version ("0" when the build has no shared version). */
  clientVersion: string;
  /** Confirmed provider session id to `session/load`; null runs `session/new`. */
  resumeSessionId: string | null;
  mcpServers: AgentRuntimeConfigPayload["mcpServers"];
  promptText: string;
  /** Bounded wait for process close after stdin EOF on the success path. */
  eofCloseWaitMs?: number;
  /** Fired once initialize completed and capabilities validated (replay-ladder "saw provider" rung). */
  onInitialized?: () => void;
  /** Fired as soon as session/new or session/load confirms the active session id. */
  onSessionId?: (sessionId: string) => void;
  onSessionUpdate: (params: unknown) => void;
  onXaiNotification: (params: unknown) => void;
  log: (message: string) => void;
};

export type GrokAcpAttemptOutcome = {
  /** Session id confirmed by session/new (or the loaded id); null when the attempt died earlier. */
  sessionId: string | null;
  /** session/prompt response; null when the prompt never completed. */
  prompt: { stopReason: string; meta: Record<string, unknown> | null } | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  /** True only when the process closed with exit code 0 after stdin EOF. */
  cleanExit: boolean;
  spawnError?: Error;
  failure?: { phase: GrokAcpFailurePhase; error: Error };
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function asMeta(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Run one ACP turn attempt against a fresh Grok process. Never throws: every
 * failure mode lands in the returned outcome for the handler to classify
 * (spawn error / protocol failure phase / stderr tail + exit status).
 */
export async function runGrokAcpAttempt(input: GrokAcpAttemptInput): Promise<GrokAcpAttemptOutcome> {
  let supervised: ReturnType<ProviderProcessSupervisor["spawn"]>;
  try {
    supervised = input.supervisor.spawn({
      command: input.binary,
      args: input.args,
      label: input.label,
      options: {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // POSIX: own process group so abort kills the whole tree (mirrors the
        // opencode handler's terminate path).
        ...(process.platform === "win32" ? {} : { detached: true }),
      },
    });
  } catch (err) {
    return {
      sessionId: null,
      prompt: null,
      exitCode: null,
      signal: null,
      stderrTail: "",
      cleanExit: false,
      spawnError: toError(err),
    };
  }
  const child = supervised.child;
  if (!child.stdin || !child.stdout || !child.stderr) {
    return {
      sessionId: null,
      prompt: null,
      exitCode: null,
      signal: null,
      stderrTail: "",
      cleanExit: false,
      spawnError: new Error("grok ACP child stdio is not piped"),
    };
  }
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;

  let stderrTail = "";
  let spawnError: Error | undefined;
  let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  let terminated = false;
  let resolveClose: () => void = () => {};
  const closeWait = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  };

  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    killTree("SIGTERM");
    const hardKill = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    hardKill.unref?.();
    const finalDeadline = setTimeout(() => {
      closed ??= { exitCode: null, signal: "SIGKILL" };
      resolveClose();
    }, KILL_GRACE_MS + FINAL_CLOSE_WAIT_MS);
    finalDeadline.unref?.();
  };

  childStderr.setEncoding("utf8");
  childStderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  });
  childStderr.on("error", () => {
    /* tail stays best-effort */
  });
  child.on("error", (err) => {
    spawnError = toError(err);
    closed ??= { exitCode: null, signal: null };
    resolveClose();
  });
  child.on("close", (exitCode, signal) => {
    closed = { exitCode, signal };
    resolveClose();
  });

  // Replay-fence state (see module doc): only notifications that belong to
  // the CURRENT prompt may reach the handler. `lastInboundAt` is stamped by
  // the notification PARSERS — the SDK runs them synchronously at receipt,
  // while handlers dispatch asynchronously (a post-load replay message is
  // often dispatched only after our continuation already resumed), so the
  // fence cannot key off handler-dispatch order alone.
  let currentSessionId: string | null = null;
  let promptSent = false;
  let replayDrops = 0;
  let lastInboundAt = 0;
  const pendingNotifications = new Set<Promise<void>>();

  const routeNotification = (params: unknown, deliver: (value: unknown) => void, channel: string): void => {
    if (!promptSent) {
      if (replayDrops < REPLAY_DROP_LOG_LIMIT) {
        input.log(`grok ACP: dropped pre-prompt ${channel} notification (session/load replay fence)`);
      }
      replayDrops++;
      return;
    }
    const routedSessionId = grokNotificationSessionId(params);
    if (currentSessionId && routedSessionId && routedSessionId !== currentSessionId) {
      input.log(`grok ACP: dropped ${channel} notification for foreign session ${routedSessionId}`);
      return;
    }
    const tracked = Promise.resolve()
      .then(() => deliver(params))
      .then(
        () => {},
        (err: unknown) => {
          input.log(`grok ACP: ${channel} notification handling failed: ${toError(err).message}`);
        },
      );
    pendingNotifications.add(tracked);
    void tracked.then(() => pendingNotifications.delete(tracked));
  };

  // The passthrough parser keeps raw params so events.ts owns ALL tolerant
  // normalization in one tested layer; the SDK's generated schemas must not
  // silently strip `_meta` (x.ai tool metadata) or reject unknown update kinds.
  const passthrough = (params: unknown): unknown => {
    lastInboundAt = Date.now();
    return params;
  };
  const app = client({ name: "first-tree" })
    .onNotification("session/update", passthrough, (context) =>
      routeNotification(context.params, input.onSessionUpdate, "session/update"),
    )
    .onNotification("_x.ai/session_notification", passthrough, (context) =>
      routeNotification(context.params, input.onXaiNotification, "_x.ai/session_notification"),
    )
    .onNotification("_x.ai/session/update", passthrough, (context) =>
      routeNotification(context.params, input.onXaiNotification, "_x.ai/session/update"),
    )
    .onRequest("session/request_permission", () => {
      // Must never fire under --always-approve + yoloMode. Fail closed:
      // cancel, never auto-approve.
      input.log(
        "grok ACP: refused unexpected session/request_permission under --always-approve (provider misbehavior)",
      );
      return { outcome: { outcome: "cancelled" as const } };
    });

  const stream = ndJsonStream(Writable.toWeb(childStdin), Readable.toWeb(childStdout));
  const connection = app.connect(stream);
  const agent = connection.agent;

  let promptInFlight = false;
  const onAbort = (): void => {
    if (promptInFlight && currentSessionId) {
      // Best-effort cooperative cancel BEFORE the SIGTERM path.
      void agent.notify("session/cancel", { sessionId: currentSessionId }).catch(() => {});
    }
    terminate();
  };
  input.abortSignal.addEventListener("abort", onAbort, { once: true });

  const outcome = (): GrokAcpAttemptOutcome => ({
    sessionId: currentSessionId,
    prompt: promptResult,
    exitCode: closed?.exitCode ?? null,
    signal: closed?.signal ?? null,
    stderrTail,
    cleanExit: closed?.exitCode === 0,
    ...(spawnError ? { spawnError } : {}),
    ...(failure ? { failure } : {}),
  });

  const failAndDrain = async (phase: GrokAcpFailurePhase, err: unknown): Promise<GrokAcpAttemptOutcome> => {
    failure = { phase, error: toError(err) };
    try {
      childStdin.end();
    } catch {
      /* already gone */
    }
    terminate();
    await closeWait;
    return outcome();
  };

  let failure: { phase: GrokAcpFailurePhase; error: Error } | undefined;
  let promptResult: GrokAcpAttemptOutcome["prompt"] = null;

  try {
    // 1. initialize — deliberately EMPTY clientCapabilities (see module doc).
    let initResponse: InitializeResponse;
    try {
      initResponse = await agent.request("initialize", {
        protocolVersion: GROK_ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "first-tree", version: input.clientVersion },
      });
    } catch (err) {
      return await failAndDrain("initialize", err);
    }
    if (initResponse.protocolVersion !== GROK_ACP_PROTOCOL_VERSION) {
      return await failAndDrain(
        "initialize",
        new Error(
          `grok provider mismatch: ACP protocolVersion ${String(initResponse.protocolVersion)} ` +
            `(expected ${GROK_ACP_PROTOCOL_VERSION})`,
        ),
      );
    }
    const agentCapabilities = initResponse.agentCapabilities;
    if (input.resumeSessionId && agentCapabilities?.loadSession !== true) {
      return await failAndDrain(
        "initialize",
        new Error("grok provider mismatch: agent does not advertise session/load capability required for resume"),
      );
    }
    const mcpCapabilities: GrokAcpMcpCapabilities = {
      http: agentCapabilities?.mcpCapabilities?.http === true,
      sse: agentCapabilities?.mcpCapabilities?.sse === true,
    };
    input.onInitialized?.();

    // 2. session/new (first turn) or session/load (resume). A session/load
    // failure is terminal for the attempt — never silently re-run as
    // session/new (a fresh session could re-execute side effects).
    const mappedServers = mapGrokAcpMcpServers(input.mcpServers, mcpCapabilities, input.log);
    if (input.resumeSessionId) {
      try {
        await agent.request("session/load", {
          sessionId: input.resumeSessionId,
          cwd: input.cwd,
          mcpServers: mappedServers,
          _meta: { yoloMode: true },
        });
      } catch (err) {
        return await failAndDrain("session_load", err);
      }
      currentSessionId = input.resumeSessionId;
    } else {
      let newSessionResponse: NewSessionResponse;
      try {
        newSessionResponse = await agent.request("session/new", {
          cwd: input.cwd,
          mcpServers: mappedServers,
          _meta: { yoloMode: true },
        });
      } catch (err) {
        return await failAndDrain("session_new", err);
      }
      currentSessionId = newSessionResponse.sessionId;
    }
    input.onSessionId?.(currentSessionId);

    if (input.resumeSessionId) {
      // Replay drain: historical updates arrive right after the load
      // response; wait until the inbound channel goes quiet before sending
      // the current prompt. Everything received during the drain is dropped
      // by the pre-prompt fence above.
      lastInboundAt = Date.now();
      const drainStart = lastInboundAt;
      for (;;) {
        const quietFor = Date.now() - lastInboundAt;
        if (quietFor >= GROK_ACP_REPLAY_QUIET_MS) break;
        if (Date.now() - drainStart >= GROK_ACP_REPLAY_DRAIN_CAP_MS) {
          input.log("grok ACP: replay drain hit its cap; proceeding with the prompt");
          break;
        }
        if (input.abortSignal.aborted) break;
        await new Promise((resolve) => {
          setTimeout(resolve, Math.min(GROK_ACP_REPLAY_QUIET_MS - quietFor, 25));
        });
      }
      if (replayDrops > 0) {
        input.log(`grok ACP: replay fence dropped ${replayDrops} historical notification(s) after session/load`);
      }
    }

    // 3. session/prompt — the replay fence opens only now.
    promptSent = true;
    promptInFlight = true;
    try {
      const promptResponse = await agent.request("session/prompt", {
        sessionId: currentSessionId,
        prompt: [{ type: "text", text: input.promptText }],
      });
      promptResult = { stopReason: promptResponse.stopReason, meta: asMeta(promptResponse._meta) };
    } catch (err) {
      return await failAndDrain("prompt", err);
    } finally {
      promptInFlight = false;
    }

    // 4. Settlement barrier: drain queued notification handlers, then end
    // stdin and require the process to close with exit 0 (Grok exits 0 on
    // clean EOF). The close wait is BOUNDED: a process that answered the
    // prompt but never exits is reclaimed through the terminate path and
    // lands as a non-clean exit (a failure input, never a silent success).
    while (pendingNotifications.size > 0) {
      await Promise.all([...pendingNotifications]);
    }
    childStdin.end();
    if (input.abortSignal.aborted) terminate();
    const eofDeadline = setTimeout(() => {
      input.log("grok ACP: process did not exit after stdin EOF; terminating the process tree");
      terminate();
    }, input.eofCloseWaitMs ?? FINAL_CLOSE_WAIT_MS);
    eofDeadline.unref?.();
    await closeWait;
    clearTimeout(eofDeadline);
    return outcome();
  } finally {
    input.abortSignal.removeEventListener("abort", onAbort);
    if (!closed) terminate();
  }
}

export type GrokAcpModelStateFetch = { ok: true; meta: Record<string, unknown> | null } | { ok: false; error: string };

/**
 * Initialize-only ACP handshake for model discovery: spawn the CLI, run
 * `initialize` (unauthenticated metadata — never touches credentials),
 * capture the response `_meta`, then reclaim the process through a bounded
 * EOF→close barrier. EVERY path reclaims the child: stdin EOF, then a
 * bounded wait, then process-tree terminate. Success requires a clean
 * exit 0 — an early return after initialize would leak the process and ACK
 * a catalog whose transport never drained.
 */
export async function fetchGrokAcpInitializeMeta(input: {
  binary: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  clientVersion: string;
  /** Bounded wait for process close after stdin EOF (tests shorten this). */
  eofCloseWaitMs?: number;
}): Promise<GrokAcpModelStateFetch> {
  const eofCloseWaitMs = input.eofCloseWaitMs ?? FINAL_CLOSE_WAIT_MS;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.binary, [...GROK_ACP_BASE_ARGS, "stdio"], {
      env: input.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(process.platform === "win32" ? {} : { detached: true }),
    });
  } catch (err) {
    return { ok: false, error: toError(err).message };
  }
  if (!child.stdin || !child.stdout) {
    return { ok: false, error: "grok ACP child stdio is not piped" };
  }
  const childStdin = child.stdin;
  const childStdout = child.stdout;

  let stderrTail = "";
  let spawnError: Error | undefined;
  let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  let resolveClose: () => void = () => {};
  const closeWait = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  };
  let terminated = false;
  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    killTree("SIGTERM");
    const hardKill = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    hardKill.unref?.();
    const finalDeadline = setTimeout(() => {
      closed ??= { exitCode: null, signal: "SIGKILL" };
      resolveClose();
    }, KILL_GRACE_MS + FINAL_CLOSE_WAIT_MS);
    finalDeadline.unref?.();
  };

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMs);
  timer.unref?.();

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  });
  child.on("error", (err) => {
    spawnError = toError(err);
    closed ??= { exitCode: null, signal: null };
    resolveClose();
  });
  child.on("close", (exitCode, signal) => {
    closed = { exitCode, signal };
    resolveClose();
  });

  const stream = ndJsonStream(Writable.toWeb(childStdin), Readable.toWeb(childStdout));
  const connection = client({ name: "first-tree" }).connect(stream);

  let meta: Record<string, unknown> | null = null;
  let initError: Error | null = null;
  try {
    const initResponse = await connection.agent.request("initialize", {
      protocolVersion: GROK_ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "first-tree", version: input.clientVersion },
    });
    meta = asMeta(initResponse._meta);
  } catch (err) {
    initError = toError(err);
  }

  // Reclaim the process on EVERY path: EOF first, bounded wait, then
  // process-tree terminate. Never resolve while the child is still running.
  try {
    childStdin.end();
  } catch {
    /* already gone */
  }
  const eofDeadline = setTimeout(() => terminate(), eofCloseWaitMs);
  eofDeadline.unref?.();
  await closeWait;
  clearTimeout(eofDeadline);
  clearTimeout(timer);

  if (timedOut) return { ok: false, error: `grok ACP model discovery timed out after ${input.timeoutMs}ms` };
  if (spawnError) return { ok: false, error: spawnError.message };
  if (initError) return { ok: false, error: stderrTail.trim() || initError.message };
  // `closed` is assigned from event callbacks; read it through a function so
  // TS does not narrow it to null from the initializer (microsoft/TypeScript#9998).
  const finalClose = ((): { exitCode: number | null; signal: NodeJS.Signals | null } | null => closed)();
  if (finalClose?.exitCode !== 0) {
    return {
      ok: false,
      error:
        `grok ACP model discovery process exited ${finalClose?.exitCode ?? `signal ${finalClose?.signal ?? "unknown"}`} ` +
        "after initialize (exit 0 required)",
    };
  }
  return { ok: true, meta };
}
