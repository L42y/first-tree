import { describe, expect, it, vi } from "vitest";
import {
  buildTeamSkillCommandMap,
  EMPTY_TEAM_SKILL_COMMAND_MAP,
  rewriteSessionMessageCommand,
  rewriteTeamSkillCommand,
} from "../runtime/team-skill-command-rewrite.js";

const reconciled = (requestedSlug: string, name: string) => ({
  key: `resource:${requestedSlug}`,
  requestedSlug,
  name,
});

describe("buildTeamSkillCommandMap", () => {
  it("maps only collision-suffixed installs; identity names need no rewrite", () => {
    const map = buildTeamSkillCommandMap([reconciled("review", "review-first-tree"), reconciled("audit", "audit")]);
    expect(map.get("review")).toBe("review-first-tree");
    expect(map.has("audit")).toBe(false);
  });

  it("fails closed on a duplicate base slug with different effective names", () => {
    const log = vi.fn();
    const map = buildTeamSkillCommandMap(
      [reconciled("review", "review-first-tree"), reconciled("review", "review-first-tree-2")],
      log,
    );
    expect(map.has("review")).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("fail closed"));
  });

  it("accepts the same effective name twice as idempotent, not a conflict", () => {
    const map = buildTeamSkillCommandMap([
      reconciled("review", "review-first-tree"),
      reconciled("review", "review-first-tree"),
    ]);
    expect(map.get("review")).toBe("review-first-tree");
  });

  it("skips malformed base slugs", () => {
    const map = buildTeamSkillCommandMap([reconciled("not a slug", "x-first-tree"), reconciled("", "y-first-tree")]);
    expect(map.size).toBe(0);
  });
});

describe("rewriteTeamSkillCommand", () => {
  const map = buildTeamSkillCommandMap([reconciled("review", "review-first-tree")]);

  it("rewrites a bare command at the start of the message", () => {
    expect(rewriteTeamSkillCommand("/review", map)).toBe("/review-first-tree");
  });

  it("preserves arguments and whitespace after the command", () => {
    expect(rewriteTeamSkillCommand("/review  --strict src/a.ts\n\nplease", map)).toBe(
      "/review-first-tree  --strict src/a.ts\n\nplease",
    );
  });

  it("rewrites after a canonical mention prefix (group-chat routing form)", () => {
    expect(rewriteTeamSkillCommand("@nova /review src/", map)).toBe("@nova /review-first-tree src/");
    expect(rewriteTeamSkillCommand("  @nova @design  /review", map)).toBe("  @nova @design  /review-first-tree");
  });

  it("never rewrites prose, paths, or mid-text slashes", () => {
    expect(rewriteTeamSkillCommand("hello /review", map)).toBe("hello /review");
    expect(rewriteTeamSkillCommand("see docs/review.md", map)).toBe("see docs/review.md");
    expect(rewriteTeamSkillCommand("@nova please /review this", map)).toBe("@nova please /review this");
  });

  it("never partially matches a longer command name", () => {
    expect(rewriteTeamSkillCommand("/review-extra", map)).toBe("/review-extra");
  });

  it("passes through unmapped commands so local/runtime skills keep working", () => {
    expect(rewriteTeamSkillCommand("/ship it", map)).toBe("/ship it");
  });

  it("is a no-op for an empty map", () => {
    expect(rewriteTeamSkillCommand("/review", EMPTY_TEAM_SKILL_COMMAND_MAP)).toBe("/review");
  });
});

describe("rewriteSessionMessageCommand", () => {
  const map = buildTeamSkillCommandMap([reconciled("review", "review-first-tree")]);

  it("rewrites string content and returns a new message object", () => {
    const message = { id: "m1", content: "/review now" };
    const rewritten = rewriteSessionMessageCommand(message, map);
    expect(rewritten.content).toBe("/review-first-tree now");
    expect(rewritten).not.toBe(message);
  });

  it("returns the same reference when nothing rewrites", () => {
    const message = { id: "m1", content: "just text" };
    expect(rewriteSessionMessageCommand(message, map)).toBe(message);
  });

  it("never touches non-string payloads", () => {
    const message = { id: "m1", content: { kind: "image" } };
    expect(rewriteSessionMessageCommand(message, map)).toBe(message);
  });
});
