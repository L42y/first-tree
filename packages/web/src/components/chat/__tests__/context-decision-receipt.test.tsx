// @vitest-environment happy-dom

import type { ContextDecision } from "@first-tree/shared";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { ContextDecisionReceipt, contextDecisionSourceHref } from "../context-decision-receipt.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PRIMARY_EVIDENCE: ContextDecision["evidence"][number] = {
  repoUrl: "https://github.com/example/context-tree",
  commit: COMMIT,
  nodePath: "product/release/rollout-policy.md",
  heading: "Expansion gates",
};

function receipt(overrides: Partial<ContextDecision> = {}): ContextDecision {
  return {
    version: 1,
    effect: "constrained",
    summary: "Team rollout policy caps Web at 20%; CLI stays at 5% until the migration guard clears.",
    evidence: [PRIMARY_EVIDENCE],
    ...overrides,
  };
}

let h: DomHarness;

beforeEach(() => {
  h = createDomHarness();
});
afterEach(() => h.cleanup());

const text = (): string => h.container.textContent ?? "";
const toggle = (): HTMLButtonElement => {
  const button = h.container.querySelector("button");
  if (!button) throw new Error("sources toggle not rendered");
  return button as HTMLButtonElement;
};

describe("ContextDecisionReceipt", () => {
  it("leads with the Context Tree effect and the agent's concrete summary", () => {
    h.render(<ContextDecisionReceipt receipt={receipt()} />);
    expect(text()).toContain("Context Tree");
    expect(text()).toContain("Options narrowed");
    expect(text()).toContain("Team rollout policy caps Web at 20%");
    expect(text()).not.toContain("1 decision");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("names each effect in user language, never the raw enum", () => {
    const labels: Array<[ContextDecision["effect"], string]> = [
      ["conflicted", "Conflict surfaced"],
      ["redirected", "Approach changed"],
      ["constrained", "Options narrowed"],
      ["confirmed", "Direction supported"],
    ];
    for (const [effect, label] of labels) {
      h.render(<ContextDecisionReceipt receipt={receipt({ effect })} />);
      expect(text()).toContain(label);
      expect(text()).not.toContain(effect);
    }
  });

  it("makes the whole compact receipt the disclosure and shows a readable source label", () => {
    h.render(<ContextDecisionReceipt receipt={receipt()} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("product/release/rollout-policy.md");

    act(() => toggle().click());

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Rollout Policy · Expansion gates");
    expect(text()).toContain("1 decision · Context Tree version 0123456");
    expect(text()).not.toContain("product/release/rollout-policy.md");
    expect(text()).not.toContain("example/context-tree");
    expect(text()).not.toContain(COMMIT);
  });

  it("keeps only a short agent-attribution note inside the expanded sources", () => {
    h.render(<ContextDecisionReceipt receipt={receipt()} />);
    expect(text()).not.toContain("agent-reported");

    act(() => toggle().click());

    expect(text()).toContain("Influence is agent-reported, not independently verified.");
    expect(text()).not.toContain("First Tree preserves the cited version");
  });

  it("makes no verification claim about the confirmed effect", () => {
    h.render(<ContextDecisionReceipt receipt={receipt({ effect: "confirmed" })} />);
    expect(text()).toContain("Direction supported");
    expect(text().toLowerCase()).not.toContain("verified");
  });

  it("links a GitHub source to the exact commit", () => {
    h.render(<ContextDecisionReceipt receipt={receipt()} />);
    act(() => toggle().click());
    const link = h.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      `https://github.com/example/context-tree/blob/${COMMIT}/product/release/rollout-policy.md`,
    );
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows an unidentifiable forge as plain text rather than a guessed link", () => {
    const evidence = [{ repoUrl: "https://git.example.com/team/tree", commit: COMMIT, nodePath: "a.md" }];
    h.render(<ContextDecisionReceipt receipt={receipt({ evidence })} />);
    act(() => toggle().click());
    expect(h.container.querySelector("a")).toBeNull();
    expect(text()).toContain("A");
    expect(text()).toContain("a.md · team/tree · 0123456");
    expect(text()).toContain("1 decision · Context Tree version 0123456");
  });

  it("summarizes one shared version once for multiple readable source rows", () => {
    const evidence = [
      PRIMARY_EVIDENCE,
      {
        repoUrl: "git@github.com:example/context-tree.git",
        commit: COMMIT,
        nodePath: "system/cloud/chat/messaging.md",
        heading: "Decision receipts",
      },
    ];
    h.render(<ContextDecisionReceipt receipt={receipt({ evidence })} />);
    act(() => toggle().click());

    expect(text()).toContain("Rollout Policy · Expansion gates");
    expect(text()).toContain("Messaging · Decision receipts");
    expect(text()).toContain("2 decisions · Context Tree version 0123456");
    expect(text()).not.toContain("Multiple Context Tree versions");
  });

  it("keeps different versions in exact links without repeating raw paths in the card", () => {
    const otherCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const evidence = [
      PRIMARY_EVIDENCE,
      {
        repoUrl: "https://github.com/example/other-tree",
        commit: otherCommit,
        nodePath: "system/cloud/chat/messaging.md",
        heading: "Decision receipts",
      },
    ];
    h.render(<ContextDecisionReceipt receipt={receipt({ evidence })} />);
    act(() => toggle().click());

    expect(text()).toContain("Rollout Policy · Expansion gates");
    expect(text()).toContain("Messaging · Decision receipts");
    expect(text()).not.toContain("product/release/rollout-policy.md");
    expect(text()).not.toContain("system/cloud/chat/messaging.md");
    expect(text()).toContain("2 decisions · 2 source versions");
    const links = Array.from(h.container.querySelectorAll("a"));
    expect(links[0]?.getAttribute("aria-label")).toContain("source version 0123456");
    expect(links[1]?.getAttribute("aria-label")).toContain("source version fedcba9");
  });
});

describe("contextDecisionSourceHref", () => {
  const evidence = (repoUrl: string, nodePath = "a/b.md") => ({ repoUrl, commit: COMMIT, nodePath });

  it("builds a GitLab blob link only when the repo matches the connected instance", () => {
    const repo = "https://gitlab.example.com/group/sub/tree";
    expect(contextDecisionSourceHref(evidence(repo), "https://gitlab.example.com")).toBe(
      `https://gitlab.example.com/group/sub/tree/-/blob/${COMMIT}/a/b.md`,
    );
    expect(contextDecisionSourceHref(evidence(repo), "https://gitlab.other.com")).toBeNull();
    expect(contextDecisionSourceHref(evidence(repo), null)).toBeNull();
  });

  // SSH bindings are valid receipt sources, so their links must resolve too.
  it("links an SSH-form GitHub source to the same web blob URL", () => {
    for (const repoUrl of ["git@github.com:example/tree.git", "ssh://git@github.com/example/tree.git"]) {
      expect(contextDecisionSourceHref(evidence(repoUrl), null), repoUrl).toBe(
        `https://github.com/example/tree/blob/${COMMIT}/a/b.md`,
      );
    }
  });

  it("escapes path segments so a source link cannot be broken by the path", () => {
    const href = contextDecisionSourceHref(evidence("https://github.com/example/tree", "a b/c?d.md"), null);
    expect(href).toBe(`https://github.com/example/tree/blob/${COMMIT}/a%20b/c%3Fd.md`);
  });
});
