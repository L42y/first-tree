import { createLogger } from "../observability/logger.js";
import { registerHandler } from "../runtime/handler.js";
import { createClaudeCodeHandler } from "./claude-code.js";
import { createClaudeCodeTuiHandler } from "./claude-code-tui/index.js";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "./claude-executable.js";
import { createCodexHandler } from "./codex/index.js";
import { createCursorHandler } from "./cursor/index.js";
import { createGrokHandler } from "./grok/index.js";
import { createKimiCodeHandler } from "./kimi-code.js";
import { createOpenCodeHandler } from "./opencode/index.js";
import { createPiHandler } from "./pi/index.js";

/** Injectable seam so tests can force a Claude-executable resolution (no real PATH / shell spawn). */
export type RegisterBuiltinHandlersDeps = {
  resolveExecutable?: () => ClaudeExecutableResolution;
};

/** Register all built-in handlers. Call once at startup. */
export function registerBuiltinHandlers(deps: RegisterBuiltinHandlersDeps = {}): void {
  // Registration runs synchronously in the ClientRuntime constructor, BEFORE the
  // WS connects — so it must not block. Resolve cheap-only (`includeLoginShell:
  // false`): daemon PATH + well-known dirs, never a login-shell `spawnSync`. A
  // `claude` that lives only on the user's interactive shell PATH resolves to
  // `undefined` here and is picked up lazily by the handler at session start
  // (which re-resolves with the login-shell probe) and by the capability probe
  // (post-registration) — neither of which is on the pre-connect path.
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();
  const log = createLogger("handlers");
  if (resolution.path) {
    log.info(`Claude Code executable: ${resolution.path} (source=${resolution.source})`);
  } else {
    log.info(
      "Claude Code executable: using SDK bundled native binary (set CLAUDE_CODE_EXECUTABLE or install `claude` on PATH to override)",
    );
  }
  registerHandler("claude-code", (config) =>
    createClaudeCodeHandler({ ...config, claudeCodeExecutable: resolution.path }),
  );
  // claude-code-tui: drives the Claude Code TUI through tmux. Replaces the
  // SDK-based handler for the post-SDK-sunset world. Requires `tmux` >= 3.0
  // and `claude` resolvable on PATH (capability probe in
  // `runtime/capabilities/claude-code-tui.ts` enforces both).
  registerHandler("claude-code-tui", (config) =>
    createClaudeCodeTuiHandler({ ...config, claudeCodeExecutable: resolution.path }),
  );
  // Codex prefers the SDK-bundled CLI binary. Global First Tree installs prune
  // that large optional binary, so the handler can fall back to PATH, known
  // install locations, or the macOS ChatGPT/Codex desktop app at session start.
  // The handler factory consumes the same HandlerConfig (workspaceRoot /
  // agentConfigCache / contextTreePath).
  registerHandler("codex", (config) => createCodexHandler(config));
  // Cursor is external-only: no bundled engine, no daemon-run installer. The
  // handler resolves `cursor-agent` / `agent` lazily at session start (with
  // the login-shell probe) and spawns one CLI process per provider turn.
  registerHandler("cursor", (config) => createCursorHandler(config));
  // Grok Build is external-only: the handler resolves the operator-installed
  // `grok` binary lazily at session start and drives one ACP (stdio) process
  // per provider turn. Windows stays fail-closed (POSIX-only supervision).
  registerHandler("grok", (config) => createGrokHandler(config));
  // Kimi Code is driven through the bundled Node SDK. It reuses the host's
  // ~/.kimi-code credential/config and does not add a First Tree login flow.
  registerHandler("kimi-code", (config) => createKimiCodeHandler(config));
  // OpenCode is an external, host-authenticated, per-turn CLI runtime. The
  // handler owns JSONL/session semantics; Windows stays fail-closed until a
  // pre-admission Job Object supervisor is supplied and accepted as drain
  // authority.
  registerHandler("opencode", (config) => createOpenCodeHandler(config));
  // Pi is an external, host-authenticated, long-lived RPC runtime. Windows
  // stays fail-closed until a pre-admission Job Object supervisor is supplied.
  registerHandler("pi", (config) => createPiHandler(config));
}
