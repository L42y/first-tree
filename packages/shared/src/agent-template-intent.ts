import { type AgentTemplateSlug, agentTemplateSlugSchema } from "./schemas/agent-template.js";

/**
 * Canonical "use this Template" intent URL: `/templates/<slug>?use=1`.
 *
 * One URL shape is shared by every surface that carries the intent across a
 * login round-trip — the public detail CTA, the OAuth `next` parameter, and
 * the server's solo-signup `next` preservation (`shouldPreserveSoloSignupNext`).
 * This builder is the ONLY producer of a valid intent URL; the parser below
 * accepts exactly this output and nothing else.
 */
export function agentTemplateIntentPath(slug: AgentTemplateSlug): string {
  return `/templates/${slug}?use=1`;
}

/**
 * Parse a candidate redirect target into its Template intent slug, or `null`
 * when the value is anything other than the strict canonical intent URL.
 *
 * Two gates, in order:
 *   1. Structural — parses as a same-origin relative URL with an exact
 *      `/templates/<slug>` pathname, a schema-valid slug, `use=1` as the ONLY
 *      query parameter, and no fragment.
 *   2. Exact-canonical — the RAW input must be byte-identical to the
 *      builder's output for the extracted slug. This rejects absolute and
 *      protocol-relative spellings of the same origin, URL-normalized forms
 *      (trailing `&`, encoded characters, backslashes, duplicate separators),
 *      and anything else that is merely "equivalent" but not canonical.
 *
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
  if (!validated.success) return null;
  // Only the builder's exact output is an intent — no normalization-tolerant
  // spellings, so OAuth `next` preservation can never widen into a general
  // deep-link or open-redirect channel.
  if (next !== agentTemplateIntentPath(validated.data)) return null;
  return validated.data;
}
