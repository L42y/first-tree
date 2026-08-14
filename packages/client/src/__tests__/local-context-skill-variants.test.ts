import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_SKILL_NAMES } from "../runtime/first-tree-skills/installer.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function field(markdown: string, name: string): string | undefined {
  return new RegExp(`^${name}: (.+)$`, "mu").exec(markdown)?.[1];
}

describe("private Local Context Skill variants", () => {
  it("keeps exactly the two same-name variants outside public inventory", () => {
    const root = join(repoRoot, "skill-variants/local-context");
    expect(readdirSync(root).sort()).toEqual(["first-tree-read", "first-tree-write"]);
    expect(CORE_SKILL_NAMES).toContain("first-tree-read");
    expect(CORE_SKILL_NAMES).toContain("first-tree-write");
    expect(CORE_SKILL_NAMES).not.toContain("first-tree-read-local");
    expect(CORE_SKILL_NAMES).not.toContain("first-tree-write-local");
  });

  it.each(["first-tree-read", "first-tree-write"])("keeps %s public metadata stable", (name) => {
    const remote = read(`skills/${name}/SKILL.md`);
    const local = read(`skill-variants/local-context/${name}/SKILL.md`);
    expect(field(local, "name")).toBe(field(remote, "name"));
    expect(field(local, "description")).toBe(field(remote, "description"));
    expect(read(`skill-variants/local-context/${name}/agents/openai.yaml`)).toBe(
      read(`skills/${name}/agents/openai.yaml`),
    );
  });
});
