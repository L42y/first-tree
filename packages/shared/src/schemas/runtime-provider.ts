import { z } from "zod";

/**
 * Canonical runtime-provider identity list. Schema, named constants, catalog
 * keys, and client built-in registry keys all derive from this single `as const`
 * tuple so a new provider cannot drift across packages.
 *
 * Wire compatibility: unknown provider *strings* may still appear on rolling
 * capability maps (`Record<string, …>`); execution paths must narrow to this
 * known set before dispatching a handler.
 */
export const RUNTIME_PROVIDER_IDS = [
  "claude-code",
  "claude-code-tui",
  "codex",
  "cursor",
  "grok",
  "kimi-code",
  "opencode",
  "pi",
] as const;

export type RuntimeProvider = (typeof RUNTIME_PROVIDER_IDS)[number];

/**
 * Named constants for call sites that prefer `RUNTIME_PROVIDERS.CODEX` over
 * string literals. Values are the same identities as {@link RUNTIME_PROVIDER_IDS}.
 */
export const RUNTIME_PROVIDERS = {
  CLAUDE_CODE: "claude-code",
  CLAUDE_CODE_TUI: "claude-code-tui",
  CODEX: "codex",
  CURSOR: "cursor",
  GROK: "grok",
  KIMI_CODE: "kimi-code",
  OPENCODE: "opencode",
  PI: "pi",
} as const satisfies Record<string, RuntimeProvider>;

export const runtimeProviderSchema = z.enum(RUNTIME_PROVIDER_IDS);

export const DEFAULT_RUNTIME_PROVIDER: RuntimeProvider = "claude-code";

/**
 * Runtime providers temporarily disabled platform-wide. A disabled provider is
 * filtered out of UI runtime selection (creating agents, onboarding, the client
 * setup/ready cards) and skipped by the client capability probe, so it is
 * neither offered to users nor advertised / re-probed by the daemon. The
 * provider stays a valid `RuntimeProvider` so already-bound agents keep their
 * label and continue to run — this only hides it from new selection + detection.
 *
 * Empty = nothing disabled. To re-enable a provider, remove it from this list
 * (single-line revert).
 */
export const DISABLED_RUNTIME_PROVIDERS: readonly RuntimeProvider[] = ["claude-code-tui"];

/** True when `provider` is not temporarily disabled (see {@link DISABLED_RUNTIME_PROVIDERS}). */
export function isRuntimeProviderEnabled(provider: string): boolean {
  return !DISABLED_RUNTIME_PROVIDERS.some((p) => p === provider);
}

/** Narrow a wire string to a known {@link RuntimeProvider}, or `null`. */
export function asRuntimeProvider(provider: string): RuntimeProvider | null {
  return (RUNTIME_PROVIDER_IDS as readonly string[]).includes(provider) ? (provider as RuntimeProvider) : null;
}
