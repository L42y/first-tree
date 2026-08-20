import { describe, expect, it, vi } from "vitest";
import { ManagedSkillsUnsafeDiscoveryError } from "../runtime/managed-skills.js";
import {
  buildTeamSkillCommandRegistry,
  EMPTY_TEAM_SKILL_COMMAND_REGISTRY,
  rewriteSessionMessageCommand,
  rewriteSessionMessageCommandForInvocation,
  rewriteTeamSkillCommand,
} from "../runtime/team-skill-command-rewrite.js";

const entry = (requestedSlug: string, effectiveName: string | null, resourceId = `res-${requestedSlug}`) => ({
  requestedSlug,
  resourceId,
  effectiveName,
});

describe("buildTeamSkillCommandRegistry", () => {
  it("records ready targets for every valid base — identity mappings included", () => {
    const registry = buildTeamSkillCommandRegistry([entry("review", "review-first-tree"), entry("audit", "audit")]);
    expect(registry.get("review")).toEqual({
      kind: "ready",
      effectiveName: "review-first-tree",
      resourceId: "res-review",
    });
    expect(registry.get("audit")).toEqual({ kind: "ready", effectiveName: "audit", resourceId: "res-audit" });
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
    // Without the routed gate the message object is returned UNCHANGED
    // (same reference — immutability means no clone was made).
    const input = batchMessage("@nova /review");
    const ungated = rewriteSessionMessageCommand(input, registry);
    expect(ungated).toBe(input);
    expect(input.content.caption).toBe("@nova /review");
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

describe("rewriteSessionMessageCommandForInvocation — server-owned Team intent marker", () => {
  const registry = buildTeamSkillCommandRegistry([entry("review", "review-first-tree"), entry("broken", null)]);
  const invocation = (slug: string, overrides: Record<string, unknown> = {}) => ({
    version: 1 as const,
    recipientAgentId: "agent-1",
    resourceId: `res-${slug}`,
    requestedSlug: slug,
    configVersion: 1,
    ...overrides,
  });
  const OPTS = { currentAgentId: "agent-1", registryVersion: 1 };

  it("rewrites a marked command to the verified effective name", () => {
    const message = { id: "m1", content: "/review src/" };
    const rewritten = rewriteSessionMessageCommandForInvocation(message, registry, invocation("review"), OPTS);
    expect(rewritten?.content).toBe("/review-first-tree src/");
    expect(message.content).toBe("/review src/");
  });

  it("matches the marked slug case-insensitively", () => {
    const message = { id: "m1", content: "/REVIEW src/" };
    const rewritten = rewriteSessionMessageCommandForInvocation(message, registry, invocation("review"), OPTS);
    expect(rewritten?.content).toBe("/review-first-tree src/");
  });

  it("settles a version-superseded marker as the stale notice (delayed delivery)", () => {
    // Chosen at v1, delivered after the config moved to v2: the registry
    // proves v2, so the v1 marker can never be honored safely.
    const message = { id: "m1", content: "/review src/" };
    const rewritten = rewriteSessionMessageCommandForInvocation(message, registry, invocation("review"), {
      ...OPTS,
      registryVersion: 2,
    });
    const text = rewritten?.content as string;
    expect(text).toContain("superseded");
    expect(text).not.toContain("/review");
  });

  it("rejects a same-slug replacement: a ready row owned by a NEW resource never serves the old invocation", () => {
    const message = { id: "m1", content: "/review src/" };
    const rewritten = rewriteSessionMessageCommandForInvocation(
      message,
      registry,
      invocation("review", { resourceId: "res-deleted-original" }),
      OPTS,
    );
    const text = rewritten?.content as string;
    expect(text).toContain("removed or renamed");
    expect(text).not.toContain("/review");
  });

  it("turns a marked command whose Skill left the config into an inert notice — never a local fall-through", () => {
    const message = { id: "m1", content: "/review src/" };
    const rewritten = rewriteSessionMessageCommandForInvocation(
      message,
      EMPTY_TEAM_SKILL_COMMAND_REGISTRY,
      invocation("review"),
      OPTS,
    );
    const text = rewritten?.content as string;
    expect(text).toContain('"review"');
    expect(text).toContain("removed or renamed");
    expect(text.startsWith("/review")).toBe(false);
    expect(text).not.toMatch(/^\/[A-Za-z0-9]/);
  });

  it("rejects a marker addressed to a different agent", () => {
    const message = { id: "m1", content: "/review src/" };
    const rewritten = rewriteSessionMessageCommandForInvocation(
      message,
      registry,
      invocation("review", { recipientAgentId: "agent-2" }),
      OPTS,
    );
    const text = rewritten?.content as string;
    expect(text).toContain("could not be verified");
    expect(text).not.toContain("/review");
  });

  it("rejects a present-but-unparseable marker (malformed or unknown marker version)", () => {
    const message = { id: "m1", content: "/review src/" };
    const rewritten = rewriteSessionMessageCommandForInvocation(message, registry, null, OPTS);
    const text = rewritten?.content as string;
    expect(text).toContain("could not be verified");
    expect(text).not.toContain("/review");
  });

  it("keeps the explicit-unavailable notice for a marked command", () => {
    const message = { id: "m1", content: "/broken please" };
    const rewritten = rewriteSessionMessageCommandForInvocation(message, registry, invocation("broken"), OPTS);
    const text = rewritten?.content as string;
    expect(text).toContain("currently unavailable");
    expect(text).not.toContain("/broken");
  });

  it("returns null when the text no longer starts with the marked command (hand-edited after selection)", () => {
    const message = { id: "m1", content: "/ship src/" };
    expect(rewriteSessionMessageCommandForInvocation(message, registry, invocation("review"), OPTS)).toBeNull();
    const prose = { id: "m1", content: "hello /review" };
    expect(rewriteSessionMessageCommandForInvocation(prose, registry, invocation("review"), OPTS)).toBeNull();
  });

  it("applies to image captions and keeps attachments immutable", () => {
    const attachments = [{ imageId: "img-1", mimeType: "image/png", filename: "shot.png" }];
    const message = { id: "m1", content: { caption: "/review src/", attachments } };
    const rewritten = rewriteSessionMessageCommandForInvocation(message, registry, invocation("review"), OPTS);
    expect(rewritten?.content).toEqual({ caption: "/review-first-tree src/", attachments });
    expect(message.content.caption).toBe("/review src/");
  });

  it("honours the mention gate for mention-prefixed marked commands", () => {
    const message = { id: "m1", content: "@nova /review" };
    expect(rewriteSessionMessageCommandForInvocation(message, registry, invocation("review"), OPTS)).toBeNull();
    const gated = rewriteSessionMessageCommandForInvocation(message, registry, invocation("review"), {
      ...OPTS,
      allowMentionPrefix: true,
    });
    expect(gated?.content).toBe("@nova /review-first-tree");
  });
});
