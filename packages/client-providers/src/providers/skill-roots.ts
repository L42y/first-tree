import type { RuntimeProvider } from "@first-tree/shared";

/**
 * Frozen native managed-skill projection roots per runtime provider.
 *
 * Composition-owned projection of the exhaustive provider set. Callers pass
 * this into runtime Managed Skills / preparation APIs (runtime must not import
 * providers).
 */
export const PROVIDER_SKILL_ROOTS: Readonly<Record<RuntimeProvider, string>> = Object.freeze({
  "claude-code": ".claude/skills",
  "claude-code-tui": ".claude/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
  grok: ".grok/skills",
  "kimi-code": ".kimi-code/skills",
  opencode: ".opencode/skills",
  pi: ".agents/skills",
} satisfies Record<RuntimeProvider, string>);
