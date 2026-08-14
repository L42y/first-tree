#!/usr/bin/env node
// Copy the canonical skill payloads from the repo-root `skills/` directory
// into `packages/client/skills/` so they ship inside the @first-tree/client
// npm tarball (see the `files` field in package.json). Public source of truth
// stays at `<repo>/skills/`; private alternatives are centrally registered
// under `<repo>/skill-variants/`. This directory is a build artifact.
//
// Runs in `prebuild`. Intentionally synchronous — fast, deterministic, and
// avoids pulling in an async dependency just to do a directory copy.

import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyPrivateSkillVariants,
  resetSkillsTarget,
  withTrustedSkillsTarget,
} from "../../../scripts/copy-skill-payloads.mjs";

// The skill set that ships with @first-tree/client. Kept hand-maintained
// (rather than "copy whatever exists in repo-root skills/") so that adding
// or retiring a skill is a deliberate decision visible in this commit.
//
// To add a skill: drop its directory under repo-root `skills/<name>/`, then
// add the name here. To retire one: remove it from this list AND delete the
// directory under repo-root `skills/`.
const BUNDLED_SKILLS = [
  "first-tree-welcome",
  "first-tree-write",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-file-bug",
  "context-tree-review",
  "context-tree-audit",
  "first-tree-qa",
];

function findRepoRoot(startDir) {
  let currentDir = resolve(startDir);
  while (true) {
    if (existsSync(join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error("Could not locate repo root (no pnpm-workspace.yaml found in any parent of this script).");
    }
    currentDir = parentDir;
  }
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const clientPkgDir = resolve(scriptDir, "..");
  const repoRoot = findRepoRoot(scriptDir);
  const sourceSkillsRoot = join(repoRoot, "skills");

  if (!existsSync(sourceSkillsRoot) || !statSync(sourceSkillsRoot).isDirectory()) {
    throw new Error(`Source skills directory missing: ${sourceSkillsRoot}`);
  }

  // Run the reset, the selective public copy, and the private-variant copy
  // inside a single verified transaction — there is no raw-path wipe here,
  // and the source roots stay pinned open for the whole mutation sequence.
  withTrustedSkillsTarget({ repoRoot, trustedParentDir: clientPkgDir }, (skillsTarget) => {
    const targetSkillsRoot = skillsTarget.targetSkillsRoot;

    // Wipe + recreate so retired skills disappear and dirty files do not
    // linger between builds. The reset re-verifies the capability immediately
    // before deleting.
    resetSkillsTarget(skillsTarget);

    const missing = [];
    for (const name of BUNDLED_SKILLS) {
      const src = join(sourceSkillsRoot, name);
      if (!existsSync(src)) {
        missing.push(name);
        continue;
      }
      const dst = join(targetSkillsRoot, name);
      cpSync(src, dst, { recursive: true });
    }

    if (missing.length > 0) {
      throw new Error(
        `Source skills missing for: ${missing.join(", ")}. Either add them under ${sourceSkillsRoot}/ or remove from BUNDLED_SKILLS in this script.`,
      );
    }

    const variantCount = copyPrivateSkillVariants({ target: skillsTarget });

    const copied = readdirSync(targetSkillsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
    process.stdout.write(
      `copy-bundled-skills: copied ${copied.length} public skill(s) + ${variantCount} private variant(s) → ${targetSkillsRoot}\n`,
    );
  });
}

main();
