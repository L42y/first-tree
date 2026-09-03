import type { MeChatRow } from "@first-tree/shared";

import type { ChatCronJob } from "./chats-api";

/**
 * Slack's quick views: a row of tiles above the conversation list, each a
 * standing pile of work with a live count. The value is not navigation — it is
 * that the piles are *named and counted*, so "what is waiting on me" stops
 * being something you reconstruct by scrolling.
 */
export type QuickViewKey = "catch-up" | "drafts" | "schedules" | "github";

export type QuickView = {
  key: QuickViewKey;
  label: string;
  /** Ionicons glyph. */
  icon: string;
  count: number;
  /** Slack's second line: "1 new", "0 items". */
  subtitle: string;
  route: string;
};

/** Catch Up counts what is waiting on you: open questions, then unread mentions. */
export function catchUpCount(rows: readonly MeChatRow[]): number {
  return rows.filter((row) => row.openRequestCount > 0 || row.unreadMentionCount > 0).length;
}

/**
 * Followed GitHub / GitLab work. The chat rows already carry `source` and
 * `entityType`, so this costs nothing extra: a PR or Issue followed into a
 * chat IS a chat with that origin.
 */
export function forgeChats(rows: readonly MeChatRow[]): MeChatRow[] {
  return rows.filter((row) => row.source === "github" || row.source === "gitlab");
}

/**
 * Active schedules first, ordered by what runs next — the only order that
 * answers "what happens soon". Paused ones keep their place at the bottom,
 * visible because a paused schedule is a thing you meant to run.
 */
export function orderSchedules(jobs: readonly ChatCronJob[]): ChatCronJob[] {
  const rank = (job: ChatCronJob) => (job.state === "active" ? 0 : 1);
  const next = (job: ChatCronJob) => {
    const at = Date.parse(job.nextRunAt ?? "");
    return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
  };
  return [...jobs].sort((a, b) => rank(a) - rank(b) || next(a) - next(b) || a.name.localeCompare(b.name));
}

/** Slack's subtitle: a count and its unit, or the empty state in the same shape. */
export function countLabel(count: number, unit: "new" | "items" | "watching" | "active"): string {
  return `${count} ${unit}`;
}

export function buildQuickViews(input: {
  rows: readonly MeChatRow[];
  draftCount: number;
  scheduleCount: number | null;
}): QuickView[] {
  const catchUp = catchUpCount(input.rows);
  return [
    {
      key: "catch-up",
      label: "Catch Up",
      icon: "layers-outline",
      count: catchUp,
      subtitle: countLabel(catchUp, "new"),
      route: "/attention",
    },
    {
      key: "drafts",
      label: "Drafts",
      icon: "create-outline",
      count: input.draftCount,
      subtitle: countLabel(input.draftCount, "items"),
      route: "/drafts",
    },
    {
      key: "schedules",
      label: "Schedules",
      icon: "time-outline",
      count: input.scheduleCount ?? 0,
      // Until the fan-out lands, saying "0 active" would be a claim we cannot
      // make; an em dash says "not counted yet" instead of lying.
      subtitle: input.scheduleCount === null ? "—" : countLabel(input.scheduleCount, "active"),
      route: "/schedules",
    },
    {
      key: "github",
      label: "Code",
      icon: "git-branch-outline",
      count: forgeChats(input.rows).length,
      subtitle: countLabel(forgeChats(input.rows).length, "watching"),
      route: "/forge",
    },
  ];
}
