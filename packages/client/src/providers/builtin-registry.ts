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
import { type CapabilityProbe, getBuiltinProviderProbes, probedRuntimeProviders } from "./builtin-probes.js";
import { PROVIDER_SKILL_ROOTS } from "./skill-roots.js";

export { probedRuntimeProviders };

/** Injectable seam so tests can force a Claude-executable resolution (no real PATH / shell spawn). */
export type BuiltinRegistryDeps = {
  resolveExecutable?: () => ClaudeExecutableResolution;
};

/**
 * Built-in provider module entry on the existing Handler / probe surfaces.
 * Not a new Handler contract — only aggregates today's wiring points.
 */
export type BuiltinProviderEntry = {
  factory: HandlerFactory;
  probe: CapabilityProbe;
  skillRoot: string;
};

export type BuiltinProviderRegistry = Readonly<Record<RuntimeProvider, BuiltinProviderEntry>>;

/**
 * Build the immutable, exhaustive built-in provider registry.
 *
 * This is the single composition root for handler factories, install probes,
 * and native skill roots. Generic runtime / CLI / web dispatchers must consume
 * this registry (or a test double) instead of listing providers themselves.
 */
export function createBuiltinProviderRegistry(deps: BuiltinRegistryDeps = {}): BuiltinProviderRegistry {
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();
  const probes = getBuiltinProviderProbes();

  return {
    "claude-code": {
      factory: (config) => createClaudeCodeHandler({ ...config, claudeCodeExecutable: resolution.path }),
      probe: probes["claude-code"],
      skillRoot: PROVIDER_SKILL_ROOTS["claude-code"],
    },
    "claude-code-tui": {
      factory: (config) => createClaudeCodeTuiHandler({ ...config, claudeCodeExecutable: resolution.path }),
      probe: probes["claude-code-tui"],
      skillRoot: PROVIDER_SKILL_ROOTS["claude-code-tui"],
    },
    codex: {
      factory: (config) => createCodexHandler(config),
      probe: probes.codex,
      skillRoot: PROVIDER_SKILL_ROOTS.codex,
    },
    cursor: {
      factory: (config) => createCursorHandler(config),
      probe: probes.cursor,
      skillRoot: PROVIDER_SKILL_ROOTS.cursor,
    },
    grok: {
      factory: (config) => createGrokHandler(config),
      probe: probes.grok,
      skillRoot: PROVIDER_SKILL_ROOTS.grok,
    },
    "kimi-code": {
      factory: (config) => createKimiCodeHandler(config),
      probe: probes["kimi-code"],
      skillRoot: PROVIDER_SKILL_ROOTS["kimi-code"],
    },
    opencode: {
      factory: (config) => createOpenCodeHandler(config),
      probe: probes.opencode,
      skillRoot: PROVIDER_SKILL_ROOTS.opencode,
    },
    pi: {
      factory: (config) => createPiHandler(config),
      probe: probes.pi,
      skillRoot: PROVIDER_SKILL_ROOTS.pi,
    },
  } as const satisfies BuiltinProviderRegistry;
}

/** Process-wide installed registry used after `registerBuiltinHandlers`. */
let installedRegistry: BuiltinProviderRegistry | null = null;

/** Install (or replace) the process-wide built-in registry reference. */
export function installBuiltinProviderRegistry(registry: BuiltinProviderRegistry): void {
  installedRegistry = registry;
}

/**
 * Return the installed registry, lazily creating the default built-ins when a
 * caller needs the full factory table before explicit registration.
 */
export function getBuiltinProviderRegistry(): BuiltinProviderRegistry {
  if (!installedRegistry) {
    installedRegistry = createBuiltinProviderRegistry();
  }
  return installedRegistry;
}

/** Test helper — clears the process-wide registry install. */
export function resetBuiltinProviderRegistryForTests(): void {
  installedRegistry = null;
}

/** Log Claude executable resolution the same way the previous registerBuiltinHandlers did. */
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
export function resolveAndLogClaudeExecutable(deps: BuiltinRegistryDeps = {}): ClaudeExecutableResolution {
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();
  logClaudeExecutableResolution(resolution);
  return resolution;
}

/** All registry keys — must equal {@link RUNTIME_PROVIDER_IDS}. */
export function builtinRegistryProviderIds(registry: BuiltinProviderRegistry): RuntimeProvider[] {
  return [...RUNTIME_PROVIDER_IDS].filter((id) => id in registry);
}

export type { CapabilityProbe } from "./builtin-probes.js";
