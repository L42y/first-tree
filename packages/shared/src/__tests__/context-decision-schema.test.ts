import { describe, expect, it } from "vitest";
import {
  CONTEXT_DECISION_METADATA_KEY,
  type ContextDecision,
  contextDecisionSchema,
  readContextDecisionMetadata,
} from "../schemas/context-decision.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function receipt(overrides: Partial<ContextDecision> = {}): Record<string, unknown> {
  return {
    version: 1,
    effect: "constrained",
    summary: "The organization-isolation constraint ruled out a global shared index.",
    evidence: [
      {
        repoUrl: "https://github.com/example/context-tree",
        commit: COMMIT,
        nodePath: "system/cloud/team/tenancy-and-identity.md",
        heading: "Organization isolation",
      },
    ],
    ...overrides,
  };
}

describe("contextDecisionSchema", () => {
  it("accepts the skill's documented receipt shape", () => {
    const parsed = contextDecisionSchema.safeParse(receipt());
    expect(parsed.success).toBe(true);
  });

  it("accepts an omitted heading and up to three evidence rows", () => {
    const rows = [
      { repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "a.md" },
      { repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "b/c.md" },
      { repoUrl: "git@gitlab.example.com:group/sub/tree.git", commit: "abc1234", nodePath: "d.md" },
    ];
    expect(contextDecisionSchema.safeParse(receipt({ evidence: rows })).success).toBe(true);
  });

  it("rejects an effect outside the four observable categories", () => {
    expect(contextDecisionSchema.safeParse(receipt({ effect: "none" as never })).success).toBe(false);
  });

  it("rejects a receipt with nothing to inspect", () => {
    expect(contextDecisionSchema.safeParse(receipt({ evidence: [] })).success).toBe(false);
  });

  it("rejects more evidence than the skill's three-node cap", () => {
    const row = { repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "a.md" };
    expect(contextDecisionSchema.safeParse(receipt({ evidence: [row, row, row, row] })).success).toBe(false);
  });

  it("rejects an empty summary", () => {
    expect(contextDecisionSchema.safeParse(receipt({ summary: "   " })).success).toBe(false);
  });

  it("rejects a credential-bearing repository URL", () => {
    const evidence = [{ repoUrl: "https://user:token@github.com/example/tree", commit: COMMIT, nodePath: "a.md" }];
    expect(contextDecisionSchema.safeParse(receipt({ evidence })).success).toBe(false);
  });

  it("rejects a repository value that is not a resolvable git URL", () => {
    const evidence = [{ repoUrl: "context-tree", commit: COMMIT, nodePath: "a.md" }];
    expect(contextDecisionSchema.safeParse(receipt({ evidence })).success).toBe(false);
  });

  it("rejects a commit that is not a hex object id", () => {
    const evidence = [{ repoUrl: "https://github.com/example/tree", commit: "main", nodePath: "a.md" }];
    expect(contextDecisionSchema.safeParse(receipt({ evidence })).success).toBe(false);
  });

  it("rejects an escaping node path", () => {
    const absolute = [{ repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "/etc/passwd" }];
    const traversal = [{ repoUrl: "https://github.com/example/tree", commit: COMMIT, nodePath: "a/../../b.md" }];
    expect(contextDecisionSchema.safeParse(receipt({ evidence: absolute })).success).toBe(false);
    expect(contextDecisionSchema.safeParse(receipt({ evidence: traversal })).success).toBe(false);
  });
});

describe("readContextDecisionMetadata", () => {
  it("returns the receipt when the stored payload parses", () => {
    expect(readContextDecisionMetadata({ [CONTEXT_DECISION_METADATA_KEY]: receipt() })?.effect).toBe("constrained");
  });

  it("fails closed on absent, unknown-version, and malformed payloads", () => {
    expect(readContextDecisionMetadata(undefined)).toBeNull();
    expect(readContextDecisionMetadata(null)).toBeNull();
    expect(readContextDecisionMetadata({})).toBeNull();
    expect(
      readContextDecisionMetadata({ [CONTEXT_DECISION_METADATA_KEY]: receipt({ version: 2 as never }) }),
    ).toBeNull();
    expect(readContextDecisionMetadata({ [CONTEXT_DECISION_METADATA_KEY]: "constrained" })).toBeNull();
    expect(readContextDecisionMetadata({ [CONTEXT_DECISION_METADATA_KEY]: { effect: "constrained" } })).toBeNull();
  });
});
