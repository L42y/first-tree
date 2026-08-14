import type { AgentTemplatePublicTemplate } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  OPENTAG_RECOMMENDED_TEMPLATE_SLUG,
  openTagTemplateTagline,
  resolveOpenTagTemplateChoices,
} from "../templates.js";

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
  it("preserves public catalog order while identifying its recommendation", () => {
    const choices = resolveOpenTagTemplateChoices([
      template("researcher"),
      template("software-engineer"),
      template(OPENTAG_RECOMMENDED_TEMPLATE_SLUG),
    ]);

    expect(choices.ordered.map((t) => t.slug)).toEqual([
      "researcher",
      "software-engineer",
      OPENTAG_RECOMMENDED_TEMPLATE_SLUG,
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

  it("uses approved onboarding taglines without replacing catalog-backed choices", () => {
    expect(openTagTemplateTagline(template("team-assistant"))).toBe(
      "For team questions, decisions, and follow-through.",
    );
    expect(openTagTemplateTagline(template("software-engineer"))).toBe(
      "For debugging, code review, and implementation planning.",
    );
    expect(openTagTemplateTagline(template("researcher"))).toBe(
      "For evidence gathering, comparison, and decision support.",
    );
    expect(openTagTemplateTagline(template("custom"))).toBe("t");
  });
});
