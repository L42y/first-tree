import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATE_MAX_SELECTION,
  agentTemplateIdsSchema,
  createAgentSchema,
  createAgentTemplateSchema,
  updateAgentTemplateSchema,
} from "../index.js";

describe("Agent Template schemas", () => {
  it("preserves Template order while rejecting duplicate or oversized selections", () => {
    expect(agentTemplateIdsSchema.parse(["second-template", "first-template"])).toEqual([
      "second-template",
      "first-template",
    ]);
    expect(agentTemplateIdsSchema.safeParse(["same-template", "same-template"]).success).toBe(false);
    expect(
      agentTemplateIdsSchema.safeParse(
        Array.from({ length: AGENT_TEMPLATE_MAX_SELECTION + 1 }, (_, index) => `template-${index}`),
      ).success,
    ).toBe(false);
  });

  it("validates immutable slugs, unique Resource references, and non-empty updates", () => {
    const base = {
      id: "research-assistant",
      title: "Research assistant",
      summary: "Produces a sourced brief.",
      customInstructions: "Research carefully.",
      resourceIds: ["skill-1", "mcp-1"],
    };
    expect(createAgentTemplateSchema.safeParse(base).success).toBe(true);
    expect(createAgentTemplateSchema.safeParse({ ...base, id: "Research Assistant" }).success).toBe(false);
    expect(
      createAgentTemplateSchema.safeParse({
        ...base,
        resourceIds: ["skill-1", "skill-1"],
      }).success,
    ).toBe(false);
    expect(updateAgentTemplateSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });

  it("accepts an ordered Template selection during Agent creation", () => {
    const parsed = createAgentSchema.parse({
      type: "agent",
      templateIds: ["research-assistant", "release-manager"],
    });
    expect(parsed.templateIds).toEqual(["research-assistant", "release-manager"]);
  });
});
