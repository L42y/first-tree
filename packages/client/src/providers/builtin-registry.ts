import type { RuntimeProvider } from "@first-tree/shared";
import { createLogger } from "../observability/logger.js";
import type { HandlerFactory } from "../runtime/contracts.js";
import {
  type ClaudeExecutableAuthority,
  type ClaudeExecutableResolution,
  createClaudeExecutableAuthority,
} from "./claude/executable.js";
import { createClaudeCodeHandler } from "./claude/index.js";
import { createClaudeCodeTuiHandler } from "./claude/tui/index.js";
import { createCodexHandler } from "./codex/index.js";
import { createCursorHandler } from "./cursor/index.js";
import { createGrokHandler } from "./grok/index.js";
import { createKimiCodeHandler } from "./kimi-code/index.js";
import { createOpenCodeHandler } from "./opencode/index.js";
import { createPiHandler } from "./pi/index.js";

/** Injectable seams for composition and tests. */
export type BuiltinHandlerRegistryDeps = {
  resolveExecutable?: ClaudeExecutableAuthority["resolve"];
  claudeExecutableAuthority?: ClaudeExecutableAuthority;
};

/**
 * Built-in handler factory map — composition-owned, runtime-frozen, exhaustive.
 *
 * Probe and skill-root projections live in sibling modules
 * (`BUILTIN_PROVIDER_PROBES`, `PROVIDER_SKILL_ROOTS`); this registry only owns
 * handler factories so generic probe/skills paths do not import heavy SDKs.
 */
export type BuiltinHandlerRegistry = Readonly<Record<RuntimeProvider, HandlerFactory>>;

/**
 * Build a frozen, exhaustive built-in handler factory table.
 *
 * The CLI composition root (`ClientRuntime`) creates this once and holds it as
 * an instance value. Standalone runtimes receive an explicit map — never
 * installed into process-global state.
 */
export function createBuiltinHandlerRegistry(deps: BuiltinHandlerRegistryDeps = {}): BuiltinHandlerRegistry {
  const authority =
    deps.claudeExecutableAuthority ?? createClaudeExecutableAuthority({ resolveExecutable: deps.resolveExecutable });

  return Object.freeze({
    "claude-code": (config) => createClaudeCodeHandler({ ...config, claudeCodeExecutable: authority.resolve().path }),
    "claude-code-tui": (config) =>
      createClaudeCodeTuiHandler({ ...config, claudeCodeExecutable: authority.resolve().path }),
    codex: (config) => createCodexHandler(config),
    cursor: (config) => createCursorHandler(config),
    grok: (config) => createGrokHandler(config),
    "kimi-code": (config) => createKimiCodeHandler(config),
    opencode: (config) => createOpenCodeHandler(config),
    pi: (config) => createPiHandler(config),
  } satisfies Record<RuntimeProvider, HandlerFactory>);
}

/** Log Claude executable resolution (cheap PATH / well-known dirs only). */
export function logClaudeExecutableResolution(resolution: ClaudeExecutableResolution): void {
  const log = createLogger("handlers");
  if (resolution.path) {
    log.info(`Claude Code executable: ${resolution.path} (source=${resolution.source})`);
  } else {
    log.info(
      "Claude Code executable: using SDK bundled native binary (set CLAUDE_CODE_EXECUTABLE or install `claude` on PATH to override)",
    );
  }
}

/** Resolve + log Claude executable using the same deps seam as registry creation. */
export function resolveAndLogClaudeExecutable(deps: BuiltinHandlerRegistryDeps = {}): ClaudeExecutableResolution {
  const authority =
    deps.claudeExecutableAuthority ?? createClaudeExecutableAuthority({ resolveExecutable: deps.resolveExecutable });
  const resolution = authority.resolve({ includeLoginShell: false });
  logClaudeExecutableResolution(resolution);
  return resolution;
}
