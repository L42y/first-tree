import { describe, expect, it } from "vitest";
import {
  sendMessageSchema,
  TEAM_SKILL_INVOCATION_METADATA_KEY,
  teamSkillInvocationFromMetadata,
  teamSkillInvocationSchema,
} from "../schemas/message.js";

/**
 * The server-owned Team Skill invocation marker: persisted in
 * `messages.metadata` after a validated skillPrecondition, consumed
 * fail-closed by the recipient's Client. These tests pin the wire shape
 * and the parse boundary — a malformed marker must read as "no marker",
 * never as partial Team intent.
 */
describe("teamSkillInvocation marker", () => {
  const marker = { resourceId: crypto.randomUUID(), slug: "review", configVersion: 3 };

  it("round-trips a well-formed marker from message metadata", () => {
    expect(teamSkillInvocationFromMetadata({ [TEAM_SKILL_INVOCATION_METADATA_KEY]: marker })).toEqual(marker);
  });

  it("reads absent, null, and malformed markers as no Team intent", () => {
    expect(teamSkillInvocationFromMetadata(undefined)).toBeNull();
    expect(teamSkillInvocationFromMetadata(null)).toBeNull();
    expect(teamSkillInvocationFromMetadata({})).toBeNull();
    for (const bad of [
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: null },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: "review" },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, slug: "Not A Slug" } },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, slug: "/review" } },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, configVersion: 0 } },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, resourceId: "not-a-uuid" } },
    ]) {
      expect(teamSkillInvocationFromMetadata(bad)).toBeNull();
    }
  });

  it("accepts slugs the materializer can produce and rejects untriggerable names", () => {
    for (const ok of ["review", "code-review", "a", "x1", "1abc"]) {
      expect(teamSkillInvocationSchema.safeParse({ ...marker, slug: ok }).success).toBe(true);
    }
    for (const bad of ["Code Review", "review ", "-review", "review_foo", "review/foo", ""]) {
      expect(teamSkillInvocationSchema.safeParse({ ...marker, slug: bad }).success).toBe(false);
    }
  });

  it("carries resourceId and slug on the request-level skillPrecondition", () => {
    const parsed = sendMessageSchema.safeParse({
      format: "text",
      content: "/review src/",
      source: "web",
      skillPrecondition: {
        recipientAgentId: crypto.randomUUID(),
        expectedConfigVersion: 1,
        resourceId: marker.resourceId,
        slug: "review",
      },
    });
    expect(parsed.success).toBe(true);
    // A precondition without the resource identity is rejected — the server
    // could not persist a meaningful marker from it.
    const incomplete = sendMessageSchema.safeParse({
      format: "text",
      content: "/review src/",
      source: "web",
      skillPrecondition: { recipientAgentId: crypto.randomUUID(), expectedConfigVersion: 1 },
    });
    expect(incomplete.success).toBe(false);
  });
});
