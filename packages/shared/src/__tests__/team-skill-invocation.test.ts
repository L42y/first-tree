import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hasTeamSkillInvocationMarker,
  sendMessageSchema,
  TEAM_SKILL_INVOCATION_MARKER_VERSION,
  TEAM_SKILL_INVOCATION_MESSAGE_PURPOSE,
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

describe("team-skill-invocation protocol sentinel + legacy rollback contract", () => {
  const precondition = {
    recipientAgentId: crypto.randomUUID(),
    expectedConfigVersion: 1,
    resourceId: crypto.randomUUID(),
    requestedSlug: "code-review",
  };

  it("accepts the sentinel purpose together with a skillPrecondition", () => {
    const parsed = sendMessageSchema.safeParse({
      format: "text",
      content: "/code-review src/",
      source: "web",
      purpose: TEAM_SKILL_INVOCATION_MESSAGE_PURPOSE,
      skillPrecondition: precondition,
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps ordinary and agent-final-text sends working without the sentinel", () => {
    expect(sendMessageSchema.safeParse({ format: "text", content: "hi", source: "web" }).success).toBe(true);
    expect(
      sendMessageSchema.safeParse({ format: "text", content: "note", source: "api", purpose: "agent-final-text" })
        .success,
    ).toBe(true);
  });

  it("the LEGACY Server contract rejects the new Web payload outright at parse time", () => {
    // The old Server's purpose enum knows only `agent-final-text`. A new
    // Web payload always pairs the precondition with the sentinel, so a
    // rolled-back Server parse-rejects the whole send — it can never strip
    // an unknown top-level field and persist a bare, unmarked slash
    // command the way a plain extra `skillPrecondition` field would allow.
    const legacyMessagePurposeSchema = z.enum(["agent-final-text"]);
    const legacySendMessageSchema = sendMessageSchema
      .omit({ skillPrecondition: true })
      .extend({ purpose: legacyMessagePurposeSchema.optional() });
    const newWebPayload = {
      format: "text",
      content: "/code-review src/",
      source: "web",
      purpose: TEAM_SKILL_INVOCATION_MESSAGE_PURPOSE,
      skillPrecondition: precondition,
    };
    expect(legacySendMessageSchema.safeParse(newWebPayload).success).toBe(false);
    // And a bare unknown-field payload WOULD have been stripped by the old
    // server — the sentinel is what closes that rollback hole.
    const strippedShape = legacySendMessageSchema.safeParse({
      format: "text",
      content: "/code-review src/",
      source: "web",
      skillPrecondition: precondition,
    });
    expect(strippedShape.success).toBe(true);
    expect("skillPrecondition" in (strippedShape.data ?? {})).toBe(false);
  });
});
