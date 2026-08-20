/**
 * Team Skill slash-command rewrite at the shared inbound boundary.
 *
 * The Managed Skills materializer may install a Team Skill under a
 * collision-suffixed `effectiveName` (e.g. `review-first-tree`) when an
 * unmanaged local Skill already occupies the requested base slug. Web and
 * users keep addressing the Cloud-declared base command (`/review`), so
 * without a rewrite the provider would invoke the WRONG Skill — the local
 * one squatting on the base name.
 *
 * This module maps base slug → effectiveName (published by the reconciler
 * after each allocation) and rewrites the command token in user message
 * text before any provider interprets it. The Team-configured command
 * claims its base slug: once a Team Skill owns `review`, the local
 * unmanaged `/review` is no longer reachable via slash — an explicit
 * product trade-off, not an accident.
 *
 * Only strict command positions rewrite, mirroring the Web composer's
 * slash-trigger semantics: a bare `/name` at the start of the message, or
 * one following a canonical mention prefix (`@name …` tokens + whitespace)
 * for already-routed group chats. Prose (`hello /review`), paths, and
 * mid-text slashes are never touched.
 *
 * Fail-closed: if two reconciled rows ever claim the same base slug with
 * different effective names, BOTH mappings are dropped (no winner-guessing)
 * and the conflict is logged. Cloud already marks normalized duplicate
 * groups `duplicate_skill_target_name` unavailable, so a conflict here
 * means inconsistent local state — passing the text through untouched is
 * the only non-guessing behavior left.
 */

/** Base slash name → final on-disk command name for this agent's skills. */
export type TeamSkillCommandMap = ReadonlyMap<string, string>;

export const EMPTY_TEAM_SKILL_COMMAND_MAP: TeamSkillCommandMap = new Map();

type CommandMapSource = Readonly<{
  /** Cloud-declared base slug the user types. */
  requestedSlug: string;
  /** Final installed command name (may carry a collision suffix). */
  name: string;
}>;

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Build the rewrite map from reconciled Team Skills. Identity mappings
 * (no collision suffix) need no rewrite and are omitted. Rows with a
 * malformed base slug are skipped; a base slug claimed by two different
 * effective names is dropped entirely (fail closed) and reported via log.
 */
export function buildTeamSkillCommandMap(
  teamSkills: readonly CommandMapSource[],
  log?: (message: string) => void,
): TeamSkillCommandMap {
  const byBase = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const skill of teamSkills) {
    const base = skill.requestedSlug;
    if (!SAFE_SLUG.test(base) || base === skill.name) continue;
    const existing = byBase.get(base);
    if (existing !== undefined && existing !== skill.name) {
      conflicts.add(base);
      continue;
    }
    byBase.set(base, skill.name);
  }
  for (const base of conflicts) {
    byBase.delete(base);
    log?.(
      `Team Skill command map conflict for /${base}: multiple effective names — leaving the command unrewritten (fail closed)`,
    );
  }
  return byBase;
}

/** One canonical mention token (`@name`), matching the shared mention charset. */
const MENTION_TOKEN = `@[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?![A-Za-z0-9_/-])`;

/**
 * Strict command position: optional leading whitespace, then any number of
 * canonical mention tokens separated by whitespace, then `/name`. The name
 * capture is greedy over the skill-name charset, so `/review-extra` never
 * partially matches a `review` entry.
 */
const COMMAND_RE = new RegExp(String.raw`^(\s*(?:${MENTION_TOKEN}\s*)*)/([A-Za-z0-9][A-Za-z0-9_-]{0,119})`);

/**
 * Rewrite the leading slash command of user message text when its name has
 * a known effective target. Returns the input unchanged (same reference)
 * when there is nothing to rewrite: unmapped names pass through so local
 * and runtime-reported commands keep working.
 */
export function rewriteTeamSkillCommand(content: string, map: TeamSkillCommandMap): string {
  if (map.size === 0) return content;
  const match = COMMAND_RE.exec(content);
  if (!match) return content;
  const [matched, prefix, name] = match;
  const effective = map.get(name ?? "");
  if (!effective) return content;
  return `${prefix}/${effective}${content.slice(matched.length)}`;
}

/**
 * Apply {@link rewriteTeamSkillCommand} to a session message's string
 * content. Non-string payloads (file/image batches) are returned as-is;
 * their rendered text never starts with a user-typed slash command.
 */
export function rewriteSessionMessageCommand<T extends { content: unknown }>(message: T, map: TeamSkillCommandMap): T {
  if (map.size === 0 || typeof message.content !== "string") return message;
  const rewritten = rewriteTeamSkillCommand(message.content, map);
  return rewritten === message.content ? message : { ...message, content: rewritten };
}
