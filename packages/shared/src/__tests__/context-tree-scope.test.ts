import { describe, expect, it } from "vitest";
import { CONTEXT_TREE_SCOPE_MAX_BYTES, parseContextTreeScopeMarkdown } from "../schemas/context-tree-scope.js";

describe("Context Tree SCOPE.md", () => {
  it("accepts domain-neutral natural language without fixed headings", () => {
    expect(
      parseContextTreeScopeMarkdown(
        "---\nschemaVersion: 1\n---\n\nThis tree covers customer operations, commercial decisions, and legal boundaries.",
      ),
    ).toMatchObject({
      frontmatter: { schemaVersion: 1 },
      body: "This tree covers customer operations, commercial decisions, and legal boundaries.",
    });
  });

  it("accepts credential-free repositories as optional routing signals", () => {
    expect(
      parseContextTreeScopeMarkdown(
        "---\nschemaVersion: 1\nrelatedRepositories:\n  - https://github.com/acme/example\n---\n\nAcme product context.",
      ).frontmatter.relatedRepositories,
    ).toEqual(["https://github.com/acme/example"]);
  });

  it("rejects empty bodies, unsafe/noncanonical URLs, unknown fields, and oversized files", () => {
    expect(() => parseContextTreeScopeMarkdown("---\nschemaVersion: 1\n---\n")).toThrow(/body/u);
    expect(() =>
      parseContextTreeScopeMarkdown(
        "---\nschemaVersion: 1\nrelatedRepositories: [https://u:p@example.com/repo]\n---\n\nScope",
      ),
    ).toThrow(/credentials/u);
    for (const url of [
      "file:///tmp/repo",
      "data:text/plain,repo",
      "https://github.com/acme/repo?token=secret",
      "https://github.com/acme/repo#token",
    ]) {
      expect(() =>
        parseContextTreeScopeMarkdown(`---\nschemaVersion: 1\nrelatedRepositories:\n  - ${url}\n---\n\nScope`),
      ).toThrow();
    }
    for (const url of [
      "http://github.com/acme/repo",
      "https://github.com/acme/repo.git",
      "https://github.com/acme/repo/",
    ]) {
      expect(() =>
        parseContextTreeScopeMarkdown(`---\nschemaVersion: 1\nrelatedRepositories:\n  - ${url}\n---\n\nScope`),
      ).not.toThrow();
    }
    expect(() => parseContextTreeScopeMarkdown("---\nschemaVersion: 1\nname: nope\n---\n\nScope")).toThrow();
    expect(() =>
      parseContextTreeScopeMarkdown(`---\nschemaVersion: 1\n---\n\n${"x".repeat(CONTEXT_TREE_SCOPE_MAX_BYTES)}`),
    ).toThrow(/limit/u);
  });
});
