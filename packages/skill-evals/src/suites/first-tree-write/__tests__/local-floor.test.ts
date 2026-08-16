import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "../..");
const remote = readFileSync(join(repoRoot, "skills/first-tree-write/SKILL.md"), "utf8");
const local = readFileSync(join(repoRoot, "skill-variants/local-context/first-tree-write/SKILL.md"), "utf8");

function frontmatterField(markdown: string, name: string): string | undefined {
  return new RegExp(`^${name}: (.+)$`, "mu").exec(markdown)?.[1];
}

describe("first-tree-write Local Context floor", () => {
  it("keeps the public routing identity and enforces source, semantics, verify, and recheck", () => {
    expect(frontmatterField(local, "name")).toBe(frontmatterField(remote, "name"));
    expect(frontmatterField(local, "description")).toBe(frontmatterField(remote, "description"));
    expect(local).toContain("## Source gate and Double Test");
    expect(local).toContain("tree local resolve --ensure --intent write");
    expect(local).toContain("Immediately re-read every changed node");
    expect(local).toContain("source-system boundary and Double Test");
    expect(local).toContain('tree verify --tree-path "<live-root>"');
    expect(local.match(/tree local resolve --ensure --intent write/gu)).toHaveLength(2);
    expect(local).toContain("A non-zero result means the write is unfinished");
    expect(local).toContain("Do not create a lock, snapshot, candidate");
    expect(local).not.toContain("per-write approval");
  });
});
