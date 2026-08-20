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
  it("records ready targets for every valid base — identity mappings included", () => {
    const registry = buildTeamSkillCommandRegistry([entry("review", "review-first-tree"), entry("audit", "audit")]);
    expect(registry.get("review")).toEqual({ kind: "ready", effectiveName: "review-first-tree" });
    expect(registry.get("audit")).toEqual({ kind: "ready", effectiveName: "audit" });
  });

  it("records configured-but-unverified bases as unavailable", () => {
    const registry = buildTeamSkillCommandRegistry([entry("review", null)]);
    expect(registry.get("review")).toEqual({ kind: "unavailable", reason: "no verified installed target" });
  });

  it("fails closed on ANY repeated base slug — even identical rows are inconsistent input", () => {
    const log = vi.fn();
    const registry = buildTeamSkillCommandRegistry(
      [entry("review", "review-first-tree"), entry("review", "review-first-tree")],
      log,
    );
    expect(registry.get("review")).toEqual({ kind: "unavailable", reason: "conflicting effective names" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("fails closed"));
  });

  it("fails closed when an identity row and a suffixed row share one base, in either order", () => {
    const forward = buildTeamSkillCommandRegistry([entry("review", "review"), entry("review", "review-first-tree")]);
    const reversed = buildTeamSkillCommandRegistry([entry("review", "review-first-tree"), entry("review", "review")]);
    for (const registry of [forward, reversed]) {
      expect(registry.get("review")).toEqual({ kind: "unavailable", reason: "conflicting effective names" });
    }
  });

  it("skips malformed base slugs", () => {
    const registry = buildTeamSkillCommandRegistry([entry("not a slug", "x-first-tree"), entry("", "y-first-tree")]);
    expect(registry.size).toBe(0);
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

  it("replaces an authoritatively unavailable command with an inert notice — no slash token survives", () => {
    const notice = rewriteTeamSkillCommand("/broken now", registry);
    expect(notice).toContain("currently unavailable");
    expect(notice).toContain("no verified installed target");
    // The bare Skill name (no slash) is included so the agent can name it.
    expect(notice).toContain('"broken"');
    expect(notice).not.toContain("/broken");
    // The arguments remain as context after the notice.
    expect(notice).toContain("now");

    const mentioned = rewriteTeamSkillCommand("@nova /broken", registry, { allowMentionPrefix: true });
    expect(mentioned.startsWith("@nova ")).toBe(true);
    expect(mentioned).toContain("currently unavailable");
    expect(mentioned).not.toContain("/broken");

    // A mention-looking prefix without the routed gate is left untouched.
    expect(rewriteTeamSkillCommand("@nova /broken", registry)).toBe("@nova /broken");
  });

  it("resolves the registry case-insensitively so case variants cannot bypass a Team claim", () => {
    expect(rewriteTeamSkillCommand("/REVIEW src/", registry)).toBe("/review-first-tree src/");
    expect(rewriteTeamSkillCommand("/BROKEN", registry)).toContain("currently unavailable");
    // Unmapped commands keep their original casing and text.
    expect(rewriteTeamSkillCommand("/Ship it", registry)).toBe("/Ship it");
  });

  it("blocks strict slash commands while the registry is unpublished; ordinary text still works", () => {
    expect(() => rewriteTeamSkillCommand("/review", null)).toThrow(ManagedSkillsUnsafeDiscoveryError);
    expect(() => rewriteTeamSkillCommand("/ship it", null)).toThrow(ManagedSkillsUnsafeDiscoveryError);
    expect(rewriteTeamSkillCommand("hello /review", null)).toBe("hello /review");
    expect(rewriteTeamSkillCommand("just text", null)).toBe("just text");
  });

  it("lets unknown local commands pass once a verified-empty registry is published", () => {
    expect(rewriteTeamSkillCommand("/ship it", EMPTY_TEAM_SKILL_COMMAND_REGISTRY)).toBe("/ship it");
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

describe("rewriteSessionMessageCommand — image batch captions", () => {
  const registry = buildTeamSkillCommandRegistry([entry("review", "review-first-tree"), entry("broken", null)]);
  const attachments = [{ imageId: "img-1", mimeType: "image/png", filename: "shot.png" }];
  const batchMessage = (caption: string) => ({
    id: "m1",
    chatId: "chat-1",
    metadata: { mentions: ["agent-1"] },
    content: { caption, attachments },
  });

  it("rewrites a bare command caption and keeps attachments/metadata immutable", () => {
    const message = batchMessage("/review src/");
    const rewritten = rewriteSessionMessageCommand(message, registry);
    expect(rewritten.content).toEqual({ caption: "/review-first-tree src/", attachments });
    // The persisted/original message keeps the base literal.
    expect(message.content.caption).toBe("/review src/");
    expect(rewritten).not.toBe(message);
    expect(rewritten.content).not.toBe(message.content);
    expect(rewritten.metadata).toBe(message.metadata);
  });

  it("rewrites a mention-prefixed caption only with the routed-mention gate", () => {
    const gated = rewriteSessionMessageCommand(batchMessage("@nova /review"), registry, { allowMentionPrefix: true });
    expect((gated.content as { caption: string }).caption).toBe("@nova /review-first-tree");
    const ungated = rewriteSessionMessageCommand(batchMessage("@nova /review"), registry);
    expect(ungated).toBe(ungated); // unchanged
    expect((ungated.content as { caption: string }).caption).toBe("@nova /review");
  });

  it("turns an unavailable caption command into the inert notice", () => {
    const rewritten = rewriteSessionMessageCommand(batchMessage("/broken please"), registry);
    const caption = (rewritten.content as { caption: string }).caption;
    expect(caption).toContain("currently unavailable");
    expect(caption).not.toContain("/broken");
  });

  it("still throws for a caption command while the registry is unpublished", () => {
    expect(() => rewriteSessionMessageCommand(batchMessage("/review"), null)).toThrow(
      ManagedSkillsUnsafeDiscoveryError,
    );
    // A caption without a strict command is unaffected by the null registry.
    const plain = batchMessage("hello there");
    expect(rewriteSessionMessageCommand(plain, null)).toBe(plain);
  });

  it("leaves single image refs, captionless batches, and unknown structures untouched", () => {
    const single = { id: "m1", content: { imageId: "img-1", mimeType: "image/png", filename: "/review" } };
    expect(rewriteSessionMessageCommand(single, registry)).toBe(single);
    const captionless = { id: "m1", content: { attachments } };
    expect(rewriteSessionMessageCommand(captionless, registry)).toBe(captionless);
    const unknown = { id: "m1", content: { kind: "other", text: "/review" } };
    expect(rewriteSessionMessageCommand(unknown, registry)).toBe(unknown);
  });
});
