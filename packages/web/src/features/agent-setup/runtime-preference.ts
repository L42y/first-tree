const RUNTIME_PREFERENCE = ["codex", "claude-code"] as const;

/**
 * Keep runtime choices consistent anywhere a member creates an agent:
 * Codex first, Claude Code second, then every other ready option in the order
 * reported by the connected computer.
 */
export function orderRuntimesByPreference<T extends string>(providers: readonly T[]): T[] {
  const preferred = RUNTIME_PREFERENCE.filter((provider): provider is (typeof RUNTIME_PREFERENCE)[number] & T =>
    providers.includes(provider as T),
  );
  const remaining = providers.filter(
    (provider) => !RUNTIME_PREFERENCE.some((preferredProvider) => preferredProvider === provider),
  );
  return [...preferred, ...remaining];
}

export function pickPreferredRuntime<T extends string>(providers: readonly T[]): T | null {
  return orderRuntimesByPreference(providers)[0] ?? null;
}
