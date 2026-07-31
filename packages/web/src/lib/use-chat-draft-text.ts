import { type Dispatch, type SetStateAction, useCallback, useLayoutEffect, useRef, useState } from "react";
import { chatDraftScope, loadDraft, saveDraft } from "./draft-store.js";

type ScopedDraft = {
  scope: string;
  text: string;
};

function loadScopedDraft(scope: string): ScopedDraft {
  return { scope, text: loadDraft(scope)?.text ?? "" };
}

/**
 * In-chat composer draft text, persisted per user + chat in browser-local
 * storage.
 *
 * A drop-in for `useState("")`: returns `[draft, setDraft]`. On top of plain
 * state it (a) seeds the initial value from the stored draft for this user +
 * chat, (b) writes every change back to storage, and (c) swaps to the target
 * chat's stored draft when the chat (or the signed-in user) changes.
 *
 * The swap matters because `ChatView` is NOT remounted on chat switch (the
 * chat-detail query just refetches by id) — without it the single `draft`
 * state would leak one chat's unsent text into the next chat. An empty draft
 * removes its stored entry, so a successful send (which sets the draft to "")
 * also clears the cache. Keys are user-scoped so a shared browser never
 * restores another account's unsent text.
 */
export function useChatDraftText(userId: string | null, chatId: string): [string, Dispatch<SetStateAction<string>>] {
  const scope = chatDraftScope(userId, chatId);
  const [storedDraft, setStoredDraft] = useState<ScopedDraft>(() => loadScopedDraft(scope));
  const draft = storedDraft.scope === scope ? storedDraft : loadScopedDraft(scope);
  const committedDraftRef = useRef(draft);

  // ChatView is reconciled in place when chatId changes. Adjust the tagged
  // state during render so React restarts this component before committing its
  // children; the previous chat's draft is never exposed under the new scope.
  if (draft !== storedDraft) {
    setStoredDraft(draft);
  }

  // A concurrent render may be abandoned. Only a committed render may change
  // which scope a setter is allowed to expose in the live composer.
  useLayoutEffect(() => {
    committedDraftRef.current = draft;
  }, [draft]);

  const setDraft = useCallback<Dispatch<SetStateAction<string>>>(
    (next) => {
      const committedDraft = committedDraftRef.current;
      const currentText = committedDraft.scope === scope ? committedDraft.text : (loadDraft(scope)?.text ?? "");
      const nextText = typeof next === "function" ? next(currentText) : next;
      if (nextText === currentText) return;

      // A send started in one chat may settle after ChatView has switched to
      // another. Persist through the setter's captured scope, then update live
      // state only while that scope is still active.
      saveDraft(scope, { text: nextText });
      if (committedDraftRef.current.scope !== scope) return;

      const nextDraft = { scope, text: nextText };
      committedDraftRef.current = nextDraft;
      setStoredDraft(nextDraft);
    },
    [scope],
  );

  return [draft.text, setDraft];
}
