// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearOnboardingSessionFlags,
  readOnboardingTemplateIntent,
  writeOnboardingTemplateIntent,
} from "../onboarding-flags.js";

describe("onboarding template intent handoff", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("round-trips a valid slug per org", () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    expect(readOnboardingTemplateIntent("org-1")).toBe("pr-engineer");
  });

  it("is scoped per organization", () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    expect(readOnboardingTemplateIntent("org-2")).toBeNull();
  });

  it("clears with a null write", () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    writeOnboardingTemplateIntent("org-1", null);
    expect(readOnboardingTemplateIntent("org-1")).toBeNull();
  });

  it("survives a refresh-style re-read (sessionStorage persists in-tab)", () => {
    writeOnboardingTemplateIntent("org-1", "docs-writer");
    // A second reader in the same tab sees the same value — refresh / Finish
    // later retention is just sessionStorage lifetime.
    expect(readOnboardingTemplateIntent("org-1")).toBe("docs-writer");
    expect(readOnboardingTemplateIntent("org-1")).toBe("docs-writer");
  });

  it("rejects and removes an invalid stored value", () => {
    window.sessionStorage.setItem("onboarding:templateIntent:org-1", "Not A Slug!");
    expect(readOnboardingTemplateIntent("org-1")).toBeNull();
    expect(window.sessionStorage.getItem("onboarding:templateIntent:org-1")).toBeNull();
  });

  it("refuses to store an invalid slug at the write boundary", () => {
    writeOnboardingTemplateIntent("org-1", "Not A Slug!");
    expect(window.sessionStorage.getItem("onboarding:templateIntent:org-1")).toBeNull();
    expect(readOnboardingTemplateIntent("org-1")).toBeNull();
    // A valid write still works after a refused one.
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    expect(readOnboardingTemplateIntent("org-1")).toBe("pr-engineer");
  });

  it("is covered by the logout session-flag wipe", () => {
    writeOnboardingTemplateIntent("org-1", "pr-engineer");
    window.sessionStorage.setItem("unrelated:key", "keep");
    clearOnboardingSessionFlags();
    expect(readOnboardingTemplateIntent("org-1")).toBeNull();
    expect(window.sessionStorage.getItem("unrelated:key")).toBe("keep");
  });
});
