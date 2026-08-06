import { z } from "zod";
import { canonicalGitRepoIdentity } from "../canonical-git-repo-url.js";

/**
 * `metadata.contextDecision` — an agent's self-attributed record that Context
 * Tree content materially shaped the choice carried by THIS message.
 *
 * Written by the `first-tree-read` skill on the same final `chat send` (or
 * blocking `chat ask`) that contains the affected choice, never as a separate
 * message and never as prose. The receipt is the agent's own report: First Tree
 * preserves the cited repository/commit/path so a reader can inspect the exact
 * source, but it does NOT independently verify that the passage caused the
 * choice. Every consumer must present it as agent-reported, never as a
 * system-verified causal claim.
 *
 * Trust boundary: the server strips the key from human senders and rejects a
 * malformed receipt from an agent sender, so a stored receipt is always an
 * agent's and always parses. Readers still parse defensively (`safeParse` via
 * `readContextDecisionMetadata`) because message rows are immutable — history
 * written before that guard is not re-validated.
 */
export const CONTEXT_DECISION_METADATA_KEY = "contextDecision";

/**
 * How Tree content acted on the choice. Exactly one applies; the skill picks
 * the first matching category in this precedence order so reports stay
 * comparable:
 *
 *   - `conflicted`  — exposed a conflict that still needs resolution/escalation
 *   - `redirected`  — changed the intended approach
 *   - `constrained` — ruled out an option or narrowed the solution boundary
 *   - `confirmed`   — removed material uncertainty and justified keeping the
 *                     choice without changing its boundary
 */
export const contextDecisionEffectSchema = z.enum(["conflicted", "redirected", "constrained", "confirmed"]);
export type ContextDecisionEffect = z.infer<typeof contextDecisionEffectSchema>;

/** At most three node paths may jointly influence one choice (skill contract). */
export const MAX_CONTEXT_DECISION_EVIDENCE = 3;
export const MAX_CONTEXT_DECISION_SUMMARY_LENGTH = 400;

/**
 * One cited passage: the exact repository + commit + Tree-root-relative node
 * path that supplied it. `repoUrl` is the credential-free binding repository as
 * the activation receipt / workspace briefing declares it — never a local
 * transport URL and never a credential-bearing remote, so a stored receipt can
 * be shown and linked without leaking a secret.
 */
export const contextDecisionEvidenceSchema = z.object({
  repoUrl: z
    .string()
    .min(1)
    .max(2_000)
    .refine((value) => canonicalGitRepoIdentity(value) !== null, {
      message: "repoUrl must be a resolvable git repository URL",
    })
    .refine((value) => !hasEmbeddedCredentials(value), {
      message: "repoUrl must not embed credentials",
    }),
  /**
   * The exact commit the passage was read at. Full 40-char SHA-1 is what the
   * skill specifies; shorter unambiguous prefixes are accepted rather than
   * failing an otherwise valid final message, and 64 covers SHA-256 repos.
   */
  commit: z.string().regex(/^[0-9a-fA-F]{7,64}$/, "commit must be a hex git object id (7-64 chars)"),
  /** Tree-root-relative path, e.g. `system/cloud/team/tenancy-and-identity.md`. */
  nodePath: z
    .string()
    .min(1)
    .max(1_000)
    .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
      message: "nodePath must be a tree-root-relative path without `..` segments",
    }),
  /** Optional heading inside the node; omitted when it cannot be named reliably. */
  heading: z.string().min(1).max(200).optional(),
});
export type ContextDecisionEvidence = z.infer<typeof contextDecisionEvidenceSchema>;

export const contextDecisionSchema = z.object({
  version: z.literal(1),
  effect: contextDecisionEffectSchema,
  /** One concrete sentence naming what the Tree content actually did here. */
  summary: z.string().trim().min(1).max(MAX_CONTEXT_DECISION_SUMMARY_LENGTH),
  /**
   * Required: a receipt with nothing to inspect is a claim, not a receipt —
   * the inspectable source is the only part First Tree can vouch for.
   */
  evidence: z.array(contextDecisionEvidenceSchema).min(1).max(MAX_CONTEXT_DECISION_EVIDENCE),
});
export type ContextDecision = z.infer<typeof contextDecisionSchema>;

/**
 * Strict reader for a stored message's receipt. Returns `null` for absent,
 * unknown-version, or malformed payloads so a renderer fails closed (shows
 * nothing) instead of rendering a partial, misleading influence claim.
 */
export function readContextDecisionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ContextDecision | null {
  if (metadata?.[CONTEXT_DECISION_METADATA_KEY] === undefined) return null;
  const parsed = contextDecisionSchema.safeParse(metadata[CONTEXT_DECISION_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * A URL that carries `user:token@host` would be persisted, rendered, and linked
 * verbatim. Reject it at the write boundary instead.
 */
function hasEmbeddedCredentials(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.includes("://")) return false;
  try {
    const url = new URL(trimmed);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}
