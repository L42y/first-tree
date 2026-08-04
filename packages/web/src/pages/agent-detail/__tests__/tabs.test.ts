import { describe, expect, it } from "vitest";
import { buildTabs, tabKeysFor } from "../tabs.js";

describe("agent-detail tabs", () => {
  it("gives an editor the 7-tab set with Responsibilities after Profile", () => {
    const tabs = buildTabs(true, false);
    expect(tabs.map((t) => t.key)).toEqual([
      "profile",
      "responsibilities",
      "runtime",
      "prompt",
      "capabilities",
      "repositories",
      "usage",
    ]);
    expect(tabs.map((t) => t.label)).toEqual([
      "Profile",
      "Responsibilities",
      "Runtime",
      "Instructions",
      "Tools & skills",
      "Repositories",
      "Usage",
    ]);
    // path stays equal to key for every tab (deep-link stability).
    expect(tabs.every((t) => t.path === t.key)).toBe(true);
  });

  it("renames runtime away from the old 'Environment' label", () => {
    const runtime = buildTabs(true, false).find((t) => t.key === "runtime");
    expect(runtime?.label).toBe("Runtime");
  });

  it("shows Responsibilities read-only while keeping Repositories and Runtime editor-only", () => {
    // Non-editor, non-human: Responsibilities remains visible, while runtime
    // and repositories keep their existing manager-only visibility.
    expect(tabKeysFor(false, false).map((t) => t.key)).toEqual([
      "profile",
      "responsibilities",
      "capabilities",
      "usage",
    ]);
  });

  it("gives a human agent only Profile", () => {
    // A human is always canEditConfig=false (it derives from type !== "human").
    expect(tabKeysFor(false, true).map((t) => t.key)).toEqual(["profile"]);
  });
});
