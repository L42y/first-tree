import { RUNTIME_PROVIDER_IDS, type RuntimeProvider } from "@first-tree/shared";

/**
 * Native managed-skill projection roots per runtime provider.
 *
 * Pure data shared by the built-in registry and `managed-skills` lookup so
 * generic aggregation never hard-codes provider branches. Keep this module free
 * of handler / probe imports to avoid composition cycles.
 */
export const PROVIDER_SKILL_ROOTS = {
  "claude-code": ".claude/skills",
  "claude-code-tui": ".claude/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
  grok: ".grok/skills",
  "kimi-code": ".kimi-code/skills",
  opencode: ".opencode/skills",
  pi: ".agents/skills",
} as const satisfies Record<RuntimeProvider, string>;

export function providerSkillRootFromRegistry(provider: RuntimeProvider): string {
  return PROVIDER_SKILL_ROOTS[provider];
}

/** Exhaustiveness helper: every known provider has a skill root. */
export function assertSkillRootsComplete(): void {
  for (const id of RUNTIME_PROVIDER_IDS) {
    if (!(id in PROVIDER_SKILL_ROOTS)) {
      throw new Error(`Missing skill root for runtime provider "${id}"`);
    }
  }
}
