import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { OPENTAG_RECOMMENDED_TEMPLATE_SLUG, resolveOpenTagTemplateChoices } from "../templates.js";

function template(slug: string, status: "active" | "retired" = "active"): AgentTemplatePublicTemplate {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    status,
    public: {
      tagline: "t",
      purpose: "p",
      targetUsers: "u",
      userValue: "v",
      instructionsSummary: "i",
      toolsAndSkillsSummary: "s",
    },
    updatedAt: "2026-08-13T00:00:00.000Z",
    replacement: null,
  };
}

describe("resolveOpenTagTemplateChoices", () => {
  it("leads with the recommendation regardless of the order the catalog returned", () => {
    const choices = resolveOpenTagTemplateChoices([
      template("researcher"),
      template("software-engineer"),
      template(OPENTAG_RECOMMENDED_TEMPLATE_SLUG),
    ]);

    expect(choices.ordered.map((t) => t.slug)).toEqual([
      OPENTAG_RECOMMENDED_TEMPLATE_SLUG,
      "researcher",
      "software-engineer",
    ]);
    expect(choices.recommendedSlug).toBe(OPENTAG_RECOMMENDED_TEMPLATE_SLUG);
  });

  it("drops retired Templates so a withdrawn configuration is never adopted", () => {
    const choices = resolveOpenTagTemplateChoices([
      template(OPENTAG_RECOMMENDED_TEMPLATE_SLUG, "retired"),
      template("researcher"),
    ]);

    expect(choices.ordered.map((t) => t.slug)).toEqual(["researcher"]);
    // Nothing is badged when the recommendation is not on offer.
    expect(choices.recommendedSlug).toBeNull();
  });

  it("returns nothing to choose when the deployment publishes no catalog", () => {
    expect(resolveOpenTagTemplateChoices([])).toEqual({ ordered: [], recommendedSlug: null });
  });
});
