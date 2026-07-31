import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Restored/direct-loaded drafts can hydrate before the roster arrives
 * (raw `@<name>` on screen). While the model is still purely a hydrate —
 * no local commit since — a later candidate roster re-resolves the SAME
 * canonical text into display labels + tokens (agentIds unchanged). The
 * first local edit/pick/delete revokes that eligibility so a late roster
 * never rewrites the user's text under them.
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
  /** Eligibility for the candidate-arrival label upgrade: true only while
   *  the model is purely a hydrate of the current canonical (initial mount,
   *  external canonical replace, scope reset). Any local commit
   *  (typing, pick, atomic delete, programmatic edit) revokes it, so a
   *  late roster never rewrites text the user is editing or tokens they
   *  already picked. */
  const upgradeEligibleRef = useRef(true);
  const scopeRef = useRef(scope);

  // Scope change (chat/request switch without remount), or external
  // canonical change (not one of our commits): rehydrate the display.
  // Adjusting state during render mirrors `useChatDraftText`'s scope-swap
  // pattern so the textarea never shows one frame of the previous scope's
  // text under the new one.
  if (scope !== scopeRef.current || canonical !== lastCanonicalRef.current) {
    scopeRef.current = scope;
    lastCanonicalRef.current = canonical;
    upgradeEligibleRef.current = true;
    const hydrated = hydrateComposerDisplay(canonical, candidatesRef.current);
    modelRef.current = hydrated;
    setModel(hydrated);
  }

  // Candidate-arrival label upgrade: a restored/direct-loaded draft is
  // hydrated with whatever roster is available (often empty on first
  // paint), leaving raw `@<name>` literals on screen. While the model is
  // still purely that hydrate (upgradeEligibleRef), a roster arriving —
  // in one batch or several — re-resolves the SAME canonical text into
  // display labels + tokens. Canonical content and agentIds never change
  // (rehydrate is a pure projection; serialize round-trips). Acceptance
  // is MONOTONE: a rehydrate is applied only when every previously
  // resolved token's identity survives in order (new tokens may be
  // inserted) AND at least one new token appears — candidate removals,
  // replacements, and displayName-only changes leave the model untouched
  // (eligibility stays open for a later genuinely-additive roster). This
  // is deliberately NOT live-roster revalidation. The JSON signature dep
  // is collision-free (displayName may contain any character) and avoids
  // re-running on array-identity-only changes.
  const candidatesSignature = useMemo(
    () => JSON.stringify(candidates.map((c) => [c.agentId, c.name ?? null, c.displayName ?? null])),
    [candidates],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: candidatesSignature IS the dep — its value controls when we re-resolve; the body reads the roster via candidatesRef.
  useEffect(() => {
    if (!upgradeEligibleRef.current) return;
    const hydrated = hydrateComposerDisplay(lastCanonicalRef.current, candidatesRef.current);
    setModel((prev) => {
      const identity = (t: ComposerMentionToken): string => JSON.stringify([t.agentId, t.name]);
      const prevIds = prev.tokens.map(identity);
      const nextIds = hydrated.tokens.map(identity);
      // prevIds must be an ordered subsequence of nextIds, and the token
      // set must strictly grow.
      let i = 0;
      for (const id of nextIds) {
        if (i < prevIds.length && id === prevIds[i]) i++;
      }
      const preserved = i === prevIds.length;
      if (!preserved || nextIds.length <= prevIds.length) return prev;
      modelRef.current = hydrated;
      return hydrated;
    });
  }, [candidatesSignature]);

  const commit = useCallback(
    (nextDisplay: string, nextTokens: ComposerMentionToken[]) => {
      const tokens = normalizeTokens(nextTokens);
      const nextCanonical = serializeComposer(nextDisplay, tokens);
      lastCanonicalRef.current = nextCanonical;
      // Any local commit revokes the label-upgrade eligibility: from here
      // on, the text belongs to the user's editing, not to a hydrate.
      upgradeEligibleRef.current = false;
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
