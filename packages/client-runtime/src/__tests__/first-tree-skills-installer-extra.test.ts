import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_SKILL_NAMES, resolveBundledSkillsRoot } from "../runtime/first-tree-skills/installer.js";

describe("bundled Core Skill resolver", () => {
  let sandbox: string | undefined;

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  });

  it("walks upward to the package-level skills payload", () => {
    sandbox = mkdtempSync(join(tmpdir(), "ft-bundled-skills-"));
    const expected = join(sandbox, "package", "skills");
    mkdirSync(join(expected, "first-tree-write"), { recursive: true });
    writeFileSync(join(expected, "first-tree-write", "SKILL.md"), "fixture\n");
    const nestedStart = join(sandbox, "package", "dist", "runtime", "nested");
    mkdirSync(nestedStart, { recursive: true });

    expect(resolveBundledSkillsRoot(nestedStart)).toBe(expected);
  });

  it("reports a packaging error when the payload cannot be found", () => {
    sandbox = mkdtempSync(join(tmpdir(), "ft-bundled-skills-missing-"));
    expect(() => resolveBundledSkillsRoot(sandbox)).toThrow("Could not locate bundled `skills/` payloads");
  });

  it("keeps the Core list unique", () => {
    expect(new Set(CORE_SKILL_NAMES).size).toBe(CORE_SKILL_NAMES.length);
  });
});
