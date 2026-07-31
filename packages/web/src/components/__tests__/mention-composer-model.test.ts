import { describe, expect, it } from "vitest";
import type { MentionCandidate } from "../mention-autocomplete.js";
import {
  adjustTokensForEdit,
  buildDisplayMentionInsert,
  type ComposerMentionToken,
  composerOverlaySegments,
  diffTextEdit,
  hydrateComposerDisplay,
  mentionDisplayLiteral,
  normalizeTokens,
  removeDisplayRange,
  serializeComposer,
  toCanonicalOffset,
  tokenAtCaret,
  triggerOverlapsToken,
} from "../mention-composer-model.js";

/** Test helper — mirrors mention-autocomplete.test.ts's `cand`. */
function cand(partial: Partial<MentionCandidate> & Pick<MentionCandidate, "agentId">): MentionCandidate {
  return {
    name: partial.agentId,
    displayName: partial.agentId,
    managedByMe: false,
    ...partial,
  };
}

const alice = cand({ agentId: "a1", name: "alice-w", displayName: "Alice Wang" });
const bob = cand({ agentId: "a2", name: "bob", displayName: "Bob" });

/** Token over `@Alice Wang` at offset 0 (label length 11). */
const aliceToken: ComposerMentionToken = { agentId: "a1", name: "alice-w", start: 0, end: 11 };

describe("mentionDisplayLiteral", () => {
  it("prefers the display name", () => {
    expect(mentionDisplayLiteral(alice)).toBe("@Alice Wang");
  });

  it("falls back to the slug when displayName is null or blank", () => {
    expect(mentionDisplayLiteral(cand({ agentId: "a3", name: "carol", displayName: null }))).toBe("@carol");
    expect(mentionDisplayLiteral(cand({ agentId: "a3", name: "carol", displayName: "  " }))).toBe("@carol");
  });

  it("returns null without a slug — a mention needs a routing target", () => {
    expect(mentionDisplayLiteral(cand({ agentId: "a4", name: null, displayName: "Nameless" }))).toBeNull();
  });
});

describe("buildDisplayMentionInsert", () => {
  it("inserts the DISPLAY literal and records the canonical slug in the token", () => {
    const source = "hi @al";
    const result = buildDisplayMentionInsert(source, { triggerIndex: 3 }, source.length, alice);
    expect(result).toEqual({
      text: "hi @Alice Wang ",
      cursor: "hi @Alice Wang ".length,
      token: { agentId: "a1", name: "alice-w", start: 3, end: 3 + "@Alice Wang".length },
    });
  });

  it("keeps existing trailing whitespace instead of doubling it", () => {
    const source = "hi @al world";
    const result = buildDisplayMentionInsert(source, { triggerIndex: 3 }, 6, bob);
    expect(result?.text).toBe("hi @Bob world");
    expect(result?.cursor).toBe("hi @Bob".length);
  });

  it("returns null when the candidate has no slug", () => {
    const result = buildDisplayMentionInsert("@", { triggerIndex: 0 }, 1, cand({ agentId: "x", name: null }));
    expect(result).toBeNull();
  });
});

describe("serializeComposer", () => {
  it("replaces token spans with canonical `@<name>`, leaving other text untouched", () => {
    expect(serializeComposer("@Alice Wang please review", [aliceToken])).toBe("@alice-w please review");
  });

  it("serializes multiple tokens right-to-left so offsets stay valid", () => {
    const text = "@Alice Wang and @Bob";
    const tokens: ComposerMentionToken[] = [aliceToken, { agentId: "a2", name: "bob", start: 16, end: 20 }];
    expect(serializeComposer(text, tokens)).toBe("@alice-w and @bob");
  });

  it("passes literally-typed `@<name>` through byte-for-byte (still routable)", () => {
    expect(serializeComposer("ping @alice-w", [])).toBe("ping @alice-w");
  });

  it("guards the canonical boundary when text is typed flush against a token", () => {
    // The user typed `x` immediately before/after the display label — the
    // token survives (boundary edit), but naive serialization would emit
    // `x@alice-w` / `@alice-wx`, which MENTION_REGEX rejects. The canonical
    // form gains a separating space; the display text is untouched.
    const text = "x@Alice Wangy";
    const token: ComposerMentionToken = { agentId: "a1", name: "alice-w", start: 1, end: 12 };
    expect(serializeComposer(text, [token])).toBe("x @alice-w y");
  });
});

describe("hydrateComposerDisplay", () => {
  it("renders resolved mentions as display literals with tokens", () => {
    const { text, tokens } = hydrateComposerDisplay("hi @alice-w !", [alice]);
    expect(text).toBe("hi @Alice Wang !");
    expect(tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 3, end: 14 }]);
  });

  it("round-trips: serialize(hydrate(canonical)) === canonical", () => {
    const canonical = "hi @alice-w and @bob, look";
    const hydrated = hydrateComposerDisplay(canonical, [alice, bob]);
    expect(serializeComposer(hydrated.text, hydrated.tokens)).toBe(canonical);
  });

  it("keeps unresolved/ghost `@tokens` as plain text (safe degradation)", () => {
    const { text, tokens } = hydrateComposerDisplay("hi @ghost", [alice]);
    expect(text).toBe("hi @ghost");
    expect(tokens).toEqual([]);
  });

  it("falls back to the slug label when the display name is empty", () => {
    const { text, tokens } = hydrateComposerDisplay("@carol hi", [
      cand({ agentId: "a3", name: "carol", displayName: null }),
    ]);
    expect(text).toBe("@carol hi");
    expect(tokens).toEqual([{ agentId: "a3", name: "carol", start: 0, end: 6 }]);
  });

  it("keeps `@<name>` inside code fences as plain text (segmentMentions contract)", () => {
    const { tokens } = hydrateComposerDisplay("use `@alice-w` literally", [alice]);
    expect(tokens).toEqual([]);
  });
});

describe("diffTextEdit", () => {
  it("reports a pure insertion", () => {
    expect(diffTextEdit("ac", "abc")).toEqual({ start: 1, removedEnd: 1, insertedLength: 1 });
  });

  it("reports a deletion", () => {
    expect(diffTextEdit("abc", "ac")).toEqual({ start: 1, removedEnd: 2, insertedLength: 0 });
  });

  it("reports a replacement", () => {
    expect(diffTextEdit("abc", "aXc")).toEqual({ start: 1, removedEnd: 2, insertedLength: 1 });
  });
});

describe("adjustTokensForEdit", () => {
  const text = "hi @Alice Wang !";

  it("shifts tokens after an insertion before them", () => {
    const token: ComposerMentionToken = { ...aliceToken, start: 3, end: 14 };
    const next = adjustTokensForEdit([token], text, `hey, ${text}`);
    expect(next).toEqual([{ ...token, start: 8, end: 19 }]);
  });

  it("keeps tokens before the edit untouched", () => {
    const token: ComposerMentionToken = { ...aliceToken, start: 3, end: 14 };
    expect(adjustTokensForEdit([token], text, `${text} more`)).toEqual([token]);
  });

  it("keeps the token on a pure insertion flush against either boundary", () => {
    const token: ComposerMentionToken = { ...aliceToken, start: 3, end: 14 };
    // Typing `x` immediately BEFORE the label…
    expect(adjustTokensForEdit([token], text, "hi x@Alice Wang !")).toEqual([{ ...token, start: 4, end: 15 }]);
    // …and immediately AFTER it.
    expect(adjustTokensForEdit([token], text, "hi @Alice Wangx !")).toEqual([token]);
  });

  it("drops the token when the edit touches its interior", () => {
    const token: ComposerMentionToken = { ...aliceToken, start: 3, end: 14 };
    // Backspace inside the label: `@Alice Wan`
    expect(adjustTokensForEdit([token], text, "hi @Alice Wan !")).toEqual([]);
    // Typing inside the label.
    expect(adjustTokensForEdit([token], text, "hi @Alicex Wang !")).toEqual([]);
    // Selection delete across part of the label.
    expect(adjustTokensForEdit([token], text, "hi @A !")).toEqual([]);
  });

  it("drops only the tokens an edit actually overlaps", () => {
    const full = "@Alice Wang and @Bob ";
    const tokens: ComposerMentionToken[] = [aliceToken, { agentId: "a2", name: "bob", start: 16, end: 20 }];
    const next = adjustTokensForEdit(tokens, full, "@Alice Wang ");
    expect(next).toEqual([aliceToken]);
  });
});

describe("normalizeTokens", () => {
  it("sorts by start and drops overlapping spans (first wins)", () => {
    const a: ComposerMentionToken = { agentId: "a1", name: "a", start: 5, end: 9 };
    const b: ComposerMentionToken = { agentId: "a2", name: "b", start: 0, end: 4 };
    const overlap: ComposerMentionToken = { agentId: "a3", name: "c", start: 3, end: 6 };
    expect(normalizeTokens([a, b, overlap])).toEqual([b, a]);
  });
});

describe("triggerOverlapsToken", () => {
  // "@Bob rest" with a committed token over `@Bob` (0..4).
  const tokens: ComposerMentionToken[] = [{ agentId: "a2", name: "bob", start: 0, end: 4 }];

  it("suppresses a trigger at the token end (pick that reused existing whitespace)", () => {
    expect(triggerOverlapsToken({ triggerIndex: 0 }, 4, tokens)).toBe(true);
  });

  it("suppresses a trigger inside the token (user clicked into the label)", () => {
    expect(triggerOverlapsToken({ triggerIndex: 0 }, 2, tokens)).toBe(true);
  });

  it("allows a trigger after the token", () => {
    expect(triggerOverlapsToken({ triggerIndex: 5 }, 8, tokens)).toBe(false);
  });

  it("allows a trigger flush before the token", () => {
    const later: ComposerMentionToken[] = [{ agentId: "a2", name: "bob", start: 3, end: 7 }];
    expect(triggerOverlapsToken({ triggerIndex: 0 }, 3, later)).toBe(false);
  });
});

describe("removeDisplayRange + tokenAtCaret", () => {
  const text = "hi @Alice Wang !";
  const token: ComposerMentionToken = { ...aliceToken, start: 3, end: 14 };

  it("finds the token flush against a collapsed caret", () => {
    expect(tokenAtCaret([token], 14, "back")).toEqual(token);
    expect(tokenAtCaret([token], 3, "forward")).toEqual(token);
    expect(tokenAtCaret([token], 13, "back")).toBeNull();
    expect(tokenAtCaret([token], 4, "forward")).toBeNull();
  });

  it("removes a whole token atomically", () => {
    const removed = removeDisplayRange(text, [token], 3, 14);
    expect(removed).toEqual({ text: "hi  !", cursor: 3, tokens: [] });
  });
});

describe("toCanonicalOffset", () => {
  // display: "hi @Alice Wang !" (token 3..14) ↔ canonical: "hi @alice-w !" (token 3..11)
  const text = "hi @Alice Wang !";
  const token: ComposerMentionToken = { ...aliceToken, start: 3, end: 14 };

  it("maps offsets before the token unchanged", () => {
    expect(toCanonicalOffset(text, [token], 3)).toBe(3);
  });

  it("maps offsets after the token by the length delta", () => {
    expect(toCanonicalOffset(text, [token], 16)).toBe(13);
  });

  it("clamps an offset inside the token to just past its canonical form", () => {
    expect(toCanonicalOffset(text, [token], 8)).toBe(11);
  });

  it("stays consistent with serializeComposer's boundary padding", () => {
    const padded = "x@Alice Wangy";
    const t: ComposerMentionToken = { agentId: "a1", name: "alice-w", start: 1, end: 12 };
    // canonical: "x @alice-w y" — the end of the display string maps to the
    // end of the canonical string, pads included.
    expect(toCanonicalOffset(padded, [t], padded.length)).toBe("x @alice-w y".length);
  });
});

describe("composerOverlaySegments", () => {
  const participants = [
    { agentId: "a1", name: "alice-w" },
    { agentId: "a2", name: "bob" },
  ];

  it("chips both committed tokens and literally-typed `@<name>`", () => {
    const text = "@Alice Wang said hi @bob";
    const segments = composerOverlaySegments(text, [aliceToken], participants);
    expect(segments).toEqual([
      { kind: "token", value: "@Alice Wang", name: "alice-w", agentId: "a1" },
      { kind: "text", value: " said hi " },
      { kind: "mention", value: "@bob", name: "bob", agentId: "a2" },
    ]);
  });

  it("never double-chips `@word`-shaped text inside a display label", () => {
    // displayName "@bob" would look like a typed mention to the segmenter.
    const tricky = cand({ agentId: "a9", name: "tricky", displayName: "@bob fan" });
    const { text, tokens } = hydrateComposerDisplay("@tricky hi", [tricky]);
    expect(text).toBe("@@bob fan hi");
    const segments = composerOverlaySegments(text, tokens, participants);
    expect(segments.filter((s) => s.kind !== "text")).toEqual([
      { kind: "token", value: "@@bob fan", name: "tricky", agentId: "a9" },
    ]);
  });

  it("keeps typed `@<name>` inside code fences un-chipped", () => {
    const segments = composerOverlaySegments("use `@bob`", [], participants);
    expect(segments).toEqual([{ kind: "text", value: "use `@bob`" }]);
  });

  it("matches segmentMentions exactly when no tokens exist", () => {
    const segments = composerOverlaySegments("hi @bob", [], participants);
    expect(segments).toEqual([
      { kind: "text", value: "hi " },
      { kind: "mention", value: "@bob", name: "bob", agentId: "a2" },
    ]);
  });
});
