import { describe, expect, it } from "vitest";
import { buildTabs, tabKeysFor } from "../tabs.js";

describe("agent-detail tabs", () => {
  it("gives an editor the six configuration and observation tabs without Responsibilities", () => {
    const tabs = buildTabs(true, false);
    expect(tabs.map((tab) => tab.key)).toEqual([
      "profile",
      "runtime",
      "prompt",
      "capabilities",
      "repositories",
      "usage",
    ]);
    expect(tabs.map((tab) => tab.label)).toEqual([
      "Profile",
      "Runtime",
      "Instructions",
      "Tools & skills",
      "Repositories",
      "Usage",
    ]);
    expect(tabs.every((tab) => tab.path === tab.key)).toBe(true);
  });

  it("keeps Repositories and Runtime editor-only", () => {
    expect(tabKeysFor(false, false).map((tab) => tab.key)).toEqual(["profile", "capabilities", "usage"]);
  });

  it("gives a human agent only Profile", () => {
    expect(tabKeysFor(false, true).map((tab) => tab.key)).toEqual(["profile"]);
  });

  it("uses the Runtime label instead of the retired Environment label", () => {
    const runtime = buildTabs(true, false).find((tab) => tab.key === "runtime");
    expect(runtime?.label).toBe("Runtime");
  });
});
