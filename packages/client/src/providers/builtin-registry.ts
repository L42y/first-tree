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
import {
  BUILTIN_PROVIDER_PROBES,
  type CapabilityProbe,
  installBuiltinProviderProbes,
  probedRuntimeProviders,
  resetBuiltinProviderProbesForTests,
} from "./builtin-probes.js";
import { installProviderSkillRoots, PROVIDER_SKILL_ROOTS, resetProviderSkillRootsForTests } from "./skill-roots.js";

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

function probesFromRegistry(registry: BuiltinProviderRegistry): Record<RuntimeProvider, CapabilityProbe> {
  const out = {} as Record<RuntimeProvider, CapabilityProbe>;
  for (const id of RUNTIME_PROVIDER_IDS) {
    out[id] = registry[id].probe;
  }
  return out;
}

function skillRootsFromRegistry(registry: BuiltinProviderRegistry): Record<RuntimeProvider, string> {
  const out = {} as Record<RuntimeProvider, string>;
  for (const id of RUNTIME_PROVIDER_IDS) {
    out[id] = registry[id].skillRoot;
  }
  return out;
}

/**
 * Build the immutable, exhaustive built-in provider registry.
 *
 * This is the single composition root for handler factories, install probes,
 * and native skill roots. Seeded from the default probe/skill-root tables;
 * {@link installBuiltinProviderRegistry} then syncs those active tables from
 * the installed registry so generic consumers cannot drift.
 */
export function createBuiltinProviderRegistry(deps: BuiltinRegistryDeps = {}): BuiltinProviderRegistry {
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();
  // Always seed from the default tables — not from any previously installed
  // override — so composition stays deterministic.
  const probes = BUILTIN_PROVIDER_PROBES;
  const skillRoots = PROVIDER_SKILL_ROOTS;

  return {
    "claude-code": {
      factory: (config) => createClaudeCodeHandler({ ...config, claudeCodeExecutable: resolution.path }),
      probe: probes["claude-code"],
      skillRoot: skillRoots["claude-code"],
    },
    "claude-code-tui": {
      factory: (config) => createClaudeCodeTuiHandler({ ...config, claudeCodeExecutable: resolution.path }),
      probe: probes["claude-code-tui"],
      skillRoot: skillRoots["claude-code-tui"],
    },
    codex: {
      factory: (config) => createCodexHandler(config),
      probe: probes.codex,
      skillRoot: skillRoots.codex,
    },
    cursor: {
      factory: (config) => createCursorHandler(config),
      probe: probes.cursor,
      skillRoot: skillRoots.cursor,
    },
    grok: {
      factory: (config) => createGrokHandler(config),
      probe: probes.grok,
      skillRoot: skillRoots.grok,
    },
    "kimi-code": {
      factory: (config) => createKimiCodeHandler(config),
      probe: probes["kimi-code"],
      skillRoot: skillRoots["kimi-code"],
    },
    opencode: {
      factory: (config) => createOpenCodeHandler(config),
      probe: probes.opencode,
      skillRoot: skillRoots.opencode,
    },
    pi: {
      factory: (config) => createPiHandler(config),
      probe: probes.pi,
      skillRoot: skillRoots.pi,
    },
  } as const satisfies BuiltinProviderRegistry;
}

/** Process-wide installed registry used after `registerBuiltinHandlers`. */
let installedRegistry: BuiltinProviderRegistry | null = null;

/**
 * Install (or replace) the process-wide built-in registry and sync the active
 * probe + skill-root tables from it. Capability aggregation and managed-skills
 * lookup read those synced tables so they cannot disagree with the registry.
 */
export function installBuiltinProviderRegistry(registry: BuiltinProviderRegistry): void {
  installedRegistry = registry;
  installBuiltinProviderProbes(probesFromRegistry(registry));
  installProviderSkillRoots(skillRootsFromRegistry(registry));
}

/** Peek at the installed registry without lazily creating one. */
export function peekInstalledBuiltinProviderRegistry(): BuiltinProviderRegistry | null {
  return installedRegistry;
}

/**
 * Return the installed registry, lazily creating the default built-ins when a
 * caller needs the full factory table before explicit registration.
 */
export function getBuiltinProviderRegistry(): BuiltinProviderRegistry {
  if (!installedRegistry) {
    installBuiltinProviderRegistry(createBuiltinProviderRegistry());
  }
  const registry = installedRegistry;
  if (!registry) {
    throw new Error("builtin provider registry failed to install");
  }
  return registry;
}

/** Test helper — clears the process-wide registry install and synced tables. */
export function resetBuiltinProviderRegistryForTests(): void {
  installedRegistry = null;
  resetBuiltinProviderProbesForTests();
  resetProviderSkillRootsForTests();
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
