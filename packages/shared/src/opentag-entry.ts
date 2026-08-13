import { z } from "zod";

/** The single authenticated OpenTag entry route. */
export const OPENTAG_ENTRY_PATH = "/opentag";

// Lowercase-normalized like `agentTemplateIdSchema`, so exactly one spelling of
// an Agent id is canonical. The exact-canonical gate below then rejects a
// mixed-case variant instead of letting two URLs mean the same entry.
const agentUuidSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.string().uuid());

/**
 * Canonical OpenTag entry URL: `/opentag`, optionally carrying the exact Agent
 * the flow is already working on as `?agent=<uuid>`.
 *
 * The Agent id in the URL is the flow's only progress memory — there is no
 * onboarding persistence behind OpenTag, so a reload, a lost response, or a
 * retry re-derives the step from this URL plus authoritative Agent / Client /
 * Feishu reads. Keeping one builder means the browser, the OAuth `next`
 * parameter, and the server's solo-signup preservation all agree on the shape.
 */
export function opentagEntryPath(agentUuid?: string | null): string {
  return agentUuid ? `${OPENTAG_ENTRY_PATH}?agent=${agentUuid}` : OPENTAG_ENTRY_PATH;
}

export type OpenTagEntryTarget = {
  /** The Agent the entry is scoped to, or `null` for a fresh entry. */
  agentUuid: string | null;
};

/**
 * Parse a candidate redirect target into an OpenTag entry, or `null` when it is
 * anything other than this builder's exact output.
 *
 * Same two gates as {@link parseAgentTemplateIntentPath}: a structural check
 * (same-origin relative URL, exact pathname, at most an `agent` UUID query, no
 * fragment) followed by an exact-canonical check against the builder. The
 * strictness is what lets OAuth preserve this destination without widening
 * `next` preservation into a general deep-link or open-redirect channel.
 *
 * Never throws — an unparseable value is simply not an OpenTag entry.
 */
export function parseOpenTagEntryPath(next: string): OpenTagEntryTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(next, "http://first-tree.local");
  } catch {
    return null;
  }
  // Anything that resolved against a different origin (absolute or
  // protocol-relative input) is not a same-app relative entry URL.
  if (parsed.origin !== "http://first-tree.local") return null;
  if (parsed.hash !== "") return null;
  if (parsed.pathname !== OPENTAG_ENTRY_PATH) return null;

  const params = [...parsed.searchParams.entries()];
  if (params.length > 1) return null;
  let agentUuid: string | null = null;
  if (params.length === 1) {
    const [key, value] = params[0] ?? [];
    if (key !== "agent") return null;
    const validated = agentUuidSchema.safeParse(value);
    if (!validated.success) return null;
    agentUuid = validated.data;
  }

  if (next !== opentagEntryPath(agentUuid)) return null;
  return { agentUuid };
}
