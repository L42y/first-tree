import { describe, expect, it, vi } from "vitest";
import { ManagedSkillsUnsafeDiscoveryError } from "../runtime/managed-skills.js";
import {
  buildTeamSkillCommandRegistry,
  EMPTY_TEAM_SKILL_COMMAND_REGISTRY,
  rewriteSessionMessageCommand,
  rewriteTeamSkillCommand,
} from "../runtime/team-skill-command-rewrite.js";

const entry = (requestedSlug: string, effectiveName: string | null) => ({ requestedSlug, effectiveName });

describe("buildTeamSkillCommandRegistry", () => {
  it("maps only collision-suffixed installs; identity names need no rewrite", () => {
    const registry = buildTeamSkillCommandRegistry([entry("review", "review-first-tree"), entry("audit", "audit")]);
    expect(registry.rewrite.get("review")).toBe("review-first-tree");
    expect(registry.rewrite.has("audit")).toBe(false);
    expect(registry.unavailable.size).toBe(0);
  });

  it("records configured-but-unverified bases as unavailable", () => {
    const registry = buildTeamSkillCommandRegistry([entry("review", null)]);
    expect(registry.unavailable.has("review")).toBe(true);
    expect(registry.rewrite.has("review")).toBe(false);
  });

  it("fails closed on a duplicate base slug with different effective names", () => {
    const log = vi.fn();
    const registry = buildTeamSkillCommandRegistry(
      [entry("review", "review-first-tree"), entry("review", "review-first-tree-2")],
      log,
    );
    expect(registry.rewrite.has("review")).toBe(false);
    expect(registry.unavailable.has("review")).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("fails closed"));
  });

  it("accepts the same effective name twice as idempotent, not a conflict", () => {
    const registry = buildTeamSkillCommandRegistry([
      entry("review", "review-first-tree"),
      entry("review", "review-first-tree"),
    ]);
    expect(registry.rewrite.get("review")).toBe("review-first-tree");
  });

  it("skips malformed base slugs", () => {
    const registry = buildTeamSkillCommandRegistry([entry("not a slug", "x-first-tree"), entry("", "y-first-tree")]);
    expect(registry.rewrite.size).toBe(0);
    expect(registry.unavailable.size).toBe(0);
  });
});

describe("rewriteTeamSkillCommand", () => {
  const registry = buildTeamSkillCommandRegistry([entry("review", "review-first-tree"), entry("broken", null)]);

  it("rewrites a bare command at the start of the message", () => {
    expect(rewriteTeamSkillCommand("/review", registry)).toBe("/review-first-tree");
  });

  it("preserves arguments and whitespace after the command", () => {
    expect(rewriteTeamSkillCommand("/review  --strict src/a.ts\n\nplease", registry)).toBe(
      "/review-first-tree  --strict src/a.ts\n\nplease",
    );
  });

  it("rewrites after a canonical mention prefix only when the caller allows it", () => {
    expect(rewriteTeamSkillCommand("@nova /review src/", registry, { allowMentionPrefix: true })).toBe(
      "@nova /review-first-tree src/",
    );
    expect(rewriteTeamSkillCommand("  @nova @design  /review", registry, { allowMentionPrefix: true })).toBe(
      "  @nova @design  /review-first-tree",
    );
    // Without the routed-mention gate the same text is NOT rewritten.
    expect(rewriteTeamSkillCommand("@nova /review src/", registry)).toBe("@nova /review src/");
  });

  it("never rewrites prose, paths, punctuation-suffixed, or mid-text commands", () => {
    expect(rewriteTeamSkillCommand("hello /review", registry)).toBe("hello /review");
    expect(rewriteTeamSkillCommand("see docs/review.md", registry)).toBe("see docs/review.md");
    expect(rewriteTeamSkillCommand("@nova please /review this", registry, { allowMentionPrefix: true })).toBe(
      "@nova please /review this",
    );
    expect(rewriteTeamSkillCommand("/review.foo", registry)).toBe("/review.foo");
  });

  it("never partially matches a longer command name", () => {
    expect(rewriteTeamSkillCommand("/review-extra", registry)).toBe("/review-extra");
  });

  it("passes through unmapped commands so local/runtime skills keep working", () => {
    expect(rewriteTeamSkillCommand("/ship it", registry)).toBe("/ship it");
  });

  it("throws before the provider when the command is configured but has no verified target", () => {
    expect(() => rewriteTeamSkillCommand("/broken now", registry)).toThrow(ManagedSkillsUnsafeDiscoveryError);
    expect(() => rewriteTeamSkillCommand("@nova /broken", registry, { allowMentionPrefix: true })).toThrow(
      ManagedSkillsUnsafeDiscoveryError,
    );
    // A mention-looking prefix without the routed gate neither rewrites nor throws.
    expect(rewriteTeamSkillCommand("@nova /broken", registry)).toBe("@nova /broken");
  });

  it("is a no-op for an empty registry", () => {
    expect(rewriteTeamSkillCommand("/review", EMPTY_TEAM_SKILL_COMMAND_REGISTRY)).toBe("/review");
  });
});

describe("rewriteSessionMessageCommand", () => {
  const registry = buildTeamSkillCommandRegistry([entry("review", "review-first-tree")]);

  it("rewrites string content and returns a new message object", () => {
    const message = { id: "m1", content: "/review now" };
    const rewritten = rewriteSessionMessageCommand(message, registry);
    expect(rewritten.content).toBe("/review-first-tree now");
    expect(rewritten).not.toBe(message);
  });

  it("returns the same reference when nothing rewrites", () => {
    const message = { id: "m1", content: "just text" };
    expect(rewriteSessionMessageCommand(message, registry)).toBe(message);
  });

  it("never touches non-string payloads", () => {
    const message = { id: "m1", content: { kind: "image" } };
    expect(rewriteSessionMessageCommand(message, registry)).toBe(message);
  });
});
