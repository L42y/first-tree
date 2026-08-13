import type { AgentTemplatePublicTemplate } from "@first-tree/shared";

/**
 * The Template OpenTag leads with.
 *
 * The official catalog states this recommendation in prose ("the recommended
 * starting point for everyday team work") but the public read model carries no
 * `recommended` field, and the list endpoint's order is not a product promise.
 * Naming the slug here keeps the recommendation stable instead of letting row
 * order decide which teammate a new member is nudged towards. When the public
 * Template contract grows a real recommendation flag, this should read it.
 */
export const OPENTAG_RECOMMENDED_TEMPLATE_SLUG = "team-assistant";

export type OpenTagTemplateChoices = {
  /** Active Templates, recommendation first, catalog order otherwise. */
  ordered: AgentTemplatePublicTemplate[];
  /** The recommended Template's slug, or null when this deployment has none. */
  recommendedSlug: string | null;
};

/**
 * Reduce the public catalog to the choices OpenTag offers. Retired Templates
 * are dropped: adopting one would import a configuration the catalog has
 * already withdrawn.
 */
export function resolveOpenTagTemplateChoices(
  templates: readonly AgentTemplatePublicTemplate[],
): OpenTagTemplateChoices {
  const active = templates.filter((template) => template.status === "active");
  const recommended = active.find((template) => template.slug === OPENTAG_RECOMMENDED_TEMPLATE_SLUG) ?? null;
  if (!recommended) return { ordered: [...active], recommendedSlug: null };
  return {
    ordered: [recommended, ...active.filter((template) => template.slug !== recommended.slug)],
    recommendedSlug: recommended.slug,
  };
}
