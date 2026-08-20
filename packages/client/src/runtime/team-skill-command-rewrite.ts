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
 * The registry is published per session after every settled skills
 * projection and holds the COMPLETE desired set, not just the successful
 * mappings: a Cloud-configured base slug with no verified target is
 * unavailable, and typing it fails closed (pre-provider) instead of
 * falling through to a possibly identically-named unmanaged Skill.
 * Successful mappings rewrite the command token; a Team Skill's base
 * command takes precedence over a local unmanaged Skill of the same name
 * (an explicit product trade-off).
 *
 * Only strict command positions rewrite, mirroring the Web composer's
 * slash-trigger semantics: a bare `/name` at the start of the message, or
 * — only when the caller proves the message's routed metadata mentions
 * this agent — one following a canonical mention prefix (`@name …`
 * tokens + whitespace). The command name must be followed by whitespace
 * or end-of-text. Prose (`hello /review`), paths, `/review.extra`, and
 * mention-prefixed text without routed mention metadata are never
 * touched.
 *
 * Fail-closed: if two entries ever claim the same base slug with
 * different effective names, BOTH mappings are dropped (no
 * winner-guessing) and the base lands in `unavailable`. Cloud already
 * marks normalized duplicate groups `duplicate_skill_target_name`
 * unavailable, so a conflict here means inconsistent local state.
 */

export type TeamSkillCommandRegistry = Readonly<{
  /** Base slash name → final on-disk command name for verified installs. */
  rewrite: ReadonlyMap<string, string>;
  /** Base slash names that are Cloud-configured but have no verified target. */
  unavailable: ReadonlySet<string>;
}>;

export const EMPTY_TEAM_SKILL_COMMAND_REGISTRY: TeamSkillCommandRegistry = {
  rewrite: new Map(),
  unavailable: new Set(),
};

export type TeamSkillCommandEntry = Readonly<{
  /** Cloud-declared base slug the user types. */
  requestedSlug: string;
  /** Final installed command name, or null when no verified target exists. */
  effectiveName: string | null;
}>;

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Build the session registry from a complete, authoritative command list.
 * Identity mappings (no collision suffix) need no rewrite and are omitted
 * from `rewrite`. Rows with a malformed base slug are skipped. A base slug
 * claimed by two different effective names fails closed into
 * `unavailable` and is reported via log.
 */
export function buildTeamSkillCommandRegistry(
  entries: readonly TeamSkillCommandEntry[],
  log?: (message: string) => void,
): TeamSkillCommandRegistry {
  const rewrite = new Map<string, string>();
  const unavailable = new Set<string>();
  const conflicts = new Set<string>();
  for (const entry of entries) {
    const base = entry.requestedSlug;
    if (!SAFE_SLUG.test(base)) continue;
    if (entry.effectiveName === null) {
      unavailable.add(base);
      continue;
    }
    if (base === entry.effectiveName) continue;
    const existing = rewrite.get(base);
    if (existing !== undefined && existing !== entry.effectiveName) {
      conflicts.add(base);
      continue;
    }
    rewrite.set(base, entry.effectiveName);
  }
  for (const base of conflicts) {
    rewrite.delete(base);
    unavailable.add(base);
    log?.(
      `Team Skill command registry conflict for /${base}: multiple effective names — the command now fails closed instead of guessing`,
    );
  }
  return { rewrite, unavailable };
}

/** One canonical mention token (`@name`), matching the shared mention charset. */
const MENTION_TOKEN = `@[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![A-Za-z0-9_/-])`;

/** Command name charset, then a hard boundary: whitespace or end of text. */
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
 * Rewrite the leading slash command of user message text when its name has
 * a verified effective target. Returns the input unchanged (same
 * reference) when there is nothing to rewrite; unmapped names pass through
 * so local and runtime-reported commands keep working.
 *
 * Throws ManagedSkillsUnsafeDiscoveryError when the command is
 * Cloud-configured but has no verified target: passing it through could
 * invoke an identically-named unmanaged Skill, so the turn fails before
 * any provider sees it.
 */
export function rewriteTeamSkillCommand(
  content: string,
  registry: TeamSkillCommandRegistry,
  opts?: { allowMentionPrefix?: boolean },
): string {
  const match = (opts?.allowMentionPrefix ? MENTIONED_COMMAND_RE : BARE_COMMAND_RE).exec(content);
  if (!match) return content;
  const [matched, prefix, name] = match;
  const command = name ?? "";
  if (registry.unavailable.has(command)) {
    throw new ManagedSkillsUnsafeDiscoveryError(
      `Team Skill command /${command} has no verified installed target — refusing to hand it to the provider`,
    );
  }
  const effective = registry.rewrite.get(command);
  if (!effective) return content;
  return `${prefix}/${effective}${content.slice(matched.length)}`;
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
  if (typeof message.content !== "string") return message;
  const rewritten = rewriteTeamSkillCommand(message.content, registry, opts);
  return rewritten === message.content ? message : { ...message, content: rewritten };
}
