// @vitest-environment happy-dom

import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ActiveTrigger, type MentionCandidate, useMentionAutocomplete } from "../mention-autocomplete.js";
import { useMentionComposer } from "../use-mention-composer.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * DOM-level contract for the display/canonical split every mention-capable
 * composer runs on (chat composer, new-chat draft, ask answer):
 *
 *   1. picking a candidate shows `@<displayName>` in the textarea while the
 *      host's canonical state receives `@<name>` + the original agentId;
 *   2. edits around a committed mention keep its routing token — edits
 *      THROUGH it degrade it to plain text; Backspace flush against it
 *      deletes the whole token atomically and re-pins the DOM caret;
 *   3. a committed token is never re-detected as an autocomplete trigger
 *      (click inside the label, caret at its end after a whitespace-reusing
 *      pick, repeated Enter/pick);
 *   4. external canonical replacement (draft restore / send clear / failed
 *      send rollback) and scope switches rehydrate the display side;
 *   5. duplicate display names keep the picked agentId — identity lives in
 *      the token, never in the label.
 */

const alice: MentionCandidate = { agentId: "a1", name: "alice-w", displayName: "Alice Wang", managedByMe: false };
const bob: MentionCandidate = { agentId: "a2", name: "bob", displayName: "Bob", managedByMe: false };

type Harness = {
  /** Latest canonical text the host received. */
  canonical: string;
  pick: (candidate: MentionCandidate) => void;
  composer: ReturnType<typeof useMentionComposer> | null;
  mentionTrigger: ActiveTrigger | null;
  setCanonical: (next: string) => void;
  setCandidates: (next: MentionCandidate[]) => void;
  setScope: (next: string) => void;
};

function Composer({ harness }: { harness: Harness }) {
  const [canonical, setCanonical] = useState("");
  const [candidates, setCandidates] = useState<MentionCandidate[]>([alice, bob]);
  const [scope, setScope] = useState("scope-a");
  const [cursor, setCursor] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composer = useMentionComposer({ canonical, onCanonicalChange: setCanonical, candidates, scope });
  const mention = useMentionAutocomplete({
    value: composer.displayText,
    cursor,
    candidates,
    tokens: composer.tokens,
    onSelect: (_update, candidate, trigger) => {
      const applied = composer.applyPick(trigger, cursor, candidate);
      if (applied) setCursor(applied.cursor);
    },
  });
  harness.canonical = canonical;
  harness.composer = composer;
  harness.mentionTrigger = mention.trigger;
  harness.pick = (candidate) => mention.pick(candidate);
  harness.setCanonical = setCanonical;
  harness.setCandidates = setCandidates;
  harness.setScope = setScope;
  return (
    <textarea
      data-ta
      ref={taRef}
      value={composer.displayText}
      onChange={(e) => {
        composer.handleInput(e.target.value);
        setCursor(e.target.selectionStart ?? e.target.value.length);
      }}
      onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? composer.displayText.length)}
      onKeyDown={(e) => {
        if (e.key === "Backspace" || e.key === "Delete") {
          const el = taRef.current;
          if (el && el.selectionStart === el.selectionEnd) {
            const removed = composer.deleteTokenAtCaret(
              el.selectionStart ?? cursor,
              e.key === "Backspace" ? "back" : "forward",
            );
            if (removed) {
              e.preventDefault();
              setCursor(removed.cursor);
              // Same re-pin the hosts apply: the native deletion that would
              // have moved the DOM caret was preventDefaulted.
              requestAnimationFrame(() => {
                const ta = taRef.current;
                if (!ta) return;
                ta.setSelectionRange(removed.cursor, removed.cursor);
              });
              return;
            }
          }
        }
        mention.handleKey(e);
      }}
    />
  );
}

let container: HTMLElement;
let root: Root;
let harness: Harness;
let originalRaf: typeof globalThis.requestAnimationFrame;
let rafQueue: FrameRequestCallback[];

beforeEach(() => {
  // Queue rAF callbacks so the caret re-pin runs AFTER React commits the
  // new value — the real ordering the hosts rely on (an immediate stub
  // would pin the selection before the value update and lose it).
  originalRaf = globalThis.requestAnimationFrame;
  rafQueue = [];
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    rafQueue.push(callback);
    return rafQueue.length;
  };
});

function flushRaf() {
  const queue = rafQueue.splice(0);
  act(() => {
    for (const cb of queue) cb(0);
  });
}

function mount() {
  harness = {
    canonical: "",
    pick: () => {},
    composer: null,
    mentionTrigger: null,
    setCanonical: () => {},
    setCandidates: () => {},
    setScope: () => {},
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Composer harness={harness} />));
}

const ta = (): HTMLTextAreaElement => {
  const el = container.querySelector<HTMLTextAreaElement>("[data-ta]");
  if (!el) throw new Error("textarea not mounted");
  return el;
};

/** Simulate a real textarea edit the way the browser reports it. */
function type(text: string, caret?: number) {
  const el = ta();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, text);
  el.setSelectionRange(caret ?? text.length, caret ?? text.length);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(k: string) {
  const el = ta();
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function selectCaret(at: number) {
  const el = ta();
  el.setSelectionRange(at, at);
  act(() => {
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
}

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  act(() => root.unmount());
  container.remove();
});

describe("useMentionComposer", () => {
  it("shows `@<displayName>` on pick while canonical state gets `@<name>` + agentId", () => {
    mount();
    type("@ali");
    act(() => harness.pick(alice));
    expect(ta().value).toBe("@Alice Wang ");
    expect(harness.canonical).toBe("@alice-w ");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 0, end: 11 }]);
  });

  it("keeps the route when typing around a committed mention", () => {
    mount();
    type("@ali");
    act(() => harness.pick(alice));
    type("@Alice Wang please review");
    expect(harness.canonical).toBe("@alice-w please review");
    // Typing BEFORE the token shifts it; canonical keeps one clean mention.
    type("hey @Alice Wang please review");
    expect(harness.canonical).toBe("hey @alice-w please review");
  });

  it("degrades a mention to plain text when the edit saws through its label", () => {
    mount();
    type("@ali");
    act(() => harness.pick(alice));
    // Backspace inside the label (native path — caret not flush at the end).
    type("@Alice Wan");
    expect(harness.canonical).toBe("@Alice Wan");
    expect(harness.composer?.tokens).toEqual([]);
  });

  it("deletes a whole mention atomically on Backspace at its end and re-pins the DOM caret", () => {
    mount();
    type("@ali");
    act(() => harness.pick(alice));
    // Caret sits right after "@Alice Wang " — one position past the token
    // end because of the trailing space, so move it flush first.
    selectCaret("@Alice Wang".length);
    key("Backspace");
    // The whole token goes in one keystroke; the trailing separator space
    // the insertion added stays behind as plain text.
    expect(ta().value).toBe(" ");
    expect(harness.canonical).toBe(" ");
    flushRaf();
    expect(ta().selectionStart).toBe(0);
    expect(ta().selectionEnd).toBe(0);
  });

  it("closes the picker after a whitespace-reusing pick and never re-triggers on the token", () => {
    mount();
    // Type a query with an existing trailing space, caret inside the run.
    type("@bo rest", 3);
    expect(harness.mentionTrigger).toEqual({ triggerIndex: 0, query: "bo" });
    act(() => harness.pick(bob));
    // The pick reused the existing space: "@Bob rest", caret at token end.
    expect(ta().value).toBe("@Bob rest");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a2", name: "bob", start: 0, end: 4 }]);
    // The popover must stay closed — the committed token is not a query.
    expect(harness.mentionTrigger).toBeNull();
    // Repeated Enter / pick is a no-op and cannot stack overlapping tokens.
    key("Enter");
    act(() => harness.pick(bob));
    expect(ta().value).toBe("@Bob rest");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a2", name: "bob", start: 0, end: 4 }]);
    // Clicking INTO the display label doesn't reopen the picker either.
    selectCaret(2);
    expect(harness.mentionTrigger).toBeNull();
    act(() => harness.pick(bob));
    expect(ta().value).toBe("@Bob rest");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a2", name: "bob", start: 0, end: 4 }]);
  });

  it("rehydrates display state from an external canonical replace (draft restore)", () => {
    mount();
    act(() => harness.setCanonical("ping @alice-w now"));
    expect(ta().value).toBe("ping @Alice Wang now");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 5, end: 16 }]);
  });

  it("falls back to raw `@<name>` while candidates have not loaded", () => {
    mount();
    act(() => harness.setCandidates([]));
    act(() => harness.setCanonical("hi @alice-w"));
    expect(ta().value).toBe("hi @alice-w");
    expect(harness.canonical).toBe("hi @alice-w");
  });

  it("resets the model on scope change even when the canonical text is identical", () => {
    mount();
    act(() => harness.setCanonical("@alice-w "));
    expect(ta().value).toBe("@Alice Wang ");
    expect(harness.composer?.tokens).toHaveLength(1);
    // Switch to a scope whose roster cannot resolve the slug, with the SAME
    // canonical draft text: the display model must rehydrate from scratch
    // (here: safe `@<name>` fallback), not leak the previous scope's token.
    act(() => {
      harness.setCandidates([]);
      harness.setScope("scope-b");
    });
    expect(ta().value).toBe("@alice-w ");
    expect(harness.composer?.tokens).toEqual([]);
    expect(harness.canonical).toBe("@alice-w ");
  });

  it("keeps the picked agentId when two agents share one displayName", () => {
    mount();
    const builder1: MentionCandidate = { agentId: "b1", name: "builder-1", displayName: "Builder", managedByMe: false };
    const builder2: MentionCandidate = { agentId: "b2", name: "builder-2", displayName: "Builder", managedByMe: false };
    act(() => harness.setCandidates([builder1, builder2]));
    type("@bu");
    act(() => harness.pick(builder2));
    expect(ta().value).toBe("@Builder ");
    expect(harness.composer?.tokens).toEqual([{ agentId: "b2", name: "builder-2", start: 0, end: 8 }]);
    expect(harness.canonical).toBe("@builder-2 ");
  });
});

describe("useMentionComposer — candidate-arrival upgrade", () => {
  it("upgrades an unedited restored draft when candidates arrive (canonical unchanged)", () => {
    mount();
    // Restored canonical draft, roster not yet loaded → raw `@<name>`.
    act(() => harness.setCandidates([]));
    act(() => harness.setCanonical("hi @alice-w"));
    expect(ta().value).toBe("hi @alice-w");
    expect(harness.composer?.tokens).toEqual([]);
    // Roster arrives (canonical + scope untouched): the SAME draft
    // re-resolves into the display label with the correct agentId.
    act(() => harness.setCandidates([alice, bob]));
    expect(ta().value).toBe("hi @Alice Wang");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 3, end: 14 }]);
    expect(harness.canonical).toBe("hi @alice-w");
  });

  it("never upgrades after a local edit — the user's text and tokens stand", () => {
    mount();
    act(() => harness.setCandidates([]));
    act(() => harness.setCanonical("hi @alice-w"));
    // Local edit before the roster arrives (typing + a real pick).
    type("hi @alice-w!");
    expect(harness.canonical).toBe("hi @alice-w!");
    type("hi @alice-w! @bo");
    act(() => harness.pick(bob));
    expect(ta().value).toBe("hi @alice-w! @Bob ");
    // The late roster must not rewrite the edited text or forge tokens
    // for the raw `@alice-w` the user typed themselves.
    act(() => harness.setCandidates([alice, bob]));
    expect(ta().value).toBe("hi @alice-w! @Bob ");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a2", name: "bob", start: 13, end: 17 }]);
    expect(harness.canonical).toBe("hi @alice-w! @bob ");
  });
});

describe("useMentionComposer — upgrade monotonicity", () => {
  it("ignores roster removal, replacement, and displayName-only changes after an upgrade", () => {
    mount();
    act(() => harness.setCandidates([]));
    act(() => harness.setCanonical("hi @alice-w"));
    act(() => harness.setCandidates([alice, bob]));
    expect(ta().value).toBe("hi @Alice Wang");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 3, end: 14 }]);
    // displayName change for a resolved agent → model untouched.
    act(() => harness.setCandidates([{ ...alice, displayName: "Alice W." }, bob]));
    expect(ta().value).toBe("hi @Alice Wang");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 3, end: 14 }]);
    // Roster removal → no degradation, model untouched.
    act(() => harness.setCandidates([bob]));
    expect(ta().value).toBe("hi @Alice Wang");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 3, end: 14 }]);
    // Replacement (alice out, a different agent with the same slug-shape in) → untouched.
    act(() =>
      harness.setCandidates([bob, { agentId: "a9", name: "alice-w", displayName: "Impostor", managedByMe: false }]),
    );
    expect(ta().value).toBe("hi @Alice Wang");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 3, end: 14 }]);
    expect(harness.canonical).toBe("hi @alice-w");
  });

  it("keeps filling in unresolved mentions as the roster arrives in batches", () => {
    mount();
    act(() => harness.setCandidates([]));
    act(() => harness.setCanonical("@alice-w and @bob look"));
    // First batch resolves Alice only.
    act(() => harness.setCandidates([alice]));
    expect(ta().value).toBe("@Alice Wang and @bob look");
    expect(harness.composer?.tokens).toEqual([{ agentId: "a1", name: "alice-w", start: 0, end: 11 }]);
    // Second batch adds Bob — Alice's identity is preserved in order.
    act(() => harness.setCandidates([alice, bob]));
    expect(ta().value).toBe("@Alice Wang and @Bob look");
    expect(harness.composer?.tokens).toEqual([
      { agentId: "a1", name: "alice-w", start: 0, end: 11 },
      { agentId: "a2", name: "bob", start: 16, end: 20 },
    ]);
    expect(harness.canonical).toBe("@alice-w and @bob look");
  });
});
