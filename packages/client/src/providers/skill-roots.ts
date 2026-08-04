import { RUNTIME_PROVIDER_IDS, type RuntimeProvider } from "@first-tree/shared";

/**
 * Immutable native managed-skill projection roots per runtime provider.
 *
 * Composition-owned projection of the exhaustive provider set — read directly
 * by `managed-skills` (not via the handler registry).
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

export function assertSkillRootsComplete(): void {
  for (const id of RUNTIME_PROVIDER_IDS) {
    if (!(id in PROVIDER_SKILL_ROOTS)) {
      throw new Error(`Missing skill root for runtime provider "${id}"`);
    }
  }
}
