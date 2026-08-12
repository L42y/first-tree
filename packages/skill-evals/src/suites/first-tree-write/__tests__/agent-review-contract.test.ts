import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../../../..");
const skillPath = join(repoRoot, "skills", "first-tree-write");
const skill = readFileSync(join(skillPath, "SKILL.md"), "utf8");

describe("first-tree-write App review handoff floor", () => {
  it("ends writer ownership at a source-complete provider artifact", () => {
    expect(skill).toContain("Let provider automation own review dispatch");
    expect(skill).toContain("GitHub App webhook creates or reuses the PR-scoped Reviewer Chat");
    expect(skill).toContain("valid matching inbound Webhook creates or\n   reuses the MR-scoped Reviewer Chat");
    expect(skill).toContain("The configured review agent may\nrepair the PR directly");
    expect(skill).toContain("Do not add a repair-consent block, exact-file permission\nlist");
    expect(skill).toContain("Do not add a repair-consent block");
    expect(skill).toContain("legacy dispatch marker or task payload");
    expect(skill).toContain("Supported GitHub App or GitLab inbound Webhooks are the sole dispatch");
  });

  it("does not retain the member task packet or direct Reviewer dispatch", () => {
    expect(skill).not.toContain('"taskType": "context_tree_pr_review"');
    expect(skill).not.toContain('"reviewPacketV1"');
    expect(skill).not.toContain("--metadata-file <packet-file>");
    expect(skill).not.toContain("same keyed handoff");
    expect(skill).not.toContain("Reassigning A to B keeps the same PR task and Chat");
  });

  it("keeps BYO Write bound to the SCOPE route and a new user confirmation", () => {
    expect(skill).toContain("exact snapshot and opaque route selection created by\n  `first-tree-read`");
    expect(skill).toContain("<firstTreeInvocation> --json context write-preflight");
    expect(skill).toContain("`firstTreeInvocation` from this Skill's\n  latest verified Core loader response");
    expect(skill).toContain("<firstTreeInvocation> tree verify --tree-path <tree>");
    expect(skill).toContain("<firstTreeInvocation> gitlab follow <mr-url>");
    for (const command of ["write-preflight", "write-worktree", "write-status", "write-finish"]) {
      expect(skill).toContain(`<firstTreeInvocation> context ${command}`);
    }
    expect(skill).not.toMatch(/(?:^|[` ])first-tree\s+(?:tree|context|gitlab)\b/mu);
    expect(skill).toContain('--snapshot "<exact-snapshot>" --github-login "<gh-login>"');
    expect(skill).toContain("For GitLab, do not pass a GitHub login");
    expect(skill).toContain("exact-host\nGitLab `glab` authentication");
    expect(skill).toContain("Never accept or re-select a Team during Write");
    expect(skill).toContain("Plan and ask in every BYO write");
    expect(skill).toContain("Before creating an authoring worktree");
    expect(skill).toContain("wait for a **new user reply** confirming that exact\n   plan");
    expect(skill).toContain("Initial write intent is not this confirmation");
    expect(skill).toContain("Managed mode does not add this gate");
    expect(skill).toContain("Only after the BYO confirmation above, create the\n   authoring worktree");
    expect(skill).toContain("If the live preflight provider is GitHub, obtain the current local\n   `gh` login again");
    expect(skill).toContain('--confirmed --github-login "<gh-login>"');
    expect(skill).toContain("If the provider is GitLab, do not pass a GitHub login");
    expect(skill).toContain("re-run the same\npreflight immediately before each push and PR/MR creation");
    expect(skill).toContain("observability only, never local routing");
  });

  it("selects publication forge from the Context Tree and follows GitLab MRs", () => {
    expect(skill).toMatch(/detect the Context Tree forge from its own `origin`/u);
    expect(skill).toContain("never infer it\nfrom the source");
    expect(skill).toMatch(/Audit-originated artifacts stay draft/u);
    expect(skill).toContain("<firstTreeInvocation> gitlab follow <mr-url>");
    expect(skill).toContain("creating, resolving or\n   reusing any GitLab MR");
    expect(skill).toContain("returned pending or active state is success");
    expect(skill).toContain("failure does not invalidate the\n   MR");
  });

  it("states the unbound or broken Tree binding degradation gate", () => {
    expect(skill).toContain("## Unbound or broken Tree binding");
    expect(skill).toContain("A missing Context Tree removes only the operations that depend on it.");
    expect(skill).toMatch(/may prompt the user to bind, create, or connect a Tree\s+merely\s+because one is absent/u);
    expect(skill).toMatch(/when the trusted managed briefing explicitly states\s+there is no bound Tree/u);
    expect(skill).toMatch(/no Tree write is possible and there is no write\s+task/u);
    expect(skill).toMatch(/state only that this Tree write cannot be completed because\s+no Tree is bound/u);
    expect(skill).toContain("do not expand the absence into bind/create guidance");
    expect(skill).toMatch(/keep failing\s+closed for Tree operations — never guess a Tree/u);
    expect(skill).toContain("the broken binding blocks only the Tree write, never unrelated work");
    expect(skill).toMatch(
      /fully\s+declared\s+binding\s+whose\s+local\s+checkout\s+simply\s+does\s+not\s+exist\s+yet\s+is\s+not\s+broken/u,
    );
    expect(skill).toMatch(/materialize\s+it\s+per\s+Tree\s+Location\s+before\s+drafting\s+and\s+continue/u);
  });

  it("states the unresolved-binding gate without trusting last-known artifacts", () => {
    expect(skill).toContain("**Unresolved binding:**");
    expect(skill).toMatch(/when the trusted managed briefing states the Tree\s+binding could not be confirmed/u);
    expect(skill).toMatch(
      /no Tree write is possible this session and\s+ordinary work continues exactly as in the explicitly-unbound case/u,
    );
    expect(skill).toMatch(
      /`.first-tree\/workspace\.json` manifest or `context-tree\/`\s+checkout may still be on disk/u,
    );
    expect(skill).toMatch(
      /never read, trust,\s+or recover from them, because this session never confirmed that binding/u,
    );
    expect(skill).toMatch(
      /state only that this Tree write cannot\s+be completed right now because the binding could not be confirmed/u,
    );
    expect(skill).toMatch(
      /never\s+claim that no Tree is bound \(that is the explicitly-unbound state\) and\s+never guess a Tree/u,
    );
  });

  it("keeps the source gate filesystem-first with forge CLIs scoped to forge steps", () => {
    expect(skill).toMatch(/read local code,\s+history, and existing files from the filesystem and plain `git` first/u);
    expect(skill).toMatch(/only for forge reads the filesystem cannot\s+answer/u);
    expect(skill).toMatch(/missing or unauthenticated CLI blocks only that forge step/u);
    expect(skill).toMatch(/source\s+reading and local drafting continue without it/u);
  });

  it("keeps version metadata and the standalone VERSION file aligned", () => {
    const version = readFileSync(join(skillPath, "VERSION"), "utf8").trim();
    expect(version).toBe("0.16.5");
    expect(skill).toContain(`version: ${version}`);
    expect(skill.split("\n").length).toBeLessThanOrEqual(500);
  });
});
