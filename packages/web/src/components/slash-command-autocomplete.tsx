import {
  type EffectiveResourceRow,
  normalizeTeamSkillTargetSlug,
  skillResourcePayloadSchema,
} from "@first-tree/shared";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * `/`-triggered slash-command popover, mirrored on the `@mention`
 * autocomplete shape. The composer owns the textarea + draft state; this
 * module only computes the active query, ranks candidates, and reports
 * keyboard intent back via `handleKey`.
 *
 * Two command kinds:
 *   - "system" — interpreted client-side (e.g. `/help`, `/clear`).
 *   - "skill"  — sent to the @mentioned agent verbatim; the agent's
 *               harness routes it through its own Skill tool.
 *
 * Per the design contract (`tmp/first-tree-slash-commands/design.html`
 * §5.1.1), the visible skill set follows the *current* @mention target.
 * When no agent is mentioned, only system commands are shown — group
 * chats require a mention to send anyway, so an unscoped skill list
 * would be unusable.
 */

export type SlashSystemCommand = {
  kind: "system";
  /** Command name without leading slash. */
  name: string;
  description: string;
};

/**
 * Minimal display descriptor for a skill row in the slash popover. The
 * daemon-reported `SkillDescriptor` satisfies it structurally, and Team
 * Skills projected from Cloud resources map onto it directly — no new
 * persisted `source` enum is needed just to render the menu.
 */
export type SlashSkillInfo = {
  /** Skill name without leading slash — the triggerable command. */
  name: string;
  /** Optional plugin namespace; rendered as `<namespace>:<name>`. */
  namespace?: string;
  description: string;
};

export type SlashSkillCommand = {
  kind: "skill";
  skill: SlashSkillInfo;
  /** Agent UUID this skill belongs to — needed by callers that want to
   *  show "from @<agent>" affordances; we drop it on insert because the
   *  caller already has the mention text in the draft. */
  agentId: string;
  /** Friendly agent label for the popover subtitle. */
  agentDisplayName: string;
};

export type SlashCommandItem = SlashSystemCommand | SlashSkillCommand;

type ActiveTrigger = {
  /** Text index of the leading `/`. */
  triggerIndex: number;
  /** The substring between `/` and the cursor, already lowercased. */
  query: string;
};

/**
 * Locate the active `/<query>` trigger. The `/` opens a slash command
 * iff it is the first char of the textarea (after optional leading
 * whitespace) — composer-wide rather than mid-word — and the query
 * accumulated since contains only command-name chars
 * (`[A-Za-z0-9_:-]`, mirroring the SkillDescriptor name + namespace
 * charset). Anything else (space, newline, punctuation) closes it.
 *
 * The "first-char only" rule is intentional. Slash commands are a
 * composer mode, not a mid-message escape — Slack and Discord use the
 * same convention. It also avoids the false positives a mid-line `/`
 * would catch (URLs, paths, dates).
 */
export function detectSlashTrigger(text: string, cursor: number): ActiveTrigger | null {
  if (cursor <= 0 || cursor > text.length) return null;

  // The slash must be at the very start of the line — that is, after a
  // run of any whitespace from position 0.
  const head = text.slice(0, cursor);
  const m = head.match(/^\s*\/([A-Za-z0-9_:-]*)$/);
  if (!m) return null;

  const triggerIndex = head.indexOf("/");
  if (triggerIndex < 0) return null;
  return { triggerIndex, query: (m[1] ?? "").toLowerCase() };
}

/**
 * Resolve the agent that should own the slash-command scope given the
 * current draft + cursor. Returns the *last* `@<name>` match strictly
 * before the cursor (most recent intent wins), or null when no token
 * resolves to a known participant. The set of "known participants" is
 * the chat's mention candidate roster — same source the `@`
 * autocomplete walks.
 *
 * Naming uses the agent slug (`name`), not the display name; matches
 * the {@link MENTION_REGEX} contract in `@first-tree/shared/mentions`.
 */
export function resolveMentionContext(
  draft: string,
  cursor: number,
  participants: Array<{ agentId: string; name: string | null; displayName: string | null }>,
): { agentId: string; displayName: string } | null {
  const byName = new Map<string, { agentId: string; displayName: string }>();
  for (const p of participants) {
    if (p.name) {
      byName.set(p.name.toLowerCase(), {
        agentId: p.agentId,
        displayName: p.displayName ?? p.name,
      });
    }
  }
  if (byName.size === 0) return null;

  // Mirror MENTION_REGEX from @first-tree/shared, but globally scanned
  // over the slice strictly before the cursor. We could import the
  // shared regex but its `g` flag carries state — a fresh local literal
  // is simpler and the source-of-truth contract is the *charset*, not
  // the binding.
  const re = /(?<![A-Za-z0-9_.@-])@([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?![A-Za-z0-9_/-])/g;
  const head = draft.slice(0, cursor);
  let lastMatch: { agentId: string; displayName: string } | null = null;
  for (const m of head.matchAll(re)) {
    const hit = byName.get((m[1] ?? "").toLowerCase());
    if (hit) lastMatch = hit;
  }
  return lastMatch;
}

/** Score a single item against the typed query. */
function scoreItem(item: SlashCommandItem, query: string): number {
  const haystack = item.kind === "system" ? item.name : commandLabelKey(item.skill);
  const lower = haystack.toLowerCase();
  if (!query) return 0;
  if (lower.startsWith(query)) return 0;
  if (lower.includes(query)) return 1;
  return Infinity;
}

/** Stable, namespace-aware label key used for matching + sorting. */
function commandLabelKey(skill: SlashSkillInfo): string {
  return skill.namespace ? `${skill.namespace}:${skill.name}` : skill.name;
}

/**
 * Project the recipient agent's effective Team Skill rows (from
 * `GET /agents/:uuid/resources` → `effective.skills`) into slash-menu
 * descriptors. Only `enabled` rows whose payload passes the shared Skill
 * Resource schema qualify — `disabled` / `replaced` / `unavailable` rows
 * and malformed payloads are skipped individually so one bad Team Skill
 * never blanks the rest of the menu.
 *
 * The slash name is derived with the same portable slug rule the Client
 * materializer uses (`normalizeTeamSkillTargetSlug`), so the menu never
 * advertises a command the runtime could not install (e.g. a display
 * name with spaces). Names that fail the slug rule are skipped. The
 * payload `namespace` is dropped on purpose: the runtime projection does
 * not carry it, so the materialized command is the plain slug.
 */
export function teamSkillRowsToSlashSkills(rows: EffectiveResourceRow[]): SlashSkillInfo[] {
  const out: SlashSkillInfo[] = [];
  for (const row of rows) {
    if (row.mode !== "enabled") continue;
    const parsed = skillResourcePayloadSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    let name: string;
    try {
      name = normalizeTeamSkillTargetSlug(parsed.data.name);
    } catch {
      continue;
    }
    out.push({ name, description: parsed.data.description });
  }
  return out;
}

/**
 * Merge the daemon-reported runtime catalog with the Team Skills
 * projected from Cloud resources. Dedup is on the case-insensitive final
 * slash literal (`namespace:name`); an exact runtime-reported command
 * always wins so the menu never shadows what the local harness actually
 * installed. Output is sorted by label key so the menu is stable.
 */
export function mergeSlashSkills(runtime: SlashSkillInfo[], team: SlashSkillInfo[]): SlashSkillInfo[] {
  const byKey = new Map<string, SlashSkillInfo>();
  for (const skill of runtime) {
    byKey.set(commandLabelKey(skill).toLowerCase(), skill);
  }
  for (const skill of team) {
    const key = commandLabelKey(skill).toLowerCase();
    if (!byKey.has(key)) byKey.set(key, skill);
  }
  return [...byKey.values()].sort((a, b) => commandLabelKey(a).localeCompare(commandLabelKey(b)));
}

export function rankSlashCommands(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  const scored: Array<{ item: SlashCommandItem; score: number }> = [];
  for (const item of items) {
    const score = scoreItem(item, query);
    if (score !== Infinity) scored.push({ item, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // System commands win ties so the small, fixed set always sits at
    // the top when both groups match.
    if (a.item.kind !== b.item.kind) return a.item.kind === "system" ? -1 : 1;
    const al = a.item.kind === "system" ? a.item.name : commandLabelKey(a.item.skill);
    const bl = b.item.kind === "system" ? b.item.name : commandLabelKey(b.item.skill);
    return al.localeCompare(bl);
  });
  return scored.slice(0, 20).map((s) => s.item);
}

type SlashInsert = {
  text: string;
  cursor: number;
  /** Kind of the picked item, so the host can decide whether to
   *  intercept (system) or just leave the literal in the textarea
   *  (skill — sent on the next Enter). */
  kind: SlashCommandItem["kind"];
};

/**
 * Build the insertion tuple for a picked item. System commands are
 * replaced with empty text (the host runs the action and clears the
 * input). Skills replace `/<query>` with `/<name> ` so the user can
 * keep typing arguments before hitting Enter.
 */
export function buildSlashInsert(
  source: string,
  trigger: ActiveTrigger,
  cursor: number,
  item: SlashCommandItem,
): SlashInsert {
  const before = source.slice(0, trigger.triggerIndex);
  const after = source.slice(cursor);

  if (item.kind === "system") {
    // System commands are intercepted by the host — clearing the
    // textarea on insert avoids the user accidentally sending the
    // literal `/help` to the recipient when the action fires.
    return { text: "", cursor: 0, kind: "system" };
  }

  const literal = `/${commandLabelKey(item.skill)}`;
  const needsSpace = after.length === 0 || !/\s/.test(after[0] ?? "");
  const tail = needsSpace ? ` ${after}` : after;
  const text = `${before}${literal}${tail}`;
  const cursorOut = before.length + literal.length + (needsSpace ? 1 : 0);
  return { text, cursor: cursorOut, kind: "skill" };
}

export type SlashKeyHandler = (e: { key: string; preventDefault: () => void }) => boolean;

export function useSlashCommand({
  value,
  cursor,
  systemCommands,
  agentSkills,
  mentionedAgent,
  onSelect,
  disabled,
}: {
  value: string;
  cursor: number;
  systemCommands: SlashSystemCommand[];
  /** Skills for the currently @-mentioned agent. Pass `null` when no
   *  agent is in scope (e.g. group chat without a recipient picked); the
   *  popover then shows only system commands. */
  agentSkills: { agentId: string; agentDisplayName: string; skills: SlashSkillInfo[] } | null;
  /** Used only for keyed memoisation — the agent ref the popover should
   *  re-rank when the @mention target flips. Pass `null` for "no
   *  mention". Identical to `agentSkills.agentId` when skills are
   *  loaded; supplied separately so a loading state still resets the
   *  highlight on switch. */
  mentionedAgent: { agentId: string; displayName: string } | null;
  onSelect: (update: SlashInsert, picked: SlashCommandItem) => void;
  disabled?: boolean;
}): {
  trigger: ActiveTrigger | null;
  results: SlashCommandItem[];
  highlightIndex: number;
  mentionedAgent: { agentId: string; displayName: string } | null;
  handleKey: SlashKeyHandler;
  pick: (item: SlashCommandItem) => void;
  dismiss: () => void;
} {
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const trigger = useMemo(() => {
    if (disabled) return null;
    return detectSlashTrigger(value, cursor);
  }, [value, cursor, disabled]);

  const items = useMemo<SlashCommandItem[]>(() => {
    const out: SlashCommandItem[] = [...systemCommands];
    if (agentSkills) {
      for (const skill of agentSkills.skills) {
        out.push({
          kind: "skill",
          skill,
          agentId: agentSkills.agentId,
          agentDisplayName: agentSkills.agentDisplayName,
        });
      }
    }
    return out;
  }, [systemCommands, agentSkills]);

  const results = useMemo(() => (trigger ? rankSlashCommands(items, trigger.query) : []), [trigger, items]);

  // Reset highlight on trigger / mention switch — re-ranking can move
  // the previously-active row out from under the highlight.
  const resetKey = trigger ? `${trigger.triggerIndex}:${trigger.query}:${mentionedAgent?.agentId ?? ""}` : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey IS the dep.
  useEffect(() => {
    setHighlightIndex(0);
  }, [resetKey]);

  useEffect(() => {
    if (trigger === null && dismissedAt !== null) setDismissedAt(null);
  }, [trigger, dismissedAt]);

  const dismissed = dismissedAt !== null && trigger !== null && dismissedAt === trigger.triggerIndex;
  const open = trigger !== null && results.length > 0 && !dismissed;

  function dismiss() {
    setDismissedAt(trigger?.triggerIndex ?? null);
  }

  function pick(item: SlashCommandItem) {
    if (!trigger) return;
    const insert = buildSlashInsert(value, trigger, cursor, item);
    onSelect(insert, item);
  }

  const handleKey: SlashKeyHandler = (e) => {
    if (!open || !trigger) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      const picked = results[highlightIndex] ?? results[0];
      if (!picked) return false;
      e.preventDefault();
      pick(picked);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
      return true;
    }
    return false;
  };

  return {
    trigger: open ? trigger : null,
    results: open ? results : [],
    highlightIndex,
    mentionedAgent,
    handleKey,
    pick,
    dismiss,
  };
}

export function SlashCommandPopover({
  trigger,
  results,
  highlightIndex,
  mentionedAgent,
  onPick,
  anchorRef,
}: {
  trigger: ActiveTrigger | null;
  results: SlashCommandItem[];
  highlightIndex: number;
  mentionedAgent: { agentId: string; displayName: string } | null;
  onPick: (item: SlashCommandItem) => void;
  anchorRef: { current: HTMLTextAreaElement | null };
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = popoverRef.current?.querySelector<HTMLElement>(`[data-slash-index="${highlightIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  if (!trigger || results.length === 0) return null;
  const anchor = anchorRef.current;
  if (!anchor) return null;

  // Group rows for visual separation — system block, then skills.
  let lastKind: SlashCommandItem["kind"] | null = null;

  return (
    <div ref={popoverRef} role="listbox" aria-label="Slash command suggestions" className="slash-popover">
      {results.map((item, i) => {
        const headerEl =
          item.kind !== lastKind ? (
            <div
              key={`hdr-${item.kind}`}
              className="px-3 py-1 text-caption mono uppercase"
              style={{ color: "var(--fg-4)" }}
            >
              {item.kind === "system" ? "System" : mentionedAgent ? `@${mentionedAgent.displayName}` : "Skills"}
            </div>
          ) : null;
        lastKind = item.kind;

        const active = i === highlightIndex;
        const label = item.kind === "system" ? `/${item.name}` : `/${commandLabelKey(item.skill)}`;
        const description = item.kind === "system" ? item.description : item.skill.description;

        return (
          // `label` is unique within a single popover render: system
          // names are a hand-curated allowlist that cannot collide with
          // skills, and the skill list is deduped upstream by the
          // case-insensitive slash literal in `mergeSlashSkills`.
          <div key={`${item.kind}-${label}`}>
            {headerEl}
            <button
              type="button"
              role="option"
              aria-selected={active}
              data-slash-index={i}
              // Hover discloses the full description — the visible subtitle
              // truncates at 110 chars, so long Claude Code skills (some are
              // multi-paragraph) need a way to reveal the rest without
              // committing the pick first.
              title={description}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(item);
              }}
              className="slash-option flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left"
              style={{
                background: active ? "var(--bg-hover)" : "transparent",
                color: "var(--fg)",
                border: "none",
                cursor: "pointer",
              }}
            >
              <span className="mono font-medium text-body">{label}</span>
              <span className="text-caption" style={{ color: "var(--fg-3)" }}>
                {description.length > 110 ? `${description.slice(0, 110)}…` : description}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
