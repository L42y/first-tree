import { RUNTIME_PROVIDER_IDS, type RuntimeProvider } from "@first-tree/shared";

/**
 * Default native managed-skill projection roots per runtime provider.
 *
 * Seed data for {@link createBuiltinProviderRegistry}. After
 * `installBuiltinProviderRegistry`, active lookups use the installed registry's
 * `skillRoot` values so probe/skill consumers cannot drift from composition.
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

let installedSkillRoots: Readonly<Record<RuntimeProvider, string>> | null = null;

/** Sync active skill-root table from an installed builtin registry. */
export function installProviderSkillRoots(roots: Readonly<Record<RuntimeProvider, string>>): void {
  installedSkillRoots = roots;
}

export function getProviderSkillRoots(): Readonly<Record<RuntimeProvider, string>> {
  return installedSkillRoots ?? PROVIDER_SKILL_ROOTS;
}

export function providerSkillRootFromRegistry(provider: RuntimeProvider): string {
  return getProviderSkillRoots()[provider];
}

export function resetProviderSkillRootsForTests(): void {
  installedSkillRoots = null;
}

/** Exhaustiveness helper: every known provider has a skill root. */
export function assertSkillRootsComplete(): void {
  for (const id of RUNTIME_PROVIDER_IDS) {
    if (!(id in PROVIDER_SKILL_ROOTS)) {
      throw new Error(`Missing skill root for runtime provider "${id}"`);
    }
  }
}
