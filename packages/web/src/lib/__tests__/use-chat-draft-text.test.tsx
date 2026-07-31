// @vitest-environment happy-dom

import { act, type Dispatch, type SetStateAction, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../test-utils/dom-harness.js";
import { chatDraftScope, loadDraft, saveDraft } from "../draft-store.js";
import { useChatDraftText } from "../use-chat-draft-text.js";

let h: DomHarness;

beforeEach(() => {
  window.localStorage.clear();
  h = createDomHarness();
});
afterEach(() => h.cleanup());

/** Probe: surfaces the hook's draft text and buttons to mutate it. Rendering
 *  it with a changing `chatId` / `userId` (same element type at the root)
 *  reconciles in place — it does NOT remount — which is exactly how ChatView
 *  switches chats (and how a re-login swaps the user without a fresh mount). */
function Probe({
  userId = "user-1",
  chatId,
  onCommit,
  onSetter,
}: {
  userId?: string;
  chatId: string;
  onCommit?: (value: { chatId: string; draft: string }) => void;
  onSetter?: (value: { chatId: string; setDraft: Dispatch<SetStateAction<string>> }) => void;
}) {
  const [draft, setDraft] = useChatDraftText(userId, chatId);
  useLayoutEffect(() => {
    onCommit?.({ chatId, draft });
  }, [chatId, draft, onCommit]);
  useLayoutEffect(() => {
    onSetter?.({ chatId, setDraft });
  }, [chatId, onSetter, setDraft]);
  return (
    <div>
      <span data-testid="draft">{draft}</span>
      <button type="button" data-testid="type" onClick={() => setDraft(`body-${chatId}`)}>
        type
      </button>
      <button type="button" data-testid="clear" onClick={() => setDraft("")}>
        clear
      </button>
    </div>
  );
}

function draftText(): string {
  return h.container.querySelector('[data-testid="draft"]')?.textContent ?? "";
}

async function click(testid: string): Promise<void> {
  const btn = h.container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
  if (!btn) throw new Error(`button ${testid} not found`);
  await act(async () => {
    btn.click();
    await Promise.resolve();
  });
}

describe("useChatDraftText", () => {
  it("seeds the initial value from the stored draft for the user + chat", async () => {
    saveDraft(chatDraftScope("user-1", "chat-a"), { text: "preexisting" });
    h.render(<Probe chatId="chat-a" />);
    await h.flush();
    expect(draftText()).toBe("preexisting");
  });

  it("persists typed text under the user + chat scope", async () => {
    h.render(<Probe chatId="chat-a" />);
    await click("type");
    expect(draftText()).toBe("body-chat-a");
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))?.text).toBe("body-chat-a");
  });

  it("swaps drafts on chat switch without leaking across chats", async () => {
    h.render(<Probe chatId="chat-a" />);
    await click("type"); // stored under chat-a

    // Switch to a chat with no stored draft → composer is empty.
    h.render(<Probe chatId="chat-b" />);
    await h.flush();
    expect(draftText()).toBe("");

    await click("type"); // stored under chat-b
    expect(loadDraft(chatDraftScope("user-1", "chat-b"))?.text).toBe("body-chat-b");

    // Back to chat-a → its draft is restored, chat-a's text was never lost.
    h.render(<Probe chatId="chat-a" />);
    await h.flush();
    expect(draftText()).toBe("body-chat-a");
  });

  it("never commits the previous scope while switching between distinct stored drafts", async () => {
    const chatAScope = chatDraftScope("user-1", "chat-a");
    const chatBScope = chatDraftScope("user-1", "chat-b");
    saveDraft(chatAScope, { text: "draft-a" });
    saveDraft(chatBScope, { text: "draft-b" });
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const commits: Array<{ chatId: string; draft: string }> = [];
    const recordCommit = (value: { chatId: string; draft: string }) => commits.push(value);

    h.render(<Probe chatId="chat-a" onCommit={recordCommit} />);
    await h.flush();
    commits.length = 0;
    setItem.mockClear();

    // Layout effects observe every committed render before passive effects.
    // The first chat-b commit must already be scoped to chat-b: chat-a's value
    // may never reach the newly exposed composer, even transiently.
    h.render(<Probe chatId="chat-b" onCommit={recordCommit} />);
    await h.flush();
    expect(commits).toEqual([{ chatId: "chat-b", draft: "draft-b" }]);
    // Switching scopes is read-only: in particular, there can be no
    // transient write of chat-a's value under chat-b before effects settle.
    expect(setItem).not.toHaveBeenCalled();
    expect(loadDraft(chatAScope)?.text).toBe("draft-a");
    expect(loadDraft(chatBScope)?.text).toBe("draft-b");
  });

  it("routes a stale setter to its original scope after a chat switch", async () => {
    const chatAScope = chatDraftScope("user-1", "chat-a");
    const chatBScope = chatDraftScope("user-1", "chat-b");
    saveDraft(chatAScope, { text: "draft-a" });
    saveDraft(chatBScope, { text: "draft-b" });
    const setters = new Map<string, Dispatch<SetStateAction<string>>>();
    const recordSetter = ({ chatId, setDraft }: { chatId: string; setDraft: Dispatch<SetStateAction<string>> }) => {
      setters.set(chatId, setDraft);
    };

    h.render(<Probe chatId="chat-a" onSetter={recordSetter} />);
    await h.flush();
    h.render(<Probe chatId="chat-b" onSetter={recordSetter} />);
    await h.flush();

    // A stale functional update reads chat-a's own stored value, never chat-b's
    // live value, and remains invisible in the current composer.
    act(() => setters.get("chat-a")?.((current) => `${current}-updated`));

    expect(draftText()).toBe("draft-b");
    expect(loadDraft(chatAScope)?.text).toBe("draft-a-updated");
    expect(loadDraft(chatBScope)?.text).toBe("draft-b");

    // Mirrors an async send from chat-a settling after chat-b has committed.
    act(() => setters.get("chat-a")?.(""));

    expect(draftText()).toBe("draft-b");
    expect(loadDraft(chatAScope)).toBeNull();
    expect(loadDraft(chatBScope)?.text).toBe("draft-b");
  });

  it("does not leak a draft across users on the same chat", async () => {
    h.render(<Probe userId="user-1" chatId="chat-a" />);
    await click("type"); // stored under user-1 / chat-a

    // A different account opens the same chat in the same browser → empty.
    h.render(<Probe userId="user-2" chatId="chat-a" />);
    await h.flush();
    expect(draftText()).toBe("");
  });

  it("clears the stored draft when emptied (mirrors clearing on send)", async () => {
    h.render(<Probe chatId="chat-a" />);
    await click("type");
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))).not.toBeNull();
    await click("clear");
    expect(draftText()).toBe("");
    expect(loadDraft(chatDraftScope("user-1", "chat-a"))).toBeNull();
  });
});
