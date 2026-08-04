import { RUNTIME_PROVIDER_IDS } from "@first-tree/shared";
import {
  type BuiltinRegistryDeps,
  createBuiltinProviderRegistry,
  installBuiltinProviderRegistry,
  resolveAndLogClaudeExecutable,
} from "../providers/builtin-registry.js";
import { registerHandler } from "../runtime/handler.js";

/** Injectable seam so tests can force a Claude-executable resolution (no real PATH / shell spawn). */
export type RegisterBuiltinHandlersDeps = BuiltinRegistryDeps;

/**
 * Register all built-in handlers from the shared composition registry.
 * Call once at startup (daemon `ClientRuntime` and standalone `AgentRuntime`).
 *
 * Built-ins no longer rely on scattered import side effects — this function is
 * the sole process-global wiring step. Custom `registerHandler` callers remain
 * supported afterward and do not alter the built-in registry snapshot.
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
  const registry = createBuiltinProviderRegistry({ resolveExecutable: () => resolution });
  installBuiltinProviderRegistry(registry);

  for (const id of RUNTIME_PROVIDER_IDS) {
    registerHandler(id, registry[id].factory);
  }
}

/** Re-export registry builder for boot-path parity tests and composition roots. */
export { createBuiltinProviderRegistry } from "../providers/builtin-registry.js";
