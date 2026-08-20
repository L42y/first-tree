import { describe, expect, it } from "vitest";
import {
  hasTeamSkillInvocationMarker,
  sendMessageSchema,
  TEAM_SKILL_INVOCATION_MARKER_VERSION,
  TEAM_SKILL_INVOCATION_METADATA_KEY,
  teamSkillInvocationFromMetadata,
} from "../schemas/message.js";

/**
 * The server-owned, versioned Team Skill invocation marker: persisted in
 * `messages.metadata` after a validated skillPrecondition, consumed
 * fail-closed by the recipient's Client. These tests pin the wire contract
 * and — critically — the distinction between a truly ABSENT key (ordinary
 * local/runtime semantics) and a PRESENT-but-malformed one (unverifiable
 * Team intent that must never fall through to a same-named local Skill).
 */
describe("teamSkillInvocation marker", () => {
  const marker = {
    version: TEAM_SKILL_INVOCATION_MARKER_VERSION,
    recipientAgentId: "agent-1",
    resourceId: "res-1",
    requestedSlug: "code-review",
    configVersion: 3,
  };

  it("round-trips a well-formed versioned marker from message metadata", () => {
    expect(teamSkillInvocationFromMetadata({ [TEAM_SKILL_INVOCATION_METADATA_KEY]: marker })).toEqual(marker);
  });

  it("distinguishes an absent key from present-but-malformed values", () => {
    // Absent / null-container: NO Team intent — ordinary semantics.
    expect(hasTeamSkillInvocationMarker(undefined)).toBe(false);
    expect(hasTeamSkillInvocationMarker(null)).toBe(false);
    expect(hasTeamSkillInvocationMarker({})).toBe(false);
    expect(teamSkillInvocationFromMetadata(undefined)).toBeNull();

    // Present in ANY of these forms: Team intent exists but is
    // unverifiable — hasTeamSkillInvocationMarker stays true while the
    // parse reads null.
    for (const bad of [
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: null },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: "code-review" },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, version: 2 } },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, recipientAgentId: "" } },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, resourceId: "" } },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, requestedSlug: "" } },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { ...marker, configVersion: 0 } },
      { [TEAM_SKILL_INVOCATION_METADATA_KEY]: { resourceId: "res-1", slug: "code-review", configVersion: 3 } },
    ]) {
      expect(hasTeamSkillInvocationMarker(bad)).toBe(true);
      expect(teamSkillInvocationFromMetadata(bad)).toBeNull();
    }
  });

  it("carries resourceId and requestedSlug on the request-level skillPrecondition", () => {
    const parsed = sendMessageSchema.safeParse({
      format: "text",
      content: "/code-review src/",
      source: "web",
      skillPrecondition: {
        recipientAgentId: crypto.randomUUID(),
        expectedConfigVersion: 1,
        resourceId: crypto.randomUUID(),
        requestedSlug: "code-review",
      },
    });
    expect(parsed.success).toBe(true);
    // A precondition without the resource identity is rejected — the server
    // could not validate a canonical marker from it.
    const incomplete = sendMessageSchema.safeParse({
      format: "text",
      content: "/code-review src/",
      source: "web",
      skillPrecondition: { recipientAgentId: crypto.randomUUID(), expectedConfigVersion: 1 },
    });
    expect(incomplete.success).toBe(false);
  });
});
