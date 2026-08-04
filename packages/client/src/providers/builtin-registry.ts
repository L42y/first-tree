import { RUNTIME_PROVIDER_IDS, type RuntimeProvider } from "@first-tree/shared";
import { createClaudeCodeHandler } from "../handlers/claude-code.js";
import { createClaudeCodeTuiHandler } from "../handlers/claude-code-tui/index.js";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "../handlers/claude-executable.js";
import { createCodexHandler } from "../handlers/codex/index.js";
import { createCursorHandler } from "../handlers/cursor/index.js";
import { createGrokHandler } from "../handlers/grok/index.js";
import { createKimiCodeHandler } from "../handlers/kimi-code.js";
import { createOpenCodeHandler } from "../handlers/opencode/index.js";
import { createPiHandler } from "../handlers/pi/index.js";
import { createLogger } from "../observability/logger.js";
import type { HandlerFactory } from "../runtime/handler.js";
import { probedRuntimeProviders } from "./builtin-probes.js";

export { probedRuntimeProviders };

/** Injectable seam for Claude executable resolution in tests. */
export type BuiltinHandlerRegistryDeps = {
  resolveExecutable?: () => ClaudeExecutableResolution;
};

/**
 * Built-in handler factory map — composition-owned, immutable, exhaustive.
 *
 * Probe and skill-root projections live in sibling modules
 * (`BUILTIN_PROVIDER_PROBES`, `PROVIDER_SKILL_ROOTS`); this registry only owns
 * handler factories so generic probe/skills paths do not import heavy SDKs.
 */
export type BuiltinHandlerEntry = {
  factory: HandlerFactory;
};

export type BuiltinHandlerRegistry = Readonly<Record<RuntimeProvider, BuiltinHandlerEntry>>;

/** @deprecated Prefer {@link BuiltinHandlerRegistry}. */
export type BuiltinProviderRegistry = BuiltinHandlerRegistry;
/** @deprecated Prefer {@link BuiltinHandlerEntry}. */
export type BuiltinProviderEntry = BuiltinHandlerEntry;
/** @deprecated Prefer {@link BuiltinHandlerRegistryDeps}. */
export type BuiltinRegistryDeps = BuiltinHandlerRegistryDeps;

/**
 * Build an immutable, exhaustive built-in handler registry value.
 *
 * Consumed once by {@link registerBuiltinHandlers}; not installed into
 * process-global state.
 */
export function createBuiltinHandlerRegistry(deps: BuiltinHandlerRegistryDeps = {}): BuiltinHandlerRegistry {
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();

  return {
    "claude-code": {
      factory: (config) => createClaudeCodeHandler({ ...config, claudeCodeExecutable: resolution.path }),
    },
    "claude-code-tui": {
      factory: (config) => createClaudeCodeTuiHandler({ ...config, claudeCodeExecutable: resolution.path }),
    },
    codex: {
      factory: (config) => createCodexHandler(config),
    },
    cursor: {
      factory: (config) => createCursorHandler(config),
    },
    grok: {
      factory: (config) => createGrokHandler(config),
    },
    "kimi-code": {
      factory: (config) => createKimiCodeHandler(config),
    },
    opencode: {
      factory: (config) => createOpenCodeHandler(config),
    },
    pi: {
      factory: (config) => createPiHandler(config),
    },
  } as const satisfies BuiltinHandlerRegistry;
}

/** @deprecated Prefer {@link createBuiltinHandlerRegistry}. */
export const createBuiltinProviderRegistry = createBuiltinHandlerRegistry;

/** Log Claude executable resolution (same behavior as prior registerBuiltinHandlers). */
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
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();
  logClaudeExecutableResolution(resolution);
  return resolution;
}

/** All registry keys — must equal {@link RUNTIME_PROVIDER_IDS}. */
export function builtinRegistryProviderIds(registry: BuiltinHandlerRegistry): RuntimeProvider[] {
  return [...RUNTIME_PROVIDER_IDS].filter((id) => id in registry);
}

export type { CapabilityProbe } from "./builtin-probes.js";
