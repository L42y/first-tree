import { isImageBatchRefContent, type TeamSkillInvocation } from "@first-tree/shared";
import { ManagedSkillsUnsafeDiscoveryError } from "./managed-skills.js";

/**
 * Pre-provider refusal for a strict slash command whose Team Skill identity
 * is UNKNOWN: no registry published yet, or the message's server-stamped
 * config version differs from the registry's proven version. This is the
 * recoverable case — custody is retained and the session recovers through a
 * fresh handler that republishes a matching registry.
 *
 * An authoritatively UNAVAILABLE Team command (registry published, explicit
 * unavailable target) does NOT throw: the rewrite emits an inert runtime
 * notice instead, so the turn settles normally instead of hot-looping on an
 * identity that cannot change by retrying.
 *
 * Extends ManagedSkillsUnsafeDiscoveryError so existing unsafe-discovery
 * guards keep matching, while custody/settlement boundaries can recognize it
 * explicitly as "provider never saw this input — safe to retry" via
 * {@link isTeamSkillCommandUnavailableError}.
 */
export class TeamSkillCommandUnavailableError extends ManagedSkillsUnsafeDiscoveryError {}

export function isTeamSkillCommandUnavailableError(error: unknown): error is TeamSkillCommandUnavailableError {
  return error instanceof TeamSkillCommandUnavailableError;
}

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
 * runtime-reported Skills. A base slug claimed twice in one publication
 * fails closed into `unavailable`. A Team Skill's base command takes
 * precedence over a local unmanaged Skill of the same name (an explicit
 * product trade-off).
 *
 * Outcomes for a strict command position:
 *   - ready → rewrite to the verified effective name (identity mappings
 *     return byte-identical text);
 *   - unavailable → replace the command with an inert First Tree runtime
 *     notice that keeps no slash command token, tells the agent to explain
 *     the unavailability to the user, and forbids invoking a same-named
 *     local Skill. The turn then settles normally;
 *   - unknown registry (`null` — unpublished or version-fenced) → throw
 *     TeamSkillCommandUnavailableError; custody retains the message and a
 *     fresh handler republishes before redelivery;
 *   - unknown command in a published registry → pass through unchanged.
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
  | Readonly<{ kind: "ready"; effectiveName: string; resourceId: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Base slash name → its resolved Team Skill command target. */
export type TeamSkillCommandRegistry = ReadonlyMap<string, TeamSkillCommandTarget>;

export const EMPTY_TEAM_SKILL_COMMAND_REGISTRY: TeamSkillCommandRegistry = new Map();

export type TeamSkillCommandEntry = Readonly<{
  /** Cloud-declared base slug the user types. */
  requestedSlug: string;
  /** The exact Team resource this identity belongs to (marker cross-check). */
  resourceId: string;
  /** Final installed command name, or null when no verified target exists. */
  effectiveName: string | null;
}>;

const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Build the session registry from a complete, authoritative command list.
 * Identity mappings (no collision suffix) are recorded as ready too —
 * every known Team base slug is explicit, so "unknown" provably means "not
 * a Team Skill". Rows with a malformed base slug never had a typable
 * command and are skipped. ANY repeated base slug — even identical rows —
 * is inconsistent input and fails closed into `unavailable`, reported via
 * log.
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
    if (registry.has(base)) {
      conflicts.add(base);
      continue;
    }
    registry.set(
      base,
      entry.effectiveName === null
        ? { kind: "unavailable", reason: "no verified installed target" }
        : { kind: "ready", effectiveName: entry.effectiveName, resourceId: entry.resourceId },
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
 * The inert replacement for an authoritatively unavailable Team command.
 * Carries the bare Skill name (never the `/name` literal) so the agent can
 * tell the user exactly which Skill is down, while keeping NO slash
 * command token the provider could parse as an invocation.
 */
function buildUnavailableNotice(name: string, reason: string, argsTail: string): string {
  const lines = [
    `[First Tree runtime] The user tried to invoke the configured Team Skill "${name}", which is currently unavailable`,
    `(${reason}). Do NOT invoke any slash command or a same-named local Skill on their behalf.`,
    `Briefly explain to the user that the Team Skill "${name}" is temporarily unavailable and its command cannot run right now.`,
  ];
  const args = argsTail.trim();
  if (args.length > 0) lines.push(`The arguments they typed after the command were: ${args}`);
  return lines.join(" ");
}

/**
 * Resolve the leading slash command of user message text against the
 * registry. Ready entries rewrite to the verified effective name (identity
 * mappings return byte-identical text); unknown commands pass through so
 * local and runtime-reported Skills keep working. Registry lookup folds
 * ASCII case (`/REVIEW` resolves the `review` entry), matching the
 * portable case-fold the materializer applies on disk — a case variant
 * must not bypass a Team Skill's claim on its base slug and land on a
 * same-named local Skill on a case-insensitive filesystem. Unmapped
 * commands return the original text untouched, case included.
 *
 * An explicit `unavailable` target produces an inert runtime notice (see
 * {@link buildUnavailableNotice}) — the deterministic terminal boundary
 * for a command that cannot become ready by retrying.
 *
 * Throws TeamSkillCommandUnavailableError only while NO proven registry
 * covers the message (`null` — unpublished, or fenced by a config-version
 * mismatch): an unproven slash command must not fall through to a possibly
 * identically-named unmanaged Skill, and retry-after-recovery can heal it.
 * Ordinary text without a strict command position is never blocked.
 */
export function rewriteTeamSkillCommand(
  content: string,
  registry: TeamSkillCommandRegistry | null,
  opts?: { allowMentionPrefix?: boolean },
): string {
  const match = (opts?.allowMentionPrefix ? MENTIONED_COMMAND_RE : BARE_COMMAND_RE).exec(content);
  if (!match) return content;
  const [matched, prefix, name] = match;
  if (registry === null) {
    throw new TeamSkillCommandUnavailableError(
      `Team Skill command registry is not published yet — refusing to hand /${name} to the provider`,
    );
  }
  const target = registry.get((name ?? "").toLowerCase());
  if (!target) return content;
  if (target.kind === "unavailable") {
    return `${prefix}${buildUnavailableNotice(name ?? "", target.reason, content.slice(matched.length))}`;
  }
  return `${prefix}/${target.effectiveName}${content.slice(matched.length)}`;
}

/**
 * The inert replacement for a strict slash command while the registry is
 * UNRESOLVED: preparation has completed (more than once, across a fresh
 * handler) without proving any command identity, so no recovery cycle can
 * change the outcome. Carries no Skill name and no slash token.
 */
/**
 * The inert replacement for a strict slash command whose message was
 * stamped against an OLDER config version than the published registry.
 * Recovery can never republish a historical registry, so the command
 * fails closed immediately — no restart, no slash token.
 */
export const TEAM_SKILL_COMMAND_STALE_VERSION_NOTICE =
  "[First Tree runtime] The user tried to invoke a Team Skill command, but the configuration that command " +
  "was sent against has been superseded by a newer one, so the command was not run. Do NOT invoke any " +
  "slash command or a same-named local Skill on their behalf. Briefly explain to the user that the " +
  "command is out of date and ask them to send it again if they still need it.";

/**
 * The inert replacement for a strict slash command sent to MULTIPLE routed
 * recipient agents. Each recipient would resolve the command against its
 * own registry — and an unknown base would fall through to that agent's
 * local Skill — so no agent may execute it at all.
 */
export const TEAM_SKILL_COMMAND_AMBIGUOUS_RECIPIENT_NOTICE =
  "[First Tree runtime] The user invoked a Team Skill command while addressing multiple agents, so it is " +
  "not clear which agent should run it. Do NOT invoke any slash command or a same-named local Skill on " +
  "their behalf. Briefly explain to the user that the command was not run and ask them to address a " +
  "single agent explicitly.";

export const TEAM_SKILL_COMMAND_UNRESOLVED_NOTICE =
  "[First Tree runtime] The user tried to invoke a Team Skill command, but this agent's skill configuration " +
  "could not be verified right now. Do NOT invoke any slash command or a same-named local Skill on their " +
  "behalf. Briefly explain to the user that the Team Skill configuration is temporarily unverifiable and " +
  "the command cannot run.";

/**
 * Replace a strict-position slash command with an inert notice, preserving
 * only the mention prefix. Used for the bounded terminal boundary of an
 * unresolvable command — the alternative (throwing) would loop recovery
 * forever when no future publication can prove an identity.
 */
export function rewriteSessionMessageCommandToNotice<T extends { content: unknown }>(
  message: T,
  notice: string,
  opts?: { allowMentionPrefix?: boolean },
): T {
  const replace = (text: string): string => {
    const match = (opts?.allowMentionPrefix ? MENTIONED_COMMAND_RE : BARE_COMMAND_RE).exec(text);
    if (!match) return text;
    const [matched, prefix] = match;
    return `${prefix}${notice}${text.slice(matched.length).trimStart() ? ` ${text.slice(matched.length).trimStart()}` : ""}`;
  };
  if (typeof message.content === "string") {
    const rewritten = replace(message.content);
    return rewritten === message.content ? message : { ...message, content: rewritten };
  }
  if (isImageBatchRefContent(message.content) && typeof message.content.caption === "string") {
    const caption = replace(message.content.caption);
    if (caption === message.content.caption) return message;
    return { ...message, content: { ...message.content, caption } };
  }
  return message;
}

/**
 * Apply {@link rewriteTeamSkillCommand} to a session message. String
 * content rewrites directly; an image-batch payload rewrites its string
 * caption with identical semantics (the composer persists "caption +
 * images" as one `format: "file"` message, and the caption is exactly
 * where a user-typed slash command lives). Single image refs, batches
 * without a caption, and unknown structures pass through unchanged.
 * Everything clones immutably: the persisted/original message keeps the
 * base literal.
 */
export function rewriteSessionMessageCommand<T extends { content: unknown }>(
  message: T,
  registry: TeamSkillCommandRegistry | null,
  opts?: { allowMentionPrefix?: boolean },
): T {
  if (typeof message.content === "string") {
    const rewritten = rewriteTeamSkillCommand(message.content, registry, opts);
    return rewritten === message.content ? message : { ...message, content: rewritten };
  }
  if (isImageBatchRefContent(message.content) && typeof message.content.caption === "string") {
    const caption = rewriteTeamSkillCommand(message.content.caption, registry, opts);
    if (caption === message.content.caption) return message;
    return { ...message, content: { ...message.content, caption } };
  }
  return message;
}

/** Strict command name in one text payload, or null when there is none. */
function strictCommandNameIn(text: string, opts?: { allowMentionPrefix?: boolean }): string | null {
  const match = (opts?.allowMentionPrefix ? MENTIONED_COMMAND_RE : BARE_COMMAND_RE).exec(text);
  return match?.[2] ?? null;
}

/** Strict command name anywhere in a session message payload (text or image caption). */
function messageStrictCommandName(content: unknown, opts?: { allowMentionPrefix?: boolean }): string | null {
  if (typeof content === "string") return strictCommandNameIn(content, opts);
  if (isImageBatchRefContent(content) && typeof content.caption === "string") {
    return strictCommandNameIn(content.caption, opts);
  }
  return null;
}

/**
 * Resolve a session message against the SERVER-OWNED Team Skill invocation
 * marker persisted in its metadata. The marker is proof that the leading
 * command was chosen from a specific agent's Team Skill menu — so unlike
 * an unmarked strict command it may NEVER fall through to a same-named
 * local Skill. The full validation chain (any failure → inert notice with
 * no slash literal):
 *
 *   - marker absent from this call's input (`invocation === null` because
 *     the key was present but malformed, or of an unknown marker version)
 *     → unresolved notice;
 *   - `recipientAgentId` differs from the current agent (misrouted copy)
 *     → unresolved notice;
 *   - `configVersion` differs from the published registry's proven version
 *     (the config the command was chosen against has been superseded —
 *     the delayed-delivery case) → stale-version notice;
 *   - the registry has no READY row for `requestedSlug`, or the ready
 *     row's `resourceId` differs (the resource was deleted and its slug
 *     later reused by a NEW resource — the old invocation must not
 *     execute the new resource) → "removed or renamed" notice;
 *   - otherwise the exact validated row rewrites the command to its
 *     verified effective name.
 *
 * Returns null when the marker does not apply to this message at all —
 * the text has no strict command position, or no longer starts with the
 * marked command (hand-edited after selection); the caller then falls
 * back to the ordinary registry path. Everything clones immutably.
 */
export function rewriteSessionMessageCommandForInvocation<T extends { content: unknown }>(
  message: T,
  registry: TeamSkillCommandRegistry,
  invocation: TeamSkillInvocation | null,
  opts: { allowMentionPrefix?: boolean; currentAgentId: string; registryVersion: number },
): T | null {
  const name = messageStrictCommandName(message.content, opts);
  if (name === null) return null;
  if (invocation === null) {
    // Key present but unparseable (or an unknown marker version): Team
    // intent exists but is unverifiable — never a local fall-through.
    return rewriteSessionMessageCommandToNotice(message, TEAM_SKILL_COMMAND_UNRESOLVED_NOTICE, opts);
  }
  if (name.toLowerCase() !== invocation.requestedSlug.toLowerCase()) return null;
  if (invocation.recipientAgentId !== opts.currentAgentId) {
    return rewriteSessionMessageCommandToNotice(message, TEAM_SKILL_COMMAND_UNRESOLVED_NOTICE, opts);
  }
  if (invocation.configVersion !== opts.registryVersion) {
    return rewriteSessionMessageCommandToNotice(message, TEAM_SKILL_COMMAND_STALE_VERSION_NOTICE, opts);
  }
  const target = registry.get(invocation.requestedSlug.toLowerCase());
  if (target !== undefined && target.kind === "unavailable") {
    // Configured but not installed: the ordinary unavailable notice.
    return rewriteSessionMessageCommand(message, registry, opts);
  }
  if (target === undefined || target.resourceId !== invocation.resourceId) {
    const removed: TeamSkillCommandRegistry = new Map([
      [
        invocation.requestedSlug.toLowerCase(),
        {
          kind: "unavailable",
          reason: "the Team Skill was removed or renamed after this command was sent",
        },
      ],
    ]);
    return rewriteSessionMessageCommand(message, removed, opts);
  }
  return rewriteSessionMessageCommand(message, registry, opts);
}
