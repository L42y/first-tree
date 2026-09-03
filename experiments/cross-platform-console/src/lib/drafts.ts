import { getItem, setItem } from "./storage";

const DRAFTS_KEY = "chat-drafts:v1";

/**
 * Unsent composer text, kept on the device. Drafts are deliberately local:
 * an unsent message is a private half-thought, and syncing it would publish
 * something the author never chose to send.
 */
export type Draft = {
  chatId: string;
  title: string;
  text: string;
  updatedAt: number;
};

type DraftMap = Record<string, Draft>;

export async function loadDrafts(): Promise<Draft[]> {
  const stored = (await getItem<DraftMap>(DRAFTS_KEY)) ?? {};
  return sortDrafts(Object.values(stored).filter(isUsableDraft));
}

export async function saveDraft(chatId: string, title: string, text: string): Promise<void> {
  const stored = (await getItem<DraftMap>(DRAFTS_KEY)) ?? {};
  const next = applyDraft(stored, chatId, title, text);
  await setItem<DraftMap>(DRAFTS_KEY, next);
}

export async function clearDraft(chatId: string): Promise<void> {
  await saveDraft(chatId, "", "");
}

/** A draft with nothing in it is not a draft; writing one deletes the entry. */
export function applyDraft(stored: DraftMap, chatId: string, title: string, text: string): DraftMap {
  const next = { ...stored };
  if (text.trim().length === 0) {
    delete next[chatId];
    return next;
  }
  next[chatId] = { chatId, title, text, updatedAt: Date.now() };
  return next;
}

export function isUsableDraft(draft: Draft | undefined | null): draft is Draft {
  return Boolean(draft && typeof draft.chatId === "string" && typeof draft.text === "string" && draft.text.trim());
}

/** Most recently touched first — a draft you just left is the one you want. */
export function sortDrafts(drafts: readonly Draft[]): Draft[] {
  return [...drafts].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** One line of the draft, for a list row. */
export function draftPreview(draft: Draft, max = 80): string {
  const flat = draft.text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
