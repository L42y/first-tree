import { describe, expect, it } from "vitest";
import { buildTabs, tabKeysFor } from "../tabs.js";

describe("agent-detail tabs", () => {
  it("places Channels immediately after Profile for an editor", () => {
    const tabs = buildTabs(true, false);
    expect(tabs.map((tab) => tab.key)).toEqual([
      "profile",
      "channels",
      "runtime",
      "prompt",
      "capabilities",
      "repositories",
      "usage",
    ]);
    expect(tabs.map((tab) => tab.label)).toEqual([
      "Profile",
      "Channels",
      "Runtime",
      "Instructions",
      "Tools & skills",
      "Repositories",
      "Usage",
    ]);
    expect(tabs.every((tab) => tab.path === tab.key)).toBe(true);
  });

  it("keeps Channels visible to a non-human read-only viewer while configuration tabs stay editor-only", () => {
    expect(tabKeysFor(false, false).map((tab) => tab.key)).toEqual(["profile", "channels", "capabilities", "usage"]);
  });

  it("gives a human agent only Profile", () => {
    expect(tabKeysFor(false, true).map((tab) => tab.key)).toEqual(["profile"]);
  });

  it("uses the Runtime label instead of the retired Environment label", () => {
    const runtime = buildTabs(true, false).find((tab) => tab.key === "runtime");
    expect(runtime?.label).toBe("Runtime");
  });
});
