import { useCallback, useRef, useState } from "react";
import type { ActiveTrigger, MentionCandidate } from "./mention-autocomplete.js";
import {
  adjustTokensForEdit,
  buildDisplayMentionInsert,
  type ComposerMentionToken,
  hydrateComposerDisplay,
  normalizeTokens,
  removeDisplayRange,
  serializeComposer,
  toCanonicalOffset,
  tokenAtCaret,
} from "./mention-composer-model.js";

/**
 * React binding for the composer mention token model (see
 * `mention-composer-model.ts` for the display/canonical contract).
 *
 * The host keeps owning its CANONICAL draft state (`canonical` /
 * `onCanonicalChange`) — every existing consumer of that state (send path,
 * mention gating, draft persistence, failed-send rollback, slash-command
 * context) keeps working on routable `@<name>` text, unchanged. This hook
 * derives and owns the DISPLAY side: the textarea binds `displayText`, and
 * every edit path funnels through one of the callbacks below so tokens stay
 * consistent:
 *
 *   - `handleInput`     — textarea `onChange` (typing, paste, IME)
 *   - `replaceDisplay`  — programmatic edits in display space (slash-command
 *                         insert, the `@` toolbar button, focus priming)
 *   - `applyPick`       — mention autocomplete commit
 *   - `deleteTokenAtCaret` — atomic Backspace/Delete of a whole mention
 *
 * External canonical changes (chat switch, send clear, failed-send restore,
 * greeting prefill) re-derive the display via rehydration; the
 * `lastCanonical` ref distinguishes those from this hook's own commits.
 * `scope` identifies the draft's owner (chat id, request id, compose
 * context) and forces the same reset even when two drafts share the same
 * canonical text (ChatView is NOT remounted on chat switch).
 *
 * Deliberately minimal: no browser undo/redo state machine (a native
 * undo/redo that crosses a mention simply degrades it to plain text), no
 * roster live-revalidation, no code-range rewriting, no caret remapping.
 */
export function useMentionComposer({
  canonical,
  onCanonicalChange,
  candidates,
  scope,
}: {
  /** Canonical draft text (`@<name>` literals) owned by the host. */
  canonical: string;
  /** Persist a new canonical draft (the host's existing setDraft). */
  onCanonicalChange: (next: string) => void;
  /** Mention roster used to resolve display labels on hydrate. */
  candidates: MentionCandidate[];
  /** Draft-owner identity (chat id / request id / compose scope). A change
   *  resets the display model even when the canonical text is unchanged. */
  scope?: string | number;
}): {
  /** What the textarea shows: display names, not slugs. */
  displayText: string;
  /** Committed mention tokens over `displayText` (offset-based identity). */
  tokens: ComposerMentionToken[];
  /** Textarea `onChange`: adjust tokens through the edit, persist canonical. */
  handleInput: (nextDisplay: string) => void;
  /** Programmatic whole-text edit in display space (tokens diff-adjusted). */
  replaceDisplay: (nextDisplay: string) => void;
  /** Autocomplete commit. Returns the new display text + caret, or null. */
  applyPick: (
    trigger: ActiveTrigger,
    cursor: number,
    candidate: MentionCandidate,
  ) => { text: string; cursor: number } | null;
  /**
   * Atomic mention deletion: with a collapsed caret flush against a token,
   * remove the whole mention instead of one character. Returns the new
   * display text + caret when a token was consumed, else null (host falls
   * through to native editing).
   */
  deleteTokenAtCaret: (caret: number, dir: "back" | "forward") => { text: string; cursor: number } | null;
  /** Map a display caret to its canonical-text offset. */
  toCanonicalCursor: (displayCursor: number) => number;
} {
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;

  const [model, setModel] = useState(() => hydrateComposerDisplay(canonical, candidates));
  // Mirror of the committed model for event handlers (they may fire between
  // a state update and the render that exposes it).
  const modelRef = useRef(model);
  modelRef.current = model;
  /** Canonical text corresponding to `model` — distinguishes this hook's own
   *  commits from external replacements (chat switch, restore, clear). */
  const lastCanonicalRef = useRef(canonical);
  const scopeRef = useRef(scope);

  // Scope change (chat/request switch without remount), or external
  // canonical change (not one of our commits): rehydrate the display.
  // Adjusting state during render mirrors `useChatDraftText`'s scope-swap
  // pattern so the textarea never shows one frame of the previous scope's
  // text under the new one.
  if (scope !== scopeRef.current || canonical !== lastCanonicalRef.current) {
    scopeRef.current = scope;
    lastCanonicalRef.current = canonical;
    const hydrated = hydrateComposerDisplay(canonical, candidatesRef.current);
    modelRef.current = hydrated;
    setModel(hydrated);
  }

  const commit = useCallback(
    (nextDisplay: string, nextTokens: ComposerMentionToken[]) => {
      const tokens = normalizeTokens(nextTokens);
      const nextCanonical = serializeComposer(nextDisplay, tokens);
      lastCanonicalRef.current = nextCanonical;
      const nextModel = { text: nextDisplay, tokens };
      modelRef.current = nextModel;
      setModel(nextModel);
      onCanonicalChange(nextCanonical);
    },
    [onCanonicalChange],
  );

  const applyTextEdit = useCallback(
    (nextDisplay: string) => {
      const prev = modelRef.current;
      commit(nextDisplay, adjustTokensForEdit(prev.tokens, prev.text, nextDisplay));
    },
    [commit],
  );

  const handleInput = useCallback((nextDisplay: string) => applyTextEdit(nextDisplay), [applyTextEdit]);

  const replaceDisplay = useCallback((nextDisplay: string) => applyTextEdit(nextDisplay), [applyTextEdit]);

  const applyPick = useCallback(
    (trigger: ActiveTrigger, cursor: number, candidate: MentionCandidate) => {
      const prev = modelRef.current;
      const insert = buildDisplayMentionInsert(prev.text, trigger, cursor, candidate);
      if (!insert) return null;
      // Re-base existing tokens through the replacement (the `@<query>` run
      // never overlaps a committed token — the hosts suppress triggers over
      // tokens via `triggerOverlapsToken` — but a trigger typed flush
      // BEFORE a token must still shift it).
      const tokens = [...adjustTokensForEdit(prev.tokens, prev.text, insert.text), insert.token];
      commit(insert.text, tokens);
      return { text: insert.text, cursor: insert.cursor };
    },
    [commit],
  );

  const deleteTokenAtCaret = useCallback(
    (caret: number, dir: "back" | "forward") => {
      const prev = modelRef.current;
      const token = tokenAtCaret(prev.tokens, caret, dir);
      if (!token) return null;
      const removed = removeDisplayRange(prev.text, prev.tokens, token.start, token.end);
      commit(removed.text, removed.tokens);
      return { text: removed.text, cursor: removed.cursor };
    },
    [commit],
  );

  const toCanonicalCursor = useCallback(
    (displayCursor: number) => toCanonicalOffset(modelRef.current.text, modelRef.current.tokens, displayCursor),
    [],
  );

  return {
    displayText: model.text,
    tokens: model.tokens,
    handleInput,
    replaceDisplay,
    applyPick,
    deleteTokenAtCaret,
    toCanonicalCursor,
  };
}
