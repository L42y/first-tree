import { describe, expect, it } from "vitest";
import { agentContextTreeInfoSchema } from "../schemas/agent.js";

describe("agentContextTreeInfoSchema", () => {
  it("accepts the bound / unbound / invalid coordinate matrix", () => {
    expect(
      agentContextTreeInfoSchema.parse({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "main",
        provider: "github",
      }),
    ).toMatchObject({ bindingState: "bound", provider: "github", branch: "main" });
    expect(
      agentContextTreeInfoSchema.parse({
        bindingState: "bound",
        repo: "git@git.example.invalid:acme/context-tree.git",
        branch: "release",
        provider: null,
      }),
    ).toMatchObject({ bindingState: "bound", provider: null });
    expect(
      agentContextTreeInfoSchema.parse({
        bindingState: "bound",
        repo: "https://gitlab.com/acme/context-tree.git",
        branch: "main",
        provider: "gitlab",
      }),
    ).toMatchObject({ bindingState: "bound", provider: "gitlab" });
    expect(
      agentContextTreeInfoSchema.parse({
        bindingState: "unbound",
        repo: null,
        branch: "main",
        provider: null,
      }),
    ).toEqual({ bindingState: "unbound", repo: null, branch: "main", provider: null });
    expect(
      agentContextTreeInfoSchema.parse({
        bindingState: "invalid",
        repo: null,
        branch: null,
        provider: null,
      }),
    ).toEqual({ bindingState: "invalid", repo: null, branch: null, provider: null });
  });

  it("fail-closes missing keys and conflicting coordinates", () => {
    expect(agentContextTreeInfoSchema.safeParse({ repo: null, branch: "main", provider: null }).success).toBe(false);
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "unbound",
        repo: null,
        branch: null,
        provider: null,
      }).success,
    ).toBe(false);
    for (const provider of [null, "github"] as const) {
      expect(
        agentContextTreeInfoSchema.safeParse({
          bindingState: "bound",
          repo: "https://gitlab.com/acme/context-tree.git",
          branch: "main",
          provider,
        }).success,
      ).toBe(false);
    }
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: null,
        provider: "github",
      }).success,
    ).toBe(false);
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        provider: "github",
      }).success,
    ).toBe(false);
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "unbound",
        repo: "git@github.com:acme/tree.git",
        branch: "main",
        provider: null,
      }).success,
    ).toBe(false);
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "invalid",
        repo: null,
        branch: "main",
        provider: null,
      }).success,
    ).toBe(false);
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "main",
      }).success,
    ).toBe(false);
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "main",
        provider: null,
      }).success,
    ).toBe(false);
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "bound",
        repo: "git@github.com:acme/context-tree.git",
        branch: "main",
        provider: "gitlab",
      }).success,
    ).toBe(false);
    expect(
      agentContextTreeInfoSchema.safeParse({
        bindingState: "bound",
        repo: "git@git.example.invalid:acme/context-tree.git",
        branch: "main",
        provider: "github",
      }).success,
    ).toBe(false);
  });
});
