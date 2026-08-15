import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_TREE_CORE_SKILL_NAMES } from "@first-tree/shared";

/**
 * The bundled First Tree Skill family. Runtime installation, update, provider
 * placement, migration, and cleanup are owned by `managed-skills.ts`.
 */
export const CORE_SKILL_NAMES = FIRST_TREE_CORE_SKILL_NAMES;

export type CoreSkillName = (typeof CORE_SKILL_NAMES)[number];

export const LOCAL_CONTEXT_SKILL_VARIANT = "local-context";
export const LOCAL_CONTEXT_VARIANT_SKILL_NAMES = ["first-tree-read", "first-tree-write"] as const;

export function localContextVariantSourcePath(bundledSkillsRoot: string, name: string): string {
  return join(bundledSkillsRoot, ".variants", LOCAL_CONTEXT_SKILL_VARIANT, name);
}

/**
 * Walk up from the running module to find the @first-tree/client package root,
 * then return its bundled `skills/` directory.
 *
 * The prebuild copies repo-root Skills into `<client-pkg>/skills/`; the npm
 * package ships that directory beside the compiled runtime.
 */
export function resolveBundledSkillsRoot(startDir?: string): string {
  let currentDir = resolve(startDir ?? dirname(fileURLToPath(import.meta.url)));
  while (true) {
    const candidate = join(currentDir, "skills", "first-tree-write", "SKILL.md");
    if (existsSync(candidate)) return join(currentDir, "skills");
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        "Could not locate bundled `skills/` payloads. Run `pnpm --filter @first-tree/client prebuild` or check that the npm tarball includes `skills/`.",
      );
    }
    currentDir = parentDir;
  }
}
