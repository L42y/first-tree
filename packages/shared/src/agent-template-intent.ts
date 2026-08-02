import { type AgentTemplateSlug, agentTemplateSlugSchema } from "./schemas/agent-template.js";

/**
 * Canonical "use this Template" intent URL: `/templates/<slug>?use=1`.
 *
 * One URL shape is shared by every surface that carries the intent across a
 * login round-trip — the public detail CTA, the OAuth `next` parameter, and
 * the server's solo-signup `next` preservation (`shouldPreserveSoloSignupNext`).
 * Parsing is deliberately strict so the server never preserves an arbitrary
 * deep-link as a post-signup destination: the pathname must be exactly
 * `/templates/<slug>` with a schema-valid slug, `use=1` must be the ONLY
 * query parameter, and no fragment is allowed.
 */
export function agentTemplateIntentPath(slug: AgentTemplateSlug): string {
  return `/templates/${slug}?use=1`;
}

/**
 * Parse a candidate redirect target into its Template intent slug, or `null`
 * when the value is anything other than the strict canonical intent URL.
 * Never throws — an unparseable or non-canonical value is simply not an
 * intent.
 */
export function parseAgentTemplateIntentPath(next: string): AgentTemplateSlug | null {
  let parsed: URL;
  try {
    parsed = new URL(next, "http://first-tree.local");
  } catch {
    return null;
  }
  // Anything that resolved against a different origin (absolute or
  // protocol-relative input) is not a same-app relative intent URL.
  if (parsed.origin !== "http://first-tree.local") return null;
  if (parsed.hash !== "") return null;
  const match = /^\/templates\/([^/]+)$/.exec(parsed.pathname);
  const slug = match?.[1];
  if (!slug) return null;
  const params = [...parsed.searchParams.entries()];
  if (params.length !== 1 || params[0]?.[0] !== "use" || params[0]?.[1] !== "1") return null;
  const validated = agentTemplateSlugSchema.safeParse(slug);
  return validated.success ? validated.data : null;
}
