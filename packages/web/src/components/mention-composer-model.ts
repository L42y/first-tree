import { type MentionParticipant, segmentMentions } from "@first-tree/shared";
import type { MentionCandidate } from "./mention-autocomplete.js";

/**
 * Composer mention token model — the display/canonical split behind every
 * `@mention`-capable body input (chat composer, new-chat draft, ask answer).
 *
 * Product contract (first-tree-context agent-naming: `displayName` is the
 * human-facing label, `name` is the immutable routing slug):
 *
 *   - The textarea holds DISPLAY text: a picked mention appears as
 *     `@<displayName>` (falling back to `@<name>` when the display name is
 *     blank). Because the textarea content IS what the user sees, the
 *     caret, selection, IME composition, and the transparent-text mirror
 *     overlay all stay glyph-aligned by construction — no overlay
 *     re-typesetting that would push the caret off the visible glyphs.
 *   - Tokens carry the routing identity (`agentId` + canonical `name`)
 *     out-of-band as offset ranges over the display text. Serialization
 *     back to the canonical wire/persistence form replaces each token span
 *     with `@<name>` by OFFSET, never by parsing the mutable, possibly
 *     duplicated, possibly space-containing display name.
 *   - A `@<name>` typed (or pasted) literally without a picker commit stays
 *     plain text; it still routes because canonical serialization leaves it
 *     untouched and extractMentions resolves it — same as before this model
 *     existed.
 *
 * Scope is deliberately minimal: picked mentions are atomic tokens, edits
 * outside them rebase them, edits through them degrade them to plain text.
 * No browser-history state machine, no roster live-revalidation, no
 * code-range rewriting, no clipboard rewriting.
 *
 * Everything in this file is pure so the edit/adjust/serialize rules are
 * unit-testable without a DOM. The React binding lives in
 * `use-mention-composer.ts`.
 */

/** One committed mention: routing identity + its span in the DISPLAY text. */
export type ComposerMentionToken = {
  agentId: string;
  /** Canonical immutable slug (no leading `@`). Routing truth. */
  name: string;
  /** `[start, end)` offsets in the display text, covering the full `@…` literal. */
  start: number;
  end: number;
};

/**
 * The visible literal for a picked candidate: `@<displayName>`, falling back
 * to `@<name>` when the display name is missing or blank (an empty display
 * name must never render as a bare `@`).
 */
export function mentionDisplayLiteral(candidate: Pick<MentionCandidate, "name" | "displayName">): string | null {
  if (!candidate.name) return null;
  const label =
    candidate.displayName && candidate.displayName.trim().length > 0 ? candidate.displayName : candidate.name;
  return `@${label}`;
}

type ActiveTriggerLike = {
  triggerIndex: number;
};

export type DisplayMentionInsert = {
  /** New display text after inserting the mention. */
  text: string;
  /** Caret offset into the new display text (after the trailing space). */
  cursor: number;
  /** The committed token, spanning exactly the inserted `@…` literal. */
  token: ComposerMentionToken;
};

/**
 * Build the display-side insertion tuple for a picked candidate. Mirrors
 * `buildMentionInsert`'s layout contract (replace the `@<query>` run under
 * the caret, one trailing space unless whitespace already follows) but the
 * inserted literal is the display name and the routing identity rides along
 * as a token. Returns null when the candidate has no `name` — a mention
 * requires a slug target.
 */
export function buildDisplayMentionInsert(
  source: string,
  trigger: ActiveTriggerLike,
  cursor: number,
  candidate: MentionCandidate,
): DisplayMentionInsert | null {
  if (!candidate.name) return null;
  const literal = mentionDisplayLiteral(candidate);
  if (!literal) return null;
  const before = source.slice(0, trigger.triggerIndex);
  const after = source.slice(cursor);
  const needsSpace = after.length === 0 || !/\s/.test(after[0] ?? "");
  const tail = needsSpace ? ` ${after}` : after;
  const text = `${before}${literal}${tail}`;
  const token: ComposerMentionToken = {
    agentId: candidate.agentId,
    name: candidate.name,
    start: before.length,
    end: before.length + literal.length,
  };
  return { text, cursor: token.end + (needsSpace ? 1 : 0), token };
}

type TextEdit = {
  /** Start of the replaced range in the OLD text. */
  start: number;
  /** End (exclusive) of the replaced range in the OLD text. */
  removedEnd: number;
  /** Replacement length in the new text. */
  insertedLength: number;
};

/**
 * Minimal single-range diff between two textarea values (common prefix +
 * common suffix). Textarea edits — typing, paste, cut, native undo, IME
 * composition updates — are all single-range, so this shape covers every
 * `onChange` the composer can receive. Ambiguous edits (e.g. inserting a
 * repeated char at a repetition boundary) resolve to the leftmost
 * interpretation, which is safe: worst case a token overlapping the
 * ambiguity is dropped (mention degrades to plain text), never re-pointed
 * at a different agent.
 */
export function diffTextEdit(prev: string, next: string): TextEdit {
  let start = 0;
  const maxStart = Math.min(prev.length, next.length);
  while (start < maxStart && prev[start] === next[start]) start++;
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }
  return { start, removedEnd: prevEnd, insertedLength: nextEnd - start };
}

/**
 * Re-base tokens through an edit. A token fully before the edit is
 * unchanged; fully after shifts by the length delta; anything the edit
 * touches (typing inside a display label, deleting across part of it,
 * pasting over it) is DROPPED — the mention degrades to the plain text the
 * user now sees, which is the only honest outcome once the visible literal
 * no longer matches what the token claims. Pure insertions exactly at a
 * token boundary keep the token (boundary edits don't alter the literal);
 * canonical serialization guards the routing boundary that creates (see
 * {@link serializeComposer}).
 */
export function adjustTokensForEdit(
  tokens: ComposerMentionToken[],
  prev: string,
  next: string,
): ComposerMentionToken[] {
  if (tokens.length === 0 || prev === next) return tokens;
  const edit = diffTextEdit(prev, next);
  const delta = edit.insertedLength - (edit.removedEnd - edit.start);
  const out: ComposerMentionToken[] = [];
  for (const t of tokens) {
    if (t.end <= edit.start) {
      // Edit starts at/after the token end (including a pure insertion
      // flush against it): the literal is untouched.
      out.push(t);
      continue;
    }
    if (t.start >= edit.removedEnd) {
      // Edit ends at/before the token start (including a pure insertion
      // flush against it): the token shifts right with the text after it.
      out.push({ ...t, start: t.start + delta, end: t.end + delta });
    }
    // Overlapping edit: the visible literal changed, so the token's claim
    // ("this span routes to agentId") is no longer true. Drop it.
  }
  return out;
}

/**
 * Defensive invariant for the token array handed to the serializer /
 * overlay / caret mapping: sorted by start, no overlapping spans (the
 * first span wins).
 */
export function normalizeTokens(tokens: ComposerMentionToken[]): ComposerMentionToken[] {
  const sorted = [...tokens].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: ComposerMentionToken[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && t.start < last.end) continue;
    out.push(t);
  }
  return out;
}

/** Chars that would break a canonical `@<name>` token's left boundary. */
const CANONICAL_LEFT_BREAK = /[A-Za-z0-9_.@-]/;
/** Chars that would break a canonical `@<name>` token's right boundary. */
const CANONICAL_RIGHT_BREAK = /[A-Za-z0-9_/-]/;

/**
 * Serialize display text + tokens back to the canonical wire/persistence
 * form: every token span becomes `@<name>`, everything else passes through
 * byte-for-byte (so a literally-typed `@<name>` keeps routing exactly as
 * before). Tokens are applied right-to-left so earlier offsets stay valid.
 *
 * Boundary guard: a token edited flush against identifier chars (the user
 * typed `x` immediately before/after the display label — allowed, since
 * boundary insertions keep the token) would serialize to `x@name` / `@namex`,
 * which `MENTION_REGEX` deliberately rejects and the mention would silently
 * stop routing. Emit a separating space in the CANONICAL form only; the
 * display text is untouched. One harmless space on the wire beats a lost
 * wake-up.
 */
export function serializeComposer(text: string, tokens: ComposerMentionToken[]): string {
  if (tokens.length === 0) return text;
  const sorted = [...tokens].sort((a, b) => b.start - a.start);
  let out = text;
  for (const t of sorted) {
    const before = out.slice(0, t.start);
    const after = out.slice(t.end);
    const leftPad = before.length > 0 && CANONICAL_LEFT_BREAK.test(before[before.length - 1] ?? "") ? " " : "";
    const rightPad = after.length > 0 && CANONICAL_RIGHT_BREAK.test(after[0] ?? "") ? " " : "";
    out = `${before}${leftPad}@${t.name}${rightPad}${after}`;
  }
  return out;
}

export type HydratedComposer = {
  /** Display text: resolved mentions rendered as `@<displayName>`. */
  text: string;
  tokens: ComposerMentionToken[];
};

/**
 * Rehydrate display state from canonical text (draft restore, failed-send
 * rollback, greeting prefill). Resolved `@<name>` mentions become display
 * literals + tokens; unresolved/ghost tokens stay plain text (they keep
 * routing through the canonical fallback path if they later resolve).
 * Candidates that haven't loaded yet degrade safely to the `@<name>`
 * literal — never dropped, never re-pointed.
 */
export function hydrateComposerDisplay(canonical: string, candidates: MentionCandidate[]): HydratedComposer {
  if (canonical.length === 0) return { text: "", tokens: [] };
  const participants: MentionParticipant[] = candidates.map((c) => ({ agentId: c.agentId, name: c.name }));
  const byId = new Map(candidates.map((c) => [c.agentId, c] as const));
  const segments = segmentMentions(canonical, participants);
  let text = "";
  const tokens: ComposerMentionToken[] = [];
  for (const seg of segments) {
    if (seg.kind !== "mention") {
      text += seg.value;
      continue;
    }
    const candidate = byId.get(seg.agentId);
    const literal = candidate ? (mentionDisplayLiteral(candidate) ?? `@${seg.name}`) : `@${seg.name}`;
    tokens.push({ agentId: seg.agentId, name: seg.name, start: text.length, end: text.length + literal.length });
    text += literal;
  }
  return { text, tokens };
}

/**
 * A `@<query>` autocomplete trigger is only honest when it sits OUTSIDE
 * every committed token. `detectMentionTrigger` is purely lexical, so a
 * display label without spaces (e.g. `@Bob`) would re-open the picker when
 * the caret lands at/inside the token — clicking into a committed mention,
 * or right after a pick that reused existing trailing whitespace. Re-picking
 * from that state would rewrite part of the label and stack a duplicate
 * overlapping token. Suppress any trigger whose `[triggerIndex, cursor)`
 * range intersects a token span; the hosts feed this the model's tokens so
 * the popover, keyboard hijack, and NewChatDraft's server-side search all
 * agree a committed mention is not a query.
 */
export function triggerOverlapsToken(
  trigger: ActiveTriggerLike,
  cursor: number,
  tokens: ReadonlyArray<Pick<ComposerMentionToken, "start" | "end">>,
): boolean {
  return tokens.some((t) => trigger.triggerIndex < t.end && cursor > t.start);
}

/**
 * The token flush against a collapsed caret, for atomic deletion:
 * `"back"` (Backspace) finds the token ENDING at the caret, `"forward"`
 * (Delete) the token STARTING at it. Returns null when no token touches the
 * caret, so the host falls through to native single-char deletion.
 */
export function tokenAtCaret(
  tokens: ComposerMentionToken[],
  caret: number,
  dir: "back" | "forward",
): ComposerMentionToken | null {
  for (const t of tokens) {
    if (dir === "back" && t.end === caret) return t;
    if (dir === "forward" && t.start === caret) return t;
  }
  return null;
}

export type RemovedRange = {
  text: string;
  cursor: number;
  tokens: ComposerMentionToken[];
};

/**
 * Delete `[start, end)` from the display text and re-base tokens through
 * the deletion (via the same adjust rules as a typed edit, so a partially
 * covered token degrades to plain text).
 */
export function removeDisplayRange(
  text: string,
  tokens: ComposerMentionToken[],
  start: number,
  end: number,
): RemovedRange {
  const next = `${text.slice(0, start)}${text.slice(end)}`;
  return { text: next, cursor: start, tokens: adjustTokensForEdit(tokens, text, next) };
}

/**
 * Map a display-text caret offset to the equivalent offset in the canonical
 * serialization — needed by consumers that reason about the canonical draft
 * (e.g. slash-command mention context, which scans `@<name>` tokens before
 * the caret). A caret inside a token maps to just past the token's
 * canonical form: the mention reads as "before the caret", matching the
 * visible reality that the user committed it.
 */
export function toCanonicalOffset(text: string, tokens: ComposerMentionToken[], displayOffset: number): number {
  let offset = displayOffset;
  const sorted = [...tokens].sort((a, b) => a.start - b.start);
  for (const t of sorted) {
    if (t.start >= displayOffset) break;
    const displayLen = t.end - t.start;
    let canonicalLen = 1 + t.name.length;
    // Keep the mapping consistent with serializeComposer's boundary pads.
    const prevChar = t.start > 0 ? text[t.start - 1] : undefined;
    const nextChar = t.end < text.length ? text[t.end] : undefined;
    if (prevChar && CANONICAL_LEFT_BREAK.test(prevChar)) canonicalLen += 1;
    if (nextChar && CANONICAL_RIGHT_BREAK.test(nextChar)) canonicalLen += 1;
    if (displayOffset >= t.end) {
      offset += canonicalLen - displayLen;
    } else {
      // Inside the token: clamp to just past its canonical form.
      offset += canonicalLen - (displayOffset - t.start);
    }
  }
  return offset;
}

export type ComposerOverlaySegment =
  | { kind: "text"; value: string }
  | { kind: "mention"; value: string; name: string; agentId: string }
  | { kind: "token"; value: string; name: string; agentId: string };

/**
 * Segments for the mirror overlay: committed tokens (from the model) plus
 * literally-typed `@<name>` runs (resolved via `segmentMentions` so code
 * fences / email addresses keep the existing no-chip contract). Token
 * ranges win on overlap — a display label can itself contain `@word`-shaped
 * text, which must not double-chip inside the token.
 */
export function composerOverlaySegments(
  text: string,
  tokens: ComposerMentionToken[],
  participants: MentionParticipant[],
): ComposerOverlaySegment[] {
  if (tokens.length === 0) return segmentMentions(text, participants);
  // Split the text around token spans and run the shared segmenter on each
  // gap, so code-fence / email / boundary suppression keeps the exact
  // segmentMentions semantics without us re-deriving offsets. A display
  // label containing `@word`-shaped text can never double-chip, because the
  // segmenter never sees the token span.
  const sorted = [...tokens].sort((a, b) => a.start - b.start);
  const out: ComposerOverlaySegment[] = [];
  let cursor = 0;
  for (const t of sorted) {
    if (t.start > cursor) {
      out.push(...segmentMentions(text.slice(cursor, t.start), participants));
    }
    out.push({ kind: "token", value: text.slice(t.start, t.end), name: t.name, agentId: t.agentId });
    cursor = t.end;
  }
  if (cursor < text.length) {
    out.push(...segmentMentions(text.slice(cursor), participants));
  }
  return out;
}
