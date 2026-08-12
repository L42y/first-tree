import { describe, expect, it } from "vitest";
import {
  kickoffOnboardingSchema,
  onboardingEventSchema,
  provisionFirstTeamAgentSchema,
  treeSetupKickoffSchema,
} from "../schemas/me-extras.js";

describe("provisionFirstTeamAgentSchema", () => {
  it("requires a stable UUID-v7 request identity, one Template, and keeps the body user-scoped", () => {
    const templateId = "0190f000-0000-7000-8000-000000000002";
    expect(
      provisionFirstTeamAgentSchema.parse({
        requestId: "0190f000-0000-7000-8000-000000000001",
        name: "pr-engineer",
        templateIds: [templateId],
      }),
    ).toEqual({ requestId: "0190f000-0000-7000-8000-000000000001", name: "pr-engineer", templateIds: [templateId] });
    expect(provisionFirstTeamAgentSchema.safeParse({ name: "pr-engineer" }).success).toBe(false);
    expect(
      provisionFirstTeamAgentSchema.safeParse({
        requestId: "3d594650-3436-4f87-9f5a-8ac4d3f7f6b3",
        name: "pr-engineer",
        templateIds: [templateId],
      }).success,
    ).toBe(false);
    expect(
      provisionFirstTeamAgentSchema.safeParse({
        requestId: "0190f000-0000-7000-8000-000000000001",
        templateIds: [templateId],
        organizationId: "org-hidden-in-body",
      }).success,
    ).toBe(false);
    expect(
      provisionFirstTeamAgentSchema.safeParse({
        requestId: "0190f000-0000-7000-8000-000000000001",
        templateIds: [],
      }).success,
    ).toBe(false);
    expect(
      provisionFirstTeamAgentSchema.safeParse({
        requestId: "0190f000-0000-7000-8000-000000000001",
        templateIds: [templateId, "0190f000-0000-7000-8000-000000000003"],
      }).success,
    ).toBe(false);
  });
});

describe("kickoffOnboardingSchema", () => {
  it("accepts a natural onboarding kickoff without an internal kind discriminator", () => {
    const parsed = kickoffOnboardingSchema.parse({
      organizationId: "org-1",
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      topic: "Get started with First Tree",
      complete: false,
    });

    expect(parsed).not.toHaveProperty("kind");
    expect(parsed.topic).toBe("Get started with First Tree");
    expect(parsed.complete).toBe(false);
  });

  it("accepts the stamp variants alongside the older complete boolean", () => {
    for (const stamp of ["completed", "invitee_skip", "none"] as const) {
      const parsed = kickoffOnboardingSchema.parse({
        agentUuid: "agent-1",
        bootstrap: "First Tree is getting the agent up to speed.",
        stamp,
      });
      expect(parsed.stamp).toBe(stamp);
    }
  });

  it("rejects an unknown stamp value", () => {
    const parsed = kickoffOnboardingSchema.safeParse({
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      stamp: "dismissed",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects the retired kickoff kind field", () => {
    const parsed = kickoffOnboardingSchema.safeParse({
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      kind: "work",
    });

    expect(parsed.success).toBe(false);
  });

  it("still rejects unknown extra fields", () => {
    const parsed = kickoffOnboardingSchema.safeParse({
      agentUuid: "agent-1",
      bootstrap: "First Tree is getting the agent up to speed.",
      unexpected: "value",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts the canonical campaign action contract and rejects obsolete fields", () => {
    const base = { agentUuid: "agent-1", bootstrap: "Fix the findings." };
    expect(
      kickoffOnboardingSchema.parse({
        ...base,
        campaignAction: { campaign: "production-scan", repoSlug: "acme/api" },
      }).campaignAction,
    ).toEqual({ campaign: "production-scan", repoSlug: "acme/api" });
    expect(
      kickoffOnboardingSchema.safeParse({
        ...base,
        scanFixRepoSlug: "acme/api",
      }).success,
    ).toBe(false);
    expect(kickoffOnboardingSchema.safeParse({ ...base, campaign: "production-scan" }).success).toBe(false);
  });
});

describe("onboardingEventSchema", () => {
  it("accepts a classified step failure and rejects arbitrary event names", () => {
    expect(
      onboardingEventSchema.parse({
        event: "step_failed",
        attrs: { step: "create-agent", reasonCode: "agent_create_failed", retryable: true },
      }),
    ).toEqual({
      event: "step_failed",
      attrs: { step: "create-agent", reasonCode: "agent_create_failed", retryable: true },
    });
    expect(onboardingEventSchema.safeParse({ event: "raw_exception" }).success).toBe(false);
  });
});

describe("treeSetupKickoffSchema", () => {
  it("accepts only the selected agent for the dedicated setup intent", () => {
    const parsed = treeSetupKickoffSchema.parse({ agentUuid: "agent-1" });

    expect(parsed).not.toHaveProperty("kind");
    expect(parsed).not.toHaveProperty("organizationId");
    expect(parsed).not.toHaveProperty("complete");
    expect(parsed).toEqual({ agentUuid: "agent-1" });
  });

  it("rejects org scope and onboarding completion controls in the body", () => {
    expect(
      treeSetupKickoffSchema.safeParse({
        organizationId: "org-1",
        agentUuid: "agent-1",
      }).success,
    ).toBe(false);
    expect(
      treeSetupKickoffSchema.safeParse({
        agentUuid: "agent-1",
        complete: true,
      }).success,
    ).toBe(false);
    expect(
      treeSetupKickoffSchema.safeParse({
        agentUuid: "agent-1",
        bootstrap: "Client-controlled setup semantics.",
      }).success,
    ).toBe(false);
  });
});
