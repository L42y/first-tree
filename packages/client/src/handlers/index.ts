import { RUNTIME_PROVIDER_IDS } from "@first-tree/shared";
import {
  type BuiltinHandlerRegistryDeps,
  createBuiltinHandlerRegistry,
  resolveAndLogClaudeExecutable,
} from "../providers/builtin-registry.js";
import { registerHandler } from "../runtime/handler.js";

/** Injectable seam so tests can force a Claude-executable resolution (no real PATH / shell spawn). */
export type RegisterBuiltinHandlersDeps = BuiltinHandlerRegistryDeps;

/**
 * Register all built-in handlers from a frozen handler registry value.
 * Call once at startup (daemon `ClientRuntime`).
 *
 * Builds the registry once, registers each factory, and discards the value —
 * there is no process-global installed registry snapshot. Probe/skill consumers
 * read their own frozen composition tables (`BUILTIN_PROVIDER_PROBES` /
 * `PROVIDER_SKILL_ROOTS`).
 */
export function registerBuiltinHandlers(deps: RegisterBuiltinHandlersDeps = {}): void {
  // Registration runs synchronously in the ClientRuntime constructor, BEFORE the
  // WS connects — so it must not block. Resolve cheap-only (`includeLoginShell:
  // false`): daemon PATH + well-known dirs, never a login-shell `spawnSync`. A
  // `claude` that lives only on the user's interactive shell PATH resolves to
  // `undefined` here and is picked up lazily by the handler at session start
  // (which re-resolves with the login-shell probe) and by the capability probe
  // (post-registration) — neither of which is on the pre-connect path.
  const resolution = resolveAndLogClaudeExecutable(deps);
  const registry = createBuiltinHandlerRegistry({
    resolveExecutable: () => resolution,
  });

  for (const id of RUNTIME_PROVIDER_IDS) {
    registerHandler(id, registry[id]);
  }
}

/** Re-export registry builder for composition roots and tests. */
export { createBuiltinHandlerRegistry } from "../providers/builtin-registry.js";
