import type { ListMeChatsResponse, MeChatRow } from "@first-tree/shared";
import { stripInlineMarkdown } from "../../lib/strip-inline-markdown.js";
import { rowAttentionReason } from "../workspace/conversations/group-rows.js";

export type MobileChatSignalTone = "needs-you" | "error" | "unread" | "working" | "idle";

export type MobileChatSignal = {
  tone: MobileChatSignalTone;
  label: string;
  rank: number;
  attention: boolean;
};

export type MobileCardContent =
  | {
      kind: "summary";
      primary: string;
      secondary: null;
    }
  | {
      kind: "dynamic";
      primary: string;
      secondary: string;
    };

export function mobileChatSignal(row: MeChatRow): MobileChatSignal {
  const attentionReason = rowAttentionReason(row);
  if (attentionReason === "failed") {
    return {
      tone: "error",
      label: row.failedAgentIds.length === 1 ? "Run failed" : `${row.failedAgentIds.length} runs failed`,
      rank: 0,
      attention: true,
    };
  }
  if (attentionReason === "request") {
    return {
      tone: "needs-you",
      label: row.openRequestCount === 1 ? "Needs your answer" : `${row.openRequestCount} questions`,
      rank: 1,
      attention: true,
    };
  }
  if (row.chatHasExplicitMentionToMe || row.unreadMentionCount > 0) {
    return {
      tone: "unread",
      label:
        row.unreadMentionCount === 0 || row.unreadMentionCount === 1 ? "Unread" : `${row.unreadMentionCount} unread`,
      rank: 2,
      attention: false,
    };
  }
  if (row.busyAgentIds.length > 0 || row.liveActivity !== null) {
    return {
      tone: "working",
      label: row.liveActivity?.label ?? "Working now",
      rank: 2,
      attention: false,
    };
  }
  return {
    tone: "idle",
    label: row.membershipKind === "watching" ? "Watching" : "Recent",
    rank: 2,
    attention: false,
  };
}

/** Keep the complete Chat list's established, quieter status language. */
export function mobileChatListSignal(row: MeChatRow): MobileChatSignal {
  const signal = mobileChatSignal(row);
  switch (signal.tone) {
    case "error":
      return { ...signal, label: row.failedAgentIds.length === 1 ? "Failed" : `${row.failedAgentIds.length} failed` };
    case "needs-you":
      return { ...signal, label: row.openRequestCount === 1 ? "Needs answer" : `${row.openRequestCount} questions` };
    case "working":
      return { ...signal, label: row.liveActivity?.label ?? "Working" };
    case "unread":
    case "idle":
      return signal;
  }
}

export function mobileChatPreview(row: MeChatRow): string {
  const raw = row.description?.trim() || row.lastMessagePreview?.trim();
  // Card previews are a one-line glance, not a rendered surface: peel inline
  // markdown so `**Task:**` / `` `code` `` don't leak their literal markers.
  // Fall back on the *stripped* value — a preview that is only markup (e.g. an
  // `![](url)` image) strips to empty and must show the placeholder, not blank.
  const stripped = raw ? stripInlineMarkdown(raw) : "";
  return stripped || "No messages yet.";
}

/**
 * Allocate Chat card content by state.
 *
 * Chat status is carried by the row icon, not by moving or replacing the chat
 * preview. Unread and working rows may add one compact evidence line, while
 * request/recovery rows retain the same summary shape as ordinary chats.
 */
export function mobileCardContent(row: MeChatRow): MobileCardContent {
  const signal = mobileChatSignal(row);
  const summary = cleanPreview(row.description);
  const latest = cleanPreview(row.lastMessagePreview);
  const fallback = summary || latest || "No messages yet.";

  if (signal.tone === "unread") {
    const currentState = summary || latest || "No summary yet.";
    const newEvidence = latest && latest !== currentState ? latest : signal.label;
    return {
      kind: "dynamic",
      primary: currentState,
      secondary: `New · ${newEvidence}`,
    };
  }

  if (signal.tone === "working") {
    const activity = cleanPreview(row.liveActivity?.detail) || row.liveActivity?.label || "Working now";
    return {
      kind: "dynamic",
      primary: fallback,
      secondary: `Working · ${activity}`,
    };
  }

  return {
    kind: "summary",
    primary: fallback,
    secondary: null,
  };
}

/**
 * Materialize the server's complete pin projection for mobile lists. Pins can
 * sit beyond the finite recency page, so they enter before the additive rows
 * and are de-duplicated by chat id. Need you is request-level and has its own
 * queue; recovery/open-ask/unread status never changes chat ordering.
 */
export function mobileRowsFromList(data: ListMeChatsResponse | undefined): MeChatRow[] {
  if (!data) return [];
  const seen = new Set<string>();
  return [...data.priorityRows.pinned, ...data.rows].filter((row) => {
    if (seen.has(row.chatId)) return false;
    seen.add(row.chatId);
    return true;
  });
}

export function sortMobileChats(rows: readonly MeChatRow[]): MeChatRow[] {
  return [...rows].sort((a, b) => {
    const bucketA = a.pinnedAt ? 0 : 1;
    const bucketB = b.pinnedAt ? 0 : 1;
    const bucketDelta = bucketA - bucketB;
    if (bucketDelta !== 0) return bucketDelta;
    return timestampValue(b.activityAt ?? b.lastMessageAt) - timestampValue(a.activityAt ?? a.lastMessageAt);
  });
}

export function countUnreadRows(rows: readonly MeChatRow[]): number {
  return rows.reduce((total, row) => total + (row.unreadMentionCount > 0 ? 1 : 0), 0);
}

function cleanPreview(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  return stripInlineMarkdown(trimmed).replace(/\s+/g, " ").trim();
}

function timestampValue(iso: string | null): number {
  if (!iso) return 0;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}
