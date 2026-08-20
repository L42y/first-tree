import { ManagedSkillsUnsafeDiscoveryError } from "./managed-skills.js";

/**
 * Team Skill slash-command registry + rewrite at the shared inbound
 * boundary.
 *
 * The Managed Skills materializer may install a Team Skill under a
 * collision-suffixed `effectiveName` (e.g. `review-first-tree`) when an
 * unmanaged local Skill already occupies the requested base slug. Web and
 * users keep addressing the Cloud-declared base command (`/review`), so
 * without a rewrite the provider would invoke the WRONG Skill — the local
 * one squatting on the base name.
 *
 * The registry is published per session after every settled projection and
 * holds the COMPLETE desired set: every known Cloud-configured base slug is
 * either `ready` (with its verified effective name — identity mappings
 * included explicitly) or `unavailable` (with a stable reason). Only a
 * command that belongs to NO known Team Skill passes through to local /
 * runtime-reported Skills. Hitting `unavailable` — or a base slug claimed
 * by two different effective names — throws before any provider sees the
 * text, so a configured command can never fall through to a same-named
 * unmanaged Skill. A Team Skill's base command takes precedence over a
 * local unmanaged Skill of the same name (an explicit product trade-off).
 *
 * Only strict command positions rewrite, mirroring the Web composer's
 * slash-trigger semantics: a bare `/name` at the start of the message, or
 * — only when the caller proves from routed message metadata that this
 * agent is an explicit recipient — one following a canonical mention
 * prefix (`@name …` tokens + whitespace). The command name must be
 * followed by whitespace or end-of-text. Prose (`hello /review`), paths
 * (`/review/src`), dotted suffixes (`/review.foo`), over-long tokens, and
 * mention-prefixed text without routed mention metadata are never
 * touched.
 */

export type TeamSkillCommandTarget =
  | Readonly<{ kind: "ready"; effectiveName: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Base slash name → its resolved Team Skill command target. */
export type TeamSkillCommandRegistry = ReadonlyMap<string, TeamSkillCommandTarget>;

export const EMPTY_TEAM_SKILL_COMMAND_REGISTRY: TeamSkillCommandRegistry = new Map();

export type TeamSkillCommandEntry = Readonly<{
  /** Cloud-declared base slug the user types. */
  requestedSlug: string;
  /** Final installed command name, or null when no verified target exists. */
  effectiveName: string | null;
}>;

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Build the session registry from a complete, authoritative command list.
 * Identity mappings (no collision suffix) are recorded as ready too —
 * every known Team base slug is explicit, so "unknown" provably means "not
 * a Team Skill". Rows with a malformed base slug never had a typable
 * command and are skipped. A base slug claimed by two different effective
 * names fails closed into `unavailable` and is reported via log.
 */
export function buildTeamSkillCommandRegistry(
  entries: readonly TeamSkillCommandEntry[],
  log?: (message: string) => void,
): TeamSkillCommandRegistry {
  const registry = new Map<string, TeamSkillCommandTarget>();
  const conflicts = new Set<string>();
  for (const entry of entries) {
    const base = entry.requestedSlug;
    if (!SAFE_SLUG.test(base)) continue;
    const existing = registry.get(base);
    if (existing) {
      // Idempotent repeats are fine; any disagreement over one base slug
      // (ready vs unavailable, or two different effective names) fails
      // closed — never let row order pick a winner.
      const same =
        existing.kind === "ready" && entry.effectiveName !== null && existing.effectiveName === entry.effectiveName;
      if (!same) conflicts.add(base);
      continue;
    }
    registry.set(
      base,
      entry.effectiveName === null
        ? { kind: "unavailable", reason: "no verified installed target" }
        : { kind: "ready", effectiveName: entry.effectiveName },
    );
  }
  for (const base of conflicts) {
    registry.set(base, { kind: "unavailable", reason: "conflicting effective names" });
    log?.(
      `Team Skill command registry conflict for /${base}: multiple effective names — the command fails closed instead of guessing`,
    );
  }
  return registry;
}

/** One canonical mention token (`@name`), matching the shared mention charset. */
const MENTION_TOKEN = `@[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![A-Za-z0-9_/-])`;

/**
 * Command name charset with a length ceiling matching the shared skill-name
 * contract, then a hard boundary: whitespace or end of text. The greedy
 * capture plus the lookahead means an over-long token or a `/review.foo` /
 * `/review/path` suffix never partially matches.
 */
const COMMAND_NAME = `([A-Za-z0-9][A-Za-z0-9_-]{0,119})(?=\\s|$)`;

/** Bare mode: optional leading whitespace, then `/name`. */
const BARE_COMMAND_RE = new RegExp(`^(\\s*)/${COMMAND_NAME}`);

/**
 * Mention-prefixed mode (routed group chats): whitespace and canonical
 * mention tokens only, then `/name`. Used only when the caller has proven
 * from routed message metadata that this agent is an explicit recipient.
 */
const MENTIONED_COMMAND_RE = new RegExp(`^(\\s*(?:${MENTION_TOKEN}\\s*)*)/${COMMAND_NAME}`);

/**
 * Resolve the leading slash command of user message text against the
 * registry. Ready entries rewrite to the verified effective name (identity
 * mappings return byte-identical text); unknown commands pass through so
 * local and runtime-reported Skills keep working.
 *
 * Throws ManagedSkillsUnsafeDiscoveryError when the command is
 * Cloud-configured but unavailable: passing it through could invoke an
 * identically-named unmanaged Skill, so the turn fails before any provider
 * sees it.
 */
export function rewriteTeamSkillCommand(
  content: string,
  registry: TeamSkillCommandRegistry,
  opts?: { allowMentionPrefix?: boolean },
): string {
  if (registry.size === 0) return content;
  const match = (opts?.allowMentionPrefix ? MENTIONED_COMMAND_RE : BARE_COMMAND_RE).exec(content);
  if (!match) return content;
  const [matched, prefix, name] = match;
  const target = registry.get(name ?? "");
  if (!target) return content;
  if (target.kind === "unavailable") {
    throw new ManagedSkillsUnsafeDiscoveryError(
      `Team Skill command /${name} is unavailable (${target.reason}) — refusing to hand it to the provider`,
    );
  }
  return `${prefix}/${target.effectiveName}${content.slice(matched.length)}`;
}

/**
 * Apply {@link rewriteTeamSkillCommand} to a session message's string
 * content. Non-string payloads (file/image batches) are returned as-is;
 * their rendered text never starts with a user-typed slash command.
 */
export function rewriteSessionMessageCommand<T extends { content: unknown }>(
  message: T,
  registry: TeamSkillCommandRegistry,
  opts?: { allowMentionPrefix?: boolean },
): T {
  if (registry.size === 0 || typeof message.content !== "string") return message;
  const rewritten = rewriteTeamSkillCommand(message.content, registry, opts);
  return rewritten === message.content ? message : { ...message, content: rewritten };
}
