import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATE_STATUSES,
  agentTemplateComponentSchema,
  agentTemplateIdsSchema,
  agentTemplatePayloadSchema,
  agentTemplateStatusSchema,
  MAX_AGENT_TEMPLATE_IDS,
} from "../schemas/agent-template.js";

const TEMPLATE_ID_A = "0190f000-0000-7000-8000-00000000000a";
const TEMPLATE_ID_B = "0190f000-0000-7000-8000-00000000000b";
const TEMPLATE_ID_C = "0190f000-0000-7000-8000-00000000000c";
const TEMPLATE_ID_D = "0190f000-0000-7000-8000-00000000000d";

const VALID_PUBLIC_PROFILE = {
  tagline: "Ship production-ready PRs faster",
  purpose: "A complete starting point for a pull-request engineering agent.",
  targetUsers: "Engineers running multiple agents in parallel.",
  userValue: "Start from a curated workflow instead of a blank configuration.",
  instructionsSummary: "Guides the agent through review-ready PR delivery.",
  toolsAndSkillsSummary: "Adds a review skill and a GitHub MCP server.",
};

const VALID_PROMPT_COMPONENT = {
  key: "instructions",
  type: "prompt",
  name: "PR Engineer Instructions",
  payload: { body: "You are a PR engineer.", description: "Core instructions" },
};

const VALID_SKILL_COMPONENT = {
  key: "review-skill",
  type: "skill",
  name: "Review Skill",
  payload: {
    name: "review",
    description: "Review a pull request.",
    body: "# Review\nDo the review.",
    metadata: {},
  },
  bundle: { attachmentId: TEMPLATE_ID_A, format: "zip", sizeBytes: 1024 },
};

const VALID_MCP_COMPONENT = {
  key: "github-mcp",
  type: "mcp",
  name: "GitHub MCP",
  payload: { name: "github", transport: "http", url: "https://mcp.github.example/mcp" },
};

function validPayload(components: unknown[] = [VALID_PROMPT_COMPONENT, VALID_SKILL_COMPONENT, VALID_MCP_COMPONENT]) {
  return { schemaVersion: 1, public: VALID_PUBLIC_PROFILE, components };
}

describe("agentTemplateStatusSchema", () => {
  it("accepts the three lifecycle states", () => {
    for (const status of Object.values(AGENT_TEMPLATE_STATUSES)) {
      expect(agentTemplateStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects unknown states", () => {
    expect(agentTemplateStatusSchema.safeParse("archived").success).toBe(false);
  });
});

describe("agentTemplateIdsSchema", () => {
  it("accepts 0 to MAX_AGENT_TEMPLATE_IDS ids", () => {
    expect(agentTemplateIdsSchema.parse([])).toEqual([]);
    expect(agentTemplateIdsSchema.parse([TEMPLATE_ID_A])).toEqual([TEMPLATE_ID_A]);
    expect(MAX_AGENT_TEMPLATE_IDS).toBe(3);
    expect(agentTemplateIdsSchema.parse([TEMPLATE_ID_A, TEMPLATE_ID_B, TEMPLATE_ID_C])).toHaveLength(3);
  });

  it("rejects more than MAX_AGENT_TEMPLATE_IDS ids", () => {
    const result = agentTemplateIdsSchema.safeParse([TEMPLATE_ID_A, TEMPLATE_ID_B, TEMPLATE_ID_C, TEMPLATE_ID_D]);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const result = agentTemplateIdsSchema.safeParse([TEMPLATE_ID_A, TEMPLATE_ID_B, TEMPLATE_ID_A]);
    expect(result.success).toBe(false);
  });

  it("normalizes uppercase hex to lowercase", () => {
    const upper = TEMPLATE_ID_A.toUpperCase();
    expect(agentTemplateIdsSchema.parse([upper])).toEqual([TEMPLATE_ID_A]);
  });

  it("treats mixed-case spellings of the same UUID as duplicates", () => {
    const result = agentTemplateIdsSchema.safeParse([TEMPLATE_ID_A, TEMPLATE_ID_A.toUpperCase()]);
    expect(result.success).toBe(false);
  });

  it("normalizes to a canonical sorted order so position carries no priority", () => {
    expect(agentTemplateIdsSchema.parse([TEMPLATE_ID_C, TEMPLATE_ID_A, TEMPLATE_ID_B])).toEqual([
      TEMPLATE_ID_A,
      TEMPLATE_ID_B,
      TEMPLATE_ID_C,
    ]);
  });

  it("rejects non-uuid ids", () => {
    expect(agentTemplateIdsSchema.safeParse(["not-a-uuid"]).success).toBe(false);
  });
});

describe("agentTemplatePayloadSchema", () => {
  it("accepts a complete payload with prompt, skill, and mcp components", () => {
    const parsed = agentTemplatePayloadSchema.parse(validPayload());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.components).toHaveLength(3);
  });

  it("requires schemaVersion 1", () => {
    expect(agentTemplatePayloadSchema.safeParse({ ...validPayload(), schemaVersion: 2 }).success).toBe(false);
  });

  it("rejects unknown top-level fields (strict)", () => {
    const result = agentTemplatePayloadSchema.safeParse({ ...validPayload(), internalNotes: "secret" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in the public profile (strict)", () => {
    const result = agentTemplatePayloadSchema.safeParse(
      validPayloadWithPublic({ ...VALID_PUBLIC_PROFILE, rawInstructions: "do not leak" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects duplicate component keys within one Template", () => {
    const secondPrompt = { ...VALID_PROMPT_COMPONENT, name: "Other Instructions" };
    const result = agentTemplatePayloadSchema.safeParse(validPayload([VALID_PROMPT_COMPONENT, secondPrompt]));
    expect(result.success).toBe(false);
  });

  it("rejects repo components", () => {
    const repoComponent = {
      key: "repo",
      type: "repo",
      name: "Repo",
      payload: { url: "https://github.com/example/repo" },
    };
    expect(agentTemplateComponentSchema.safeParse(repoComponent).success).toBe(false);
  });

  it("rejects invalid component keys", () => {
    const bad = { ...VALID_PROMPT_COMPONENT, key: "Not A Key" };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects component keys that are not strict kebab-case segments", () => {
    for (const key of ["trailing-", "-leading", "double--dash", "UPPER", "under_score", ""]) {
      const bad = { ...VALID_PROMPT_COMPONENT, key };
      expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
    }
    for (const key of ["a", "segment", "many-segment-key", "with-123-numbers"]) {
      const good = { ...VALID_PROMPT_COMPONENT, key };
      expect(agentTemplateComponentSchema.safeParse(good).success).toBe(true);
    }
  });

  it("prompt components reject unknown nested payload fields (strict payload)", () => {
    const bad = {
      ...VALID_PROMPT_COMPONENT,
      payload: { ...VALID_PROMPT_COMPONENT.payload, resourceId: TEMPLATE_ID_A },
    };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("skill components reject unknown nested payload fields (strict payload)", () => {
    const bad = {
      ...VALID_SKILL_COMPONENT,
      payload: { ...VALID_SKILL_COMPONENT.payload, resourceId: TEMPLATE_ID_A },
    };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects mcp payloads carrying url credentials", () => {
    const bad = {
      ...VALID_MCP_COMPONENT,
      payload: { name: "github", transport: "http", url: "https://user:pass@mcp.github.example/mcp" },
    };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("skill components reuse the runtime complete-directory bundle descriptor", () => {
    const parsed = agentTemplateComponentSchema.parse(VALID_SKILL_COMPONENT);
    expect(parsed.type).toBe("skill");
    if (parsed.type !== "skill") throw new Error("unreachable");
    // The bundle descriptor references an immutable ZIP attachment holding the
    // complete Skill directory (SKILL.md plus supporting files) — the same
    // shape Team Skills use at runtime.
    expect(parsed.bundle).toEqual({ attachmentId: TEMPLATE_ID_A, format: "zip", sizeBytes: 1024 });
  });

  it("skill components require a bundle descriptor", () => {
    const { bundle: _bundle, ...withoutBundle } = VALID_SKILL_COMPONENT;
    expect(agentTemplateComponentSchema.safeParse(withoutBundle).success).toBe(false);
  });

  it("skill components reject non-zip bundle formats", () => {
    const bad = { ...VALID_SKILL_COMPONENT, bundle: { ...VALID_SKILL_COMPONENT.bundle, format: "tar" } };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown fields inside components (strict)", () => {
    const bad = { ...VALID_MCP_COMPONENT, resourceId: "0190f000-0000-7000-8000-0000000000ff" };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });
});

function validPayloadWithPublic(publicProfile: unknown) {
  return { schemaVersion: 1, public: publicProfile, components: [VALID_PROMPT_COMPONENT] };
}
