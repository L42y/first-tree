import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "../..");
const remote = readFileSync(join(repoRoot, "skills/first-tree-read/SKILL.md"), "utf8");
const local = readFileSync(join(repoRoot, "skill-variants/local-context/first-tree-read/SKILL.md"), "utf8");

function frontmatterField(markdown: string, name: string): string | undefined {
  return new RegExp(`^${name}: (.+)$`, "mu").exec(markdown)?.[1];
}

describe("first-tree-read Local Context floor", () => {
  it("preserves the public routing identity while enforcing the live Local workflow", () => {
    expect(frontmatterField(local, "name")).toBe(frontmatterField(remote, "name"));
    expect(frontmatterField(local, "description")).toBe(frontmatterField(remote, "description"));
    expect(local).toContain("tree local resolve --ensure --intent read");
    expect(local).toContain('tree verify --tree-path "<live-root>"');
    expect(local).toContain('tree tree --tree-path "<live-root>" --help');
    expect(local).toContain("Immediately before using Local Context");
    expect(local).toContain("no stable snapshot guarantee");
    expect(local).toContain("no immutable commit attribution");
    expect(local).not.toContain("git pull");
  });
});
